import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = fileURLToPath(new URL("../", import.meta.url));
// Execute the actual test helpers without launching browsers or importing service entry points.
function loadHelper(relative, overrides = {}, append = "", globals = {}) {
  const filename = resolve(root, relative), module = { exports: {} };
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.startsWith("./")) return loadHelper(resolve(dirname(filename), `${name.replace(/\.js$/, "")}.ts`), overrides, "", globals);
    return createRequire(filename)(name);
  };
  // ESM imports are hoisted even when the source places them below a constant;
  // preserve that behavior when executing a source module as CommonJS here.
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.ES2022, true);
  const imports = source.statements.filter(ts.isImportDeclaration), body = source.statements.filter(statement => !ts.isImportDeclaration(statement));
  const text = [...imports, ...body].map(statement => statement.getFullText(source)).join("\n");
  const output = ts.transpileModule(text + append, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  // Keep the real SDK's plain-object checks in the same realm, without leaking
  // a module's variables. Browser callbacks still run only in Playwright.
  const bindings = { exports: module.exports, module, require: localRequire,
    URL, Buffer, console, process, Error, AggregateError, performance, structuredClone, ...globals };
  vm.compileFunction(output, Object.keys(bindings), { filename })(...Object.values(bindings));
  return module.exports;
}
const { cleanupAll, withCleanup } = loadHelper("tests/e2e/test-cleanup.ts");

test("cleanup attempts observers, every context, author and room even after multiple failures, preserving primary", async () => {
  const primary = new Error("entry_failed"), errors = [new Error("observer_failed"), new Error("context_failed"), new Error("room_failed")];
  const attempted = [];
  await assert.rejects(withCleanup(async () => { throw primary; }, () => [
    async () => { attempted.push("observer"); throw errors[0]; },
    async () => { attempted.push("context1"); throw errors[1]; },
    async () => { attempted.push("context2"); },
    async () => { attempted.push("author"); },
    async () => { attempted.push("room"); throw errors[2]; }
  ]), error => {
    assert(error instanceof AggregateError); assert.equal(error.cause, primary);
    assert.deepEqual(Array.from(error.errors), [primary, ...errors]); return true;
  });
  assert.deepEqual(attempted, ["observer", "context1", "context2", "author", "room"]);
});

test("cleanup preserves primary alone, propagates cleanup-only failure and retains successful result", async () => {
  const primary = new Error("primary");
  await assert.rejects(withCleanup(async () => { throw primary; }, () => [async () => {}]), error => error === primary);
  await assert.rejects(cleanupAll([async () => { throw primary; }]), error => error instanceof AggregateError && error.errors[0] === primary);
  assert.equal(await withCleanup(async () => 42, () => [async () => {}]), 42);
});

function entryFixture(failAt, cleanupFails = false) {
  const primary = new Error(`${failAt}_failed`), cleanup = new Error("close_failed");
  const calls = { closed: 0, deleted: 0 };
  const actualExpect = require("@playwright/test").expect;
  const expect = value => actualExpect(value);
  expect.poll = fn => ({ async toBe(value) {
    if (failAt === "scene") throw primary;
    actualExpect(await fn()).toBe(value);
  } });
  let evaluations = 0;
  const page = {
    on() {},
    waitForResponse: () => failAt === "admission" ? Promise.reject(primary) : Promise.resolve({ json: async () => ({ participantId: "member" }) }),
    goto: async () => { if (failAt === "navigation") throw primary; },
    locator: () => ({ fill: async () => {}, click: async () => {} }),
    evaluate: async () => failAt === "success" && ++evaluations === 1 ? "loaded" : true
  };
  const context = { newPage: async () => { if (failAt === "newPage") throw primary; return page; },
    close: async () => { calls.closed++; if (cleanupFails) throw cleanup; } };
  const helper = loadHelper("tests/e2e/room-plugin-fixture.ts", {
    "@playwright/test": { expect },
    "./reference-template-fixture": {},
    "./functional-frame-budget": { installFunctionalFrameBudget: async () => {} },
    "./meeting-tools-acceptance": { installMeetingPerformanceObservation: async () => {} },
    "./plugin-author-scenarios": { privateHttp: async (_origin, path, method) => {
      if (method === "DELETE") { calls.deleted++; return { status: 200 }; }
      return { status: 201, json: () => path === "/api/rooms" ? { roomId: "owned" } : { inviteLink: "https://example.invalid/?invite=synthetic" } };
    } }
  });
  return { ...helper, calls, primary, cleanup, browser: { newContext: async () => context }, value: { origin: "https://example.invalid", adminToken: "synthetic" },
    prepare: async () => { if (failAt === "prepare") throw primary; } };
}
for (const stage of ["newPage", "prepare", "navigation", "admission", "scene"]) {
  test(`enterPluginRoom closes its unreturned context after ${stage} failure`, async () => {
    const fixture = entryFixture(stage);
    await assert.rejects(fixture.enterPluginRoom(fixture.browser, fixture.value, "owned", "member", "Member", fixture.prepare),
      error => stage === "navigation" ? error.message === "owned_plugin_runtime_navigation_failed" : error === fixture.primary);
    assert.equal(fixture.calls.closed, 1);
  });
}
test("owned room deletion is attempted despite entry AND context-close failure; both errors survive", async () => {
  const fixture = entryFixture("newPage", true);
  await assert.rejects(fixture.enterOwnedPluginRoom(fixture.browser, fixture.value), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(Array.from(error.errors), [fixture.primary, fixture.cleanup]); return true;
  });
  assert.deepEqual(fixture.calls, { closed: 1, deleted: 1 });
});
test("closing a returned owned actor deletes its room even when closing the context fails", async () => {
  const fixture = entryFixture("success", true);
  const actor = await fixture.enterOwnedPluginRoom(fixture.browser, fixture.value);
  await assert.rejects(actor.close(), error => error instanceof AggregateError && error.errors[0] === fixture.cleanup);
  assert.deepEqual(fixture.calls, { closed: 1, deleted: 1 });
});

async function observationFixture() {
  const { captureRoomAuthority, expectExactRoomAuthority } = loadHelper("tests/e2e/room-state-observation.ts");
  const cdp = new EventEmitter(); cdp.send = async () => ({}); cdp.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => cdp }), isClosed: () => false,
    evaluate: async () => true };
  const capture = await captureRoomAuthority(page);
  const created = requestId => cdp.emit("Network.webSocketCreated", { requestId,
    url: "ws://example.invalid?roomId=owned&participantId=member&accessToken=synthetic" });
  const closed = requestId => cdp.emit("Network.webSocketClosed", { requestId });
  const frame = (requestId, payload) => cdp.emit("Network.webSocketFrameReceived", { requestId,
    response: { opcode: 1, payloadData: JSON.stringify(payload) } });
  const snapshot = (requestId, clientTimeMs = 0, mediaObjects = {}) => frame(requestId, { type: "room_state", room: {
    participants: [{ participantId: "member", clientTimeMs }], seatOccupancy: {}, mediaObjects } });
  return { capture, page, cdp, created, closed, frame, snapshot, expectExactRoomAuthority };
}

