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
function loadHelper(relative, overrides = {}) {
  const filename = resolve(root, relative), module = { exports: {} };
  const localRequire = name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.startsWith("./")) return loadHelper(resolve(dirname(filename), `${name}.ts`), overrides);
    return createRequire(filename)(name);
  };
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInNewContext(output, { exports: module.exports, module, require: localRequire,
    URL, Buffer, console, process, Error, AggregateError }, { filename });
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
