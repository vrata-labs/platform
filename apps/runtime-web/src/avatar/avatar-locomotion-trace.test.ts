import test from "node:test";
import assert from "node:assert/strict";

import {
  recordAvatarLocomotionTrace,
  replayAvatarLocomotionTraceFromInputs,
  replayAvatarLocomotionTraceFromRemoteModes
} from "./avatar-locomotion-trace.js";
import { mapAvatarLocomotionStateToMode } from "./avatar-locomotion.js";

test("record/replay locomotion trace is deterministic across the same input path", () => {
  const trace = recordAvatarLocomotionTrace([
    { moveX: 0, moveZ: 0, turnRate: 0 },
    { moveX: 0, moveZ: 1, turnRate: 0 },
    { moveX: 0.8, moveZ: 0.2, turnRate: 0 },
    { moveX: 0.2, moveZ: -0.8, turnRate: 0 },
    { moveX: 0, moveZ: 0, turnRate: 1.1 },
    { moveX: 0, moveZ: 0.09, turnRate: 0 }
  ]);
  const replay = replayAvatarLocomotionTraceFromInputs(trace);

  assert.equal(replay.every((frame) => frame.matches), true);
  assert.deepEqual(trace.map((frame) => frame.snapshot.state), ["idle", "walk", "strafe", "backpedal", "turn", "idle"]);
});

test("record/replay locomotion trace validates remote mode sequence against self trace", () => {
  const trace = recordAvatarLocomotionTrace([
    { moveX: 0, moveZ: 1, turnRate: 0 },
    { moveX: 0.9, moveZ: 0.1, turnRate: 0 },
    { moveX: 0, moveZ: -1, turnRate: 0 },
    { moveX: 0, moveZ: 0, turnRate: 1 }
  ]);
  const remoteModes = trace.map((frame) => mapAvatarLocomotionStateToMode(frame.snapshot.state));
  const replay = replayAvatarLocomotionTraceFromRemoteModes(trace, remoteModes);

  assert.equal(replay.every((frame) => frame.matches), true);
});

test("record/replay locomotion trace catches remote contract mismatches", () => {
  const trace = recordAvatarLocomotionTrace([
    { moveX: 0, moveZ: 1, turnRate: 0 },
    { moveX: 0.9, moveZ: 0.1, turnRate: 0 }
  ]);
  const replay = replayAvatarLocomotionTraceFromRemoteModes(trace, [1, 1]);

  assert.equal(replay[0]?.matches, true);
  assert.equal(replay[1]?.matches, false);
  assert.equal(replay[1]?.expectedState, "strafe");
  assert.equal(replay[1]?.actualState, "walk");
});
