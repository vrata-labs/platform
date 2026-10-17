import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bindHostControls, type HostControlBindingsContext } from "./host-control-bindings.js";
import type { RuntimeSessionControlResponse } from "./index.js";
import { createHostControlsHarness, makeHostParticipant } from "./testing/host-controls-harness.js";

function createBindingsHarness(t: TestContext) {
  const h = createHostControlsHarness(t);
  const queued: Array<{ action: () => Promise<RuntimeSessionControlResponse>; status: string }> = [];
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let renders = 0;
  function service(name: string) {
    return async function (this: unknown, ...args: unknown[]): Promise<RuntimeSessionControlResponse> {
      assert.equal(this, undefined); calls.push({ name, args }); return { state: {} };
    };
  }
  const context: HostControlBindingsContext = {
    ...h.elements, apiBaseUrl: "https://example.invalid", roomId: "room", debugState: h.state.debugState,
    get roomStateAccessToken() { return h.state.roomStateAccessToken; },
    canManageHostControls: h.runtime.canManageHostControls, authorityRevision: h.runtime.authorityRevision, participantLabel: h.runtime.participantLabel,
    transferRoomOwner: service("owner"),
    renderHostControls(this: unknown) { assert.equal(this, undefined); renders += 1; },
    async runHostControlAction(this: unknown, action, status) {
      assert.equal(this, undefined); queued.push({ action, status });
    },
    runRoomSessionControlAction: service("session"), removeRoomParticipant: service("remove"),
    transferRoomHost: service("transfer"), grantRoomPresenter: service("grant"), revokeRoomPresenter: service("revoke")
  };
  return { ...h, context, queued, calls, get renders() { return renders; } };
}

test("the eight host event handlers register once in their original order", (t) => {
  const h = createBindingsHarness(t); const registrations: string[] = [];
  const names = ["lockRoomButton", "unlockRoomButton", "endSessionButton", "hostParticipantSelect",
    "removeParticipantButton", "transferHostButton", "grantPresenterButton", "revokePresenterButton"] as const;
  for (const name of names) {
    const element = h.elements[name]; const original = element.addEventListener;
    t.mock.method(element, "addEventListener", function (this: EventTarget, ...args: Parameters<EventTarget["addEventListener"]>) {
      registrations.push(`${name}:${args[0]}`); original.apply(this, args);
    });
  }
  bindHostControls(h.context);
  assert.deepEqual(registrations, names.map((name) => `${name}:${name === "hostParticipantSelect" ? "change" : "click"}`));
  assert.deepEqual(h.queued, []); assert.deepEqual(h.calls, []); assert.equal(h.renders, 0);
});

test("Owner transfer captures the clicked revision and participant while reading the current token at dispatch", async (t) => {
  const h = createBindingsHarness(t); h.state.activeIdentityProtocolVersion = 2;
  h.state.debugState.personalRoom = { roomType: "personal", isOwner: true, ownerParticipantId: "self" };
  h.state.latestRealtimeParticipants = [makeHostParticipant("a"), makeHostParticipant("b")];
  await h.respond({ state: {}, authorityRevision: 7, ownerParticipantId: "self" }); bindHostControls(h.context);
  h.elements.hostParticipantSelect.value = "a"; h.elements.transferOwnerButton.dispatchEvent(new Event("click"));
  assert.equal(h.queued.length, 1);
  await h.respond({ state: {}, authorityRevision: 8, ownerParticipantId: "self" });
  h.elements.hostParticipantSelect.value = "b"; h.state.roomStateAccessToken = "fresh-token";
  await h.queued[0]!.action();
  assert.deepEqual(h.calls, [{ name: "owner", args: ["https://example.invalid", "room", "fresh-token", "a", 7] }]);
});

for (const [button, action, status] of [
  ["lockRoomButton", "lock", "Room locked"],
  ["unlockRoomButton", "unlock", "Room unlocked"],
  ["endSessionButton", "end", "Session ended"]] as const) {
  test(`${action} retains its action, status and live token without binding the API function`, async (t) => {
    const h = createBindingsHarness(t); bindHostControls(h.context);
    h.elements[button].dispatchEvent(new Event("click"));
    assert.equal(h.queued.length, 1); assert.equal(h.queued[0]?.status, status);
    h.state.roomStateAccessToken = "refreshed-token"; await h.queued[0]!.action();
    assert.deepEqual(h.calls, [{ name: "session", args: ["https://example.invalid", "room", "refreshed-token", action] }]);
  });
}

for (const [button, serviceName, status] of [
  ["removeParticipantButton", "remove", "Removed “a”"],
  ["transferHostButton", "transfer", "Transferred host to “a”"],
  ["grantPresenterButton", "grant", "Granted presenter to “a”"],
  ["revokePresenterButton", "revoke", "Revoked presenter from “a”"]] as const) {
  test(`${serviceName} ignores empty selection, captures the clicked participant and reads the current token`, async (t) => {
    const h = createBindingsHarness(t); bindHostControls(h.context);
    h.elements[button].dispatchEvent(new Event("click")); assert.equal(h.queued.length, 0);
    h.state.latestRealtimeParticipants = [makeHostParticipant("a"), makeHostParticipant("b")];
    h.runtime.renderHostControls(); h.elements.hostParticipantSelect.value = "a";
    h.elements[button].dispatchEvent(new Event("click"));
    assert.equal(h.queued.length, 1); assert.equal(h.queued[0]?.status, status);
    h.elements.hostParticipantSelect.value = "b"; h.state.roomStateAccessToken = "refreshed-token";
    await h.queued[0]!.action();
    assert.deepEqual(h.calls, [{ name: serviceName, args: ["https://example.invalid", "room", "refreshed-token", "a"] }]);
  });
}

test("selection change updates diagnostics before rendering, including an empty selection", (t) => {
  const h = createBindingsHarness(t);
  h.state.latestRealtimeParticipants = [makeHostParticipant("a"), makeHostParticipant("b")];
  h.runtime.renderHostControls(); const observed: Array<string | null> = [];
  h.context.renderHostControls = function (this: unknown) {
    assert.equal(this, undefined); observed.push(h.state.debugState.hostControls.selectedParticipantId);
  };
  bindHostControls(h.context);
  h.elements.hostParticipantSelect.value = "b";
  h.elements.hostParticipantSelect.dispatchEvent(new Event("change"));
  h.elements.hostParticipantSelect.value = "missing";
  h.elements.hostParticipantSelect.dispatchEvent(new Event("change"));
  assert.deepEqual(observed, ["b", null]); assert.deepEqual(h.queued, []);
});

test("visible action messages use names while the API still receives opaque routing IDs", async t => {
  const h = createBindingsHarness(t), id = "opaque-routing-id-not-a-display-name";
  h.state.latestRealtimeParticipants = [makeHostParticipant(id, "")]; h.runtime.renderHostControls();
  bindHostControls(h.context); h.elements.hostParticipantSelect.value = id;
  h.elements.grantPresenterButton.dispatchEvent(new Event("click"));
  assert.equal(h.queued[0]!.status, "Granted presenter to “Participant”");
  await h.queued[0]!.action(); assert.equal(h.calls[0]!.args[3], id);
});
