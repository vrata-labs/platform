import test from "node:test";
import assert from "node:assert/strict";
import { isManualLocomotionCommand } from "../locomotion/runtime-commands.js";
import { planStandUp, STAND_UP_STATUS } from "./stand-up.js";

test("standing up releases only a confirmed seat, returns to the entry point and counts as a manual intent", () => {
  assert.deepEqual(planStandUp({ seatId: null, exit: { x: 0, y: 0, z: 0 } }), []);
  const commands = planStandUp({ seatId: "seat-a", exit: { x: 1, y: 0, z: 4 } });
  assert.deepEqual(commands, [
    { type: "telemetry", kind: "seat_release" },
    { type: "send_seat_release", seatId: "seat-a" },
    { type: "release_local_seat" },
    { type: "teleport_to_floor", point: { x: 1, y: 0, z: 4 } },
    { type: "status", message: STAND_UP_STATUS }
  ]);
  assert.equal(commands.some(isManualLocomotionCommand), true, "an explicit stand vetoes automatic seating");
  assert.deepEqual(planStandUp({ seatId: "seat-a", exit: null }).map(command => command.type), ["telemetry", "send_seat_release", "release_local_seat", "status"]);
});