test("closed/overlapping socket snapshots never satisfy reconnect before a new connection snapshot", async () => {
  const f = await observationFixture();
  await withCleanup(async () => {
    f.created("old"); f.snapshot("old");
    const before = f.capture.snapshot();
    f.snapshot("old"); f.closed("old");
    assert.equal(f.capture.snapshot(), null);
    f.created("new"); f.snapshot("old");
    assert(f.capture.received() > 1 && f.capture.connections() > 1); // The former false-positive witness.
    assert.equal(f.capture.snapshot(), null);
    await assert.rejects(f.expectExactRoomAuthority([{ page: f.page, participantId: "member", authority: f.capture }], 25));
    f.snapshot("new"); const current = f.capture.snapshot();
    assert(current.generation > before.generation); assert.notEqual(current.socketScope, before.socketScope); assert(current.sequence > 0);
    await f.expectExactRoomAuthority([{ page: f.page, participantId: "member", authority: f.capture }], 100);
    f.created("overlapping"); f.snapshot("new"); assert.equal(f.capture.snapshot(), null);
    f.snapshot("overlapping"); f.closed("new"); assert.equal(f.capture.snapshot().generation, 3);
  }, () => [() => f.capture.close()]);
  assert.equal(f.cdp.listenerCount("Network.webSocketFrameReceived"), 0);
});

test("unchanged-media barrier requires the exact post-denial presence marker on a live current connection", async () => {
  const f = await observationFixture();
  await withCleanup(async () => {
    f.created("old"); f.snapshot("old");
    const before = f.capture.snapshot();
    const barrier = f.capture.watchParticipantBarrier("member", 123456);
    assert.equal(barrier.snapshot(), null); // Cached identical bytes cannot pass.
    f.snapshot("old", 123455); assert.equal(barrier.snapshot(), null);
    f.snapshot("old", 123456); assert.equal(barrier.snapshot().mediaHash, before.mediaHash);
    assert(barrier.snapshot().sequence > before.sequence);
    f.closed("old"); assert.equal(barrier.snapshot(), null);
    f.created("new"); f.snapshot("old", 123456); assert.equal(barrier.snapshot(), null);
    f.snapshot("new", 123456, { changed: true }); assert.notEqual(barrier.snapshot().mediaHash, before.mediaHash);
    barrier.close(); assert.equal(barrier.snapshot(), null);
  }, () => [() => f.capture.close()]);
});

test("existing-socket control enables its own CDP Page domain before registering the persistent script", async () => {
  const { installExistingSocketControl } = loadHelper("tests/e2e/room-state-observation.ts");
  const calls = [];
  const cdp = { async send(method) { calls.push(method); return { identifier: "owned-script" }; }, async detach() { calls.push("detach"); } };
  const page = { context: () => ({ newCDPSession: async () => cdp }), isClosed: () => false,
    evaluate: async () => { calls.push("cleanup"); } };
  const close = await installExistingSocketControl(page);
  assert.deepEqual(calls, ["Page.enable", "Page.addScriptToEvaluateOnNewDocument"]);
  await close();
  assert.deepEqual(calls.slice(2), ["cleanup", "Page.removeScriptToEvaluateOnNewDocument", "detach"]);
});

async function socketControlFixture() {
  const { installExistingSocketControl } = loadHelper("tests/e2e/room-state-observation.ts");
  const sockets = [];
  class Native {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closes = 0; sockets.push(this); }
    close() { this.closes++; this.readyState = 3; }
    send(bytes) { this.sent.push(JSON.parse(bytes)); }
  }
  const window = { WebSocket: Native };
  const cdp = { async send(method, input) {
    if (method === "Page.addScriptToEvaluateOnNewDocument") vm.runInNewContext(input.source, { window, URL });
    return { identifier: "owned-script" };
  }, async detach() {} };
  const page = { context: () => ({ newCDPSession: async () => cdp }), isClosed: () => false,
    evaluate: async () => window.__t16SocketCleanup() };
  const cleanup = await installExistingSocketControl(page);
  return { window, Native, sockets, cleanup };
}

test("held OLD socket survives only voluntary client close, commands never switch to the runtime replacement, release restores retirement", async () => {
  const f = await socketControlFixture();
  await withCleanup(async () => {
    const old = new f.window.WebSocket("ws://example.invalid/?roomId=owned");
    f.window.__t16HoldSocket();
    assert.throws(() => f.window.__t16HoldSocket(), /already_held/);
    old.close(); // applyAccessDebug voluntarily retires this transport on a role change.
    const current = new f.window.WebSocket("ws://example.invalid/?roomId=owned");
    assert.equal(f.sockets.length, 2, "only the runtime constructs a replacement; holding never opens one");
    assert.equal(f.window.__t16SocketCommand({ commandId: "t16-old-command" }), "sent");
    assert.equal(old.sent.length, 1); assert.equal(current.sent.length, 0); assert.equal(old.closes, 0);
    f.window.__t16ReleaseSocket();
    assert.equal(old.closes, 1); assert.equal(old.readyState, 3); assert.equal(Object.hasOwn(old, "close"), false);
    current.close(); assert.equal(current.closes, 1, "nonheld client transports close normally");
  }, () => [f.cleanup]);
  assert.equal(f.window.WebSocket, f.Native); assert.equal(f.window.__t16HoldSocket, undefined);
});

test("server closure is not suppressed and failed-test cleanup completes deferred client close", async () => {
  const f = await socketControlFixture();
  const old = new f.window.WebSocket("ws://example.invalid/?roomId=owned");
  f.window.__t16HoldSocket(); old.close();
  f.Native.prototype.close.call(old); // A server close is not a call to the intercepted client method.
  assert.equal(f.window.__t16SocketCommand({ commandId: "t16-closed-command" }), "closed");
  assert.equal(old.sent.length, 0);
  const primary = new Error("owned_failure");
  await assert.rejects(withCleanup(async () => { throw primary; }, () => [f.cleanup]), error => error === primary);
  assert.equal(Object.hasOwn(old, "close"), false); assert.equal(f.window.WebSocket, f.Native);
  assert.equal(f.window.__t16ReleaseSocket, undefined);
});

test("pending startup has its own bound after normal entry; response observation cannot start without an outgoing claim", async () => {
  let completeEntry;
  const entering = new Promise(resolve => { completeEntry = resolve; });
  const sentinel = new Error("stop_after_claim_observation"), polls = [];
  const expect = { poll(_callback, options) {
    polls.push(options);
    return { async toBe() { throw sentinel; } };
  } };
  const helper = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "@playwright/test": { expect },
    "./plugin-author-scenarios": {}, "./room-plugin-fixture": { enterPluginRoom: () => entering },
    "./room-state-observation": {}, "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { disablePendingClaim };\n");
  const result = helper.disablePendingClaim({}, {}, "owned", async () => {}, [], new Map(), async () => {});
  void result.catch(() => undefined);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(polls.length, 0, "claim observation cannot consume its deadline during onboarding or scene loading");
  completeEntry({ page: { evaluate: async () => ({ synthetic: true }) }, context: { close: async () => {} } });
  await assert.rejects(result, error => error === sentinel);
  assert.equal(polls.length, 1);
  assert.equal(polls[0].timeout, 60000, "startup is separately bounded, not charged to the response window");
  assert.deepEqual(Array.from(polls[0].intervals), [50]);
});

