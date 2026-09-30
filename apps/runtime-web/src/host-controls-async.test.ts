import assert from "node:assert/strict";
import test from "node:test";
import { createRoomAccessDebugState } from "@vrata/shared-types";
import type { RuntimeSessionControlResponse } from "./index.js";
import { createHostControlsRuntime } from "./host-controls-runtime.js";
import { createHostControlsHarness, deferred, makeHostParticipant } from "./testing/host-controls-harness.js";

test("refresh preserves feature/token gates, the 1000 ms boundary, and force semantics", async (t) => {
  const h = createHostControlsHarness(t); let now = 5000;
  t.mock.method(Date, "now", () => now);
  h.state.runtimeFlags = { hostControlsEnabled: false };
  await h.runtime.refreshSessionControl(true);
  h.state.runtimeFlags = { hostControlsEnabled: true }; h.state.roomStateAccessToken = "";
  await h.runtime.refreshSessionControl(true);
  assert.equal(h.fetchCalls.length, 0);
  h.state.roomStateAccessToken = "token-2"; await h.runtime.refreshSessionControl();
  now = 5999; await h.runtime.refreshSessionControl();
  assert.equal(h.fetchCalls.length, 1);
  now = 6000; await h.runtime.refreshSessionControl();
  assert.equal(h.fetchCalls.length, 2);
  await h.runtime.refreshSessionControl(true);
  assert.equal(h.fetchCalls.length, 3);
  assert.deepEqual(h.fetchCalls, Array.from({ length: 3 }, () => ["https://example.invalid", "room", "token-2"]));
});

test("a forced refresh does not overlap a pending request and reads current state on completion", async (t) => {
  const h = createHostControlsHarness(t); const response = deferred<RuntimeSessionControlResponse>();
  h.hooks.fetch = () => response.promise;
  const pending = h.runtime.refreshSessionControl(true);
  await h.runtime.refreshSessionControl(true);
  assert.equal(h.fetchCalls.length, 1);
  h.state.latestRealtimeParticipants = [makeHostParticipant("new", "New participant")];
  h.state.roomStateAccessToken = "token-new";
  response.resolve({ state: { presenterParticipantId: "new" } }); await pending;
  assert.equal(h.elements.presenterLineEl.textContent, "Presenter: New participant");
  assert.deepEqual(h.fetchCalls[0], ["https://example.invalid", "room", "token-1"]);
  await h.runtime.refreshSessionControl(true);
  assert.deepEqual(h.fetchCalls[1], ["https://example.invalid", "room", "token-new"]);
});

test("refresh failure logs the original error, releases its guard, and retains start-time throttling", async (t) => {
  const h = createHostControlsHarness(t); let now = 4000;
  t.mock.method(Date, "now", () => now);
  const error = new Error("network"); h.hooks.fetch = async () => { throw error; };
  await h.runtime.refreshSessionControl();
  assert.deepEqual(h.warnings, [["session_control_refresh_failed", error]]);
  assert.deepEqual(h.errors, []);
  now = 4999; await h.runtime.refreshSessionControl(); assert.equal(h.fetchCalls.length, 1);
  h.hooks.fetch = async () => ({ state: { lockedAt: "locked" } });
  now = 5000; await h.runtime.refreshSessionControl(); assert.equal(h.fetchCalls.length, 2);
  assert.equal(h.state.debugState.hostControls.locked, true);
});

test("blocked responses set session state before blocking and skip access and normal rendering", async (t) => {
  const h = createHostControlsHarness(t); let observedEnded = false;
  h.hooks.block = (reason) => {
    h.runtime.renderHostControls(reason);
    observedEnded = h.state.debugState.hostControls.ended;
  };
  await h.respond({
    state: { endedAt: "ended" }, token: "must-not-apply", access: createRoomAccessDebugState("host"),
    participant: { participantId: "self", role: "guest", permissions: [], status: "blocked", reason: "session_ended" }
  });
  assert.deepEqual(h.blockCalls, ["session_ended"]); assert.equal(observedEnded, true);
  assert.deepEqual(h.accessCalls, []);
  assert.deepEqual(h.elements.hostControlsStatusEl.textWrites, ["session_ended"]);
});

test("a blocked response without a reason follows the existing normal access path", async (t) => {
  const h = createHostControlsHarness(t); const access = createRoomAccessDebugState("member");
  await h.respond({ state: {}, token: "new-token", access, expiresInSeconds: 42,
    participant: { participantId: "self", role: "member", permissions: [], status: "blocked", reason: "" } });
  assert.deepEqual(h.blockCalls, []);
  assert.deepEqual(h.accessCalls, [[access, "new-token", 42]]);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Room open");
});

