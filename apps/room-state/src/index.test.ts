import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";

import {
  applyAvatarReliableState,
  applyMediaObjectCreateCommand,
  applyMediaObjectPatchCommand,
  applyRemoteBrowserExecutorPatchCommand,
  applyMediaObjectStopCommand,
  applyDocumentMediaObjectsCleanup,
  applyPdfPresentationDocumentCleanup,
  applyPrivilegedRoomCommand,
  applySeatClaim,
  applySeatRelease,
  applySurfaceMediaAudioCommand,
  connectParticipant,
  createRoomStateServer,
  disconnectParticipant,
  relayAvatarPoseFrame,
  startRoomStateService
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

test("room-state readiness endpoint reports ready", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  const server = startRoomStateService(4031);

  try {
    const response = await fetch("http://127.0.0.1:4031/health/ready", {
      headers: { "x-request-id": "room-state-request-id" }
    });
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("x-request-id"), "room-state-request-id");
    const payload = (await response.json()) as { status?: string; service?: string };
    assert.equal(payload.status, "ready");
    assert.equal(payload.service, "room-state");

    const liveResponse = await fetch("http://127.0.0.1:4031/health/live");
    assert.equal(liveResponse.ok, true);
    const livePayload = (await liveResponse.json()) as { status?: string; service?: string };
    assert.equal(livePayload.status, "live");
    assert.equal(livePayload.service, "room-state");

    const metricsResponse = await fetch("http://127.0.0.1:4031/metrics");
    assert.equal(metricsResponse.ok, true);
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /vrata_room_state_active_rooms \d+/);
    assert.match(metricsText, /vrata_room_state_active_participants \d+/);
    assert.match(metricsText, /vrata_image_viewers_started_total \d+/);
    assert.match(metricsText, /vrata_video_playback_commands_total\{command="play"\} \d+/);

    const cleanupResponse = await fetch("http://127.0.0.1:4031/api/internal/rooms/empty/documents/document-1/media-objects", { method: "DELETE" });
    assert.equal(cleanupResponse.ok, true);
    assert.deepEqual(await cleanupResponse.json(), { removedCount: 0 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
  }
});

test("room-state websocket requires valid signed room session token in production", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.NODE_ENV = "production";
  process.env.STATE_TOKEN_SECRET = "room-state-session-secret";
  const server = startRoomStateService(4034);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = signRoomSessionToken({
    tenantId: "demo-tenant",
    roomId: "demo-room",
    participantId: "p-session",
    displayName: "Session Participant",
    role: "host",
    permissions: getRoomPermissions("host"),
    sessionId: "session-1",
    iat: nowSeconds,
    exp: nowSeconds + 60,
    jti: "jti-1"
  }, "room-state-session-secret");

  try {
    const allowed = new WebSocket(`ws://127.0.0.1:4034?roomId=demo-room&participantId=p-session&accessToken=${token}`);
    await new Promise<void>((resolve, reject) => {
      allowed.once("open", resolve);
      allowed.once("error", reject);
    });
    allowed.close();

    const denied = new WebSocket(`ws://127.0.0.1:4034?roomId=demo-room&participantId=p-session&accessToken=${token.slice(0, -1)}x`);
    const close = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      denied.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
      denied.once("error", reject);
    });
    assert.equal(close.code, 1008);
    assert.equal(close.reason, "invalid_session_token");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.NODE_ENV;
    delete process.env.STATE_TOKEN_SECRET;
  }
});

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

