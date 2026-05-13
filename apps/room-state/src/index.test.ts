import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAvatarReliableState,
  applyMediaObjectCreateCommand,
  applyMediaObjectPatchCommand,
  applyMediaObjectStopCommand,
  applyPrivilegedRoomCommand,
  applySeatClaim,
  applySeatRelease,
  applySurfaceMediaAudioCommand,
  connectParticipant,
  createRoomStateServer,
  disconnectParticipant,
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

test("applyPrivilegedRoomCommand rejects guest and accepts host permissions", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "guest", createSocket() as never);
  connectParticipant(server, "demo-room", "host", createSocket() as never, { role: "host" });

  const guestResult = applyPrivilegedRoomCommand(server, "demo-room", "guest", "surface.create-object");
  const hostResult = applyPrivilegedRoomCommand(server, "demo-room", "host", "surface.create-object");

  assert.equal(guestResult.accepted, false);
  assert.equal(guestResult.role, "guest");
  assert.equal(hostResult.accepted, true);
  assert.equal(hostResult.role, "host");
});

test("media object commands mutate authoritative room state", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "host", createSocket() as never, { role: "host" });
  connectParticipant(server, "demo-room", "member", createSocket() as never, { role: "member" });

  const created = applyMediaObjectCreateCommand(server, "demo-room", "host", {
    commandId: "cmd-create",
    surfaceId: "debug-main",
    objectType: "surface-test-card"
  });

  assert.equal(created.accepted, true);
  assert.equal(server.rooms.get("demo-room")?.mediaObjects.surfaces["debug-main"]?.activeObjectId, created.objectId);

  const patched = applyMediaObjectPatchCommand(server, "demo-room", "member", {
    commandId: "cmd-patch",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 0,
    patch: { type: "increment-click-count", inputEventId: "member:1" }
  });

  assert.equal(patched.accepted, true);
  assert.equal(patched.revision, 1);

  const stopped = applyMediaObjectStopCommand(server, "demo-room", "host", {
    commandId: "cmd-stop",
    surfaceId: "debug-main",
    objectId: created.objectId ?? ""
  });

  assert.equal(stopped.accepted, true);
  assert.equal(server.rooms.get("demo-room")?.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
});

test("screen-share commands mutate authoritative room state", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "host", createSocket() as never, { role: "host" });

  const created = applyMediaObjectCreateCommand(server, "demo-room", "host", {
    commandId: "cmd-create-share",
    surfaceId: "debug-main",
    objectType: "screen-share"
  });
  assert.equal(created.accepted, true);
  assert.equal(created.objectType, "screen-share");

  const active = applyMediaObjectPatchCommand(server, "demo-room", "host", {
    commandId: "cmd-active-share",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 0,
    patch: { type: "mark-active", mediaTrackSid: "track-1" }
  });
  assert.equal(active.accepted, true);
  assert.equal(active.revision, 1);
  assert.equal((server.rooms.get("demo-room")?.mediaObjects.objects[created.objectId ?? ""]?.state as { mediaTrackSid?: string } | undefined)?.mediaTrackSid, "track-1");
});

test("whiteboard commands append and clear strokes through authoritative room state", () => {
  const server = createRoomStateServer();
  const memberSocket = createSocket();
  connectParticipant(server, "demo-room", "host", createSocket() as never, { role: "host" });
  connectParticipant(server, "demo-room", "member", memberSocket as never, { role: "member" });

  const created = applyMediaObjectCreateCommand(server, "demo-room", "host", {
    commandId: "cmd-create-whiteboard",
    surfaceId: "debug-main",
    objectType: "whiteboard"
  });
  assert.equal(created.accepted, true);
  assert.equal(created.objectType, "whiteboard");

  const appended = applyMediaObjectPatchCommand(server, "demo-room", "member", {
    commandId: "cmd-append-whiteboard",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 0,
    patch: {
      type: "append-stroke",
      inputEventId: "member:stroke:1",
      stroke: {
        strokeId: "stroke-1",
        participantId: "member",
        tool: "pen",
        color: "#2563eb",
        width: 4,
        points: [{ u: 0.2, v: 0.3, t: 10 }]
      }
    }
  });
  assert.equal(appended.accepted, true);
  assert.equal(appended.permission, "whiteboard.draw");
  assert.equal((server.rooms.get("demo-room")?.mediaObjects.objects[created.objectId ?? ""]?.state as { strokes?: unknown[] } | undefined)?.strokes?.length, 1);

  const rejectedClear = applyMediaObjectPatchCommand(server, "demo-room", "member", {
    commandId: "cmd-member-clear-whiteboard",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 1,
    patch: { type: "clear", inputEventId: "member:clear:1" }
  });
  assert.equal(rejectedClear.accepted, false);
  assert.equal(rejectedClear.permission, "whiteboard.clear");

  const cleared = applyMediaObjectPatchCommand(server, "demo-room", "host", {
    commandId: "cmd-clear-whiteboard",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 1,
    patch: { type: "clear", inputEventId: "host:clear:1" }
  });
  assert.equal(cleared.accepted, true);
  assert.equal((server.rooms.get("demo-room")?.mediaObjects.objects[created.objectId ?? ""]?.state as { strokes?: unknown[] } | undefined)?.strokes?.length, 0);

  const payload = JSON.parse(memberSocket.sent[memberSocket.sent.length - 1]!);
  assert.equal(payload.type, "room_state");
  assert.equal(payload.room.mediaObjects.objects[created.objectId ?? ""].state.strokes.length, 0);
});

