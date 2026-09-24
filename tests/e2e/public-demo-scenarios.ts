import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type DemoRole = "host" | "member" | "guest";
type JsonRecord = Record<string, any>;

type PublicDemoModule = {
  cleanupPublicDemo(options: JsonRecord): Promise<JsonRecord>;
  publicDemoCleanupRecordPath(stateFile: string): string;
  readPublicDemoState(stateFile: string, options?: JsonRecord): Promise<JsonRecord>;
  seedPublicDemo(options: JsonRecord): Promise<JsonRecord>;
};

type DemoClient = {
  context: BrowserContext;
  page: Page;
  role: DemoRole;
  inviteLink: string;
  displayName: string;
  participantId: string;
  sessionToken: string;
  audioMock: boolean;
  requireDevRoleQueryDisabled: boolean;
};

export type PublicDemoScenarioOptions = {
  browser: Browser;
  testInfo: TestInfo;
  origin: string;
  adminToken: string;
  staging: boolean;
};

const viewport = { width: 640, height: 400 };
const requestTimeoutMs = 15_000;
const corePollIntervals = [250, 500, 1_000, 2_000];
const expectedCatalog = [
  { templateId: "meeting-room-basic", currentVersion: "2.0.0", status: "active" },
  { templateId: "personal-room-basic", currentVersion: "2.0.0", status: "active" },
  { templateId: "presentation-room-basic", currentVersion: "2.0.0", status: "active" }
];

let demoModulePromise: Promise<PublicDemoModule> | undefined;

function loadPublicDemoModule(): Promise<PublicDemoModule> {
  demoModulePromise ??= import(pathToFileURL(resolve("tools/public-demo.mjs")).href) as Promise<PublicDemoModule>;
  return demoModulePromise;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function responseJson(response: Response, step: string): Promise<JsonRecord> {
  try {
    return await response.json() as JsonRecord;
  } catch {
    throw new Error(`${step}_invalid_json`);
  }
}

async function fetchJson(
  origin: string,
  path: string,
  init: RequestInit,
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch {
    throw new Error(`${step}_request_failed`);
  }
  return { status: response.status, data: await responseJson(response, step) };
}

async function adminJson(
  origin: string,
  adminToken: string,
  path: string,
  init: RequestInit,
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  const headers = new Headers(init.headers);
  headers.set("x-vrata-admin-token", adminToken);
  if (init.body) headers.set("content-type", "application/json");
  return fetchJson(origin, path, { ...init, headers }, step);
}

function requireStatus(actual: number, expected: number, step: string): void {
  if (actual !== expected) throw new Error(`${step}_unexpected_status_${actual}`);
}

function inviteToken(inviteLink: string): string {
  let url: URL;
  try {
    url = new URL(inviteLink);
  } catch {
    throw new Error("public_demo_invite_invalid");
  }
  const token = url.searchParams.get("invite");
  const keys = [...url.searchParams.keys()];
  if (!token || keys.length !== 1 || keys[0] !== "invite") throw new Error("public_demo_invite_invalid");
  return token;
}

function decodeSessionToken(token: string): JsonRecord {
  const body = token.split(".")[0];
  if (!body) throw new Error("public_demo_session_token_invalid");
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JsonRecord;
  } catch {
    throw new Error("public_demo_session_token_invalid");
  }
}

async function requestStateToken(
  origin: string,
  roomId: string,
  input: { inviteToken?: string; requestedRole?: string },
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  return fetchJson(origin, "/api/tokens/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId,
      participantId: `public-demo-check-${randomUUID()}`,
      displayName: "Public demo access check",
      ...input
    })
  }, step);
}

async function expectStateTokenDenied(
  origin: string,
  roomId: string,
  input: { inviteToken?: string; requestedRole?: string },
  reason: string,
  step: string
): Promise<void> {
  const result = await requestStateToken(origin, roomId, input, step);
  requireStatus(result.status, 403, step);
  if (result.data.error !== "room_access_denied" || result.data.reason !== reason) {
    throw new Error(`${step}_wrong_denial`);
  }
}

function browserInviteUrl(inviteLink: string, input: { audioMock?: boolean } = {}): string {
  const url = new URL(inviteLink);
  inviteToken(inviteLink);
  if (input.audioMock) {
    url.searchParams.set("debug", "1");
    url.searchParams.set("scenefit", "0");
    url.searchParams.set("audiomock", "1");
  }
  return url.href;
}

async function navigateAndRemoveSensitiveQuery(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch {
    throw new Error("public_demo_browser_navigation_failed");
  }
  await page.addStyleTag({ content: "#debug-panel,#xr-debug-panel { display: none !important; }" });
  if (new URL(url).searchParams.has("invite")) {
    await expect(page.locator("#guest-onboarding")).toBeVisible({ timeout: 30_000 });
  }
  try {
    await page.evaluate(() => {
      history.replaceState(null, "", location.pathname);
    });
  } catch {
    throw new Error("public_demo_browser_url_redaction_failed");
  }
}