test("local and published pending wrappers execute the same exported scenario without a skip", async () => {
  const pending = [], fixture = { origin: "https://example.invalid", adminToken: "synthetic", close: async () => {} };
  for (const published of [false, true]) {
    const cases = [];
    const test = (name, run) => cases.push({ name, run });
    test.use = () => {}; test.setTimeout = () => {}; test.skip = () => assert.fail("mandatory case cannot skip");
    loadHelper(`tests/e2e/room-plugin-auto-seat${published ? "-staging" : ""}.spec.ts`, {
      "@playwright/test": { test },
      "./plugin-author-scenarios": {}, "./room-plugin-fixture": { startRoomPluginFixture: async protocol => { assert.equal(protocol, 2); return fixture; } },
      "./room-plugin-auto-seat-scenarios": { runPendingAutoSeatScenario: async (browser, value) => pending.push({ browser, value }) },
      "./room-plugin-no-anchor-fixture": {}, "./public-demo-scenarios": { assertExactActivePublicDemoCatalog: async origin => assert.equal(origin, fixture.origin) }
    }, "", { process: { env: { BASE_URL: fixture.origin, STAGING_ADMIN_TOKEN: fixture.adminToken, VRATA_REFERENCE_CATALOG_ACTIVE: "1" } } });
    const selected = cases.filter(row => row.name.includes("pending retirement"));
    assert.equal(selected.length, 1); assert.equal(selected[0].name.includes("@staging-extended"), published);
    await selected[0].run({ browser: "same-browser" });
  }
  assert.equal(pending.length, 2);
  assert(pending.every(row => row.browser === "same-browser" && row.value.origin === fixture.origin && row.value.adminToken === fixture.adminToken));
});

test("shared auto-seat setup closes its Host renderer before the scenario and uses only the ordinary admitted session for CAS", async () => {
  const calls = [], host = { roomId: "owned", session: { token: "ordinary-session" },
    context: { close: async () => calls.push("host-renderer-closed") } };
  const helper = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "./plugin-author-scenarios": { downloadPublicSdk: async () => ({}), createExternalAuthorProject: async () => ({
      buildAutoSeat: async () => { calls.push("external-build"); return {}; }, assertNotExecuted: async () => {}, close: async () => calls.push("author-closed")
    }), bearer: token => ({ authorization: `Bearer ${token}` }), pluginPath: (_room, path) => path,
    privateHttp: async (_origin, path, method, headers, body) => {
      assert.deepEqual(headers, { authorization: "Bearer ordinary-session" });
      assert.equal(Object.hasOwn(headers, "x-vrata-admin-token"), false);
      if (method === "GET") return { status: 200, json: () => ({ revision: 0 }) };
      assert.equal(path, "bindings/external.auto-seat"); assert.equal(body.expectedRevision, body.enabled ? 0 : 1);
      calls.push(body.enabled ? "enable" : "disable");
      return { status: 200, json: () => ({ revision: body.enabled ? 1 : 2 }) };
    } },
    "./room-plugin-fixture": { enterOwnedPluginRoom: async () => host, useOwnedActor: async (_host, run) => run(),
      installPluginArtifact: async () => ({ pluginId: "external.auto-seat" }) },
    "./room-state-observation": {}, "./room-seat-protocol-race": {}, "./staging-identity": { identityProtocolAt: async () => 2 }, "./scene-bundle-fixtures": {}
  }, "\nexport { withAutoSeatRoom };\n");
  await helper.withAutoSeatRoom({}, {}, async (_roomId, put) => {
    assert.deepEqual(calls, ["external-build", "enable", "host-renderer-closed"]);
    await put(false);
  });
  assert.deepEqual(calls, ["external-build", "enable", "host-renderer-closed", "disable", "author-closed"]);
});

test("public-demo stale write projects the read DTO into valid PUT fields and reaches real CAS without changing state", async () => {
  const { staleBindingUpdate } = loadHelper("tests/e2e/public-demo-plugins.ts", {
    "./plugin-author-scenarios": {}, "./plugin-author-ui": {}, "./room-plugin-fixture": {},
    "./meeting-tools-acceptance": {}, "./room-state-observation": {}
  }, "\nexport { staleBindingUpdate };\n");
  const contracts = loadHelper("apps/api/src/plugins/contracts.ts");
  const policy = loadHelper("apps/api/src/plugins/policy.ts");
  const deps = { "./contracts.js": contracts, "./policy.js": policy };
  const { parseRoomPluginBindingHttpBody } = loadHelper("apps/api/src/plugins/http-dto.ts", deps);
  const { createRoomPluginStorage } = loadHelper("apps/api/src/plugins/storage.ts", deps);
  const readBinding = { bindingId: "22222222-2222-4222-8222-222222222222", pluginId: "external.demo", generation: 2, bindingRevision: 2,
    packageId: "11111111-1111-4111-8111-111111111111", version: "1.0.1", artifactSha256: "a".repeat(64), enabled: true,
    config: { greeting: "Public demo" }, approvedCapabilities: ["status.set", "seating.cancelPendingOwnClaim"] };
  const bytes = value => Buffer.from(JSON.stringify(value));
  const beforeRead = JSON.stringify(readBinding);
  assert.throws(() => parseRoomPluginBindingHttpBody(bytes({ ...readBinding, expectedRevision: 1,
    config: { greeting: "stale" }, approvedCapabilities: ["status.set"] })), error => error.code === "plugin_invalid_binding");
  const body = staleBindingUpdate(readBinding);
  const parsed = parseRoomPluginBindingHttpBody(bytes(body));
  assert.equal(parsed.expectedRevision, 1);
  assert.equal(parsed.input.packageId, readBinding.packageId);
  assert.equal(parsed.input.config.greeting, "stale");
  for (const field of ["bindingId", "pluginId", "generation", "bindingRevision"]) {
    assert.throws(() => parseRoomPluginBindingHttpBody(bytes({ ...body, [field]: readBinding[field] })),
      error => error.code === "plugin_invalid_binding", `read-only ${field} must not sneak back into the stale probe`);
  }
  let transactions = 0;
  const state = { revision: 2, deleting: false }, beforeState = JSON.stringify(state);
  const storage = createRoomPluginStorage({ async transaction(_scope, operation) {
    transactions++;
    return operation({ state, getPackage() { assert.fail("stale CAS must fail before package mutation"); } });
  } });
  await assert.rejects(storage.putBinding({ tenantId: "owned", roomId: "owned" }, readBinding.pluginId, parsed.input, parsed.expectedRevision),
    error => error.code === "plugin_revision_conflict");
  assert.equal(transactions, 1, "the corrected request really reaches CAS, not the parser's 400 path");
  assert.equal(JSON.stringify(state), beforeState);
  assert.equal(JSON.stringify(readBinding), beforeRead);
});