test("PDF presentation page is retained for late join and internal document cleanup", () => {
  const server = createRoomStateServer();
  const presenterSocket = createSocket();
  connectParticipant(server, "pdf-room", "presenter", presenterSocket as never, { role: "presenter" });
  const created = applyMediaObjectCreateCommand(server, "pdf-room", "presenter", {
    commandId: "pdf-create",
    surfaceId: "debug-main",
    objectType: "pdf-presentation"
  });
  const selected = applyMediaObjectPatchCommand(server, "pdf-room", "presenter", {
    commandId: "pdf-select",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 0,
    patch: { type: "select-document", documentId: "doc-1", filename: "slides.pdf", checksum: `sha256:${"b".repeat(64)}`, pageCount: 2, inputEventId: "select-1" }
  });
  const pageTwo = applyMediaObjectPatchCommand(server, "pdf-room", "presenter", {
    commandId: "pdf-page",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: selected.revision ?? 1,
    patch: { type: "go-to-page", page: 2, inputEventId: "page-2" }
  });
  assert.equal(pageTwo.accepted, true);

  const lateSocket = createSocket();
  connectParticipant(server, "pdf-room", "late", lateSocket as never, { role: "guest" });
  const lateSnapshot = [...lateSocket.sent].reverse().map((payload) => JSON.parse(payload) as { type?: string; serverTimeMs?: number; room?: { mediaObjects?: { objects?: Record<string, { state?: { currentPage?: number } }> } } }).find((payload) => payload.type === "room_state");
  assert.equal(lateSnapshot?.room?.mediaObjects?.objects?.[created.objectId ?? ""]?.state?.currentPage, 2);
  assert.equal(typeof lateSnapshot?.serverTimeMs, "number");

  assert.equal(applyPdfPresentationDocumentCleanup(server, "pdf-room", "doc-1"), 1);
  assert.equal(server.rooms.get("pdf-room")?.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
});

test("video state and server clock are retained for late join and generic cleanup", () => {
  const server = createRoomStateServer();
  connectParticipant(server, "video-room", "presenter", createSocket() as never, { role: "presenter" });
  const created = applyMediaObjectCreateCommand(server, "video-room", "presenter", {
    commandId: "video-create",
    surfaceId: "debug-main",
    objectType: "video-player"
  });
  const selected = applyMediaObjectPatchCommand(server, "video-room", "presenter", {
    commandId: "video-select",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 0,
    patch: {
      type: "select-video",
      documentId: "video-1",
      filename: "clip.webm",
      checksum: `sha256:${"f".repeat(64)}`,
      contentType: "video/webm",
      widthPx: 1280,
      heightPx: 720,
      durationMs: 2000,
      inputEventId: "video-select-1"
    }
  });
  const playing = applyMediaObjectPatchCommand(server, "video-room", "presenter", {
    commandId: "video-play",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: selected.revision ?? 1,
    patch: { type: "play", inputEventId: "video-play-1" }
  });
  assert.equal(playing.accepted, true);

  const lateSocket = createSocket();
  connectParticipant(server, "video-room", "late", lateSocket as never, { role: "guest" });
  const snapshot = [...lateSocket.sent].reverse().map((payload) => JSON.parse(payload) as {
    type?: string;
    serverTimeMs?: number;
    room?: { mediaObjects?: { objects?: Record<string, { state?: { playbackState?: string; anchorServerTimeMs?: number } }> } };
  }).find((payload) => payload.type === "room_state");
  assert.equal(typeof snapshot?.serverTimeMs, "number");
  assert.equal(snapshot?.room?.mediaObjects?.objects?.[created.objectId ?? ""]?.state?.playbackState, "playing");
  assert.equal(typeof snapshot?.room?.mediaObjects?.objects?.[created.objectId ?? ""]?.state?.anchorServerTimeMs, "number");

  assert.equal(applyDocumentMediaObjectsCleanup(server, "video-room", "video-1"), 1);
  assert.equal(server.rooms.get("video-room")?.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
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

test("markdown board commands sync sticky note create move and delete", () => {
  const server = createRoomStateServer();
  const memberSocket = createSocket();
  connectParticipant(server, "demo-room", "host", createSocket() as never, { role: "host" });
  connectParticipant(server, "demo-room", "member", memberSocket as never, { role: "member" });
  connectParticipant(server, "demo-room", "guest", createSocket() as never, { role: "guest" });

  const created = applyMediaObjectCreateCommand(server, "demo-room", "host", {
    commandId: "cmd-create-markdown-board",
    surfaceId: "debug-main",
    objectType: "markdown-board"
  });
  assert.equal(created.accepted, true);
  assert.equal(created.objectType, "markdown-board");

  const added = applyMediaObjectPatchCommand(server, "demo-room", "member", {
    commandId: "cmd-add-note",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 0,
    patch: {
      type: "create-note",
      inputEventId: "member:note:create:1",
      noteId: "note-1",
      text: "# Hello\n<script>alert(1)</script>",
      x: 0.2,
      y: 0.3
    }
  });
  assert.equal(added.accepted, true);
  assert.equal(added.permission, "markdown-board.edit");
  assert.equal((server.rooms.get("demo-room")?.mediaObjects.objects[created.objectId ?? ""]?.state as { notes?: unknown[] } | undefined)?.notes?.length, 1);

  const denied = applyMediaObjectPatchCommand(server, "demo-room", "guest", {
    commandId: "cmd-guest-note",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 1,
    patch: { type: "move-note", inputEventId: "guest:note:move:1", noteId: "note-1", x: 0.5, y: 0.5 }
  });
  assert.equal(denied.accepted, false);
  assert.equal(denied.permission, "markdown-board.edit");

  const moved = applyMediaObjectPatchCommand(server, "demo-room", "member", {
    commandId: "cmd-move-note",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 1,
    patch: { type: "move-note", inputEventId: "member:note:move:1", noteId: "note-1", x: 0.6, y: 0.4 }
  });
  assert.equal(moved.accepted, true);
  assert.equal(moved.revision, 2);

  const deleted = applyMediaObjectPatchCommand(server, "demo-room", "member", {
    commandId: "cmd-delete-note",
    surfaceId: "debug-main",
    objectId: created.objectId ?? "",
    expectedRevision: 2,
    patch: { type: "delete-note", inputEventId: "member:note:delete:1", noteId: "note-1" }
  });
  assert.equal(deleted.accepted, true);
  assert.equal((server.rooms.get("demo-room")?.mediaObjects.objects[created.objectId ?? ""]?.state as { notes?: unknown[] } | undefined)?.notes?.length, 0);

  const payload = JSON.parse(memberSocket.sent[memberSocket.sent.length - 1]!);
  assert.equal(payload.type, "room_state");
  assert.equal(payload.room.mediaObjects.objects[created.objectId ?? ""].state.notes.length, 0);
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

test("remote browser executor callback activates LiveKit media tracks", () => {
  const server = createRoomStateServer();
  const hostSocket = createSocket();
  connectParticipant(server, "demo-room", "host", hostSocket as never, { role: "host" });

  const created = applyMediaObjectCreateCommand(server, "demo-room", "host", {
    commandId: "cmd-create-browser",
    surfaceId: "debug-main",
    objectType: "remote-browser"
  });
  assert.equal(created.accepted, true);
  const objectId = created.objectId ?? "";
  const opened = applyMediaObjectPatchCommand(server, "demo-room", "host", {
    commandId: "cmd-open-browser",
    surfaceId: "debug-main",
    objectId,
    expectedRevision: 0,
    patch: { type: "open-url", url: "https://example.com", inputEventId: "host:open:1" }
  });
  assert.equal(opened.accepted, true);

  const active = applyRemoteBrowserExecutorPatchCommand(server, {
    roomId: "demo-room",
    surfaceId: "debug-main",
    objectId,
    executorSessionId: `remote-browser:${objectId}`,
    patch: {
      type: "mark-active",
      mediaParticipantId: `remote-browser:${objectId}`,
      mediaTrackSid: "TR_VP",
      audioTrackSid: "TR_AUDIO",
      inputEventId: "executor:active:1"
    }
  });
  assert.equal(active.accepted, true);
  const state = server.rooms.get("demo-room")?.mediaObjects.objects[objectId]?.state as { status?: string; mediaTrackSid?: string; audioTrackSid?: string } | undefined;
  assert.equal(state?.status, "active");
  assert.equal(state?.mediaTrackSid, "TR_VP");
  assert.equal(state?.audioTrackSid, "TR_AUDIO");

  const payload = JSON.parse(hostSocket.sent[hostSocket.sent.length - 1]!);
  assert.equal(payload.type, "room_state");
  assert.equal(payload.room.mediaObjects.objects[objectId].state.mediaTrackSid, "TR_VP");
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
