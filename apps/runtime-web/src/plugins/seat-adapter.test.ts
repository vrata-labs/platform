import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ROOM_PLUGIN_ARRIVAL, RoomPluginSeatAdapter, type RoomPluginSeatWorld } from "./seat-adapter.js";

function harness(overrides: Partial<RoomPluginSeatWorld> = {}) {
  let now = 0, optedOut = false, aliasCounter = 0;
  const world: RoomPluginSeatWorld = { ready: false, correlation: true, online: true, xr: false, selfId: "self-private-id",
    seats: [{ id: "seat-a", yaw: 0 }, { id: "seat-b", yaw: 1.5 }], occupancy: {}, currentSeatId: null, pendingSeatId: null, ...overrides };
  const claims: Array<[string, string]> = [], cancels: Array<[string, string]> = [];
  const adapter = new RoomPluginSeatAdapter({ world: () => world, optedOut: () => optedOut, clock: () => now,
    random: () => `alias-${++aliasCounter}`,
    claim: (seatId, commandId) => { claims.push([seatId, commandId]); world.pendingSeatId = seatId; },
    cancel: (release, claim) => { cancels.push([release, claim]); world.pendingSeatId = null; return true; } });
  return { adapter, world, claims, cancels, advance(ms: number) { now += ms; }, optOut() { optedOut = true; } };
}

test("the arrival grant arms at platform readiness, opens at the first seating room.ready and only for a standing, online, non-XR participant", async () => {
  const h = harness();
  h.adapter.activate(); assert.equal(h.adapter.arrivalAllowed(), false);
  assert.deepEqual(await h.adapter.claim("seat-a"), { error: "arrival-not-allowed" }, "no claim before readiness");
  h.world.ready = true; assert.equal(h.adapter.arrivalAllowed(), false, "armed, not yet delivered to a plugin");
  h.advance(ROOM_PLUGIN_ARRIVAL.entryMs - 1); h.adapter.activate(); assert.equal(h.adapter.arrivalAllowed(), true);
  h.advance(ROOM_PLUGIN_ARRIVAL.windowMs); assert.equal(h.adapter.arrivalAllowed(), false, "the window is bounded");
  h.adapter.activate(); assert.equal(h.adapter.arrivalAllowed(), false, "it never reopens in this page session");
  for (const blocked of [{ correlation: false }, { xr: true }, { online: false }, { currentSeatId: "seat-a" }, { pendingSeatId: "seat-b" }]) {
    const other = harness({ ready: true, ...blocked }); other.adapter.activate(); assert.equal(other.adapter.arrivalAllowed(), false, JSON.stringify(blocked));
  }
  const opted = harness(); opted.optOut(); opted.world.ready = true; opted.adapter.activate(); assert.equal(opted.adapter.arrivalAllowed(), false);
  const stale = harness({ ready: true }); stale.adapter.observe(); stale.advance(ROOM_PLUGIN_ARRIVAL.entryMs + 1); stale.adapter.activate();
  assert.equal(stale.adapter.arrivalAllowed(), false, "a behavior enabled long after entry never seats people already present");
  const vetoed = harness({ ready: true }); vetoed.adapter.observe(); vetoed.adapter.manualIntent(); vetoed.adapter.activate();
  assert.equal(vetoed.adapter.arrivalAllowed(), false, "a manual action before the plugin is ready vetoes too");
  assert.deepEqual(h.claims, []);
});

test("an accepted correlated claim uses the grant; seat ownership then belongs to the participant", async () => {
  const h = harness({ ready: true }); h.adapter.activate();
  const pending = h.adapter.claim("seat-a");
  assert.equal(h.claims.length, 1); const [, commandId] = h.claims[0];
  assert.match(commandId, /^plugin-seat:[\w-]+:\d+$/);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: "plugin-seat:other:1" });
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true });
  assert.equal(h.adapter.diagnostics().inFlight, true, "uncorrelated answers are not this attempt");
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId });
  assert.deepEqual(await pending, { result: "accepted" });
  assert.equal(h.adapter.diagnostics().grant, "used");
  h.adapter.cancelOwn(); h.adapter.manualIntent();
  assert.deepEqual(h.cancels, [], "a confirmed seat is never cancelled by the plugin or the veto");
  assert.deepEqual(await h.adapter.claim("seat-b"), { error: "arrival-not-allowed" });
});

