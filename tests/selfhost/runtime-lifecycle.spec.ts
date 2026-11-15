import { test, expect, type Browser, type Page, type Request } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createExternalAuthorProject, downloadPublicSdk, nativeMarker, privateHttp, bearer, pluginPath, inviteTokenFromLink, sha256 } from "../e2e/plugin-author-scenarios";
import { uploadThroughUi, chooseVersion, act } from "../e2e/plugin-author-ui";
import { captureRoomAuthority, expectExactRoomAuthority } from "../e2e/room-state-observation";
import { chooseMeetingPanel } from "../e2e/meeting-tools-acceptance";
import { observeFunctionalClient } from "../e2e/functional-diagnostics";

const runtimeSha = "4d5ca28883cffbf08a82112f33a25fca18431164";
const origin = process.env.T17_SELFHOST_ORIGIN!;
const output = process.env.T17_SELFHOST_OUTPUT!;
const adminToken = process.env.VRATA_ADMIN_TOKEN!;
const control = (operation: string) => JSON.parse(execFileSync("/usr/bin/python3", [process.env.T17_SELFHOST_CONTROL!, operation],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }));

test("fresh self-host: standalone public SDK artifact, normal author UI, restart and owned cleanup", async ({ browser }) => {
  const demo = await import(pathToFileURL(resolve("tools/public-demo.mjs")).href);
  const stateFile = join(output, "demo.private.json"), neighbourFile = join(output, "neighbour.private.json");
  const core = { stateFile, baseUrl: origin, adminToken };
  const neighbourCore = { ...core, stateFile: neighbourFile };
  const actors: Awaited<ReturnType<typeof enter>>[] = [];
  const authorHttp: Array<Record<string, unknown>> = [];
  const pendingHttp = new Set<Promise<void>>();
  const runtimeDiagnostics: Array<Record<string, unknown>> = [];
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  const facts: Record<string, unknown> = { runtimeSha, normalSceneAndRender: true, fakeMedia: false, lifecyclePassed: false };
  let primary: unknown;
  try {
    const before = control("continuity");
    expect(before.runtimeSha).toBe(runtimeSha);
    await demo.seedPublicDemo(core);
    await demo.seedPublicDemo(neighbourCore);
    const state = await demo.readPublicDemoState(stateFile), neighbour = await demo.readPublicDemoState(neighbourFile);
    await expect(demo.checkPublicDemo(core)).resolves.toMatchObject({ prepared: true });
    const host = await enter(browser, state, "host"); actors.push(host);
    const guest = await enter(browser, state, "guest"); actors.push(guest);
    await expectExactRoomAuthority([host, guest]);
    for (const actor of actors) expect(await actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins?.running ?? 0)).toBe(0);
    const sdk = await downloadPublicSdk(origin, "0.2.0");
    author = await createExternalAuthorProject(sdk, "0.2.0");
    const pluginId = "external.t17-selfhost";
    const body = (version: string) => `export function init(context: RoomPluginContext) { return context.sdk.status.set(String(context.config.greeting) + " ${version}"); }`;
    const first = await author.build(pluginId, "1.0.0", ["status.set"], body("v1"));
    const second = await author.build(pluginId, "1.0.1", ["status.set", "seating.cancelPendingOwnClaim"], body("v2"));
    const other = await author.build("external.t17-neighbour", "1.0.0", ["status.set"], body("neighbour"));
    facts.artifactHashes = [first, second, other].map(a => ({ version: a.version, artifactSha256: a.artifactSha256, entrySha256: a.entrySha256 }));
    await chooseMeetingPanel(host.page, "people", false);
    await expect(host.page.locator("#room-plugin-author")).toBeVisible();
    const entry = host.page.locator(`[data-plugin-id="${pluginId}"]`);
    let authorRequests = 0, invalidAuthor = false;
    const requestTimes = new WeakMap<Request, { seq: number; started: number; method: string; route: string }>();
    let requestSequence = 0;
    host.page.on("request", request => {
      if (!new URL(request.url()).pathname.includes(`/rooms/${state.roomId}/plugins/`)) return;
      authorRequests++;
      const headers = request.headers();
      invalidAuthor ||= Boolean(headers["x-vrata-admin-token"]) || !headers.authorization?.startsWith("Bearer rs2.");
      const path = new URL(request.url()).pathname, method = request.method();
      const route = method === "PUT" && path.endsWith(`/bindings/${pluginId}`) ? "author-binding"
        : method === "GET" && path.endsWith("/plugins/packages") ? "author-library" : null;
      if (route && requestSequence < 128) requestTimes.set(request, {
        seq: ++requestSequence, started: performance.now(), method, route
      });
    });
    host.page.on("response", response => {
      const timing = requestTimes.get(response.request());
      if (!timing) return;
      const event: Record<string, unknown> = { seq: timing.seq, method: timing.method, route: timing.route,
        event: "response", elapsedMs: Math.round(performance.now() - timing.started), status: response.status(),
        revision: null, error: null };
      authorHttp.push(event);
      const work = (async () => {
        try {
          const length = Number(await response.headerValue("content-length"));
          if (Number.isFinite(length) && length > 512 * 1024) { event.error = "body_too_large"; return; }
          const bytes = await response.body();
          if (bytes.byteLength > 512 * 1024) { event.error = "body_too_large"; return; }
          const body = JSON.parse(bytes.toString("utf8"));
          if (Number.isSafeInteger(body?.revision) && body.revision >= 0) event.revision = body.revision;
          if (typeof body?.error === "string"
            && /^(?:plugin|identity|room_plugin|internal|invalid|service)_[a-z0-9_]{1,70}$/.test(body.error)) event.error = body.error;
        } catch { event.error = "body_unavailable"; }
      })();
      pendingHttp.add(work);
      void work.finally(() => pendingHttp.delete(work));
    });
    host.page.on("requestfailed", request => {
      const timing = requestTimes.get(request);
      if (!timing) return;
      const code = request.failure()?.errorText;
      authorHttp.push({ seq: timing.seq, method: timing.method, route: timing.route, event: "requestfailed",
        elapsedMs: Math.round(performance.now() - timing.started), status: null, revision: null,
        error: code && /^net::ERR_[A-Z0-9_]{1,80}$/.test(code) ? code : "request_failed" });
    });
    const call = (suffix: string, method = "GET", body?: unknown, actor = host) =>
      privateHttp(origin, pluginPath(state.roomId, suffix), method, bearer(actor.sessionToken), body);
    const library = async () => { const r = await call("packages"); expect(r.status).toBe(200); return r.json<any>(); };
    await uploadThroughUi(host.page, first);
    await entry.locator('[data-config-key="greeting"]').fill("Selfhost");
    await entry.locator('[data-capability="status.set"]').check();
    await act(host.page, entry, "enable", "Behavior enabled");
    await status(guest.page, "Selfhost v1");
    await noInstanceFailure(actors);
    expect((await library()).revision).toBe(1);
    const uninterrupted = control("continuity");
    expect(uninterrupted.containers).toEqual(before.containers);
    facts.installWithoutRebuildOrRestart = true;

    await uploadThroughUi(host.page, second);
    await chooseVersion(entry, second.version);
    await expect(entry.locator('[data-capability="seating.cancelPendingOwnClaim"]')).not.toBeChecked();
    await status(guest.page, "Selfhost v1");
    expect((await library()).revision).toBe(1);
    await entry.locator('[data-capability="seating.cancelPendingOwnClaim"]').check();
    await act(host.page, entry, "enable", "Behavior enabled");
    await status(guest.page, "Selfhost v2");
    await noInstanceFailure(actors);
    const installed = await library();
    expect(installed.revision).toBe(2);
    expect(installed.bindings[0].artifactSha256).toBe(second.artifactSha256);
    const stale = await call(`bindings/${pluginId}`, "DELETE", { expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(sha256(Buffer.from(JSON.stringify(await library())))).toBe(sha256(Buffer.from(JSON.stringify(installed))));
    await expect(guest.page.locator("#room-plugin-author")).toBeHidden();
    for (const [suffix, method, body] of [["packages", "GET", undefined], ["packages", "POST", first.bytes],
      [`bindings/${pluginId}`, "DELETE", { expectedRevision: 2 }], [`packages/${installed.packages[0].packageId}`, "DELETE", undefined]] as const) {
      const denied = await call(suffix, method, body, guest);
      expect(denied.status).toBe(403);
      expect(denied.json<any>().error).toBe("plugin_author_forbidden");
    }
    const neighbourInvite = neighbour.resources.invites.find((i: any) => i.role === "host");
    const admission = await privateHttp(origin, "/api/tokens/state", "POST", {}, { identityProtocolVersion: 2,
      roomId: neighbour.roomId, displayName: "T17 neighbour", inviteToken: inviteTokenFromLink(neighbourInvite.inviteLink) });
    expect(admission.status).toBe(200);
    const neighbourToken = admission.json<any>().token;
    const neighbourCall = (suffix: string, method = "GET", body?: unknown, token = neighbourToken) =>
      privateHttp(origin, pluginPath(neighbour.roomId, suffix), method, bearer(token), body);
    const neighbourUpload = await neighbourCall("packages", "POST", other.bytes);
    expect(neighbourUpload.status).toBe(201);
    const neighbourBefore = await neighbourCall("packages");
    expect(neighbourBefore.status).toBe(200);
    expect((await neighbourCall("packages", "GET", undefined, host.sessionToken)).status).toBe(403);

    const restarted = control("restart");
    expect(restarted.runtimeSha).toBe(runtimeSha);
    expect(restarted.apiRestarted).toBe(true);
    await expect(demo.checkPublicDemo(core)).resolves.toMatchObject({ prepared: true });
    expect(await library()).toEqual(installed);
    for (const actor of actors) {
      await actor.page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
      await status(actor.page, "Selfhost v2");
    }
    await expectExactRoomAuthority(actors);
    await noInstanceFailure(actors);
    await chooseMeetingPanel(host.page, "people", false);
    await expect(host.page.locator("#room-plugin-author")).toBeVisible();
    await expect(guest.page.locator("#room-plugin-author")).toBeHidden();
    const content = await call(`packages/${installed.bindings[0].packageId}/content`, "GET", undefined, guest);
    expect(content.status).toBe(200); expect(content.bytes.equals(second.bytes)).toBe(true);
    facts.restartPersistence = true;

    await act(host.page, entry, "disable", "Behavior disabled");
    expect((await library()).revision).toBe(3);
    for (const actor of actors) {
      await expect.poll(() => actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins?.running), { timeout: 15_000 }).toBe(0);
      await expect(actor.page.locator("#room-plugin-status-list")).not.toContainText("Selfhost");
    }
    await noInstanceFailure(actors);
    const disabled = await call("runtime", "GET", undefined, guest);
    expect(disabled.status).toBe(200); expect(disabled.json<any>().bindings).toHaveLength(0);
    expect((await call(`packages/${installed.bindings[0].packageId}/content`, "GET", undefined, guest)).status).toBe(403);
    await act(host.page, entry, "unbind", "Behavior removed from this room");
    expect((await library()).revision).toBe(4);
    for (const version of ["1.0.1", "1.0.0"]) {
      await chooseVersion(entry, version);
      await act(host.page, entry, "delete", "Package version deleted");
    }
    expect((await library()).packages).toHaveLength(0);
    expect((await library()).bindings).toHaveLength(0);
    for (const actor of actors) expect(await actor.page.evaluate(marker => Reflect.has(window, marker), nativeMarker)).toBe(false);
    await author.assertNotExecuted();
    expect(authorRequests > 0 && !invalidAuthor).toBe(true);
    await guest.observation.close(); await guest.authority.close(); await guest.context.close(); actors.splice(actors.indexOf(guest), 1);
    await expectExactRoomAuthority([host]);
    expect(Object.keys(host.authority.snapshot()!.occupancy)).toHaveLength(0);
    await host.observation.close(); await host.authority.close(); await host.context.close(); actors.splice(actors.indexOf(host), 1);
    await demo.cleanupPublicDemo(core);
    await expect(access(stateFile)).rejects.toThrow();
    await expect(demo.cleanupPublicDemo({ ...core, stateFile: demo.publicDemoCleanupRecordPath(stateFile) })).resolves.toMatchObject({ cleaned: true });
    expect((await neighbourCall("packages")).bytes.equals(neighbourBefore.bytes)).toBe(true);
    expect(sha256(await downloadPublicSdk(origin, "0.2.0"))).toBe(sha256(sdk));
    expect((await privateHttp(origin, `/api/rooms/${state.roomId}`, "GET", { "x-vrata-admin-token": adminToken })).status).toBe(404);
    facts.lifecyclePassed = true;
    facts.authorityAndNoGhosts = true;
    facts.neighbourAndSdkPreserved = true;
  } catch (error) { primary = error; }
  finally {
    const failures: unknown[] = [];
    for (const actor of actors) {
      if (primary) {
        try {
          const observation = await actor.observation.snapshot();
          const resources = await actor.page.evaluate(() => performance.getEntriesByType("resource")
            .filter((item): item is PerformanceResourceTiming => item instanceof PerformanceResourceTiming)
            .filter(item => /\/plugins\/(?:runtime|packages\/[^/]+\/content)$/.test(new URL(item.name).pathname))
            .slice(-128).map(item => ({ route: new URL(item.name).pathname.endsWith("/runtime") ? "runtime" : "content",
              startTime: item.startTime, requestStart: item.requestStart, responseStart: item.responseStart,
              responseEnd: item.responseEnd, duration: item.duration, transferSize: item.transferSize })));
          const renderer = await runtimeRenderer(actor.page);
          const client: Record<string, unknown> = { role: actor.role, observation, resources, renderer };
          runtimeDiagnostics.push(client);
          // Read-only, after the original failure: distinguish server/transport
          // latency from a delayed browser event loop. Never retry the author PUT.
          const started = performance.now();
          try {
            const response = await privateHttp(origin, pluginPath(actor.roomId, "runtime"), "GET", bearer(actor.sessionToken));
            const elapsedMs = Math.round(performance.now() - started), body = response.json<any>();
            client.directRuntimeGet = { elapsedMs, status: response.status,
              revision: Number.isSafeInteger(body?.revision) ? body.revision : null,
              leaseExpiresAtMs: Number.isSafeInteger(body?.leaseExpiresAtMs) ? body.leaseExpiresAtMs : null,
              receivedAtMs: Date.now(), bindingCount: Array.isArray(body?.bindings) ? body.bindings.length : null,
              error: typeof body?.error === "string"
                && /^(?:plugin|identity|room_plugin|internal|invalid|service)_[a-z0-9_]{1,70}$/.test(body.error) ? body.error : null };
          } catch (error) {
            client.directRuntimeGet = { elapsedMs: Math.round(performance.now() - started), failed: true,
              error: error instanceof Error ? error.name : "unknown" };
          }
        } catch (error) {
          runtimeDiagnostics.push({ role: actor.role, unavailable: true,
            error: error instanceof Error ? error.name : "unknown" });
        }
      }
      try { await actor.observation.close(); } catch (e) { failures.push(e); }
      try { await actor.authority.close(); } catch (e) { failures.push(e); }
      try { await actor.context.close(); } catch (e) { failures.push(e); }
    }
    try { await author?.close(); } catch (e) { failures.push(e); }
    for (const item of [core, neighbourCore]) {
      const exists = await access(item.stateFile).then(() => true, () => false);
      if (exists) try { await demo.cleanupPublicDemo(item); } catch (e) { failures.push(e); }
    }
    await Promise.allSettled([...pendingHttp]);
    try {
      await writeFile(join(output, "author-http.private.json"),
        JSON.stringify({ schema: 1, events: authorHttp }, null, 2) + "\n", { mode: 0o600 });
      await writeFile(join(output, "runtime-diagnostics.private.json"),
        JSON.stringify({ schema: 1, clients: runtimeDiagnostics }, null, 2) + "\n", { mode: 0o600 });
    } catch (error) { failures.push(error); }
    facts.cleanupPassed = failures.length === 0;
    await writeFile(join(output, "lifecycle-facts.json"), JSON.stringify(facts, null, 2) + "\n", { mode: 0o600 });
    if (primary || failures.length) {
      const details = (error: unknown) => error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
      try {
        await writeFile(join(output, "lifecycle-failure.private.json"), JSON.stringify({
          primary: primary ? details(primary) : null, cleanupFailures: failures.map(details)
        }, null, 2) + "\n", { mode: 0o600 });
      } catch (error) { failures.push(error); }
      throw new AggregateError([...(primary ? [primary] : []), ...failures],
        "t17_selfhost_lifecycle_failed", { cause: primary });
    }
  }
});

