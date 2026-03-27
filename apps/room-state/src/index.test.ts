import test from "node:test";
import assert from "node:assert/strict";

import { createRoomState, joinRoom } from "./state.js";

test("joinRoom appends participant", () => {
  const state = joinRoom(createRoomState("demo-room"), "p1");
  assert.equal(state.participants.length, 1);
  assert.equal(state.participants[0]?.participantId, "p1");
});
