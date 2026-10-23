import assert from "node:assert/strict";
import test from "node:test";
import { createRoomAccessDebugState, getRoomPermissions, type RoomRole } from "@vrata/shared-types";
import type { RuntimeSessionControlResponse } from "./index.js";
import { createHostControlsRuntime } from "./host-controls-runtime.js";
import { createHostControlsHarness, deferred, makeHostParticipant } from "./testing/host-controls-harness.js";
import { createSessionAwareFetch, createSessionUpgradeGate } from "./session-upgrade.js";

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

test("host action uncertainty remains visible through finally and always releases the action guard", async (t) => {
  const h = createHostControlsHarness(t); const error = new Error("action failure");
  await h.runtime.runHostControlAction(async () => { throw error; }, "not applied");
  assert.deepEqual(h.errors, [[error]]);
  const message = "Host action could not be confirmed. Check the current room state before retrying.";
  assert.deepEqual(h.elements.hostControlsStatusEl.textWrites, ["Applying host action...", message, message]);
  await h.runtime.runHostControlAction(async () => ({ state: { endedAt: "ended" } }), "Session ended");
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Session ended");
  assert.equal(h.elements.hostControlsEl.hidden, true);
});

test("synchronous action errors are handled and hidden panels retain the failure label", async (t) => {
  const h = createHostControlsHarness(t); const error = new Error("synchronous failure");
  h.state.runtimeFlags = { hostControlsEnabled: false };
  await h.runtime.runHostControlAction(() => { throw error; }, "not applied");
  assert.deepEqual(h.errors, [[error]]);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Host action could not be confirmed. Check the current room state before retrying.");
});

test("an older poll cannot overwrite the result of a later host action", async (t) => {
  const h = createHostControlsHarness(t); const poll = deferred<RuntimeSessionControlResponse>();
  h.hooks.fetch = () => poll.promise;
  const pending = h.runtime.refreshSessionControl(true);
  await h.runtime.runHostControlAction(async () => ({ state: { lockedAt: "locked" } }), "Room locked");
  assert.equal(h.state.debugState.hostControls.locked, true);
  poll.resolve({ state: {} }); await pending;
  assert.equal(h.state.debugState.hostControls.locked, true);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Room locked");
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
test("newer Owner authority survives stale role responses and a terminal block", async (t) => {
  const h = createHostControlsHarness(t);
  h.state.activeIdentityProtocolVersion = 2;
  h.state.debugState.personalRoom = { roomType: "personal", isOwner: true, ownerParticipantId: "self" };
  h.state.debugState.access.canManageRoomSession = false;
  await h.respond({ state: {}, authorityRevision: 6, ownerParticipantId: "self" });
  assert.equal(h.elements.hostControlsEl.hidden, false, "a Member-Owner keeps room controls");
  await h.respond({ state: { endedAt: "old" }, authorityRevision: 5, ownerParticipantId: "other" });
  assert.equal(h.state.debugState.personalRoom.isOwner, true); assert.equal(h.elements.hostControlsEl.hidden, false);
  assert.equal(h.runtime.authorityRevision(), 6);
  const delayed = deferred<RuntimeSessionControlResponse>(); h.hooks.fetch = () => delayed.promise;
  const pending = h.runtime.refreshSessionControl(true); h.state.sessionControlBlocked = true;
  delayed.resolve({ state: {}, authorityRevision: 7, ownerParticipantId: "other" }); await pending;
  assert.equal(h.runtime.authorityRevision(), 6); assert.equal(h.state.debugState.personalRoom.isOwner, true);
  h.runtime.renderHostControls(); assert.equal(h.elements.hostControlsEl.hidden, true);
});

test("Owner projection and self-action guards use the server-issued identity adopted after controller creation", async (t) => {
  const h = createHostControlsHarness(t);
  h.state.participantId = "server-issued"; h.state.activeIdentityProtocolVersion = 2;
  h.state.debugState.personalRoom = { roomType: "personal", isOwner: false, ownerParticipantId: null };
  h.state.latestRealtimeParticipants = [makeHostParticipant("server-issued")];
  await h.respond({ state: {}, authorityRevision: 2, ownerParticipantId: "server-issued" });
  assert.equal(h.state.debugState.personalRoom.isOwner, true);
  assert.equal(h.elements.removeParticipantButton.disabled, true, "the adopted self ID is not removable through its own panel");
  assert.equal(h.elements.hostControlsEl.hidden, false);
});

function authorityPayload(role: RoomRole, revision: number, owner = false): RuntimeSessionControlResponse {
  return { state: { hostParticipantId: role === "host" ? "self" : "host-peer", presenterParticipantId: role === "presenter" ? "self" : null },
    authorityRevision: revision, ownerParticipantId: owner ? "self" : null,
    participant: { participantId: "self", role, permissions: getRoomPermissions(role), isOwner: owner, status: "active" } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("v2 live promotion and demotion use explicit API permissions with the existing RS2", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2; h.state.roomStateAccessToken = "rs2.owned-current";
  await h.respond(authorityPayload("presenter", 2)); await h.respond(authorityPayload("member", 3));
  assert.deepEqual(h.accessCalls.map(([access, token]) => ({ role: access.role, screen: access.canStartScreenShare, token })), [
    { role: "presenter", screen: true, token: "rs2.owned-current" }, { role: "member", screen: false, token: "rs2.owned-current" }
  ]);
});

test("repeated v2 access is idempotent and stale or contradictory revisions do not resurrect Presenter", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  await h.respond(authorityPayload("presenter", 4)); await h.respond(authorityPayload("presenter", 4));
  assert.equal(h.accessCalls.length, 1);
  await h.respond(authorityPayload("member", 5));
  await h.respond(authorityPayload("presenter", 4)); await h.respond(authorityPayload("presenter", 5));
  assert.equal(h.accessCalls.length, 2); assert.equal(h.runtime.authorityRevision(), 5);
  assert.equal(h.state.debugState.hostControls.presenterParticipantId, null);
});

test("malformed v2 access never advances the authority cache or expands a role", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  await h.respond(authorityPayload("member", 3));
  const malicious = authorityPayload("member", 20); malicious.participant!.permissions = [...getRoomPermissions("member"), "room.admin"];
  await h.respond(malicious);
  await h.respond({ ...authorityPayload("presenter", 21), authorityRevision: undefined });
  await h.respond({ ...authorityPayload("presenter", 22), participant: { ...authorityPayload("presenter", 22).participant!, participantId: "other" } });
  assert.equal(h.runtime.authorityRevision(), 3); assert.equal(h.accessCalls.length, 1);
  await h.respond(authorityPayload("presenter", 4)); assert.equal(h.accessCalls.length, 2);
});

test("late v2 responses are bound to the current participant but ordinary renewal does not invalidate them", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  const response = deferred<RuntimeSessionControlResponse>(); h.hooks.fetch = () => response.promise;
  const pending = h.runtime.refreshSessionControl(true); h.state.roomStateAccessToken = "rs2.renewed";
  response.resolve(authorityPayload("presenter", 2)); await pending;
  assert.equal(h.accessCalls[0]![1], "rs2.renewed");
  const old = deferred<RuntimeSessionControlResponse>(); h.hooks.fetch = () => old.promise;
  const second = h.runtime.refreshSessionControl(true); h.state.participantId = "another-admission";
  old.resolve(authorityPayload("host", 3)); await second;
  assert.equal(h.accessCalls.length, 1); assert.equal(h.runtime.authorityRevision(), 2);
});

