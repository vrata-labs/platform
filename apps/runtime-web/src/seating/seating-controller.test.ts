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
