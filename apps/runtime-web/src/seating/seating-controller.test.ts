import test from "node:test";
import assert from "node:assert/strict";

import { createSeatingController } from "./seating-controller.js";

test("seating controller preserves authoritative occupancy before anchors", () => {
  const seating = createSeatingController({ participantId: "p-1" });

  const snapshot = seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } });

  assert.equal(snapshot.currentSeatId, "seat-a");
  assert.equal(snapshot.pendingSeatId, null);
});

test("seating controller keeps seat when anchors later contain it", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } });

  const result = seating.reconcileAnchors(new Set(["seat-a"]));

  assert.equal(result.snapshot.currentSeatId, "seat-a");
  assert.deepEqual(result.commands, []);
});

test("seating controller releases when authoritative seat anchor is missing", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } });

  const result = seating.reconcileAnchors(new Set(["seat-b"]));

  assert.equal(result.snapshot.currentSeatId, null);
  assert.deepEqual(result.commands, [{ type: "send_seat_release", seatId: "seat-a" }]);
});

test("in-flight pre-release room snapshots cannot reseat a teleported participant", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } });
  seating.releaseLocal();
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).currentSeatId, null);
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).currentSeatId, null);
  seating.applyOccupancy({ seatOccupancy: {} });
  seating.requestSeatClaim("seat-a");
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).currentSeatId, "seat-a");
});

test("release suppression does not prevent claiming another seat or an explicit same-seat reclaim", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.forceSeated("seat-a");
  seating.releaseLocal();
  seating.requestSeatClaim("seat-b");
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).pendingSeatId, "seat-b");
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-b": "p-1" } }).currentSeatId, "seat-b");
  seating.releaseLocal();
  seating.requestSeatClaim("seat-b");
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-b": "p-1" } }).currentSeatId, "seat-b");
});

test("pre-join identity adoption retargets the same controller without inheriting public-ID occupancy", () => {
  const seating = createSeatingController({ participantId: "untrusted-tab-id" });
  const bridgeReference = seating;
  seating.adoptParticipantId("server-issued-id");
  assert.equal(seating, bridgeReference);
  assert.equal(seating.applyOccupancy({ seatOccupancy: { chair: "untrusted-tab-id" } }).currentSeatId, null);
  assert.equal(seating.applyOccupancy({ seatOccupancy: { chair: "server-issued-id" } }).currentSeatId, "chair");
  assert.throws(() => seating.adoptParticipantId("another-id"), /seating_identity_transition_requires_standing/);
});

test("cancel → early empty snapshot → late accept never seats; only the release acknowledgement lifts suppression", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.requestSeatClaim("seat-a");
  const cancelled = seating.cancelPending("release:1");
  assert.deepEqual(cancelled.commands, [{ type: "send_seat_release", seatId: "seat-a", commandId: "release:1" }]);
  assert.equal(cancelled.snapshot.pendingSeatId, null);
  // An older snapshot from before the server processed the claim arrives first.
  assert.equal(seating.applyOccupancy({ seatOccupancy: {} }).currentSeatId, null);
  // The late accept and its broadcast still cannot produce a seated state or pose.
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).currentSeatId, null);
  assert.deepEqual(seating.getPendingCorrelatedReleases(), [{ seatId: "seat-a", commandId: "release:1" }]);
  seating.applyOccupancy({ seatOccupancy: {} });
  seating.acknowledgeRelease("release:1");
  assert.deepEqual(seating.getPendingCorrelatedReleases(), []);
  assert.equal(seating.applyOccupancy({ seatOccupancy: {} }).currentSeatId, null);
});

test("a manual reclaim of the cancelled seat is honoured only after the old release is acknowledged", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.requestSeatClaim("seat-a");
  seating.cancelPending("release:1");
  seating.requestSeatClaim("seat-a");
  assert.equal(seating.getPendingSeatId(), "seat-a");
  // The new claim is sent after the release on the same ordered socket; an accept seen
  // before the acknowledgement still belongs to the cancelled attempt.
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).currentSeatId, null);
  seating.acknowledgeRelease("release:1");
  assert.equal(seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } }).currentSeatId, "seat-a");
});

test("cancel never releases a confirmed seat and duplicate cancellation sends nothing", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.applyOccupancy({ seatOccupancy: { "seat-a": "p-1" } });
  assert.deepEqual(seating.cancelPending("release:1").commands, []);
  assert.equal(seating.getCurrentSeatId(), "seat-a");
  seating.releaseLocal(); seating.applyOccupancy({ seatOccupancy: {} });
  seating.requestSeatClaim("seat-b");
  assert.equal(seating.cancelPending("release:2").commands.length, 1);
  assert.deepEqual(seating.cancelPending("release:2").commands, []);
  assert.throws(() => seating.adoptParticipantId("other"), /seating_identity_transition_requires_standing/);
  seating.reset();
  assert.deepEqual(seating.getPendingCorrelatedReleases(), []);
});

test("a late rejection of a cancelled or older claim never clears the newer pending claim", () => {
  const seating = createSeatingController({ participantId: "p-1" });
  seating.requestSeatClaim("seat-a", "plugin:1");
  seating.cancelPending("release:1");
  seating.requestSeatClaim("seat-b");
  assert.equal(seating.isCancelledClaim("plugin:1"), true);
  assert.equal(seating.settleRejectedClaim({ seatId: "seat-a", commandId: "plugin:1" }).pendingSeatId, "seat-b");
  assert.equal(seating.settleRejectedClaim({ seatId: "seat-a" }).pendingSeatId, "seat-b", "a different seat answer is not ours");
  assert.equal(seating.settleRejectedClaim({ seatId: "seat-b", commandId: "plugin:other" }).pendingSeatId, "seat-b");
  assert.equal(seating.settleRejectedClaim({ seatId: "seat-b" }).pendingSeatId, null, "the legacy manual answer clears its own claim");
  seating.acknowledgeRelease("release:1");
  assert.equal(seating.isCancelledClaim("plugin:1"), false);
  seating.requestSeatClaim("seat-c", "plugin:2");
  assert.equal(seating.settleRejectedClaim({ seatId: "seat-c", commandId: "plugin:2" }).pendingSeatId, null);
});
