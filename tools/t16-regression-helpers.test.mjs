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

test("pending-disable timing stays observational, preserves the 3000ms failure and cleans its response listener", async () => {
  let now = 1, fromClient, fromServer, closed = 0;
  const logs = [], page = new EventEmitter(), context = { close: async () => { closed++; } };
  page.context = () => context; page.isClosed = () => false;
  page.evaluate = async callback => callback.toString().includes("__VRATA_DEBUG__")
    ? { participantId: "private-participant", pendingSeatId: "seat-01", currentSeatId: null, running: 0 } : undefined;
  const server = { onMessage(callback) { fromServer = callback; }, send() {} };
  const socket = { connectToServer: () => server, onMessage(callback) { fromClient = callback; }, send() {}, close() {} };
  page.routeWebSocket = async (_match, handler) => handler(socket);
  const roomId = "private-owned-room", claimId = "plugin-seat:private-claim", releaseId = "plugin-release:private-release";
  const helper = loadHelper("tests/e2e/room-plugin-auto-seat-scenarios.ts", {
    "./plugin-author-scenarios": { pluginPath: (room, suffix) => `/api/rooms/${room}/plugins/${suffix}` },
    "./room-plugin-fixture": { async enterPluginRoom(_browser, _value, _room, _role, _name, prepare) {
      await prepare(context, page);
      now = 100; fromClient(JSON.stringify({ type: "seat_claim", commandId: claimId, seatId: "seat-01" }));
      now = 120; fromServer(JSON.stringify({ type: "seat_claim_result", seatClaimResult: { commandId: claimId, accepted: true } }));
      now = 3200; return { page, context, session: { participantId: "private-participant" } };
    } },
    "./room-state-observation": {}, "./room-seat-protocol-race": {}, "./staging-identity": {}, "./scene-bundle-fixtures": {}
  }, "\nexport { disablePendingClaim };\n", { performance: { now: () => now }, console: { info: (...args) => logs.push(args), warn() {} } });
  const put = async enabled => {
    assert.equal(enabled, false); now = 3250;
    page.emit("requestfinished", { url: () => `https://example.invalid/api/rooms/${roomId}/plugins/runtime`,
      response: async () => ({ status: () => 200, json: async () => ({ revision: 9, bindings: [], token: "must-not-log", config: { private: "must-not-log" } }) }) });
    now = 3300; fromClient(JSON.stringify({ type: "seat_release", commandId: releaseId }));
    now = 3320; fromServer(JSON.stringify({ type: "seat_release_result", seatReleaseResult: { commandId: releaseId } }));
  };
  const observations = new Map();
  await assert.rejects(helper.disablePendingClaim({}, {}, roomId, put, {}, [], observations, async () => ({})),
    error => /Expected: true/.test(error.message), "a late release must still fail; diagnostics cannot turn it into PASS");
  assert.equal(page.listenerCount("requestfinished"), 0);
  assert.equal(closed, 2);
  assert.equal(logs.length, 1); assert.equal(logs[0][0], "t16_pending_claim_timing");
  const facts = JSON.parse(logs[0][1]);
  assert.equal(facts.claimCount, 1); assert.equal(facts.releaseCount, 1);
  assert.equal(facts.releaseDeltaMs, 3200);
  assert.equal(facts.phaseOffsetsMs.entryComplete, 3100);
  assert.equal(facts.phaseOffsetsMs.disableRequested, 3100);
  assert.equal(facts.phaseOffsetsMs.serverReleaseAck, 3220);
  assert.deepEqual(facts.runtimeReads, [{ offsetMs: 3150, status: 200, revision: 9, enabledBindings: 0 }]);
  for (const privateValue of [roomId, claimId, releaseId, "private-participant", "example.invalid", "must-not-log"]) {
    assert.equal(logs[0][1].includes(privateValue), false);
  }
});