async function waitForOnboarding(page: Page): Promise<void> {
  await expect(page.locator("#guest-onboarding")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#guest-enter-without-audio")).toBeEnabled();
  await expect.poll(() => page.locator("#guest-enter-without-audio").evaluate((button) =>
    typeof (button as HTMLButtonElement).onclick === "function"), {
    timeout: 30_000,
    intervals: corePollIntervals
  }).toBe(true);
}

async function tokenResponseForNextJoin(page: Page): Promise<import("@playwright/test").Response> {
  return page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === "/api/tokens/state";
  }, { timeout: 45_000 });
}

async function completeOnboarding(page: Page, displayName: string): Promise<import("@playwright/test").Response> {
  await waitForOnboarding(page);
  const responsePromise = tokenResponseForNextJoin(page);
  void responsePromise.catch(() => undefined);
  await page.locator("#guest-name-input").fill(displayName);
  await page.locator("#guest-enter-without-audio").evaluate((button: HTMLButtonElement) => button.click());
  const onboarding = await page.evaluate(() => ({
    completed: (window as any).__VRATA_DEBUG__?.guestOnboarding?.completed ?? false,
    handler: typeof (document.querySelector("#guest-enter-without-audio") as HTMLButtonElement | null)?.onclick,
    status: document.querySelector("#guest-onboarding-status")?.textContent ?? null
  }));
  if (!onboarding.completed) throw new Error(`public_demo_onboarding_not_completed:${JSON.stringify(onboarding)}`);
  try {
    return await responsePromise;
  } catch {
    const state = await page.evaluate(() => ({
      status: document.querySelector("#status-line")?.textContent ?? null,
      onboarding: document.querySelector("#guest-onboarding")?.hasAttribute("hidden") ?? null,
      issue: (window as any).__VRATA_DEBUG__?.issueCode ?? null
    })).catch(() => null);
    throw new Error(`public_demo_onboarding_token_request_missing:${JSON.stringify(state)}`);
  }
}

async function expectInviteBrowserDenied(page: Page, link: string, displayName: string, message: string): Promise<void> {
  await navigateAndRemoveSensitiveQuery(page, browserInviteUrl(link));
  const response = await completeOnboarding(page, displayName);
  requireStatus(response.status(), 403, "public_demo_denied_invite_browser");
  await expect(page.locator("#status-line")).toContainText(message, { timeout: 30_000 });
}

async function expectDirectRoomBrowserDenied(page: Page, origin: string, roomId: string): Promise<void> {
  await navigateAndRemoveSensitiveQuery(page, new URL(`/rooms/${roomId}?debug=1&scenefit=0`, origin).href);
  await expect(page.locator("#status-line")).toContainText("Access denied: private invite required", { timeout: 30_000 });
}

function assertTrustedSession(data: JsonRecord, expectedRole: DemoRole): { participantId: string; token: string } {
  const token = typeof data.token === "string" ? data.token : "";
  const payload = decodeSessionToken(token);
  if (data.role !== expectedRole
    || payload.role !== expectedRole
    || payload.roleSource !== "trusted"
    || typeof payload.participantId !== "string"
    || !payload.participantId) {
    throw new Error("public_demo_untrusted_session_role");
  }
  return { participantId: payload.participantId, token };
}

async function joinClientPage(input: {
  context: BrowserContext;
  page: Page;
  role: DemoRole;
  inviteLink: string;
  displayName: string;
  audioMock: boolean;
  requireDevRoleQueryDisabled: boolean;
}, navigate = true): Promise<DemoClient> {
  if (navigate) {
    await navigateAndRemoveSensitiveQuery(input.page, browserInviteUrl(input.inviteLink, {
      audioMock: input.audioMock
    }));
  }
  const response = await completeOnboarding(input.page, input.displayName);
  requireStatus(response.status(), 200, "public_demo_browser_join");
  let data: JsonRecord;
  try {
    data = await response.json() as JsonRecord;
  } catch {
    throw new Error("public_demo_browser_join_invalid_json");
  }
  const session = assertTrustedSession(data, input.role);
  await expect.poll(async () => input.page.evaluate(() => {
    const debug = (window as any).__VRATA_DEBUG__;
    return {
      connected: debug?.roomStateConnected ?? false,
      role: debug?.access?.role ?? null
    };
  }), { timeout: 45_000, intervals: corePollIntervals }).toEqual({
    connected: true,
    role: input.role
  });
  if (input.requireDevRoleQueryDisabled) {
    await expect.poll(() => input.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.roleQueryAllowed ?? true), {
      timeout: 15_000, intervals: corePollIntervals
    }).toBe(false);
  }
  const debugParticipantId = await input.page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId ?? "");
  if (debugParticipantId !== session.participantId) throw new Error("public_demo_participant_binding_mismatch");
  expect(await input.page.title()).toBe("Vrata Room");
  if (new URL(input.page.url()).searchParams.has("invite")) throw new Error("public_demo_browser_invite_not_redacted");
  return {
    context: input.context,
    page: input.page,
    role: input.role,
    inviteLink: input.inviteLink,
    displayName: input.displayName,
    participantId: session.participantId,
    sessionToken: session.token,
    audioMock: input.audioMock,
    requireDevRoleQueryDisabled: input.requireDevRoleQueryDisabled
  };
}