for (const [startupAt, releaseDelta] of [[16_000, 1200], [100, 3200], [21_050, 1200]]) test(`controlled pending-disable starts response at claim ${startupAt}ms, keeps release fence ${releaseDelta}ms and cleans its listener`, async () => {
  let now = 1, fromClient, fromServer, closed = 0;
  let installed = false, pendingReads = 0, entered = false, discoveryContinued = false, mutationCommitted = false;
  const polls = [], actualExpect = require("@playwright/test").expect;
  const expect = value => actualExpect(value);
  expect.poll = (callback, options) => {
    polls.push({ at: now, entered, ...structuredClone(options) });
    return actualExpect.poll(callback, options);
  };
  let runtimeRoute, pendingRefresh, refreshContinued = 0;
  const afterFence = new Error("positive_control_reached_intermediate_pose");
  const logs = [], page = new EventEmitter(), context = { close: async () => { closed++; } };
  page.context = () => context; page.isClosed = () => false;
  page.addInitScript = async () => { installed = true; };
  page.evaluate = async callback => {
    if (callback.toString().includes("localPose")) throw afterFence;
    if (callback.toString().includes("readyDeliveries")) return { revision: 9, lastInstanceFailure: null, readyDeliveries: [], pendingBeforeSend: true, releaseDeltaMs: releaseDelta,
      startup: { ready: true, correlation: true, online: true, firstReadyAtMs: 10, openedAtMs: startupAt - 20, claimAtMs: startupAt },
      entry: { joinClicks: [{ trusted: true }], admissionStarts: [1], discovery: [{ status: 200 }] },
      seating: { settlements: [{ reason: "retired" }] } };
    if (!callback.toString().includes("__VRATA_DEBUG__")) return;
    pendingReads++;
    return { participantId: "private-participant", pendingSeatId: "seat-01", currentSeatId: null, running: 0 };
  };
  const server = { onMessage(callback) { fromServer = callback; }, send(message) {
    if (JSON.parse(message).type !== "seat_claim") return;
    assert.equal(pendingReads, 0, "the page captured pending before send; no extra Node/page poll may delay upstream acceptance");
    pendingRefresh = runtimeRoute({ async continue() {
      assert.equal(mutationCommitted, true, "pending refresh must read the real post-CAS state, not race an enabled read");
      refreshContinued++;
    }, fulfill() { assert.fail("never fabricate runtime discovery"); } });
    assert.equal(refreshContinued, 0);
    fromServer(JSON.stringify({ type: "room_state", room: { seatOccupancy: { "seat-01": "private-participant" } } }));
    now = startupAt + 20; fromServer(JSON.stringify({ type: "seat_claim_result", seatClaimResult: { commandId: claimId, accepted: true } }));
  } };
  const socket = { connectToServer: () => server, onMessage(callback) { fromClient = callback; }, send() {}, close() {} };
  page.routeWebSocket = async (_match, handler) => handler(socket);
  page.route = async (_match, handler) => {
    runtimeRoute = handler;
  };
  const roomId = "private-owned-room", claimId = "plugin-seat:private-claim", releaseId = "plugin-release:private-release";
  const helper = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "@playwright/test": { expect },
    "./plugin-author-scenarios": { pluginPath: (room, suffix) => `/api/rooms/${room}/plugins/${suffix}` },
    "./room-plugin-fixture": { async enterPluginRoom(_browser, _value, _room, _role, _name, prepare) {
      await prepare(context, page);
      assert.equal(installed, true, "delivery observation is installed before navigation and the first claim");
       assert.equal(discoveryContinued, false);
       await runtimeRoute({ async continue() { discoveryContinued = true; }, fulfill() { assert.fail("no discovery substitution"); } });
       assert.equal(discoveryContinued, true, "startup discovery is not held until entryComplete");
       now = startupAt; fromClient(JSON.stringify({ type: "seat_claim", commandId: claimId, seatId: "seat-01" }));
       entered = true; return { page, context, session: { participantId: "private-participant" } };
    } },
    "./room-state-observation": {}, "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { disablePendingClaim };\n", { performance: { now: () => now }, console: { info: (...args) => logs.push(args), warn() {} } });
  const put = async enabled => {
    assert.equal(enabled, false); assert.equal(pendingReads, 0);
    assert.equal(now, startupAt + 20, "Host PUT begins in the real accepted callback, without poll/UI/read overhead");
    now = startupAt + releaseDelta - 50;
    page.emit("requestfinished", { url: () => `https://example.invalid/api/rooms/${roomId}/plugins/runtime`,
      response: async () => ({ status: () => 200, json: async () => ({ revision: 9, bindings: [], token: "must-not-log", config: { private: "must-not-log" } }) }) });
    mutationCommitted = true;
    now = startupAt + releaseDelta; fromClient(JSON.stringify({ type: "seat_release", commandId: releaseId }));
     now += 20; fromServer(JSON.stringify({ type: "seat_release_result", seatReleaseResult: { commandId: releaseId } }));
     return 9;
  };
  const observations = new Map();
   await assert.rejects(helper.disablePendingClaim({}, {}, roomId, put, [], observations, async () => ({})),
     error => releaseDelta < 3000 && startupAt < 20_000 ? error === afterFence : /Expected: true/.test(error.message),
     "only an early release with proven fresh startup reaches intermediate pose; late release or entry expiry must fail");
  await pendingRefresh; assert.equal(refreshContinued, 1);
  assert.equal(polls[0].at, startupAt); assert.equal(polls[0].entered, false, "response window starts at outgoing claim, even before entryComplete");
  assert.equal(polls[0].timeout, 15000); assert.deepEqual(Array.from(polls[0].intervals), [50]);
  assert.equal(polls[1].timeout, 60000);
  assert.equal(page.listenerCount("requestfinished"), 0);
  assert.equal(closed, 2);
  assert.equal(logs.length, 1); assert.equal(logs[0][0], "t16_pending_claim_timing");
  const facts = JSON.parse(logs[0][1]);
  assert.equal(facts.claimCount, 1); assert.equal(facts.releaseCount, 1);
  assert.equal(facts.releaseDeltaMs, releaseDelta);
  assert.equal(facts.phaseOffsetsMs.entryComplete, releaseDelta + 20);
  assert.equal(facts.phaseOffsetsMs.disableRequested, 20);
  assert.equal(facts.phaseOffsetsMs.serverReleaseAck, releaseDelta + 20);
  assert.deepEqual(facts.runtimeReads, [{ offsetMs: releaseDelta - 50, status: 200, revision: 9, enabledBindings: 0 }]);
  for (const privateValue of [roomId, claimId, releaseId, "private-participant", "example.invalid", "must-not-log"]) {
    assert.equal(logs[0][1].includes(privateValue), false);
  }
});

