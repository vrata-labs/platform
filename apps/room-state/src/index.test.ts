import test from "node:test";
import assert from "node:assert/strict";

import {
  applySeatClaim,
  applySeatRelease,
  applyAvatarReliableState,
  connectParticipant,
  createRoomStateServer,
  relayAvatarPoseFrame
} from "./index.js";

function createSocket() {
  const sent: string[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(payload: string) {
      sent.push(payload);
    }
  };
}

test("connectParticipant replays stored reliable avatar state to late joiner", () => {
  const server = createRoomStateServer();
  const firstSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", firstSocket as never);
  applyAvatarReliableState(server, "demo-room", "p1", {
    participantId: "spoofed",
    avatarId: "preset-01",
    recipeVersion: 1,
    inputMode: "desktop",
    seated: false,
    muted: false,
    audioActive: true,
    updatedAt: new Date(0).toISOString()
  });

  const lateJoinSocket = createSocket();
  connectParticipant(server, "demo-room", "p2", lateJoinSocket as never);

  const payloads = lateJoinSocket.sent.map((item) => JSON.parse(item));
  const reliablePayload = payloads.find((item) => item.type === "avatar_reliable_state");
  assert.equal(reliablePayload?.reliableState.participantId, "p1");
  assert.equal(reliablePayload?.reliableState.avatarId, "preset-01");
});

test("applyAvatarReliableState overrides spoofed participant id and broadcasts", () => {
  const server = createRoomStateServer();
  const firstSocket = createSocket();
  const secondSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", firstSocket as never);
  connectParticipant(server, "demo-room", "p2", secondSocket as never);

  applyAvatarReliableState(server, "demo-room", "p1", {
    participantId: "spoofed",
    avatarId: "preset-02",
    recipeVersion: 1,
    inputMode: "vr-controller",
    seated: false,
    muted: false,
    audioActive: true,
    updatedAt: new Date(0).toISOString()
  });

  const payload = JSON.parse(secondSocket.sent[secondSocket.sent.length - 1]!);
  assert.equal(payload.type, "avatar_reliable_state");
  assert.equal(payload.reliableState.participantId, "p1");
  assert.equal(payload.reliableState.inputMode, "vr-controller");
});

test("relayAvatarPoseFrame broadcasts validated pose payload with server participant id", () => {
  const server = createRoomStateServer();
  const firstSocket = createSocket();
  const secondSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", firstSocket as never);
  connectParticipant(server, "demo-room", "p2", secondSocket as never);

  relayAvatarPoseFrame(server, "demo-room", "p1", {
    seq: 3,
    sentAtMs: 10,
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: -0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: 0.2, y: 1.2, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  });

  const payload = JSON.parse(secondSocket.sent[secondSocket.sent.length - 1]!);
  assert.equal(payload.type, "avatar_pose_preview");
  assert.equal(payload.participantId, "p1");
  assert.equal(payload.poseFrame.seq, 3);
});

test("avatar relay helpers reject invalid payloads", () => {
  const server = createRoomStateServer();
  assert.throws(() => applyAvatarReliableState(server, "demo-room", "p1", { avatarId: "preset-01" }), /invalid_avatar_reliable_state/);
  assert.throws(() => relayAvatarPoseFrame(server, "demo-room", "p1", { seq: 1 }), /invalid_avatar_pose_preview/);
});

test("applySeatClaim uses first claim wins and keeps previous occupant", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "p1", createSocket() as never);
  connectParticipant(server, "demo-room", "p2", createSocket() as never);

  const first = applySeatClaim(server, "demo-room", "p1", "seat-a");
  const second = applySeatClaim(server, "demo-room", "p2", "seat-a");

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.occupantId, "p1");
  assert.equal(server.rooms.get("demo-room")?.seatOccupancy["seat-a"], "p1");
});

test("applySeatClaim switches seats for same participant atomically", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "p1", createSocket() as never);

  applySeatClaim(server, "demo-room", "p1", "seat-a");
  const switched = applySeatClaim(server, "demo-room", "p1", "seat-b");

  assert.equal(switched.accepted, true);
  assert.equal(switched.previousSeatId, "seat-a");
  assert.equal(server.rooms.get("demo-room")?.seatOccupancy["seat-a"], undefined);
  assert.equal(server.rooms.get("demo-room")?.seatOccupancy["seat-b"], "p1");
});

test("applySeatRelease clears occupied seat for participant", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "p1", createSocket() as never);

  applySeatClaim(server, "demo-room", "p1", "seat-a");
  const releasedSeatId = applySeatRelease(server, "demo-room", "p1");

  assert.equal(releasedSeatId, "seat-a");
  assert.equal(server.rooms.get("demo-room")?.seatOccupancy["seat-a"], undefined);
});