test("surface media audio command is admin-only and broadcasts accepted changes", () => {
  const server = createRoomStateServer();
  const hostSocket = createSocket();
  const adminSocket = createSocket();
  connectParticipant(server, "demo-room", "host", hostSocket as never, { role: "host" });
  connectParticipant(server, "demo-room", "admin", adminSocket as never, { role: "admin" });

  const rejected = applySurfaceMediaAudioCommand(server, "demo-room", "host", {
    commandId: "cmd-host-audio",
    surfaceId: "debug-main",
    enabled: true
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.permission, "surface.configure-audio");
  assert.equal(rejected.blockedReason, "missing-permission");
  assert.equal(server.rooms.get("demo-room")?.mediaObjects.surfaces["debug-main"]?.mediaAudioEnabled, false);

  const accepted = applySurfaceMediaAudioCommand(server, "demo-room", "admin", {
    commandId: "cmd-admin-audio",
    surfaceId: "debug-main",
    enabled: true
  });
  assert.equal(accepted.accepted, true);
  assert.equal(server.rooms.get("demo-room")?.mediaObjects.surfaces["debug-main"]?.mediaAudioEnabled, true);

  const payload = JSON.parse(hostSocket.sent[hostSocket.sent.length - 1]!);
  assert.equal(payload.type, "room_state");
  assert.equal(payload.room.mediaObjects.surfaces["debug-main"].mediaAudioEnabled, true);
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

test("late join room snapshot includes occupied seats", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "p1", createSocket() as never);
  applySeatClaim(server, "demo-room", "p1", "seat-a");

  const lateJoinSocket = createSocket();
  connectParticipant(server, "demo-room", "p2", lateJoinSocket as never);

  const payloads = lateJoinSocket.sent.map((item) => JSON.parse(item));
  const roomPayload = [...payloads].reverse().find((item: { type?: string }) => item.type === "room_state");
  assert.equal(roomPayload?.room?.seatOccupancy?.["seat-a"], "p1");
  assert.equal(roomPayload?.room?.participants?.length, 2);
});

test("reconnecting same participant does not duplicate occupied seat state", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "demo-room", "p1", createSocket() as never);
  applySeatClaim(server, "demo-room", "p1", "seat-a");

  const reconnectSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", reconnectSocket as never);

  const room = server.rooms.get("demo-room");
  assert.equal(room?.participants.length, 1);
  assert.equal(room?.participants[0]?.participantId, "p1");
  assert.equal(room?.seatOccupancy["seat-a"], "p1");

  const payloads = reconnectSocket.sent.map((item) => JSON.parse(item));
  const roomPayload = [...payloads].reverse().find((item: { type?: string }) => item.type === "room_state");
  assert.equal(roomPayload?.room?.participants?.length, 1);
  assert.equal(roomPayload?.room?.seatOccupancy?.["seat-a"], "p1");
});

test("disconnecting stale socket after same participant reconnect does not clear occupied seat", () => {
  const server = createRoomStateServer();
  const firstSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", firstSocket as never);
  applySeatClaim(server, "demo-room", "p1", "seat-a");

  const secondSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", secondSocket as never);
  disconnectParticipant(server, "demo-room", "p1", firstSocket as never);

  const room = server.rooms.get("demo-room");
  assert.equal(room?.participants.length, 1);
  assert.equal(room?.seatOccupancy["seat-a"], "p1");
});

test("reconnect during disconnect grace keeps occupied seat", async () => {
  const server = createRoomStateServer();
  const firstSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", firstSocket as never);
  applySeatClaim(server, "demo-room", "p1", "seat-a");

  disconnectParticipant(server, "demo-room", "p1", firstSocket as never);
  const reconnectSocket = createSocket();
  connectParticipant(server, "demo-room", "p1", reconnectSocket as never);

  await new Promise((resolve) => setTimeout(resolve, 1700));

  const room = server.rooms.get("demo-room");
  assert.equal(room?.participants.length, 1);
  assert.equal(room?.seatOccupancy["seat-a"], "p1");
});