test("access is applied only with both access and a truthy token, before final rendering", async (t) => {
  const h = createHostControlsHarness(t); const access = createRoomAccessDebugState("guest");
  for (const payload of [{ state: {}, access }, { state: {}, access, token: "" }, { state: {}, token: "token" }]) {
    await h.respond(payload);
  }
  assert.equal(h.accessCalls.length, 0);
  h.hooks.access = () => { h.state.debugState.access = { canManageRoomSession: false }; };
  await h.respond({ state: { lockedAt: "locked" }, access, token: "guest-token" });
  assert.deepEqual(h.accessCalls, [[access, "guest-token", undefined]]);
  assert.equal(h.elements.hostControlsEl.hidden, true);
  assert.equal(h.state.debugState.hostControls.locked, true);
});

test("host actions disable controls before invoking the unbound action and reject overlap", async (t) => {
  const h = createHostControlsHarness(t); const result = deferred<RuntimeSessionControlResponse>();
  h.state.latestRealtimeParticipants = [makeHostParticipant("peer")];
  let calls = 0;
  const pending = h.runtime.runHostControlAction(function (this: unknown) {
    assert.equal(this, undefined); calls += 1;
    assert.equal(h.elements.hostControlsStatusEl.textContent, "Applying host action...");
    for (const [name, element] of Object.entries(h.elements)) {
      if (name.endsWith("Button") || name === "hostParticipantSelect") assert.equal(element.disabled, true, name);
    }
    return result.promise;
  }, "Room locked");
  await h.runtime.runHostControlAction(async () => { calls += 1; return { state: {} }; }, "duplicate");
  assert.equal(calls, 1);
  result.resolve({ state: { lockedAt: "locked" } }); await pending;
  assert.deepEqual(h.elements.hostControlsStatusEl.textWrites, ["Applying host action...", "Room locked", "Room locked"]);
  assert.equal(h.elements.unlockRoomButton.disabled, false);
  assert.equal(h.elements.hostParticipantSelect.disabled, false);
});

test("host action errors retain existing status overwrite and always release the action guard", async (t) => {
  const h = createHostControlsHarness(t); const error = new Error("action failure");
  await h.runtime.runHostControlAction(async () => { throw error; }, "not applied");
  assert.deepEqual(h.errors, [[error]]);
  // Existing behavior: the final visible-panel render replaces the error label.
  assert.deepEqual(h.elements.hostControlsStatusEl.textWrites, ["Applying host action...", "Host action failed", "Room open"]);
  await h.runtime.runHostControlAction(async () => ({ state: { endedAt: "ended" } }), "Session ended");
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Session ended");
  assert.equal(h.elements.hostControlsEl.hidden, true);
});

test("synchronous action errors are handled and hidden panels retain the failure label", async (t) => {
  const h = createHostControlsHarness(t); const error = new Error("synchronous failure");
  h.state.runtimeFlags = { hostControlsEnabled: false };
  await h.runtime.runHostControlAction(() => { throw error; }, "not applied");
  assert.deepEqual(h.errors, [[error]]);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Host action failed");
});

test("polling and actions keep independent guards and preserve response arrival order", async (t) => {
  const h = createHostControlsHarness(t); const poll = deferred<RuntimeSessionControlResponse>();
  h.hooks.fetch = () => poll.promise;
  const pending = h.runtime.refreshSessionControl(true);
  await h.runtime.runHostControlAction(async () => ({ state: { lockedAt: "locked" } }), "Room locked");
  assert.equal(h.state.debugState.hostControls.locked, true);
  // The extraction must not silently introduce stale-response suppression.
  poll.resolve({ state: {} }); await pending;
  assert.equal(h.state.debugState.hostControls.locked, false);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Room open");
});

test("each controller owns its own pending refresh and host action guards", async (t) => {
  const h = createHostControlsHarness(t); const other = createHostControlsRuntime(h.context);
  const poll = deferred<RuntimeSessionControlResponse>(); const action = deferred<RuntimeSessionControlResponse>();
  h.hooks.fetch = () => h.fetchCalls.length === 1 ? poll.promise : Promise.resolve({ state: {} });
  const pendingPoll = h.runtime.refreshSessionControl(true);
  const pendingAction = h.runtime.runHostControlAction(() => action.promise, "first");
  await other.refreshSessionControl(true); assert.equal(h.fetchCalls.length, 2);
  let otherActionCalled = false;
  await other.runHostControlAction(async () => { otherActionCalled = true; return { state: {} }; }, "second");
  assert.equal(otherActionCalled, true);
  poll.resolve({ state: {} }); action.resolve({ state: {} });
  await Promise.all([pendingPoll, pendingAction]);
});
