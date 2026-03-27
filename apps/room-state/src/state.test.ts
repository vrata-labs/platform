import test from "node:test";
import assert from "node:assert/strict";

import { createParticipantState, createRoomState, joinRoom, leaveRoom, updateParticipantState } from "./state.js";

test("joinRoom adds participant once", () => {
  const room = joinRoom(createRoomState("demo"), "p1");
  const duplicated = joinRoom(room, "p1");
  assert.equal(duplicated.participants.length, 1);
});

test("leaveRoom removes participant", () => {
  const room = leaveRoom(joinRoom(createRoomState("demo"), "p1"), "p1");
  assert.equal(room.participants.length, 0);
});

test("updateParticipantState replaces matching participant", () => {
  const joined = joinRoom(createRoomState("demo"), "p1");
  const updated = updateParticipantState(joined, { ...createParticipantState("p1"), x: 5, z: 7, mode: "vr" });
  assert.equal(updated.participants[0]?.x, 5);
  assert.equal(updated.participants[0]?.mode, "vr");
});