test("busy, unknown and occupied seats count as bounded candidates; one claim at a time", async () => {
  const h = harness({ ready: true, occupancy: { "seat-b": "someone-else" } }); h.adapter.activate();
  assert.deepEqual(await h.adapter.claim("seat-b"), { result: "busy" });
  assert.deepEqual(await h.adapter.claim("invented-seat"), { result: "busy" });
  assert.deepEqual(h.claims, [], "neither reached the server");
  const pending = h.adapter.claim("seat-a");
  assert.deepEqual(await h.adapter.claim("seat-a"), { error: "quota-exceeded" });
  h.adapter.settleClaim({ seatId: "seat-a", accepted: false, commandId: h.claims[0][1] });
  assert.deepEqual(await pending, { result: "busy" });
  h.world.pendingSeatId = null;
  for (let i = 0; i < ROOM_PLUGIN_ARRIVAL.candidates; i++) await h.adapter.claim("invented-seat");
  assert.deepEqual(await h.adapter.claim("seat-a"), { error: "arrival-not-allowed" }, "at most eight candidates");
});

test("a manual intent cancels the pending plugin claim through the release barrier and vetoes later claims", async () => {
  const h = harness({ ready: true }); h.adapter.activate();
  const pending = h.adapter.claim("seat-a"); const claimId = h.claims[0][1];
  h.adapter.manualIntent();
  assert.deepEqual(await pending, { result: "cancelled" });
  assert.equal(h.cancels.length, 1); assert.equal(h.cancels[0][1], claimId); assert.match(h.cancels[0][0], /^plugin-release:/);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: claimId });
  assert.equal(h.adapter.diagnostics().grant, "closed", "a late accept of the cancelled attempt is not a plugin success");
  assert.deepEqual(await h.adapter.claim("seat-b"), { error: "arrival-not-allowed" });
});

test("a plugin may cancel only its own pending claim; a lost answer times out into a cancelled barrier", async () => {
  const h = harness({ ready: true }); h.adapter.activate();
  h.adapter.cancelOwn(); assert.deepEqual(h.cancels, [], "nothing pending");
  const pending = h.adapter.claim("seat-a");
  h.adapter.cancelOwn();
  assert.deepEqual(await pending, { result: "cancelled" }); assert.equal(h.cancels.length, 1);
  const lost = h.adapter.claim("seat-b");
  await delay(ROOM_PLUGIN_ARRIVAL.claimResponseMs + 50);
  assert.deepEqual(await lost, { result: "offline" }); assert.equal(h.cancels.length, 2);
  h.adapter.stop("offline"); assert.equal(h.adapter.arrivalAllowed(), false);
});

test("snapshots use binding-scoped pseudonyms and minimize data for plugins without seating", () => {
  const h = harness({ ready: true, occupancy: { "seat-b": "someone-else" } }); h.adapter.activate();
  const first = h.adapter.snapshot("binding-1", true), again = h.adapter.snapshot("binding-1", true), other = h.adapter.snapshot("binding-2", true);
  assert.equal(first.ownParticipantAlias, again.ownParticipantAlias); assert.notEqual(first.ownParticipantAlias, other.ownParticipantAlias);
  assert.equal(JSON.stringify([first, other]).includes("self-private-id") || JSON.stringify([first, other]).includes("someone-else"), false);
  assert.deepEqual(first.seats.map(seat => seat.id), ["seat-a", "seat-b"]); assert.equal(first.seats[0].occupantAlias, null);
  assert.equal(first.arrivalAllowed, true);
  const statusOnly = h.adapter.snapshot("binding-3", false);
  assert.deepEqual([statusOnly.seats, statusOnly.arrivalAllowed], [[], false]);
  h.adapter.forget("binding-1");
  assert.notEqual(h.adapter.snapshot("binding-1", true).ownParticipantAlias, first.ownParticipantAlias, "a new instance gets new aliases");
});
