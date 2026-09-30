import assert from "node:assert/strict";
import test from "node:test";
import { createHostControlsRuntime } from "./host-controls-runtime.js";
import { createHostControlsHarness, makeHostParticipant } from "./testing/host-controls-harness.js";

test("construction does not read runtime state before main initializes it", (t) => {
  const h = createHostControlsHarness(t);
  const context = { ...h.context };
  for (const key of ["debugState", "runtimeFlags", "roomStateAccessToken", "latestRealtimeParticipants", "latestFallbackParticipants"]) {
    Object.defineProperty(context, key, { get() { throw new Error(`early_read:${key}`); } });
  }
  assert.doesNotThrow(() => createHostControlsRuntime(context));
  assert.equal(h.created.length, 0);
  assert.equal(h.fetchCalls.length, 0);
});

test("empty host panel retains its original visibility and disabled states", (t) => {
  const h = createHostControlsHarness(t); h.runtime.renderHostControls();
  const e = h.elements;
  assert.equal(e.hostControlsEl.hidden, false);
  assert.equal(e.presenterLineEl.textContent, "Presenter: none");
  assert.equal(e.hostControlsStatusEl.textContent, "Room open");
  assert.deepEqual(e.hostParticipantSelect.options.map((option) => [option.value, option.textContent]), [["", "No participants"]]);
  assert.equal(h.state.debugState.hostControls.selectedParticipantId, null);
  assert.equal(e.hostParticipantSelect.disabled, true);
  assert.equal(e.lockRoomButton.disabled, false);
  assert.equal(e.unlockRoomButton.disabled, true);
  assert.equal(e.endSessionButton.disabled, false);
  for (const button of [e.removeParticipantButton, e.transferHostButton, e.grantPresenterButton, e.revokePresenterButton]) {
    assert.equal(button.disabled, true);
  }
});

test("flags and replaced access state immediately hide and re-enable host controls", (t) => {
  const h = createHostControlsHarness(t);
  h.state.latestRealtimeParticipants = [makeHostParticipant("guest")];
  h.runtime.renderHostControls("keep this status");
  h.state.runtimeFlags = { hostControlsEnabled: false };
  h.runtime.renderHostControls();
  assert.equal(h.elements.hostControlsEl.hidden, true);
  assert.equal(h.state.debugState.hostControls.enabled, false);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "keep this status");
  h.state.runtimeFlags = { hostControlsEnabled: true };
  h.state.debugState = { ...h.state.debugState, access: { canManageRoomSession: false } };
  h.runtime.renderHostControls();
  assert.equal(h.elements.hostControlsEl.hidden, true);
  h.state.debugState.access = { canManageRoomSession: true };
  h.runtime.renderHostControls();
  assert.equal(h.elements.hostControlsEl.hidden, false);
  assert.equal(h.elements.removeParticipantButton.disabled, false);
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Room open");
});

test("presence merge prefers realtime records and sorts without mutating either source", (t) => {
  const h = createHostControlsHarness(t);
  const fallback = [makeHostParticipant("c", "Charlie"), makeHostParticipant("b", "Old name")];
  const realtime = [makeHostParticipant("b", "Bob"), { ...makeHostParticipant("a", "Alice"), role: "member" as const }];
  h.state.latestFallbackParticipants = fallback; h.state.latestRealtimeParticipants = realtime;
  h.runtime.renderHostControls();
  assert.deepEqual(h.elements.hostParticipantSelect.options.map((option) => [option.value, option.textContent]), [
    ["a", "Alice (member)"], ["b", "Bob (guest)"], ["c", "Charlie (guest)"]
  ]);
  assert.deepEqual(fallback.map((item) => item.participantId), ["c", "b"]);
  assert.deepEqual(realtime.map((item) => item.participantId), ["b", "a"]);
  assert.equal(h.state.debugState.hostControls.selectedParticipantId, "a");
});

