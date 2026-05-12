import test from "node:test";
import assert from "node:assert/strict";

import { claimSeat, createParticipantState, createRoomState, joinRoom, leaveRoom, mergeParticipantState, releaseSeat, updateParticipantState } from "./state.js";

test("joinRoom adds participant once", () => {
  const room = joinRoom(createRoomState("demo"), "p1");
  const duplicated = joinRoom(room, "p1");
  assert.equal(duplicated.participants.length, 1);
});

test("joinRoom assigns access role and permissions", () => {
  const room = joinRoom(createRoomState("demo"), "p1", { role: "host" });
  assert.equal(room.participants[0]?.role, "host");
  assert.equal(room.participants[0]?.permissions.includes("screen-share.start"), true);
});

test("updateParticipantState does not allow client-side role escalation", () => {
  const joined = joinRoom(createRoomState("demo"), "p1");
  const updated = updateParticipantState(joined, {
    participantId: "p1",
    role: "host",
    permissions: ["screen-share.start"]
  });
  assert.equal(updated.participants[0]?.role, "guest");
  assert.equal(updated.participants[0]?.permissions.includes("screen-share.start"), false);
});

test("leaveRoom removes participant", () => {
  const room = leaveRoom(joinRoom(createRoomState("demo"), "p1"), "p1");
  assert.equal(room.participants.length, 0);
});

test("updateParticipantState replaces matching participant", () => {
  const joined = joinRoom(createRoomState("demo"), "p1");
  const updated = updateParticipantState(joined, {
    participantId: "p1",
    rootTransform: { x: 5, y: 0, z: 7 },
    mode: "vr"
  });
  assert.equal(updated.participants[0]?.rootTransform.x, 5);
  assert.equal(updated.participants[0]?.mode, "vr");
});

test("mergeParticipantState preserves existing head and body transforms on partial updates", () => {
  const current = createParticipantState("p1");
  const merged = mergeParticipantState(current, {
    rootTransform: { x: 3, y: 0, z: 4 },
    activeMedia: { audio: true, screenShare: false },
    updatedAt: "2026-03-28T10:00:00.000Z"
  });

  assert.deepEqual(merged.bodyTransform, current.bodyTransform);
  assert.deepEqual(merged.headTransform, current.headTransform);
  assert.equal(merged.rootTransform.x, 3);
  assert.equal(merged.activeMedia.audio, true);
  assert.equal(merged.updatedAt, "2026-03-28T10:00:00.000Z");
});

test("mergeParticipantState defaults missing orientation to zero and preserves new orientation", () => {
  const current = createParticipantState("p1");
  const legacy = mergeParticipantState(current, {
    rootTransform: { x: 1, y: 0, z: 2 }
  });
  const oriented = mergeParticipantState(legacy, {
    rootTransform: { x: 1, y: 0, z: 2, yaw: 0.8 },
    headTransform: { x: 1, y: 1.6, z: 2, yaw: 0.9, pitch: -0.2 }
  });

  assert.equal(legacy.rootTransform.yaw, 0);
  assert.equal(oriented.rootTransform.yaw, 0.8);
  assert.equal(oriented.headTransform?.yaw, 0.9);
  assert.equal(oriented.headTransform?.pitch, -0.2);
});

test("updateParticipantState ignores stale lower sequence updates", () => {
  const room = updateParticipantState(joinRoom(createRoomState("demo"), "p1"), {
    participantId: "p1",
    rootTransform: { x: 5, y: 0, z: 7, yaw: 1 },
    seq: 5,
    clientTimeMs: 500
  });
  const stale = updateParticipantState(room, {
    participantId: "p1",
    rootTransform: { x: 99, y: 0, z: 99, yaw: 3 },
    seq: 4,
    clientTimeMs: 400
  });

  assert.equal(stale.participants[0]?.rootTransform.x, 5);
  assert.equal(stale.participants[0]?.rootTransform.yaw, 1);
  assert.equal(stale.participants[0]?.seq, 5);
});

test("claimSeat assigns free seat to participant", () => {
  const room = joinRoom(createRoomState("demo"), "p1");
  const result = claimSeat(room, "p1", "seat-a");
  assert.equal(result.accepted, true);
  assert.equal(result.room.seatOccupancy["seat-a"], "p1");
});

test("claimSeat rejects occupied seat for another participant", () => {
  const joined = joinRoom(joinRoom(createRoomState("demo"), "p1"), "p2");
  const occupied = claimSeat(joined, "p1", "seat-a").room;
  const rejected = claimSeat(occupied, "p2", "seat-a");
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.occupantId, "p1");
  assert.equal(rejected.room.seatOccupancy["seat-a"], "p1");
});

test("claimSeat switches participant from previous seat atomically", () => {
  const room = claimSeat(joinRoom(createRoomState("demo"), "p1"), "p1", "seat-a").room;
  const switched = claimSeat(room, "p1", "seat-b");
  assert.equal(switched.accepted, true);
  assert.equal(switched.previousSeatId, "seat-a");
  assert.equal(switched.room.seatOccupancy["seat-a"], undefined);
  assert.equal(switched.room.seatOccupancy["seat-b"], "p1");
});

test("releaseSeat clears current participant seat", () => {
  const room = claimSeat(joinRoom(createRoomState("demo"), "p1"), "p1", "seat-a").room;
  const released = releaseSeat(room, "p1");
  assert.equal(released.releasedSeatId, "seat-a");
  assert.equal(released.room.seatOccupancy["seat-a"], undefined);
});

test("leaveRoom clears occupied seats for participant", () => {
  const room = claimSeat(joinRoom(createRoomState("demo"), "p1"), "p1", "seat-a").room;
  const left = leaveRoom(room, "p1");
  assert.equal(left.participants.length, 0);
  assert.equal(left.seatOccupancy["seat-a"], undefined);
});