async function reloadClientThroughInvite(client: DemoClient): Promise<void> {
  const previousParticipantId = client.participantId;
  const rejoined = await joinClientPage(client);
  if (rejoined.participantId !== previousParticipantId) throw new Error("public_demo_reload_changed_participant");
  client.page = rejoined.page;
  client.sessionToken = rejoined.sessionToken;
}

async function createTrackedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(120_000);
  return context;
}

async function waitForExactPresence(clients: DemoClient[]): Promise<void> {
  const expectedIds = clients.map((client) => client.participantId);
  const snapshots = async () => Promise.all(clients.map(async (client) => client.page.evaluate((allParticipantIds) => {
       const debug = (window as any).__VRATA_DEBUG__;
       const localId = debug?.participantId;
       const expectedRemoteIds = allParticipantIds.filter((id) => id !== localId);
       const actualRemoteIds = (debug?.remoteParticipants ?? []).map((participant: any) => participant.participantId);
       return {
         expected: expectedRemoteIds.length,
         avatarCount: debug?.remoteAvatarCount ?? null,
         remoteCount: actualRemoteIds.length,
         matches: expectedRemoteIds.every((id) => actualRemoteIds.includes(id)),
         connected: debug?.roomStateConnected ?? false,
         scene: debug?.sceneBundleState ?? null
       };
    }, expectedIds)));
  try {
    await expect.poll(async () => (await snapshots()).every((state) =>
      state.avatarCount === state.expected && state.remoteCount === state.expected && state.matches),
    { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true);
  } catch {
    const final = await snapshots();
    if (final.every((state) => state.avatarCount === state.expected && state.remoteCount === state.expected && state.matches)) return;
    throw new Error(`public_demo_presence_mismatch:${JSON.stringify(final)}`);
  }
}

async function waitForPresentation(clients: DemoClient[], pageNumber: number): Promise<void> {
  for (const client of clients) {
    await client.page.bringToFront();
    const snapshot = async () => client.page.evaluate((expectedPage) => {
      const debug = (window as any).__VRATA_DEBUG__;
      const presentation = debug?.pdfPresentation;
      const surface = debug?.mediaObjects?.surfaces?.find((item: any) => item.surfaceId === "debug-main");
      const ready = Boolean(presentation?.renderState === "ready"
        && presentation?.page === expectedPage
        && presentation?.pageCount === 3
        && typeof presentation?.lastRenderMs === "number"
        && presentation?.errorCode === null
        && typeof surface?.textureId === "number");
      const texture = (window as any).__VRATA_TEST__?.sampleMediaSurfaceTexture(
        "debug-main",
        { u: 0.5, v: 0.5 },
        { width: 0.8, height: 0.8 }
      );
      return { ready, page: presentation?.page ?? null, renderState: presentation?.renderState ?? null,
        issue: presentation?.errorCode ?? null, scene: debug?.sceneBundleState ?? null,
        visible: texture?.samples?.length === 128 && texture.samples.some((pixel: number[]) => Math.max(...pixel) > 16) };
    }, pageNumber);
    try {
      await expect.poll(async () => {
        const current = await snapshot();
        return current.ready && current.visible;
      }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    } catch {
      throw new Error(`public_demo_pdf_page_${pageNumber}_${client.role}_not_rendered:${JSON.stringify(await snapshot())}`);
    }
  }
}

async function activateButton(page: Page, selector: string): Promise<void> {
  await expect(page.locator(selector)).toBeEnabled({ timeout: 30_000 });
  await page.locator(selector).evaluate((button: HTMLButtonElement) => button.click());
}

async function sessionRequest(
  origin: string,
  roomId: string,
  sessionToken: string,
  path: string,
  init: RequestInit,
  step: string
): Promise<{ status: number; data: JsonRecord }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${sessionToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetchJson(origin, `/api/rooms/${roomId}${path}`, { ...init, headers }, step);
}

async function leaveClient(client: DemoClient, origin: string, roomId: string): Promise<void> {
  await client.page.close();
  const departure = await sessionRequest(
    origin,
    roomId,
    client.sessionToken,
    `/presence/${encodeURIComponent(client.participantId)}`,
    { method: "DELETE" },
    "public_demo_presence_departure"
  );
  requireStatus(departure.status, 200, "public_demo_presence_departure");
}

async function denyGuestPresentationControl(guest: DemoClient, roomId: string): Promise<void> {
  await expect(guest.page.locator("#documents-panel")).toBeHidden();
  await expect(guest.page.locator("#presentation-next")).toBeDisabled();
  const denied = await sessionRequest(new URL(guest.inviteLink).origin, roomId, guest.sessionToken, "/documents", { method: "POST" }, "public_demo_guest_document_upload");
  requireStatus(denied.status, 403, "public_demo_guest_document_upload");
  await expect.poll(() => guest.page.evaluate(() => (window as any).__VRATA_DEBUG__?.pdfPresentation?.page ?? null), {
    timeout: 15_000,
    intervals: corePollIntervals
  }).toBe(2);
}

type AudioSnapshot = {
  audioState: string | null;
  publishedAudio: boolean;
  audioSource: string | null;
  subscribedAudioCount: number;
  remoteActive: boolean;
  remoteMuted: boolean;
  remoteHasAudioNode: boolean;
  speakerLevel: number;
  spatialLevel: number;
  spatialHasAudioNode: boolean;
  spatialPannerActive: boolean;
  webrtcAvailable: boolean;
  transportCount: number;
  publisherConnected: boolean;
  subscriberConnected: boolean;
  bytesSent: number;
  bytesReceived: number;
};

async function readAudioSnapshot(listener: DemoClient, sourceParticipantId: string): Promise<AudioSnapshot> {
  return listener.page.evaluate((targetParticipantId) => {
    const debug = (window as any).__VRATA_DEBUG__;
    const remote = debug?.remoteParticipants?.find((participant: any) => participant.participantId === targetParticipantId);
    const spatial = debug?.spatialAudio?.remoteSources?.find((source: any) => source.participantId === targetParticipantId);
    const transports = debug?.media?.webrtc?.transports ?? [];
    const publisher = transports.find((transport: any) => transport.role === "publisher");
    const subscriber = transports.find((transport: any) => transport.role === "subscriber");
    const connected = (transport: any) => transport?.connectionState === "connected"
      || transport?.iceConnectionState === "connected"
      || transport?.iceConnectionState === "completed";
    return {
      audioState: debug?.media?.audioState ?? null,
      publishedAudio: debug?.media?.publishedAudio ?? false,
      audioSource: debug?.media?.audioSource ?? null,
      subscribedAudioCount: debug?.media?.subscribedAudioCount ?? 0,
      remoteActive: remote?.activeAudio ?? false,
      remoteMuted: remote?.muted ?? true,
      remoteHasAudioNode: remote?.hasAudioNode ?? false,
      speakerLevel: debug?.speakerOutputLevel ?? 0,
      spatialLevel: spatial?.audioLevel ?? 0,
      spatialHasAudioNode: spatial?.hasAudioNode ?? false,
      spatialPannerActive: spatial?.pannerActive ?? false,
      webrtcAvailable: debug?.media?.webrtc?.available ?? false,
      transportCount: transports.length,
      publisherConnected: connected(publisher),
      subscriberConnected: connected(subscriber),
      bytesSent: Math.max(0, ...transports.map((transport: any) => transport.selectedCandidatePair?.bytesSent ?? 0)),
      bytesReceived: Math.max(0, ...transports.map((transport: any) => transport.selectedCandidatePair?.bytesReceived ?? 0))
    };
  }, sourceParticipantId);
}

function audioReady(snapshot: AudioSnapshot): boolean {
  return snapshot.audioState === "joined"
    && snapshot.publishedAudio
    && snapshot.audioSource === "mock"
    && snapshot.subscribedAudioCount >= 1
    && snapshot.remoteActive
    && !snapshot.remoteMuted
    && snapshot.speakerLevel > 0
    && snapshot.spatialLevel > 0
    && snapshot.spatialHasAudioNode
    && snapshot.spatialPannerActive
    && snapshot.webrtcAvailable
    && snapshot.transportCount >= 1
    && (snapshot.publisherConnected || snapshot.subscriberConnected)
    && snapshot.bytesSent > 0
    && snapshot.bytesReceived > 0;
}

async function runStrictStagingAudio(host: DemoClient, member: DemoClient): Promise<void> {
  for (const client of [host, member]) {
    await client.page.locator("#join-muted").uncheck();
    await activateButton(client.page, "#join-audio");
  }

  try {
    await expect.poll(async () => {
      const [hostState, memberState] = await Promise.all([
        readAudioSnapshot(host, member.participantId),
        readAudioSnapshot(member, host.participantId)
      ]);
      return audioReady(hostState) && audioReady(memberState);
    }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] }).toBe(true);
  } catch {
    const [hostState, memberState] = await Promise.all([
      readAudioSnapshot(host, member.participantId),
      readAudioSnapshot(member, host.participantId)
    ]);
    throw new Error(`public_demo_audio_not_ready:${JSON.stringify({ hostState, memberState })}`);
  }

  const [hostBaseline, memberBaseline] = await Promise.all([
    readAudioSnapshot(host, member.participantId),
    readAudioSnapshot(member, host.participantId)
  ]);
  await expect.poll(async () => {
    const [hostState, memberState] = await Promise.all([
      readAudioSnapshot(host, member.participantId),
      readAudioSnapshot(member, host.participantId)
    ]);
    return hostState.bytesReceived > hostBaseline.bytesReceived
      && memberState.bytesReceived > memberBaseline.bytesReceived
      && hostState.speakerLevel > 0
      && memberState.speakerLevel > 0;
  }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBe(true);

  await activateButton(member.page, "#toggle-mute");
  await expect.poll(async () => {
    const [hostState, memberState] = await Promise.all([
      readAudioSnapshot(host, member.participantId),
      readAudioSnapshot(member, host.participantId)
    ]);
    return memberState.audioState === "muted"
      && !memberState.publishedAudio
      && hostState.remoteMuted
      && !hostState.remoteActive
      && hostState.subscribedAudioCount === 0
      && hostState.speakerLevel === 0;
  }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBe(true);

  const mutedBaseline = await readAudioSnapshot(host, member.participantId);
  await activateButton(member.page, "#toggle-mute");
  await expect.poll(async () => {
    const hostState = await readAudioSnapshot(host, member.participantId);
    const memberState = await readAudioSnapshot(member, host.participantId);
    return audioReady(hostState)
      && memberState.audioState === "joined"
      && memberState.publishedAudio
      && hostState.bytesReceived > mutedBaseline.bytesReceived
      && hostState.speakerLevel > 0;
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] }).toBe(true);
}

async function attachAllowlistedDiagnostics(
  testInfo: TestInfo,
  environment: "local" | "staging",
  phase: string,
  clients: DemoClient[]
): Promise<void> {
  const clientDiagnostics = await Promise.all(clients.map(async (client) => {
    if (client.page.isClosed()) return { role: client.role, pageOpen: false };
    const state = await client.page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return {
        connected: debug?.roomStateConnected ?? false,
        sceneState: debug?.sceneBundleState ?? null,
        accessRole: debug?.access?.role ?? null,
        roleQueryAllowed: debug?.access?.roleQueryAllowed ?? null,
        remoteCount: debug?.remoteAvatarCount ?? null,
        notesState: debug?.notes?.saveState ?? null,
        presentationState: debug?.pdfPresentation?.renderState ?? null,
        presentationPage: debug?.pdfPresentation?.page ?? null,
        mediaState: debug?.media?.audioState ?? null,
        audioSource: debug?.media?.audioSource ?? null,
        webrtcAvailable: debug?.media?.webrtc?.available ?? false,
        transportCount: debug?.media?.webrtc?.transports?.length ?? 0,
        issueCode: debug?.issueCode ?? null
      };
    }).catch(() => null);
    return { role: client.role, pageOpen: true, state };
  }));
  await testInfo.attach("public-demo-diagnostics", {
    body: JSON.stringify({ environment, phase, clientCount: clients.length, clients: clientDiagnostics }, null, 2),
    contentType: "application/json"
  });
}

