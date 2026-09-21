import test from "node:test";
import assert from "node:assert/strict";
import { createSeatingController } from "./seating-controller.js";

import {
  DEFAULT_SEAT_RECLAIM_RETRY_DELAY_MS,
  planSeatReclaimOnReconnect,
  shouldRetrySeatReclaim
} from "./seat-reclaim.js";

test("seat reclaim planner emits claim commands for current seat after reconnect", () => {
  const plan = planSeatReclaimOnReconnect({
    currentSeatId: "seat-a",
    seatingEnabled: true,
    roomStateClientAvailable: true
  });

  assert.equal(plan.seatId, "seat-a");
  assert.equal(plan.retryDelayMs, DEFAULT_SEAT_RECLAIM_RETRY_DELAY_MS);
  assert.deepEqual(plan.commands, [
    { type: "request_seat_claim", seatId: "seat-a" },
    { type: "send_seat_claim", seatId: "seat-a" }
  ]);
});

test("seat reclaim planner stays idle without a reclaimable connected seat", () => {
  assert.deepEqual(planSeatReclaimOnReconnect({
    currentSeatId: null,
    seatingEnabled: true,
    roomStateClientAvailable: true
  }), { seatId: null, commands: [], retryDelayMs: null });
  assert.deepEqual(planSeatReclaimOnReconnect({
    currentSeatId: "seat-a",
    seatingEnabled: false,
    roomStateClientAvailable: true
  }), { seatId: null, commands: [], retryDelayMs: null });
  assert.deepEqual(planSeatReclaimOnReconnect({
    currentSeatId: "seat-a",
    seatingEnabled: true,
    roomStateClientAvailable: false
  }), { seatId: null, commands: [], retryDelayMs: null });
});

test("seat reclaim retry only resends while the same client is still pending", () => {
  const base = {
    seatId: "seat-a",
    roomStateConnected: true,
    sameRoomStateClient: true,
    currentSeatId: null,
    pendingSeatId: "seat-a"
  };

  assert.equal(shouldRetrySeatReclaim(base), true);
  assert.equal(shouldRetrySeatReclaim({ ...base, roomStateConnected: false }), false);
  assert.equal(shouldRetrySeatReclaim({ ...base, sameRoomStateClient: false }), false);
  assert.equal(shouldRetrySeatReclaim({ ...base, currentSeatId: "seat-a" }), false);
  assert.equal(shouldRetrySeatReclaim({ ...base, pendingSeatId: null }), false);
  assert.equal(shouldRetrySeatReclaim({ ...base, pendingSeatId: "seat-b" }), false);
});

test("reconnect resends a locally released seat until authoritative occupancy acknowledges it", () => {
  const controller = createSeatingController({ participantId: "p1" });
  controller.applyOccupancy({ seatOccupancy: { "seat-a": "p1" } });
  controller.releaseLocal();
  controller.applyOccupancy({ seatOccupancy: { "seat-a": "p1" } });
  assert.equal(controller.getCurrentSeatId(), null);
  const input = () => ({ currentSeatId: controller.getCurrentSeatId(), pendingReleaseSeatIds: controller.getPendingReleaseSeatIds(), seatingEnabled: true, roomStateClientAvailable: true });
  const expected = { seatId: null, commands: [{ type: "send_seat_release", seatId: "seat-a" }], retryDelayMs: null };
  assert.deepEqual(planSeatReclaimOnReconnect(input()), expected);
  assert.deepEqual(planSeatReclaimOnReconnect(input()), expected);
  controller.applyOccupancy({ seatOccupancy: {} });
  assert.deepEqual(planSeatReclaimOnReconnect(input()), { seatId: null, commands: [], retryDelayMs: null });
});

test("pending release cleanup does not depend on seating being enabled after reconnect", () => {
  const input = { currentSeatId: null, pendingReleaseSeatIds: ["seat-a"], seatingEnabled: false, roomStateClientAvailable: true };
  assert.deepEqual(planSeatReclaimOnReconnect(input), {
    seatId: null, commands: [{ type: "send_seat_release", seatId: "seat-a" }], retryDelayMs: null
  });
  assert.deepEqual(planSeatReclaimOnReconnect({ ...input, roomStateClientAvailable: false }), { seatId: null, commands: [], retryDelayMs: null });
});

test("reconnect releases the previous seat before reclaiming another current seat", () => {
  const controller = createSeatingController({ participantId: "p1" });
  controller.forceSeated("seat-a");
  controller.releaseLocal();
  controller.forceSeated("seat-b");
  assert.deepEqual(planSeatReclaimOnReconnect({
    currentSeatId: controller.getCurrentSeatId(), pendingReleaseSeatIds: controller.getPendingReleaseSeatIds(), seatingEnabled: true, roomStateClientAvailable: true
  }).commands, [
    { type: "send_seat_release", seatId: "seat-a" },
    { type: "request_seat_claim", seatId: "seat-b" },
    { type: "send_seat_claim", seatId: "seat-b" }
  ]);
});

test("new seat intent, acknowledgement by another occupant, and reset clear pending releases", () => {
  const controller = createSeatingController({ participantId: "p1" });
  for (const reset of [
    () => controller.requestSeatClaim("seat-a"),
    () => controller.forceSeated("seat-a"),
    () => controller.applyOccupancy({ seatOccupancy: { "seat-a": "p2" } }),
    () => controller.reset()
  ]) {
    controller.forceSeated("seat-a");
    controller.releaseLocal();
    const detached = controller.getPendingReleaseSeatIds();
    detached.push("not-a-pending-seat");
    assert.deepEqual(controller.getPendingReleaseSeatIds(), ["seat-a"]);
    reset();
    assert.deepEqual(controller.getPendingReleaseSeatIds(), []);
  }
});