// The VM/network/page boundaries are controlled; cancellation and sticky failure
// come from the actual Controller/SeatAdapter, including real empty refresh.
async function pendingCausalityFixture(earlyFailure = false, lateDiscovery = "complete") {
  const { RoomPluginController } = loadHelper("apps/runtime-web/src/plugins/controller.ts");
  const { RoomPluginSeatAdapter } = loadHelper("apps/runtime-web/src/plugins/seat-adapter.ts");
  const { expectExactRoomAuthority } = loadHelper("tests/e2e/room-state-observation.ts");
  const actualExpect = require("@playwright/test").expect;
  const expect = (...args) => actualExpect(...args);
  // Deterministic single evaluation: an unfinished discovery or unapplied
  // revision must fail, not spend 15s on a fake browser boundary.
  expect.poll = callback => ({ async toBe(value) { await Promise.resolve(); actualExpect(await callback()).toBe(value); },
    async toEqual(value) { await Promise.resolve(); actualExpect(await callback()).toEqual(value); } });
  let now = 10, fromClient, fromServer, runtimeRoute, readyResolve, readyReject, flight;
  let snapshot = { revision: 1, bindings: [] }, enters = 0, intermediateFrames = 0, pendingClosed = 0, lateClosed = 0;
  const commands = [], logs = [], cancelledAt = [], discoveryCalls = [];
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const world = { ready: true, correlation: true, online: true, xr: false, selfId: "pending",
    seats: [{ id: "seat-01", yaw: 0 }], occupancy: {}, currentSeatId: null, pendingSeatId: null };
  const sendClient = payload => { commands.push({ ...payload }); fromClient(JSON.stringify(payload)); };
  const sendServer = payload => {
    const inner = payload.seatClaimResult ?? payload.seatReleaseResult;
    if (inner) commands.push({ type: payload.type, ...inner });
    fromServer(JSON.stringify(payload));
  };
  const adapter = new RoomPluginSeatAdapter({ world: () => world, optedOut: () => false, clock: () => now, random: () => "alias",
    claim(seatId, commandId) {
      world.pendingSeatId = seatId;
      const seating = adapter.diagnostics();
      Object.assign(window.__t16SeatDelivery, { pendingBeforeSend: true, startup: { ready: true, correlation: true, online: true,
        firstReadyAtMs: seating.firstReadyAtMs, openedAtMs: seating.openedAtMs, claimAtMs: now } });
      sendClient({ type: "seat_claim", commandId, seatId });
    },
    cancel(commandId) {
      cancelledAt.push(now); world.pendingSeatId = null;
      window.__t16SeatDelivery.releaseDeltaMs = now - 100;
      sendClient({ type: "seat_release", commandId, seatId: "seat-01" });
      sendServer({ type: "room_state", room: { seatOccupancy: {} } });
      sendServer({ type: "seat_release_result", seatReleaseResult: { commandId } }); return true;
    } });
  const controller = new RoomPluginController({ apiBaseUrl: "https://example.invalid", roomId: "owned", clock: () => now,
    context: () => ({ active: true, ready: true, online: true, visible: true, connection: "connected" }),
    proof: () => ({ token: "unit-only", deadlineMs: 900_000 }), render() {}, start: async () => assert.fail("VM boundary is already running"),
    timers: { schedule: () => ({}), cancel() {} }, http: { snapshot: async () => snapshot },
    seating: { ready: () => true, supported: () => true, activate: () => adapter.activate(),
      snapshot: (owner, seating) => adapter.snapshot(owner, seating), retire: owner => adapter.retire(owner) } });
  const debug = { participantId: "pending", roomStateConnected: true, remoteParticipants: [], seatOccupancy: {},
    currentSeatId: null, pendingSeatId: null, locomotionMode: "desktop", localPose: { root: { x: 0, y: 0, z: 0 } },
    get plugins() { return { ...controller.diagnostics(), seating: adapter.diagnostics() }; } };
  const window = { __VRATA_DEBUG__: debug, __t16SeatDelivery: { accepted: 0, occupied: 0, released: 0 },
    __t16SeatEntryFacts: () => ({ joinClicks: [{ trusted: true }], admissionStarts: [1], discovery: [{ status: 200 }] }) };
  function pageFor(ownWindow, closed) {
    const context = { close: async () => { closed(); } }, page = new EventEmitter();
    page.context = () => context; page.isClosed = () => false; page.addInitScript = async () => {};
    page.evaluate = async (callback, arg) => vm.runInNewContext(`(${callback.toString()})(arg)`, {
      window: ownWindow, arg, requestAnimationFrame: callback => { intermediateFrames++; callback(0); }, Promise, JSON });
    return { page, context };
  }
  const pending = pageFor(window, () => { pendingClosed++; });
  const lateDebug = { participantId: "late", roomStateConnected: true, remoteParticipants: [], seatOccupancy: {}, currentSeatId: null, pendingSeatId: null,
    plugins: { state: lateDiscovery === "unapplied" ? "off" : "empty", revision: lateDiscovery === "unapplied" ? null : 2,
      instances: 0, running: 0, failed: 0, lastInstanceFailure: null } };
  const late = { ...pageFor({ __VRATA_DEBUG__: lateDebug }, () => { lateClosed++; }),
    session: { participantId: "late" }, requests: { plugin: lateDiscovery === "pending" ? 0 : 1, workers: 0, wasm: 0 } };
  const discoveryTimeout = new Error("late_discovery_unfinished");
  late.page.waitForResponse = (predicate, options) => {
    discoveryCalls.push(options); const response = { url: () => "https://example.invalid/api/rooms/owned/plugins/runtime", status: () => 200,
      json: async () => ({ revision: 2, bindings: [] }) };
    assert.equal(predicate(response), true);
    return lateDiscovery === "pending" ? Promise.reject(discoveryTimeout) : Promise.resolve(response);
  };
  const authority = { commands: () => commands, snapshot: () => ({ participants: ["pending"], occupancy: {}, generation: 1 }) };
  const lateAuthority = { commands: () => [], snapshot: () => ({ participants: ["late"], occupancy: {}, generation: 1 }) };
  const upstream = { onMessage(callback) { fromServer = callback; }, send(bytes) {
    const payload = JSON.parse(bytes); if (payload.type !== "seat_claim") return;
    now = 110;
    sendServer({ type: "room_state", room: { seatOccupancy: { "seat-01": "pending" } } });
    sendServer({ type: "seat_claim_result", seatClaimResult: { commandId: payload.commandId, seatId: "seat-01", accepted: true } });
  } };
  const socket = { connectToServer: () => upstream, onMessage(callback) { fromClient = callback; }, close() {}, send(bytes) {
    const message = JSON.parse(bytes), state = window.__t16SeatDelivery;
    if (message.type === "room_state" && message.room.seatOccupancy["seat-01"]) state.occupied++;
    if (message.type === "seat_claim_result") state.accepted++;
    if (message.type === "seat_release_result") state.released++;
  } };
  pending.page.route = async (_, callback) => { runtimeRoute = callback; };
  pending.page.routeWebSocket = async (_, callback) => callback(socket);
  const helper = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "@playwright/test": { expect }, "./plugin-author-scenarios": { pluginPath: (room, suffix) => `/api/rooms/${room}/plugins/${suffix}` },
    "./room-plugin-fixture": { async enterPluginRoom(_browser, _origin, _room, _role, _name, prepare) {
      if (++enters === 2) { await prepare(late.context, late.page); return late; }
      await prepare(pending.context, pending.page); await runtimeRoute({ continue: async () => {} });
      controller.start(2); await flush();
      const entry = { binding: { bindingId: "binding", approvedCapabilities: ["seating.claimSelfOnEntry"] }, generation: 1,
        key: "unit", state: "running", abort: new AbortController(), starting: false, starts: [], instance: {
          state: "ready", busy: true, terminate() {}, event() { return new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); }
        } };
      controller.entries.set("binding", entry);
      now = 90; controller.notifySeating(entry, false); // Actual ready record and failure callback.
      now = 100; flight = adapter.claim("seat-01", "binding:1");
      return { ...pending, session: { participantId: "pending" } };
    } }, "./room-state-observation": { expectExactRoomAuthority }, "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { disablePendingClaim };\n", { performance: { now: () => now }, console: { info: (...args) => logs.push(args), warn() {} } });
  const put = async () => {
    now = 1100;
    if (earlyFailure) {
      readyReject(new Error("VM lifecycle failed before disable")); await flush();
      assert.deepEqual(adapter.diagnostics().settlements, [{ atMs: 1100, reason: "retired" }]);
      assert.equal(controller.diagnostics().failed, 1);
      assert.equal(controller.diagnostics().readyDeliveries[0].failedAtMs, 1100);
      now = 1200;
    }
    snapshot = { revision: 2, bindings: [] }; controller.kick(); await flush();
    readyResolve(); await flush();
    // Actual empty manifest removes failed entries and clears lastFailure. Only
    // lastInstanceFailure still distinguishes the failure-retirement control.
    assert.equal(controller.diagnostics().state, "empty"); assert.equal(controller.diagnostics().failed, 0);
    assert.equal(controller.diagnostics().lastFailure, null); assert.equal(controller.diagnostics().revision, 2);
    pending.page.emit("requestfinished", { url: () => "https://example.invalid/api/rooms/owned/plugins/runtime",
      response: async () => ({ status: () => 200, json: async () => snapshot }) });
    return 2;
  };
  return { async run() { return helper.disablePendingClaim({}, {}, "owned", put, [], new Map(), async page => page === pending.page ? authority : lateAuthority); },
    close() { controller.stop(); adapter.stop(); },
    facts: () => ({ enters, intermediateFrames, pendingClosed, lateClosed, discoveryCalls, cancelledAt, diagnostics: controller.diagnostics(),
      settlements: adapter.diagnostics().settlements, logs, listeners: pending.page.listenerCount("requestfinished"), flight }) };
}

