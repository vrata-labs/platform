import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAcceptedSeatClaimToOccupancy,
  applyForcedSeatOccupancy,
  removeLocalSeatFromOccupancy,
  removeParticipantFromSeatOccupancy
} from "./seat-occupancy.js";

test("removeParticipantFromSeatOccupancy clears every local occupied seat without mutating input", () => {
  const occupancy = { "seat-a": "p-1", "seat-b": "p-2", "seat-c": "p-1" };

  const result = removeParticipantFromSeatOccupancy(occupancy, "p-1");

  assert.deepEqual(result, { "seat-b": "p-2" });
  assert.deepEqual(occupancy, { "seat-a": "p-1", "seat-b": "p-2", "seat-c": "p-1" });
});

test("removeLocalSeatFromOccupancy only clears the requested seat when occupied by local participant", () => {
  const occupancy = { "seat-a": "p-1", "seat-b": "p-2" };

  assert.deepEqual(removeLocalSeatFromOccupancy(occupancy, { seatId: "seat-a", participantId: "p-1" }), { "seat-b": "p-2" });
  assert.deepEqual(removeLocalSeatFromOccupancy(occupancy, { seatId: "seat-b", participantId: "p-1" }), occupancy);
});

test("applyForcedSeatOccupancy overlays local forced seat without mutating input", () => {
  const occupancy = { "seat-a": "p-2" };

  const result = applyForcedSeatOccupancy(occupancy, { forcedSeatId: "seat-b", participantId: "p-1" });

  assert.deepEqual(result, { "seat-a": "p-2", "seat-b": "p-1" });
  assert.deepEqual(occupancy, { "seat-a": "p-2" });
});

test("applyAcceptedSeatClaimToOccupancy moves local occupancy after accepted claim", () => {
  const result = applyAcceptedSeatClaimToOccupancy(
    { "seat-a": "p-1", "seat-c": "p-2" },
    {
      participantId: "p-1",
      result: {
        seatId: "seat-b",
        accepted: true,
        previousSeatId: "seat-a"
      }
    }
  );

  assert.deepEqual(result, { "seat-b": "p-1", "seat-c": "p-2" });
});

test("applyAcceptedSeatClaimToOccupancy leaves occupancy unchanged for rejected claim", () => {
  const occupancy = { "seat-a": "p-1", "seat-b": "p-2" };

  const result = applyAcceptedSeatClaimToOccupancy(occupancy, {
    participantId: "p-1",
    result: {
      seatId: "seat-c",
      accepted: false,
      previousSeatId: null
    }
  });

  assert.deepEqual(result, occupancy);
  assert.notEqual(result, occupancy);
});