async function status(page: Page, text: string) {
  await expect(page.locator("#room-plugin-status-list")).toContainText(text, { timeout: 30_000 });
}

async function noInstanceFailure(actors: Array<{ page: Page }>) {
  for (const actor of actors) {
    expect(await actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins?.lastInstanceFailure ?? null)).toBeNull();
  }
}

async function runtimeRenderer(page: Page) {
  return page.evaluate(() => {
    const gl = document.querySelector("canvas")?.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) as string : null;
  });
}

async function enter(browser: Browser, state: any, role: "host" | "guest") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const authority = await captureRoomAuthority(page);
  const observation = await observeFunctionalClient(page);
  try {
    const inviteLink = state.resources.invites.find((i: any) => i.role === role).inviteLink;
    const url = new URL(inviteLink);
    expect(url.origin).toBe(origin);
    expect(url.searchParams.has("role") || url.searchParams.has("onboard") || url.searchParams.has("debug")).toBe(false);
    await page.goto(inviteLink, { waitUntil: "domcontentloaded" });
    await page.locator("#guest-name-input").fill(`T17 self-host ${role}`);
    const admission = page.waitForResponse(r => new URL(r.url()).pathname === "/api/tokens/state" && r.status() === 200);
    void admission.catch(() => undefined);
    await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
    const session = await (await admission).json();
    expect(session.role).toBe(role); expect(session.token.startsWith("rs2.")).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected), { timeout: 30_000 }).toBe(true);
    const renderer = await runtimeRenderer(page);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    await writeFile(join(output, `renderer-${role}.json`), JSON.stringify({ renderer, viewport }, null, 2) + "\n", { mode: 0o600 });
    expect(renderer, "selfhost_requires_a_verified_hardware_renderer").not.toBeNull();
    expect(renderer!, "selfhost_hardware_rendering_required").not.toMatch(/swiftshader|llvmpipe|software/i);
    expect(viewport).toEqual({ width: 1280, height: 720, dpr: 1 });
    return { context, page, authority, observation, role, roomId: state.roomId as string,
      participantId: session.participantId as string, sessionToken: session.token as string };
  } catch (e) { await observation.close(); await authority.close(); await context.close(); throw e; }
}
