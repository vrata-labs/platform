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