test("actual helper rejects actual VM failure retirement before disable even after empty refresh hides failed entries", async () => {
  const f = await pendingCausalityFixture(true);
  try {
    await assert.rejects(f.run(), /toBeNull[\s\S]*host-unavailable/);
    const facts = f.facts();
    assert.equal(facts.diagnostics.lastInstanceFailure, "host-unavailable"); assert.equal(facts.diagnostics.failed, 0);
    assert.deepEqual(facts.settlements, [{ atMs: 1100, reason: "retired" }]);
    assert.deepEqual(await facts.flight, { result: "cancelled" });
    assert.equal(facts.enters, 1); assert.equal(facts.intermediateFrames, 0); assert.equal(facts.listeners, 0);
  } finally { f.close(); }
});

for (const discovery of ["complete", "pending", "unapplied"]) test(`actual pending helper requires completed disabled late discovery and accepted empty revision: ${discovery}`, async () => {
  const f = await pendingCausalityFixture(false, discovery);
  try {
    if (discovery === "complete") await f.run();
    else await assert.rejects(f.run(), discovery === "pending" ? /late_discovery_unfinished/ : /Expected/);
    const facts = f.facts();
    assert.equal(facts.enters, 2); assert.equal(facts.intermediateFrames, 4, "both intermediate and final two-RAF checks remain");
    assert.equal(facts.diagnostics.lastInstanceFailure, null); assert.deepEqual(facts.cancelledAt, [1100]);
    assert.equal(facts.discoveryCalls.length, 1); assert.equal(facts.discoveryCalls[0].timeout, 15000);
    assert.equal(facts.listeners, 0); assert.equal(facts.pendingClosed > 0, true);
    if (discovery === "complete") assert.equal(facts.lateClosed, 1);
  } finally { f.close(); }
});

test("preinstalled seat-delivery observer counts only actual correlated replay and restores native methods", async () => {
  const { installSeatDeliveryObservation } = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "./plugin-author-scenarios": {}, "./room-plugin-fixture": {}, "./room-state-observation": {},
    "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { installSeatDeliveryObservation };\n");
  const sent = [], delivered = [];
  let now = 100;
  class Target { dispatchEvent(event) { delivered.push(event); return true; } }
  class Socket extends Target { send(data) { sent.push(data); } }
  class Message { constructor(data) { this.data = JSON.stringify(data); } }
  const originalSend = Socket.prototype.send, originalDispatch = Target.prototype.dispatchEvent;
  const window = { __VRATA_DEBUG__: { participantId: "private-self", pendingSeatId: "seat-01", currentSeatId: null,
    plugins: { seating: { ready: true, correlation: true, online: true, firstReadyAtMs: 10, openedAtMs: 80 } } } };
  await installSeatDeliveryObservation({ addInitScript: async callback => vm.runInNewContext(`(${callback.toString()})()`, {
    window, WebSocket: Socket, EventTarget: Target, MessageEvent: Message, performance: { now: () => now }
  }) });
  const socket = new Socket(), state = window.__t16SeatDelivery;
  const send = message => socket.send(JSON.stringify(message));
  const deliver = message => socket.dispatchEvent(new Message(message));
  try {
    send({ type: "seat_claim", commandId: "plugin-seat:first", seatId: "seat-01" });
     assert.equal(state.pendingBeforeSend, true, "pending and standing were captured before the unchanged send");
     assert.equal(state.startup.claimAtMs, 100); assert.equal(state.startup.firstReadyAtMs, 10);
     window.__VRATA_DEBUG__.plugins.seating.firstReadyAtMs = 999;
     assert.equal(state.startup.firstReadyAtMs, 10, "a later instance cannot repair the saved startup proof");
     send({ type: "seat_claim", commandId: "plugin-seat:unrelated", seatId: "seat-02" });
     now = 1300;
     send({ type: "seat_release", commandId: "plugin-release:first" });
     assert.equal(state.releaseDeltaMs, 1200, "elapsed release is measured at the actual browser sends on one clock");
    assert.equal(sent.length, 3, "all native sends are unchanged");
    assert.equal(state.accepted + state.occupied + state.released, 0, "captured or sent bytes are not delivery");
    deliver({ type: "seat_claim_result", seatClaimResult: { commandId: "plugin-seat:unrelated", accepted: true } });
    deliver({ type: "seat_release_result", seatReleaseResult: { commandId: "plugin-release:other" } });
    assert.equal(state.accepted + state.released, 0);
    deliver({ type: "room_state", room: { seatOccupancy: { "seat-01": "private-self" } } });
    deliver({ type: "seat_claim_result", seatClaimResult: { commandId: "plugin-seat:first", accepted: true } });
    assert.deepEqual([state.accepted, state.occupied, state.released], [1, 1, 0], "intermediate delivery is distinct from the final empty/release");
    deliver({ type: "room_state", room: { seatOccupancy: {} } });
    deliver({ type: "seat_release_result", seatReleaseResult: { commandId: "plugin-release:first" } });
    assert.deepEqual([state.accepted, state.occupied, state.released], [1, 1, 1]);
    assert.equal(delivered.length, 6);
  } finally { window.__t16SeatDeliveryCleanup(); }
  assert.equal(Socket.prototype.send, originalSend); assert.equal(Target.prototype.dispatchEvent, originalDispatch);
  assert.equal(window.__t16SeatDelivery, undefined); assert.equal(window.__t16SeatDeliveryCleanup, undefined);
  await installSeatDeliveryObservation({ addInitScript: async callback => vm.runInNewContext(`(${callback.toString()})()`, {
    window, WebSocket: Socket, EventTarget: Target, MessageEvent: Message, performance: { now: () => 100 }
  }) });
  try {
    window.__VRATA_DEBUG__.pendingSeatId = null;
    socket.send(JSON.stringify({ type: "seat_claim", commandId: "plugin-seat:invalid-pending", seatId: "seat-01" }));
    window.__VRATA_DEBUG__.pendingSeatId = "seat-01";
    assert.equal(window.__t16SeatDelivery.pendingBeforeSend, false, "later pending state cannot repair a missing pre-send witness");
  } finally { window.__t16SeatDeliveryCleanup(); }
});

