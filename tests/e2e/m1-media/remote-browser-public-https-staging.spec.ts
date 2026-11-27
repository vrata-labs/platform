import { createPrivateKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { enterBrowserRoom, openBrowserAddress, readBrowserRoom, waitForBrowserObject } from "./remote-browser-room";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(process.env.STAGING_REMOTE_BROWSER_E2E !== "1", "Requires dedicated managed rooms, operator credentials and two authorized staging participants");

type Modes = Record<"whiteboard" | "remoteBrowser" | "pdf" | "video", boolean>;
type Room = {
  kind: string;
  status: string;
  visibility: string;
  publishedVersionId: string;
  revision: number;
  effectiveCutoff: string;
  mediaModes: Modes;
  remoteBrowserUrlPolicy: "allowlist" | "public-https";
};
type Settings = Partial<Pick<Room, "mediaModes" | "remoteBrowserUrlPolicy">>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} for the shared browser staging test`);
  return value;
}

function controlledUrl(name: string): URL {
  const url = URL.parse(required(name));
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) {
    throw new Error(`${name} must be a controlled HTTPS address on port 443 without credentials, query or fragment`);
  }
  return url;
}

// Observe the application's own audio analyser. We never publish, inject or redirect media.
async function observeBrowserAudio(context: BrowserContext) {
  await context.addInitScript(() => {
    const analysers = new Map<string, AnalyserNode>();
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, destination: unknown, ...rest: unknown[]) {
      if (this instanceof MediaStreamAudioSourceNode && destination instanceof AnalyserNode) {
        for (const track of this.mediaStream.getAudioTracks()) analysers.set(track.id, destination);
      }
      return Reflect.apply(connect, this, [destination, ...rest]);
    } as typeof AudioNode.prototype.connect;
    Reflect.set(window, "__testBrowserToneHz", () => {
      for (const audio of document.querySelectorAll("audio")) {
        if (audio.paused || audio.muted || audio.volume === 0 || !(audio.srcObject instanceof MediaStream)) continue;
        for (const track of audio.srcObject.getAudioTracks()) {
          const analyser = analysers.get(track.id);
          if (!analyser || track.muted || track.readyState !== "live") continue;
          const bins = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(bins);
          const peak = bins.reduce((index, value, next) => value > bins[index] ? next : index, 0);
          if (bins[peak] > -65) return peak * analyser.context.sampleRate / analyser.fftSize;
        }
      }
      return null;
    });
  });
}

function readTone(page: Page): Promise<number | null> {
  return page.evaluate(() => Reflect.get(window, "__testBrowserToneHz")?.() ?? null);
}

function readDecodedColor(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const videos = [...document.querySelectorAll("video")].filter(video =>
      !video.paused && video.readyState >= 2 && video.srcObject instanceof MediaStream
      && video.srcObject.getVideoTracks().some(track => track.readyState === "live"));
    if (videos.length !== 1) return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(videos[0], 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    if (green < 50 && red > 180 && blue < 50) return "red";
    if (green < 50 && blue > 180 && red < 50) return "blue";
    return null;
  });
}

test("@staging-extended managed private room publishes controlled HTTPS video and audio, then revokes access", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const origin = controlledUrl("BASE_URL").origin;
  const publicTarget = controlledUrl("STAGING_REMOTE_BROWSER_PUBLIC_URL");
  const legacyTarget = controlledUrl("STAGING_REMOTE_BROWSER_ALLOWLIST_URL");
  expect(publicTarget.origin).not.toBe(legacyTarget.origin);
  const tenant = required("STAGING_REMOTE_BROWSER_TENANT");
  const selectedId = required("STAGING_REMOTE_BROWSER_ROOM");
  const neighbourId = required("STAGING_REMOTE_BROWSER_NEIGHBOUR");
  expect(selectedId).not.toBe(neighbourId);
  const kid = required("STAGING_REMOTE_BROWSER_OPERATOR_KID");
  const privateKey = createPrivateKey(await readFile(required("STAGING_REMOTE_BROWSER_OPERATOR_KEY_FILE")));
  const { signIntegrationAssertion } = await import(pathToFileURL(resolve("apps/api/dist/testing/integration-assertions.js")).href);
  const sign = () => signIntegrationAssertion({ kid, issuer: "portal:stage", privateKey },
    { scope: ["getRoom", "updateRoomAccess"] });
  const stem = `${origin}/integration/v1/tenants/${encodeURIComponent(tenant)}/rooms`;
  async function operation<T>(roomId: string, method: "GET" | "PATCH", suffix = "", data?: unknown): Promise<T> {
    const response = await request.fetch(`${stem}/${encodeURIComponent(roomId)}${suffix}`, {
      method, data, maxRedirects: 0, timeout: 10_000,
      headers: { authorization: `Bearer ${sign()}`, ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) }
    }).catch(() => {
      throw new Error(`managed test-room transport failed: ${method} ${suffix || "room"}`);
    });
    expect(response.status(), `managed test-room API ${method} ${suffix || "room"}`).toBe(200);
    return response.json();
  }
  const rooms = new Map<string, Room>();
  for (const id of [selectedId, neighbourId]) {
    const room = await operation<Room>(id, "GET");
    expect(room).toMatchObject({ kind: "custom", visibility: "private", status: "active", remoteBrowserUrlPolicy: "allowlist" });
    expect(room.publishedVersionId).toBeTruthy();
    expect(Date.parse(room.effectiveCutoff) - Date.now()).toBeGreaterThan(300_000);
    rooms.set(id, room);
  }
  const selected = rooms.get(selectedId)!;
  const neighbour = rooms.get(neighbourId)!;

  const changed = new Set<string>();
  async function update(id: string, settings: Settings) {
    changed.add(id);
    const current = await operation<Room>(id, "GET");
    const result = await operation<Room>(id, "PATCH", "/access", { expectedRevision: current.revision, ...settings });
    expect(result).toMatchObject(settings);
    return result;
  }
  const contexts: BrowserContext[] = [];
  async function participant(roomId: string, role: "host" | "member", envName: string, name: string) {
    const entryUrl = required(envName);
    const url = URL.parse(entryUrl);
    if (url?.origin !== origin || url.pathname !== `/rooms/${roomId}` || !url.hash.startsWith("#grant=")) {
      throw new Error(`Unexpected grant entry origin or room in ${envName}`);
    }
    const context = await browser.newContext({ locale: "en-US" });
    contexts.push(context);
    if (role === "member") await observeBrowserAudio(context);
    const page = await context.newPage();
    await enterBrowserRoom(page, entryUrl, name);
    await expect.poll(async () => (await readBrowserRoom(page))?.access?.role).toBe(role);
    return page;
  }
  try {
    // Only consume dedicated single-use entries. Revoking an account grant
    // would revoke that account's other grants in the room and its identity.
    const viewer = await participant(selectedId, "member", "STAGING_REMOTE_BROWSER_VIEWER_ENTRY_URL", "Browser viewer");
    const host = await participant(selectedId, "host", "STAGING_REMOTE_BROWSER_HOST_ENTRY_URL", "Browser host");
    const otherHost = await participant(neighbourId, "host", "STAGING_REMOTE_BROWSER_NEIGHBOUR_ENTRY_URL", "Neighbour host");
    const identities = await Promise.all([host, viewer].map(async page => (await readBrowserRoom(page))?.participantId));
    expect(identities.every(Boolean) && identities[0] !== identities[1], "independent admitted participants").toBe(true);

    await update(selectedId, { remoteBrowserUrlPolicy: "public-https", mediaModes: { ...selected.mediaModes, remoteBrowser: false } });
    await expect(host.locator("#remote-browser-control")).toBeHidden();
    await expect(host.locator("#open-remote-browser")).toBeDisabled();
    expect((await readBrowserRoom(host))?.mediaObjects?.surfaces?.some(surface => surface.activeObjectType === "remote-browser")).toBe(false);
    await update(selectedId, { mediaModes: { ...selected.mediaModes, remoteBrowser: true } });
    await openBrowserAddress(host, publicTarget.href);
    await waitForBrowserObject(host, publicTarget.href);
    const opened = (await readBrowserRoom(host))!;
    const surface = opened.mediaObjects?.surfaces?.find(candidate => candidate.activeObjectType === "remote-browser");
    expect(surface?.activeObjectId).toBeTruthy();
    await expect.poll(async () => {
      const state = await readBrowserRoom(viewer);
      return {
        activeObjectId: state?.mediaObjects?.surfaces?.find(candidate => candidate.surfaceId === surface?.surfaceId)?.activeObjectId,
        video: state?.remoteBrowser?.externalVideoTrackSid,
        audio: state?.remoteBrowser?.audioTrackSid
      };
    }, { timeout: 45_000 }).toEqual({
      activeObjectId: surface?.activeObjectId, video: opened.remoteBrowser?.mediaTrackSid, audio: opened.remoteBrowser?.audioTrackSid
    });
    const colors = new Set<string>();
    await expect.poll(async () => {
      const color = await readDecodedColor(viewer);
      if (color) colors.add(color);
      return [...colors].sort();
    }, { timeout: 20_000, intervals: [150, 250, 400] }).toEqual(["blue", "red"]);
    await expect.poll(async () => Math.abs((await readTone(viewer) ?? 0) - 880), { timeout: 20_000 }).toBeLessThan(50);

    await update(neighbourId, { mediaModes: { ...neighbour.mediaModes, remoteBrowser: true } });
    await openBrowserAddress(otherHost, publicTarget.href);
    await expect(otherHost.locator("#remote-browser-status")).toHaveText("This address is blocked by the room's browser policy.");
    await openBrowserAddress(otherHost, legacyTarget.href);
    await waitForBrowserObject(otherHost, legacyTarget.href);
    await otherHost.locator("#stop-remote-browser").click();

    // Prove it is still the same working publication just before revocation.
    await expect.poll(async () => Math.abs((await readTone(viewer) ?? 0) - 880)).toBeLessThan(50);
    const revokeStarted = performance.now();
    await update(selectedId, { remoteBrowserUrlPolicy: "allowlist" });
    await expect.poll(async () => {
      const state = (await readBrowserRoom(viewer))?.remoteBrowser;
      return { retired: !state?.mediaTrackSid && !state?.audioTrackSid && !state?.externalVideoTrackSid, tone: await readTone(viewer) };
    }, { timeout: Math.max(1, 10_000 - (performance.now() - revokeStarted)), intervals: [100, 250, 500] })
      .toEqual({ retired: true, tone: null });
    await openBrowserAddress(host, publicTarget.href);
    await expect(host.locator("#remote-browser-status")).toHaveText("This address is blocked by the room's browser policy.");
    await openBrowserAddress(host, legacyTarget.href);
    await waitForBrowserObject(host, legacyTarget.href);
    await host.locator("#stop-remote-browser").click();
  } finally {
    const restored = await Promise.allSettled([...changed].map(async id => {
      const original = rooms.get(id)!;
      await update(id, { mediaModes: original.mediaModes, remoteBrowserUrlPolicy: original.remoteBrowserUrlPolicy });
    }));
    await Promise.allSettled(contexts.map(context => context.close()));
    expect(restored.every(result => result.status === "fulfilled"), "test-room settings restored").toBe(true);
  }
});