async function attachCleanupRecord(
  demo: PublicDemoModule,
  testInfo: TestInfo,
  environment: "local" | "staging",
  cleanupRecord: string
): Promise<void> {
  const record = await demo.readPublicDemoState(cleanupRecord, { allowCleanupRecord: true });
  await testInfo.attach("public-demo-cleanup-record", {
    body: JSON.stringify({
      environment,
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      runId: record.runId,
      tenantId: record.tenantId,
      roomId: record.roomId,
      resources: {
        documentIds: record.resources?.documentIds ?? [],
        inviteIds: record.resources?.inviteIds ?? []
      },
      cleanup: record.lifecycle?.cleanup ?? null
    }, null, 2),
    contentType: "application/json"
  });
}

async function supplementalInvites(origin: string, adminToken: string, roomId: string): Promise<{
  expiredLink: string;
  revokedLink: string;
}> {
  const expired = await adminJson(origin, adminToken, `/api/rooms/${roomId}/invites`, {
    method: "POST",
    body: JSON.stringify({ role: "guest", expiresAt: new Date(Date.now() - 60_000).toISOString(), waitingRoomEnabled: false })
  }, "public_demo_create_expired_invite");
  requireStatus(expired.status, 201, "public_demo_create_expired_invite");
  const expiredLink = typeof expired.data.inviteLink === "string" ? expired.data.inviteLink : "";
  inviteToken(expiredLink);

  const revoked = await adminJson(origin, adminToken, `/api/rooms/${roomId}/invites`, {
    method: "POST",
    body: JSON.stringify({ role: "guest", expiresInSeconds: 3_600, waitingRoomEnabled: false })
  }, "public_demo_create_revoked_invite");
  requireStatus(revoked.status, 201, "public_demo_create_revoked_invite");
  const revokedLink = typeof revoked.data.inviteLink === "string" ? revoked.data.inviteLink : "";
  const revokedId = typeof revoked.data.inviteId === "string" ? revoked.data.inviteId : "";
  inviteToken(revokedLink);
  if (!revokedId) throw new Error("public_demo_revoked_invite_invalid");
  const revoke = await adminJson(origin, adminToken, `/api/rooms/${roomId}/invites/${encodeURIComponent(revokedId)}/revoke`, {
    method: "POST"
  }, "public_demo_revoke_invite");
  requireStatus(revoke.status, 200, "public_demo_revoke_invite");
  return { expiredLink, revokedLink };
}

