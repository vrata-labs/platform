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
    if (name.startsWith("./")) return loadHelper(resolve(dirname(filename), `${name}.ts`), overrides, "", globals);
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

test("pending-disable claim observation starts only after normal scene/connection entry completes", async () => {
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
  const result = helper.disablePendingClaim({}, {}, "owned", async () => {}, {}, [], new Map(), async () => {});
  void result.catch(() => undefined);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(polls.length, 0, "claim observation cannot consume its deadline during onboarding or scene loading");
  completeEntry({ page: { evaluate: async () => ({ synthetic: true }) }, context: { close: async () => {} } });
  await assert.rejects(result, error => error === sentinel);
  assert.equal(polls.length, 1);
  assert.equal(polls[0].timeout, 15000, "the original claim-observation deadline is unchanged");
  assert.deepEqual(Array.from(polls[0].intervals), [50]);
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

for (const releaseDelta of [1200, 3200]) test(`controlled pending-disable keeps the real release fence at ${releaseDelta}ms and cleans its listener`, async () => {
  let now = 1, fromClient, fromServer, closed = 0;
  let installed = false, pendingReads = 0, entered = false, discoveryContinued = false;
  const afterFence = new Error("positive_control_reached_intermediate_pose");
  const logs = [], page = new EventEmitter(), context = { close: async () => { closed++; } };
  page.context = () => context; page.isClosed = () => false;
  page.addInitScript = async () => { installed = true; };
  page.evaluate = async callback => {
    if (callback.toString().includes("localPose")) throw afterFence;
    if (callback.toString().includes("readyDeliveries")) return { revision: 9, readyDeliveries: [], seating: { settlements: [{ reason: "retired" }] } };
    if (!callback.toString().includes("__VRATA_DEBUG__")) return;
    pendingReads++;
    return { participantId: "private-participant", pendingSeatId: "seat-01", currentSeatId: null, running: 0 };
  };
  const server = { onMessage(callback) { fromServer = callback; }, send(message) {
    if (JSON.parse(message).type !== "seat_claim") return;
    assert.equal(pendingReads, 1, "actual pending/current must be checked BEFORE upstream claim delivery");
    fromServer(JSON.stringify({ type: "room_state", room: { seatOccupancy: { "seat-01": "private-participant" } } }));
    now = 120; fromServer(JSON.stringify({ type: "seat_claim_result", seatClaimResult: { commandId: claimId, accepted: true } }));
  } };
  const socket = { connectToServer: () => server, onMessage(callback) { fromClient = callback; }, send() {}, close() {} };
  page.routeWebSocket = async (_match, handler) => handler(socket);
  page.route = async (_match, handler) => {
    void handler({ async continue() {
      assert.equal(entered, true, "runtime discovery cannot consume the claim deadline during entry");
      discoveryContinued = true;
      now = 100; fromClient(JSON.stringify({ type: "seat_claim", commandId: claimId, seatId: "seat-01" }));
    } });
  };
  const roomId = "private-owned-room", claimId = "plugin-seat:private-claim", releaseId = "plugin-release:private-release";
  const helper = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "./plugin-author-scenarios": { pluginPath: (room, suffix) => `/api/rooms/${room}/plugins/${suffix}` },
    "./room-plugin-fixture": { async enterPluginRoom(_browser, _value, _room, _role, _name, prepare) {
      await prepare(context, page);
      assert.equal(installed, true, "delivery observation is installed before navigation and the first claim");
       assert.equal(discoveryContinued, false);
       entered = true; return { page, context, session: { participantId: "private-participant" } };
    } },
    "./room-state-observation": {}, "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { disablePendingClaim };\n", { performance: { now: () => now }, console: { info: (...args) => logs.push(args), warn() {} } });
  const put = async enabled => {
    assert.equal(enabled, false); assert.equal(pendingReads, 1);
    assert.equal(now, 120, "Host PUT begins in the real accepted callback, without poll/UI/read overhead");
    now = 100 + releaseDelta - 50;
    page.emit("requestfinished", { url: () => `https://example.invalid/api/rooms/${roomId}/plugins/runtime`,
      response: async () => ({ status: () => 200, json: async () => ({ revision: 9, bindings: [], token: "must-not-log", config: { private: "must-not-log" } }) }) });
    now = 100 + releaseDelta; fromClient(JSON.stringify({ type: "seat_release", commandId: releaseId }));
    now += 20; fromServer(JSON.stringify({ type: "seat_release_result", seatReleaseResult: { commandId: releaseId } }));
  };
  const observations = new Map();
  await assert.rejects(helper.disablePendingClaim({}, {}, roomId, put, {}, [], observations, async () => ({})),
    error => releaseDelta < 3000 ? error === afterFence : /Expected: true/.test(error.message),
    "only an early release reaches intermediate pose; a late release must still fail");
  assert.equal(page.listenerCount("requestfinished"), 0);
  assert.equal(closed, 2);
  assert.equal(logs.length, 1); assert.equal(logs[0][0], "t16_pending_claim_timing");
  const facts = JSON.parse(logs[0][1]);
  assert.equal(facts.claimCount, 1); assert.equal(facts.releaseCount, 1);
  assert.equal(facts.releaseDeltaMs, releaseDelta);
  assert.equal(facts.phaseOffsetsMs.entryComplete, -99);
  assert.equal(facts.phaseOffsetsMs.pendingVerified, 0);
  assert.equal(facts.phaseOffsetsMs.disableRequested, 20);
  assert.equal(facts.phaseOffsetsMs.serverReleaseAck, releaseDelta + 20);
  assert.deepEqual(facts.runtimeReads, [{ offsetMs: releaseDelta - 50, status: 200, revision: 9, enabledBindings: 0 }]);
  for (const privateValue of [roomId, claimId, releaseId, "private-participant", "example.invalid", "must-not-log"]) {
    assert.equal(logs[0][1].includes(privateValue), false);
  }
});

test("preinstalled seat-delivery observer counts only actual correlated replay and restores native methods", async () => {
  const { installSeatDeliveryObservation } = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "./plugin-author-scenarios": {}, "./room-plugin-fixture": {}, "./room-state-observation": {},
    "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { installSeatDeliveryObservation };\n");
  const sent = [], delivered = [];
  class Target { dispatchEvent(event) { delivered.push(event); return true; } }
  class Socket extends Target { send(data) { sent.push(data); } }
  class Message { constructor(data) { this.data = JSON.stringify(data); } }
  const originalSend = Socket.prototype.send, originalDispatch = Target.prototype.dispatchEvent;
  const window = { __VRATA_DEBUG__: { participantId: "private-self" } };
  await installSeatDeliveryObservation({ addInitScript: async callback => vm.runInNewContext(`(${callback.toString()})()`, {
    window, WebSocket: Socket, EventTarget: Target, MessageEvent: Message
  }) });
  const socket = new Socket(), state = window.__t16SeatDelivery;
  const send = message => socket.send(JSON.stringify(message));
  const deliver = message => socket.dispatchEvent(new Message(message));
  try {
    send({ type: "seat_claim", commandId: "plugin-seat:first", seatId: "seat-01" });
    send({ type: "seat_claim", commandId: "plugin-seat:unrelated", seatId: "seat-02" });
    send({ type: "seat_release", commandId: "plugin-release:first" });
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

test("initial four-entry barrier continues original HTTP discovery together without registering a WS route", async () => {
  const { holdInitialSeatDiscovery } = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "./plugin-author-scenarios": { pluginPath: (room, suffix) => `/api/rooms/${room}/plugins/${suffix}` },
    "./room-plugin-fixture": {}, "./room-state-observation": {}, "./room-seat-protocol-race": {},
    "./staging-identity": {}, "./scene-bundle-fixtures": {}
  });
  let release, reached = 0, continued = 0;
  const gate = new Promise(resolve => { release = resolve; }), pending = [];
  for (let i = 0; i < 4; i++) await holdInitialSeatDiscovery({
    routeWebSocket() { assert.fail("normal live transport must remain native"); },
    async route(match, handler) {
      assert.equal(match(new URL("https://example.invalid/api/rooms/owned/plugins/runtime")), true);
      assert.equal(match(new URL("https://example.invalid/elsewhere")), false);
      pending.push(handler({ async continue() { continued++; }, fulfill() { assert.fail("no fabricated HTTP response"); } }));
    }
  }, "owned", gate, () => { reached++; });
  assert.equal(reached, 4); assert.equal(continued, 0);
  release(); await Promise.all(pending);
  assert.equal(continued, 4);
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
