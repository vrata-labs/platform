import test from "node:test";
import assert from "node:assert/strict";

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