test("actual Playwright mock keeps native receive distinct from delayed app dispatch on the same page clock", async () => {
  const { installSeatAckObservation } = loadHelper("tests/e2e/seat-ack-observation.ts");
  let now = 0;
  const sockets = [], bindingCalls = [], delivered = [];
  const context = vm.createContext({ URL, Blob, Uint8Array, crypto: require("node:crypto").webcrypto,
    EventTarget, MessageEvent, Event, CloseEvent: Event, performance: { now: () => now }, document: { baseURI: "https://example.invalid/" } });
  // Native classes and their EventTarget methods must all belong to this VM.
  vm.runInContext(`class Target {
    constructor() { this.listeners={}; }
    addEventListener(type, listener) { (this.listeners[type]??=[]).push(listener); }
    dispatchEvent(event) { for(const listener of this.listeners[event.type]??[]) listener.call(this,event); return true; }
  }
  class Native extends Target {
    static OPEN=1; constructor(url) { super(); this.url=url; this.readyState=1; sockets.push(this); }
    get [Symbol.toStringTag]() { return 'WebSocket'; }
    send(data) { this.lastSent=data; }
    get onmessage() { return this.listener; }
    set onmessage(fn) { this.listener=fn; originalAdd.call(this,'message',fn); }
  }
  globalThis.EventTarget=Target; globalThis.WebSocket=Native; globalThis.window=globalThis;
  globalThis.originalAdd=Target.prototype.addEventListener; globalThis.originalDispatch=Target.prototype.dispatchEvent;`, Object.assign(context, { sockets }));
  await installSeatAckObservation({ addInitScript: async callback => vm.runInContext(`(${callback.toString()})()`, context) });
  const pwRoot = dirname(dirname(require.resolve("@playwright/test")));
  const core = createRequire(resolve(pwRoot, "package.json")).resolve("playwright-core/package.json");
  const mockSource = require(resolve(dirname(core), "lib/generated/webSocketMockSource.js")).source;
  context.module = { exports: {} }; context.__pwWebSocketBinding = call => bindingCalls.push(call);
  vm.runInContext(mockSource + "\n(module.exports.inject())(globalThis);", context);
  vm.runInContext(`globalThis.app=new WebSocket('ws://example.invalid/?roomId=private-owned');
    app.addEventListener('message', event=>delivered.push(event.data));`, Object.assign(context, { delivered }));
  const id = bindingCalls[0].id;
  const dispatch = (type, data) => context.__pwWebSocketDispatch({ id, type, ...(data ? { data: { data: JSON.stringify(data), isBase64: false } } : {}) });
  dispatch("ensureOpened"); dispatch("connect");
  const claim = { type: "seat_claim", commandId: "plugin-seat:private-first", seatId: "private-seat" };
  now = 100; context.app.send(JSON.stringify(claim));
  now = 200; dispatch("sendToServer", claim);
  const accepted = { type: "seat_claim_result", seatClaimResult: { commandId: claim.commandId, accepted: true } };
  now = 400; context.originalDispatch.call(sockets[0], new MessageEvent("message", { data: JSON.stringify(accepted) }));
  assert.equal(delivered.length, 0, "native reception is not application delivery");
  now = 3500; dispatch("sendToPage", accepted);
  const facts = JSON.parse(JSON.stringify(context.__t16SeatAckFacts()));
  assert.deepEqual(facts.rows.map(row => [row.phase, row.atMs]), [["outgoing-claim", 100], ["native-send", 200],
    ["native-receive", 400], ["mock-dispatch", 3500], ["app-delivery", 3500], ["app-handler-return", 3500]]);
  assert.equal(delivered.length, 1); assert.equal(facts.nativeSetterObserved, true);
  assert(facts.rows.every(row => row.attempt === 1 && row.current === true));
  for (const secret of [claim.commandId, claim.seatId, "private-owned", "example.invalid"]) assert.equal(JSON.stringify(facts).includes(secret), false);
});

test("four actual normal entry helpers wait at actionable forms, then submit UI without holding post-ready traffic", async () => {
  const actualExpect = require("@playwright/test").expect;
  let release, allPrepared, now = 0;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { allPrepared = resolve; });
  const forms = [], clicks = [], discoveries = [], closed = [];
  const expect = value => ({
    ...actualExpect(value),
    async toHaveValue(name) { assert.equal(value.value, name); },
    async toBeVisible() { assert.equal(value.visible, true); },
    async toBeEnabled() { assert.equal(value.enabled, true); }
  });
  expect.poll = fn => ({ async toBe(value) { actualExpect(await fn()).toBe(value); } });
  const helper = loadHelper("tests/e2e/room-plugin-fixture.ts", {
    "@playwright/test": { expect }, "./reference-template-fixture": {},
    "./functional-frame-budget": { installFunctionalFrameBudget: async () => {} },
    "./meeting-tools-acceptance": { installMeetingPerformanceObservation: async () => {} },
    "./plugin-author-scenarios": { privateHttp: async () => ({ status: 201, json: () => ({ inviteLink: "https://example.invalid/?invite=private" }) }) }
  });
  const browser = { async newContext() {
    const index = forms.length;
    let admitted, evaluations = 0;
    const admission = new Promise(resolve => { admitted = resolve; });
    const input = { value: "", async fill(value) { this.value = value; } };
    const button = { visible: true, enabled: true, async click(options) {
      assert.equal(options.noWaitAfter, true); clicks.push({ index, at: now });
      // Normal application discovery after admission is not gated at all.
      discoveries.push({ index, at: now }); admitted({ json: async () => ({ participantId: `member-${index}` }) });
    } };
    const page = { on() {}, waitForResponse: () => admission,
      async goto(link) { const params = new URL(link).searchParams; assert(params.has("invite") && !params.has("role") && !params.has("onboard")); },
      locator: selector => selector === "#guest-name-input" ? input : button,
      evaluate: async () => ++evaluations === 1 ? "loaded" : true,
      route() { assert.fail("no post-ready discovery interception"); }, routeWebSocket() { assert.fail("native WS must not be routed"); }
    };
    forms.push(page);
    return { newPage: async () => page, close: async () => { closed.push(index); } };
  } };
  const prepared = new Set();
  const entries = [1, 2, 3, 4].map(index => helper.enterPluginRoom(browser, { origin: "https://example.invalid" }, "owned", "member", `Member ${index}`,
    undefined, async page => { prepared.add(page); if (prepared.size === 4) allPrepared(); await gate; }));
  await ready;
  assert.equal(forms.length, 4); assert.equal(clicks.length, 0); assert.equal(discoveries.length, 0);
  now = 25_000; release(); const members = await Promise.all(entries);
  assert.equal(clicks.length, 4); assert.equal(discoveries.length, 4);
  assert(clicks.every(row => row.at === 25_000));
  await Promise.all(members.map(member => member.context.close()));
  assert.equal(new Set(closed).size, 4);
});