test("participant selection survives rerender and falls back when the selected peer leaves", (t) => {
  const h = createHostControlsHarness(t);
  h.state.latestRealtimeParticipants = [makeHostParticipant("a", ""), makeHostParticipant("b")];
  h.runtime.renderHostControls(); h.elements.hostParticipantSelect.value = "b";
  h.runtime.renderHostControls();
  assert.equal(h.state.debugState.hostControls.selectedParticipantId, "b");
  h.state.latestRealtimeParticipants = [makeHostParticipant("a", "")];
  h.runtime.renderHostControls();
  assert.equal(h.elements.hostParticipantSelect.value, "a");
  assert.equal(h.elements.hostParticipantSelect.options[0]?.textContent, "a (guest)");
});

test("lock state and self/host/presenter restrictions are rendered independently", async (t) => {
  const h = createHostControlsHarness(t); const e = h.elements;
  h.state.latestRealtimeParticipants = [makeHostParticipant("self"), makeHostParticipant("peer")];
  await h.respond({ state: { hostParticipantId: "self", presenterParticipantId: "peer", lockedAt: "locked" } });
  assert.equal(e.lockRoomButton.disabled, true); assert.equal(e.unlockRoomButton.disabled, false);
  assert.equal(h.state.debugState.hostControls.locked, true);
  e.hostParticipantSelect.value = "self"; h.runtime.renderHostControls();
  assert.equal(e.removeParticipantButton.disabled, true); assert.equal(e.transferHostButton.disabled, true);
  assert.equal(e.grantPresenterButton.disabled, false); assert.equal(e.revokePresenterButton.disabled, true);
  e.hostParticipantSelect.value = "peer"; h.runtime.renderHostControls();
  assert.equal(e.removeParticipantButton.disabled, false); assert.equal(e.transferHostButton.disabled, false);
  assert.equal(e.grantPresenterButton.disabled, true); assert.equal(e.revokePresenterButton.disabled, false);
  assert.equal(e.presenterLineEl.textContent, "Presenter: peer");
  assert.equal(e.hostControlsStatusEl.textContent, "Room locked; host self; presenter peer");
});

test("an offline presenter remains selectable solely for presenter revocation", async (t) => {
  const h = createHostControlsHarness(t); const e = h.elements;
  await h.respond({ state: { presenterParticipantId: "offline" } });
  assert.equal(e.presenterLineEl.textContent, "Presenter: offline");
  assert.deepEqual(e.hostParticipantSelect.options.map((option) => option.textContent), ["offline (presenter offline)"]);
  assert.equal(e.hostParticipantSelect.value, "offline");
  assert.equal(e.hostParticipantSelect.disabled, false); assert.equal(e.revokePresenterButton.disabled, false);
  assert.equal(e.removeParticipantButton.disabled, true); assert.equal(e.transferHostButton.disabled, true);
  assert.equal(e.grantPresenterButton.disabled, true);
  h.state.latestRealtimeParticipants = [makeHostParticipant("peer")]; h.runtime.renderHostControls();
  assert.equal(e.hostParticipantSelect.value, "offline");
  assert.equal(h.state.debugState.hostControls.selectedParticipantId, "offline");
});

test("an ended session hides all actions but still renders the presenter and explicit status", async (t) => {
  const h = createHostControlsHarness(t);
  h.state.latestRealtimeParticipants = [makeHostParticipant("speaker", "Speaker")];
  await h.respond({ state: { endedAt: "ended", presenterParticipantId: "speaker" } });
  h.runtime.renderHostControls("Session ended by host");
  assert.equal(h.elements.hostControlsEl.hidden, true);
  assert.equal(h.state.debugState.hostControls.ended, true);
  assert.equal(h.elements.presenterLineEl.textContent, "Presenter: Speaker");
  assert.equal(h.elements.hostControlsStatusEl.textContent, "Session ended by host");
  for (const [name, element] of Object.entries(h.elements)) {
    if (name.endsWith("Button") || name === "hostParticipantSelect") assert.equal(element.disabled, true, name);
  }
});