test("renewal with an older or absent revision refreshes no role or ownership flags", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  h.state.debugState.personalRoom = { roomType: "personal", isOwner: false, ownerParticipantId: null };
  await h.respond(authorityPayload("presenter", 8));
  assert.equal(h.runtime.acceptRenewedAuthority({ participantId: "self", role: "member", permissions: getRoomPermissions("member"), isOwner: true, authorityRevision: 7 }), null);
  assert.equal(h.runtime.acceptRenewedAuthority({ participantId: "self", role: "host", permissions: getRoomPermissions("host"), isOwner: true }), null);
  assert.equal(h.runtime.authorityRevision(), 8); assert.equal(h.state.debugState.personalRoom.isOwner, false);
  const updated = h.runtime.acceptRenewedAuthority({ participantId: "self", role: "member", permissions: getRoomPermissions("member"), isOwner: true, authorityRevision: 9 });
  assert.equal(updated?.role, "member"); assert.equal(updated?.canManageRoomSession, false);
  assert.equal(h.state.debugState.personalRoom.isOwner, true);
});

test("admission revision pins initial capabilities without treating a later role label as authority", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  h.runtime.observeAdmissionRevision(4, { participantId: "self", access: createRoomAccessDebugState("member"), isOwner: false });
  await h.respond(authorityPayload("host", 3)); await h.respond(authorityPayload("host", 4));
  assert.equal(h.accessCalls.length, 0);
  await h.respond(authorityPayload("presenter", 5)); assert.equal(h.accessCalls.length, 1);
});

test("v2 state-only action schedules one fresh self view after an older pending poll retires", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  const old = deferred<RuntimeSessionControlResponse>(), fresh = deferred<RuntimeSessionControlResponse>();
  h.hooks.fetch = () => h.fetchCalls.length === 1 ? old.promise : fresh.promise;
  const pending = h.runtime.refreshSessionControl(true);
  await h.runtime.runHostControlAction(async () => ({ state: { hostParticipantId: "host-peer" }, revision: 3 }), "Host transferred");
  assert.equal(h.fetchCalls.length, 1);
  old.resolve(authorityPayload("host", 2)); await pending; await tick();
  assert.equal(h.fetchCalls.length, 2); await h.runtime.refreshSessionControl(true); assert.equal(h.fetchCalls.length, 2);
  fresh.resolve(authorityPayload("member", 3)); await tick();
  assert.equal(h.accessCalls.length, 1); assert.equal(h.accessCalls[0]![0].role, "member");
});