test("passive entry phases preserve original fetch/worker delivery and expose no URLs, source or action IDs", async () => {
  const { installSeatEntryObservation } = loadHelper("tests/e2e/seat-entry-observation.ts");
  let now = 0, click;
  const posted = [], deliveries = [], reads = [], resources = [];
  const loading = Promise.resolve({ status: 200 });
  class Worker extends EventTarget { postMessage(...args) { posted.push(args); } }
  const window = { Worker, fetch(...args) { reads.push(args); return loading; } };
  const document = { addEventListener(type, callback, capture) { assert.equal(type, "click"); assert.equal(capture, true); click = callback; } };
  const performance = { now: () => now, timeOrigin: 100_000, getEntriesByName: (url, type) => {
    assert.equal(type, "resource"); return resources.filter(entry => entry.name === url);
  } };
  await installSeatEntryObservation({ addInitScript: async callback => vm.runInNewContext(`(${callback.toString()})()`, {
    window, document, location: { href: "https://example.invalid/" }, performance, URL, Request
  }) });
  now = 25_000; click({ target: { closest: () => true }, isTrusted: true });
  assert.equal(window.fetch("/api/tokens/state"), loading);
  const url = "https://example.invalid/api/rooms/private-room/plugins/runtime", options = { headers: { authorization: "private-proof" } };
  now = 25_100; assert.equal(window.fetch(url, options), loading, "no promise or HTTP hold is introduced");
  now = 25_200; await loading;
  resources.push({ name: url, startTime: 25_100, responseEnd: 25_180 });
  const worker = new window.Worker("https://example.invalid/private-worker", { name: "room-plugin-kernel" });
  worker.addEventListener("message", event => deliveries.push(event.data));
  const init = { type: "init", source: "private-source", config: { secret: "private-config" } };
  worker.postMessage(init, []);
  now = 25_300; const command = { type: "event", id: 23456, event: { type: "room.ready" } };
  worker.postMessage(command, []);
  now = 25_400; worker.dispatchEvent(new MessageEvent("message", { data: { type: "requests", actionId: 23455 } }));
  now = 25_500; worker.dispatchEvent(new MessageEvent("message", { data: { type: "requests", actionId: 23456, requestsJson: "private-requests" } }));
  const facts = JSON.parse(JSON.stringify(window.__t16SeatEntryFacts()));
  assert.deepEqual(facts.joinClicks, [{ atMs: 25_000, trusted: true }]);
  assert.deepEqual(facts.admissionStarts, [25_000]);
  assert.deepEqual(facts.discovery, [{ startMs: 25_100, responseMs: 25_200, status: 200, bodyEndMs: 25_180 }]);
  assert.deepEqual(facts.kernel.map(row => [row.phase, row.atMs]), [["worker-created", 25_200], ["init-dispatch", 25_200],
    ["ready-kernel-dispatch", 25_300], ["ready-handler-request-received", 25_500]]);
  assert.equal(deliveries.length, 2); assert.equal(posted[0][0], init); assert.equal(posted[1][0], command); assert.equal(reads[1][1], options);
  for (const secret of ["example.invalid", "private-room", "private-source", "private-config", "private-proof", "private-requests", "23456"]) {
    assert.equal(JSON.stringify(facts).includes(secret), false);
  }
  facts.kernel.length = 0; assert.equal(window.__t16SeatEntryFacts().kernel.length, 4);
});

test("native-only ACK observer preserves bytes and separates old-socket answers from current generation", async () => {
  const { installSeatAckObservation } = loadHelper("tests/e2e/seat-ack-observation.ts");
  let now = 0;
  const context = vm.createContext({ URL, performance: { now: () => now } });
  vm.runInContext(`class Target {
    constructor() { this.listeners={}; }
    addEventListener(type, fn) { (this.listeners[type]??=[]).push(fn); }
    dispatchEvent(event) { for(const fn of this.listeners[event.type]??[]) fn.call(this,event); return true; }
  }
  class Native extends Target {
    constructor(url) { super(); this.url=url; this.sent=[]; }
    get [Symbol.toStringTag]() { return 'WebSocket'; }
    send(data) { this.sent.push(data); }
  }
  globalThis.EventTarget=Target; globalThis.WebSocket=Native; globalThis.window=globalThis;
  globalThis.originalDispatch=Target.prototype.dispatchEvent;`, context);
  await installSeatAckObservation({ addInitScript: async callback => vm.runInContext(`(${callback.toString()})()`, context) });
  const old = new context.WebSocket("ws://example.invalid/?roomId=private-room");
  let deliveries = 0; old.addEventListener("message", () => { deliveries++; });
  const bytes = JSON.stringify({ type: "seat_claim", commandId: "plugin-seat:private-old", seatId: "private-seat" });
  now = 100; old.send(bytes); assert.deepEqual(Array.from(old.sent), [bytes]);
  const current = new context.WebSocket("ws://example.invalid/?roomId=private-room");
  current.addEventListener("message", () => { deliveries++; });
  now = 150;
  const accepted = { type: "message", data: JSON.stringify({ type: "seat_claim_result", seatClaimResult: { commandId: "plugin-seat:private-old", accepted: true } }) };
  context.originalDispatch.call(current, accepted);
  assert.equal(context.__t16SeatAckFacts().rows.length, 2, "matching ID on wrong socket cannot be attributed to the attempt");
  now = 200; context.originalDispatch.call(old, accepted);
  const facts = JSON.parse(JSON.stringify(context.__t16SeatAckFacts()));
  assert.equal(deliveries, 2, "all app callbacks still execute unchanged");
  assert.deepEqual(facts.rows.slice(2).map(row => [row.phase, row.atMs, row.current]), [
    ["native-receive", 200, false], ["native-app-delivery", 200, false], ["app-handler-return", 200, false]
  ]);
  for (const secret of ["private-room", "private-old", "private-seat", "example.invalid"]) assert.equal(JSON.stringify(facts).includes(secret), false);
});
