import test from "node:test";
import assert from "node:assert/strict";

import type { SceneBundleSeatAnchor } from "../scene-bundle.js";
import {
  createSeatAnchorReadModel,
  planMissingCurrentSeatAnchorCommands,
  planSeatAnchorReconciliation
} from "./seat-anchor-reconcile.js";

function anchor(id: string): SceneBundleSeatAnchor {
  return {
    id,
    position: { x: 1, y: 0, z: -2 },
    yaw: 0,
    seatHeight: 0.5,
    radius: 0.8,
    label: `Seat ${id}`
  };
}

test("createSeatAnchorReadModel indexes anchors and available seat ids", () => {
  const seatA = anchor("seat-a");
  const seatB = anchor("seat-b");

  const readModel = createSeatAnchorReadModel([seatA, seatB], -0.1);

  assert.deepEqual(readModel.anchors, [seatA, seatB]);
  assert.equal(readModel.anchorMap.get("seat-a"), seatA);
  assert.equal(readModel.anchorMap.get("seat-b"), seatB);
  assert.deepEqual([...readModel.availableSeatIds], ["seat-a", "seat-b"]);
  assert.equal(readModel.teleportFloorY, -0.1);
});

test("planSeatAnchorReconciliation removes local released seats and emits release commands", () => {
  const occupancy = { "seat-a": "local", "seat-b": "remote" };

  const plan = planSeatAnchorReconciliation({
    releases: [{ type: "send_seat_release", seatId: "seat-a" }],
    seatOccupancy: occupancy,
    participantId: "local"
  });

  assert.deepEqual(plan.seatOccupancy, { "seat-b": "remote" });
  assert.notEqual(plan.seatOccupancy, occupancy);
  assert.equal(plan.resetSeatLock, true);
  assert.deepEqual(plan.commands, [
    { type: "send_seat_release", seatId: "seat-a" },
    { type: "status", message: "Seat anchor unavailable, returned to standing" }
  ]);
});

test("planSeatAnchorReconciliation does not remove non-local occupancy", () => {
  const occupancy = { "seat-a": "remote" };

  const plan = planSeatAnchorReconciliation({
    releases: [{ type: "send_seat_release", seatId: "seat-a" }],
    seatOccupancy: occupancy,
    participantId: "local"
  });

  assert.deepEqual(plan.seatOccupancy, occupancy);
  assert.equal(plan.resetSeatLock, true);
  assert.deepEqual(plan.commands, [
    { type: "send_seat_release", seatId: "seat-a" },
    { type: "status", message: "Seat anchor unavailable, returned to standing" }
  ]);
});

test("planMissingCurrentSeatAnchorCommands waits for anchors and releases missing seats", () => {
  const seatMap = new Map([["seat-a", anchor("seat-a")]]);

  assert.deepEqual(planMissingCurrentSeatAnchorCommands({ currentSeatId: null, anchorsReady: true, seatAnchorMap: seatMap }), []);
  assert.deepEqual(planMissingCurrentSeatAnchorCommands({ currentSeatId: "seat-a", anchorsReady: true, seatAnchorMap: seatMap }), []);
  assert.deepEqual(planMissingCurrentSeatAnchorCommands({ currentSeatId: "missing", anchorsReady: false, seatAnchorMap: seatMap }), []);
  assert.deepEqual(planMissingCurrentSeatAnchorCommands({ currentSeatId: "missing", anchorsReady: true, seatAnchorMap: seatMap }), [
    { type: "send_seat_release", seatId: "missing" },
    { type: "release_local_seat" },
    { type: "status", message: "Seat anchor unavailable, returned to standing" }
  ]);
});