test("a terminal block ignores a late action acknowledgement and a new controller starts independently", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  const result = deferred<RuntimeSessionControlResponse>(); const pending = h.runtime.runHostControlAction(() => result.promise, "late");
  h.state.sessionControlBlocked = true; result.resolve(authorityPayload("host", 10)); await pending;
  assert.equal(h.accessCalls.length, 0); assert.equal(h.runtime.authorityRevision(), null);
  h.state.sessionControlBlocked = false;
  const next = createHostControlsRuntime(h.context); h.hooks.fetch = async () => authorityPayload("member", 1);
  await next.refreshSessionControl(true); assert.equal(next.authorityRevision(), 1);
});

test("action uncertainty survives unchanged polls but a newly observed room state replaces stale status", async t => {
  const h = createHostControlsHarness(t); await h.respond({ state: {} });
  await h.runtime.runHostControlAction(async () => { throw new Error("ACK unavailable"); }, "unused");
  await h.respond({ state: {} }); assert.match(h.elements.hostControlsStatusEl.textContent, /could not be confirmed/);
  await h.respond({ state: { lockedAt: "now" } }); assert.equal(h.elements.hostControlsStatusEl.textContent, "Room locked");
});

test("REST recovery denial terminates v2 polling even without a live room-state socket", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  const gate = createSessionUpgradeGate(); gate.install(() => { h.state.sessionControlBlocked = true; });
  const request = createSessionAwareFetch(gate, async () => Response.json({ error: "identity_required", reason: "identity_recovery_required" }, { status: 409 }));
  h.hooks.fetch = async () => { await request("https://example.invalid/api/rooms/room/session-control"); throw new Error("must not reach"); };
  await h.runtime.refreshSessionControl(true);
  assert.equal(gate.reason, "identity_recovery_required"); assert.equal(h.state.sessionControlBlocked, true);
  await h.runtime.refreshSessionControl(true); assert.equal(h.fetchCalls.length, 1);
});

test("an uncertain v2 command forces a fresh self GET without retrying its mutation", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  h.hooks.fetch = async () => authorityPayload("member", 2);
  let writes = 0;
  await h.runtime.runHostControlAction(async () => { writes++; throw new Error("ACK lost"); }, "unused"); await tick();
  assert.equal(writes, 1); assert.equal(h.fetchCalls.length, 1); assert.equal(h.accessCalls[0]?.[0].role, "member");
});

test("a late command rejection cannot overwrite the terminal message or issue another command", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  const rejected = deferred<RuntimeSessionControlResponse>();
  const pending = h.runtime.runHostControlAction(() => rejected.promise, "unused");
  h.state.sessionControlBlocked = true; h.runtime.renderHostControls("Room access needs recovery");
  rejected.reject(new Error("late failure")); await pending;
  let commands = 0; await h.runtime.runHostControlAction(async () => { commands++; return authorityPayload("host", 9); }, "unused");
  assert.equal(commands, 0); assert.equal(h.elements.hostControlsStatusEl.textContent, "Room access needs recovery");
  assert.equal(h.fetchCalls.length, 0);
});

test("committed authority does not claim that pending or mismatched native enforcement is complete", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  const payload = authorityPayload("host", 2);
  payload.mediaScreenReconciliation = { state: "pending", desiredVersion: { authorityRevision: 2, roomActive: true } };
  await h.respond(payload); assert.match(h.elements.hostControlsStatusEl.textContent, /synchronization pending/);
  h.runtime.renderHostControls("Presenter access changed");
  assert.match(h.elements.hostControlsStatusEl.textContent, /has not been confirmed/);
  payload.mediaScreenReconciliation.state = "observed"; await h.respond(payload);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Presenter access changed");
  payload.mediaScreenReconciliation.desiredVersion.authorityRevision = 1; await h.respond(payload);
  assert.match(h.elements.hostControlsStatusEl.textContent, /has not been confirmed/);
});

test("v2 self authority refresh is independent of the Host action panel feature gate", async t => {
  const h = createHostControlsHarness(t); h.state.activeIdentityProtocolVersion = 2; h.state.runtimeFlags.hostControlsEnabled = false;
  await h.respond(authorityPayload("presenter", 2));
  assert.equal(h.fetchCalls.length, 1); assert.equal(h.accessCalls[0]?.[0].canStartScreenShare, true);
  assert.equal(h.elements.hostControlsEl.hidden, true);
});

test("refresh diagnostics distinguish an outstanding request from a stopped timer without exposing credentials", async t => {
  const h = createHostControlsHarness(t), pending = deferred<RuntimeSessionControlResponse>();
  h.hooks.fetch = () => pending.promise;
  const refresh = h.runtime.refreshSessionControl(true);
  assert.equal(h.runtime.refreshDiagnostics().inFlight, true);
  assert.equal(h.runtime.refreshDiagnostics().outcome, "pending");
  assert.equal(h.runtime.refreshDiagnostics().started, 1);
  pending.resolve({ state: {} }); await refresh;
  const diagnostic = h.runtime.refreshDiagnostics();
  assert.equal(diagnostic.finished, 1); assert.equal(diagnostic.outcome, "applied"); assert.equal(diagnostic.inFlight, false);
  assert.ok(!JSON.stringify(diagnostic).includes(h.state.roomStateAccessToken));
});