export async function assertExactActivePublicDemoCatalog(origin: string): Promise<void> {
  const catalog = await fetchJson(origin, "/api/templates", { method: "GET" }, "public_demo_catalog_preflight");
  requireStatus(catalog.status, 200, "public_demo_catalog_preflight");
  const actual = Array.isArray(catalog.data.items)
    ? catalog.data.items.map((item: JsonRecord) => ({
      templateId: item.templateId,
      currentVersion: item.currentVersion,
      status: item.status
    })).sort((left: JsonRecord, right: JsonRecord) => String(left.templateId).localeCompare(String(right.templateId)))
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expectedCatalog)) {
    throw new Error("public_demo_exact_active_catalog_required");
  }
}

export async function runPublicDemoScenario(options: PublicDemoScenarioOptions): Promise<void> {
  const demo = await loadPublicDemoModule();
  const stateDirectory = await mkdtemp(join(tmpdir(), "vrata-public-demo-e2e-"));
  const stateFile = join(stateDirectory, "private-state.json");
  const cleanupRecord = demo.publicDemoCleanupRecordPath(stateFile);
  const contexts: BrowserContext[] = [];
  const clients: DemoClient[] = [];
  const environment = options.staging ? "staging" : "local";
  let phase = "seed";
  let primaryError: unknown;
  let cleanupFailed = false;
  const setPhase = (next: string) => {
    phase = next;
    console.log(`public-demo:${environment}:${next}`);
  };

  if (!options.staging) {
    options.testInfo.annotations.push({
      type: "voice-acceptance",
      description: "Not assessed: the local reference fixture has no LiveKit media service."
    });
  }

  try {
    await demo.seedPublicDemo({
      baseUrl: options.origin,
      stateFile,
      adminToken: options.adminToken,
      inviteTtlSeconds: 3_600,
      timeoutMs: requestTimeoutMs,
      onCleanupRecord: (record: JsonRecord) => {
        console.log(`public-demo:planned:${JSON.stringify({ runId: record.runId, origin: record.origin, tenantId: record.tenantId, roomId: record.roomId, planned: record.planned })}`);
      }
    });
    const state = await demo.readPublicDemoState(stateFile);
    const roomId = state.roomId as string;
    const hostInvite = state.resources.invites.find((invite: JsonRecord) => invite.role === "host")?.inviteLink;
    const memberInvites = state.resources.invites.filter((invite: JsonRecord) => invite.role === "member").map((invite: JsonRecord) => invite.inviteLink);
    const guestInvite = state.resources.invites.find((invite: JsonRecord) => invite.role === "guest")?.inviteLink;
    if (typeof hostInvite !== "string" || memberInvites.length !== 2 || memberInvites.some((link: unknown) => typeof link !== "string") || typeof guestInvite !== "string") {
      throw new Error("public_demo_seeded_invites_invalid");
    }
    const negativeInvites = await supplementalInvites(options.origin, options.adminToken, roomId);
    const invalidInviteLink = new URL(`/rooms/${roomId}`, options.origin);
    invalidInviteLink.searchParams.set("invite", "invalid-public-demo-invite-token");

    setPhase("access-denials");
    await expectStateTokenDenied(options.origin, roomId, {}, "invite_required", "public_demo_direct_room_denial");
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(invalidInviteLink.href) }, "invite_required", "public_demo_invalid_invite_denial");
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(negativeInvites.expiredLink) }, "invite_expired", "public_demo_expired_invite_denial");
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(negativeInvites.revokedLink) }, "invite_revoked", "public_demo_revoked_invite_denial");
    const requestedHost = await requestStateToken(options.origin, roomId, {
      inviteToken: inviteToken(guestInvite),
      requestedRole: "host"
    }, "public_demo_guest_role_query_server_check");
    requireStatus(requestedHost.status, 200, "public_demo_guest_role_query_server_check");
    assertTrustedSession(requestedHost.data, "guest");

    const deniedContext = await createTrackedContext(options.browser);
    contexts.push(deniedContext);
    const deniedPage = await deniedContext.newPage();
    await expectDirectRoomBrowserDenied(deniedPage, options.origin, roomId);
    await expectInviteBrowserDenied(deniedPage, invalidInviteLink.href, "Invalid Demo Invite", "Access denied: private invite required");
    await expectInviteBrowserDenied(deniedPage, negativeInvites.expiredLink, "Expired Demo Invite", "Access denied: invite link expired");
    await expectInviteBrowserDenied(deniedPage, negativeInvites.revokedLink, "Revoked Demo Invite", "Access denied: invite link revoked");
    await deniedContext.close();
    contexts.pop();
    for (let index = 0; index < 4; index += 1) contexts.push(await createTrackedContext(options.browser));

    setPhase("four-participant-join");
    let hostPage = await contexts[0]!.newPage();
    const host = await joinClientPage({
      context: contexts[0]!, page: hostPage, role: "host", inviteLink: hostInvite,
      displayName: "Public Demo Host", audioMock: options.staging, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(host);
    console.log(`public-demo:${environment}:host-joined`);
    let firstMemberPage = await contexts[1]!.newPage();
    const firstMember = await joinClientPage({
      context: contexts[1]!, page: firstMemberPage, role: "member", inviteLink: memberInvites[0] as string,
      displayName: "Public Demo Member One", audioMock: options.staging, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(firstMember);
    console.log(`public-demo:${environment}:member-one-joined`);
    let secondMemberPage = await contexts[2]!.newPage();
    const secondMember = await joinClientPage({
      context: contexts[2]!, page: secondMemberPage, role: "member", inviteLink: memberInvites[1] as string,
      displayName: "Public Demo Member Two", audioMock: false, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(secondMember);
    console.log(`public-demo:${environment}:member-two-joined`);
    let guestPage = await contexts[3]!.newPage();
    const guest = await joinClientPage({
      context: contexts[3]!, page: guestPage, role: "guest", inviteLink: guestInvite,
      displayName: "Public Demo Guest", audioMock: false, requireDevRoleQueryDisabled: !options.staging
    });
    clients.push(guest);
    console.log(`public-demo:${environment}:guest-joined`);
    if (new Set(clients.map((client) => client.participantId)).size !== 4) throw new Error("public_demo_participant_ids_not_unique");
    await waitForExactPresence(clients);

    setPhase("presentation-page-one");
    await expect(host.page.locator("#documents-panel")).toBeVisible();
    await expect(host.page.locator("#document-select")).toBeEnabled({ timeout: 30_000 });
    await expect(host.page.locator("#document-select")).toHaveValue(state.resources.document.documentId, { timeout: 30_000 });
    await expect(host.page.locator("#media-surface-select")).toHaveValue("debug-main");
    await expect(host.page.locator("#document-surface-button")).toBeEnabled({ timeout: 30_000 });
    await activateButton(host.page, "#document-surface-button");

    setPhase("shared-notes");
    const note = "# Public demo decision\n- Keep the production invite flow.";
    await secondMember.page.bringToFront();
    await expect(secondMember.page.locator("#notes-scope-select")).toHaveValue("shared");
    await expect(secondMember.page.locator("#notes-editor")).toBeEnabled();
    await secondMember.page.locator("#notes-editor").evaluate((editor: HTMLTextAreaElement, value) => {
      editor.value = value;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, note);
    await expect.poll(() => secondMember.page.evaluate(() => ({
      saveState: (window as any).__VRATA_DEBUG__?.notes?.saveState ?? null,
      status: document.querySelector("#notes-status")?.textContent ?? null
    })), {
      timeout: 30_000,
      intervals: corePollIntervals
    }).toEqual({ saveState: "saved", status: "Notes saved" });
    const savedNote = await sessionRequest(options.origin, roomId, secondMember.sessionToken, "/notes/shared", { method: "GET" }, "public_demo_member_note_confirmation");
    requireStatus(savedNote.status, 200, "public_demo_member_note_confirmation");
    if (savedNote.data.note?.content !== note) throw new Error("public_demo_member_note_not_persisted");
    await expect(guest.page.locator("#notes-editor")).toBeDisabled();
    await expect(guest.page.locator("#notes-status")).toContainText("Notes read-only");
    const guestNoteWrite = await sessionRequest(options.origin, roomId, guest.sessionToken, "/notes/shared", {
      method: "PUT",
      body: JSON.stringify({ content: "Guest must not overwrite the shared note." })
    }, "public_demo_guest_note_write");
    requireStatus(guestNoteWrite.status, 403, "public_demo_guest_note_write");

    setPhase("presentation-page-two");
    await waitForPresentation([host], 1);
    await activateButton(host.page, "#presentation-next");
    await waitForPresentation(clients, 2);

    await leaveClient(guest, options.origin, roomId);
    await waitForExactPresence([host, firstMember, secondMember]);
    guest.page = await guest.context.newPage();
    const [, rejoinedGuest] = await Promise.all([
      reloadClientThroughInvite(firstMember),
      joinClientPage(guest)
    ]);
    guest.page = rejoinedGuest.page;
    guest.participantId = rejoinedGuest.participantId;
    guest.sessionToken = rejoinedGuest.sessionToken;
    if (new Set(clients.map((client) => client.participantId)).size !== 4) throw new Error("public_demo_rejoin_participant_ids_not_unique");
    await Promise.all([
      waitForPresentation([firstMember, guest], 2),
      waitForExactPresence(clients)
    ]);
    await expect(firstMember.page.locator("#notes-editor")).toHaveValue(note, { timeout: 15_000 });

    await expect(guest.page.locator("#notes-editor")).toHaveValue(note, { timeout: 15_000 });
    await expect(guest.page.locator("#notes-editor")).toBeDisabled();
    const memberSessionControl = await sessionRequest(options.origin, roomId, firstMember.sessionToken, "/session-control/lock", {
      method: "POST"
    }, "public_demo_member_session_control");
    requireStatus(memberSessionControl.status, 403, "public_demo_member_session_control");
    const guestSessionControl = await sessionRequest(options.origin, roomId, guest.sessionToken, "/session-control/lock", {
      method: "POST"
    }, "public_demo_guest_session_control");
    requireStatus(guestSessionControl.status, 403, "public_demo_guest_session_control");
    await denyGuestPresentationControl(guest, roomId);

    setPhase("presentation-page-three");
    await activateButton(host.page, "#presentation-next");
    await waitForPresentation(clients, 3);

    if (options.staging) {
      setPhase("strict-livekit-audio");
      await runStrictStagingAudio(host, firstMember);
    }

    setPhase("host-lock-unlock-remove");
    await leaveClient(guest, options.origin, roomId);
    setPhase("host-lock-guest-left");
    await waitForExactPresence([host, firstMember, secondMember]);
    await activateButton(host.page, "#lock-room");
    setPhase("host-lock-active");
    await expect.poll(async () => {
      const result = await adminJson(options.origin, options.adminToken, `/api/rooms/${roomId}/session-control`, { method: "GET" }, "public_demo_lock_state");
      return result.status === 200 && Boolean(result.data.state?.lockedAt);
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    await expect(host.page.locator("#host-controls-status")).toContainText("Room locked", { timeout: 120_000 });
    await expectStateTokenDenied(options.origin, roomId, { inviteToken: inviteToken(guest.inviteLink) }, "room_locked", "public_demo_locked_guest_denial");
    setPhase("host-lock-denial-confirmed");
    await activateButton(host.page, "#unlock-room");
    setPhase("host-lock-released");
    await expect.poll(async () => {
      const result = await adminJson(options.origin, options.adminToken, `/api/rooms/${roomId}/session-control`, { method: "GET" }, "public_demo_unlock_state");
      return result.status === 200 && !result.data.state?.lockedAt;
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(true);
    await expect(host.page.locator("#host-controls-status")).toContainText(/Room (unlocked|open)/, { timeout: 120_000 });
    guest.page = await guest.context.newPage();
    const unlockedGuest = await joinClientPage(guest);
    guest.page = unlockedGuest.page;
    guest.participantId = unlockedGuest.participantId;
    guest.sessionToken = unlockedGuest.sessionToken;
    setPhase("host-lock-guest-rejoined");
    await waitForExactPresence(clients);

    await expect.poll(async () => host.page.locator("#host-participant-select").evaluate((select, participantId) =>
      Array.from((select as HTMLSelectElement).options).some((option) => option.value === participantId), guest.participantId), {
      timeout: 30_000,
      intervals: corePollIntervals
    }).toBe(true);
    await host.page.locator("#host-participant-select").selectOption(guest.participantId);
    const removalResponse = host.page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === "POST"
        && new URL(response.url()).pathname === `/api/rooms/${roomId}/participants/${guest.participantId}/remove`;
    }, { timeout: 30_000 });
    await activateButton(host.page, "#remove-participant");
    setPhase("host-remove-dispatched");
    requireStatus((await removalResponse).status(), 200, "public_demo_host_remove_guest");
    await waitForExactPresence([host, firstMember, secondMember]);
    const blockedGuest = await sessionRequest(options.origin, roomId, guest.sessionToken, "/session-control", { method: "GET" }, "public_demo_removed_guest_server_state");
    requireStatus(blockedGuest.status, 200, "public_demo_removed_guest_server_state");
    if (blockedGuest.data.participant?.status !== "blocked" || blockedGuest.data.participant?.reason !== "participant_removed") {
      throw new Error("public_demo_removed_guest_not_blocked_on_server");
    }
    setPhase("host-remove-server-confirmed");
    await guest.page.bringToFront();
    await expect(guest.page.locator("#status-line")).toContainText("Access denied: removed by host", { timeout: 120_000 });
    phase = "completed";
  } catch (error) {
    primaryError = error;
    await attachAllowlistedDiagnostics(options.testInfo, environment, phase, clients).catch(() => undefined);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    try {
      const cleanupInput = await pathExists(stateFile)
        ? stateFile
        : await pathExists(cleanupRecord) ? cleanupRecord : null;
      if (cleanupInput) {
        await demo.cleanupPublicDemo({
          stateFile: cleanupInput,
          baseUrl: options.origin,
          adminToken: options.adminToken,
          timeoutMs: requestTimeoutMs
        });
      }
    } catch {
      cleanupFailed = true;
      if (await pathExists(cleanupRecord)) {
        await attachCleanupRecord(demo, options.testInfo, environment, cleanupRecord).catch(() => undefined);
      }
    } finally {
      if (await pathExists(cleanupRecord)) {
        await attachCleanupRecord(demo, options.testInfo, environment, cleanupRecord).catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  }

  if (primaryError && cleanupFailed) {
    throw new AggregateError([primaryError, new Error("public_demo_cleanup_failed")], "public_demo_scenario_and_cleanup_failed");
  }
  if (primaryError) throw primaryError;
  if (cleanupFailed) throw new Error("public_demo_cleanup_failed");
}
