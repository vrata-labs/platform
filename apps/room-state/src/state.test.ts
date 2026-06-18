import test from "node:test";
import assert from "node:assert/strict";
import { DISABLED_EXTENSION_CARD_TYPE, EXTENSION_TEST_CARD_TYPE, MISSING_CAPABILITY_EXTENSION_CARD_TYPE } from "@vrata/shared-types";

import {
  claimSeat,
  createMediaObject,
  createParticipantState,
  createRoomState,
  joinRoom,
  leaveRoom,
  mergeParticipantState,
  patchMediaObjectState,
  patchRemoteBrowserExecutorState,
  releaseSeat,
  setSurfaceMediaAudioEnabled,
  stopMediaObject,
  updateParticipantState
} from "./state.js";

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

test("createRoomState includes default media surface", () => {
  const room = createRoomState("demo");
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.label, "Main screen");
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.allowedObjectTypes.includes("surface-test-card"), true);
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.allowedObjectTypes.includes("screen-share"), true);
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.allowedObjectTypes.includes("whiteboard"), true);
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.allowedObjectTypes.includes("remote-browser"), true);
  assert.equal(room.mediaObjects.surfaces["debug-main"]?.mediaAudioEnabled, false);
  assert.equal(room.mediaObjects.surfaces["whiteboard-wall"]?.label, "Whiteboard wall");
  assert.equal(room.mediaObjects.surfaces["whiteboard-wall"]?.allowedObjectTypes.includes("screen-share"), true);
  assert.equal(room.mediaObjects.surfaces["whiteboard-wall"]?.allowedObjectTypes.includes("whiteboard"), true);
  assert.equal(room.mediaObjects.surfaces["whiteboard-wall"]?.allowedObjectTypes.includes("remote-browser"), true);
  assert.equal(room.mediaObjects.surfaces["laptop-screen"]?.label, "Laptop screen");
  assert.equal(room.mediaObjects.surfaces["laptop-screen"]?.allowedObjectTypes.includes("screen-share"), true);
  assert.equal(room.mediaObjects.surfaces["laptop-screen"]?.allowedObjectTypes.includes("whiteboard"), true);
  assert.equal(room.mediaObjects.surfaces["laptop-screen"]?.allowedObjectTypes.includes("remote-browser"), true);
});

test("joinRoom upgrades legacy default surface object allow lists", () => {
  const room = createRoomState("demo");
  room.mediaObjects.surfaces["whiteboard-wall"]!.allowedObjectTypes = ["surface-test-card", "whiteboard"];
  room.mediaObjects.surfaces["laptop-screen"]!.allowedObjectTypes = ["surface-test-card", "screen-share", "remote-browser"];

  const joined = joinRoom(room, "host", { role: "host" });

  assert.equal(joined.mediaObjects.surfaces["whiteboard-wall"]?.allowedObjectTypes.includes("remote-browser"), true);
  assert.equal(joined.mediaObjects.surfaces["laptop-screen"]?.allowedObjectTypes.includes("whiteboard"), true);
});

test("joinRoom restores missing default media surfaces for legacy room state", () => {
  const room = createRoomState("demo");
  delete room.mediaObjects.surfaces["whiteboard-wall"];
  delete room.mediaObjects.surfaces["laptop-screen"];

  const joined = joinRoom(room, "host", { role: "host" });

  assert.equal(joined.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
  assert.equal(joined.mediaObjects.surfaces["whiteboard-wall"]?.label, "Whiteboard wall");
  assert.equal(joined.mediaObjects.surfaces["laptop-screen"]?.label, "Laptop screen");
});

test("media objects remain independent across surfaces", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const share = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-share",
    surfaceId: "debug-main",
    objectType: "screen-share",
    objectId: "share-1",
    nowMs: 1
  });
  assert.equal(share.result.accepted, true);

  const board = createMediaObject(share.room, "host", {
    commandId: "cmd-create-board",
    surfaceId: "whiteboard-wall",
    objectType: "whiteboard",
    objectId: "board-1",
    nowMs: 2
  });
  assert.equal(board.result.accepted, true);
  assert.equal(board.room.mediaObjects.surfaces["debug-main"]?.activeObjectId, "share-1");
  assert.equal(board.room.mediaObjects.surfaces["whiteboard-wall"]?.activeObjectId, "board-1");

  const stoppedShare = stopMediaObject(board.room, "host", {
    commandId: "cmd-stop-share",
    surfaceId: "debug-main",
    objectId: "share-1"
  });
  assert.equal(stoppedShare.result.accepted, true);
  assert.equal(stoppedShare.room.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
  assert.equal(stoppedShare.room.mediaObjects.surfaces["whiteboard-wall"]?.activeObjectId, "board-1");
  assert.equal(stoppedShare.room.mediaObjects.objects["board-1"]?.type, "whiteboard");
});

test("setSurfaceMediaAudioEnabled is admin-only and updates one surface", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const rejected = setSurfaceMediaAudioEnabled(hostRoom, "host", {
    commandId: "cmd-host-audio",
    surfaceId: "debug-main",
    enabled: true
  });
  assert.equal(rejected.result.accepted, false);
  assert.equal(rejected.result.permission, "surface.configure-audio");
  assert.equal(rejected.result.blockedReason, "missing-permission");
  assert.equal(rejected.room.mediaObjects.surfaces["debug-main"]?.mediaAudioEnabled, false);

  const adminRoom = joinRoom(hostRoom, "admin", { role: "admin" });
  const accepted = setSurfaceMediaAudioEnabled(adminRoom, "admin", {
    commandId: "cmd-admin-audio",
    surfaceId: "debug-main",
    enabled: true
  });
  assert.equal(accepted.result.accepted, true);
  assert.equal(accepted.result.permission, "surface.configure-audio");
  assert.equal(accepted.room.mediaObjects.surfaces["debug-main"]?.mediaAudioEnabled, true);
});

test("createMediaObject enforces host permissions and rejects unknown types", () => {
  const guestRoom = joinRoom(createRoomState("demo"), "guest");
  const guest = createMediaObject(guestRoom, "guest", {
    commandId: "cmd-guest",
    surfaceId: "debug-main",
    objectType: "surface-test-card",
    objectId: "obj-guest",
    nowMs: 1
  });
  assert.equal(guest.result.accepted, false);
  assert.equal(guest.result.blockedReason, "missing-permission");

  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const unknown = createMediaObject(hostRoom, "host", {
    commandId: "cmd-unknown",
    surfaceId: "debug-main",
    objectType: "unknown-object",
    objectId: "obj-unknown",
    nowMs: 1
  });
  assert.equal(unknown.result.accepted, false);
  assert.equal(unknown.result.blockedReason, "unknown-object-type");
});

test("extension protocol creates registered test object and rejects invalid extensions", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-extension-card",
    surfaceId: "debug-main",
    objectType: EXTENSION_TEST_CARD_TYPE,
    objectId: "extension-card-1",
    nowMs: 1
  });
  assert.equal(created.result.accepted, true);
  assert.equal(created.room.mediaObjects.objects["extension-card-1"]?.type, EXTENSION_TEST_CARD_TYPE);
  assert.deepEqual(created.room.mediaObjects.objects["extension-card-1"]?.state, {
    clickCount: 0,
    lastInputEventId: null
  });

  const memberRoom = joinRoom(created.room, "member", { role: "member" });
  const patched = patchMediaObjectState(memberRoom, "member", {
    commandId: "cmd-patch-extension-card",
    surfaceId: "debug-main",
    objectId: "extension-card-1",
    expectedRevision: 0,
    patch: { type: "increment-click-count", inputEventId: "member:extension:1" },
    nowMs: 2
  });
  assert.equal(patched.result.accepted, true);
  assert.equal(patched.result.permission, "surface.input");
  assert.deepEqual(patched.room.mediaObjects.objects["extension-card-1"]?.state, {
    clickCount: 1,
    lastInputEventId: "member:extension:1"
  });

  const missingCapability = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-missing-capability",
    surfaceId: "debug-main",
    objectType: MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
    objectId: "missing-capability-1",
    nowMs: 3
  });
  assert.equal(missingCapability.result.accepted, false);
  assert.equal(missingCapability.result.blockedReason, "missing-extension-capability");

  const disabled = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-disabled",
    surfaceId: "debug-main",
    objectType: DISABLED_EXTENSION_CARD_TYPE,
    objectId: "disabled-1",
    nowMs: 4
  });
  assert.equal(disabled.result.accepted, false);
  assert.equal(disabled.result.blockedReason, "extension-disabled");
});

test("extension protocol enforces action permissions through generic reducer", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-extension-card-permission",
    surfaceId: "debug-main",
    objectType: EXTENSION_TEST_CARD_TYPE,
    objectId: "extension-card-permission",
    nowMs: 1
  });
  const guestRoom = joinRoom(created.room, "guest", { role: "guest" });
  const patched = patchMediaObjectState(guestRoom, "guest", {
    commandId: "cmd-guest-extension-action",
    surfaceId: "debug-main",
    objectId: "extension-card-permission",
    expectedRevision: 0,
    patch: { type: "increment-click-count", inputEventId: "guest:extension:1" },
    nowMs: 2
  });
  assert.equal(patched.result.accepted, false);
  assert.equal(patched.result.permission, "surface.input");
  assert.equal(patched.result.blockedReason, "missing-permission");
});

test("surface-test-card state updates through revisioned reducer", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create",
    surfaceId: "debug-main",
    objectType: "surface-test-card",
    objectId: "obj-1",
    nowMs: 1
  });
  assert.equal(created.result.accepted, true);

  const memberRoom = joinRoom(created.room, "member", { role: "member" });
  const patched = patchMediaObjectState(memberRoom, "member", {
    commandId: "cmd-patch",
    surfaceId: "debug-main",
    objectId: "obj-1",
    expectedRevision: 0,
    patch: { type: "increment-click-count", inputEventId: "member:1" },
    nowMs: 2
  });

  assert.equal(patched.result.accepted, true);
  assert.equal(patched.result.revision, 1);
  assert.deepEqual(patched.room.mediaObjects.objects["obj-1"]?.state, {
    clickCount: 1,
    lastInputEventId: "member:1"
  });

  const stale = patchMediaObjectState(patched.room, "member", {
    commandId: "cmd-stale",
    surfaceId: "debug-main",
    objectId: "obj-1",
    expectedRevision: 0,
    patch: { type: "increment-click-count", inputEventId: "member:2" },
    nowMs: 3
  });
  assert.equal(stale.result.accepted, false);
  assert.equal(stale.result.blockedReason, "revision-mismatch");

  const duplicate = patchMediaObjectState(patched.room, "member", {
    commandId: "cmd-duplicate",
    surfaceId: "debug-main",
    objectId: "obj-1",
    expectedRevision: 1,
    patch: { type: "increment-click-count", inputEventId: "member:1" },
    nowMs: 4
  });
  assert.equal(duplicate.result.accepted, false);
  assert.equal(duplicate.result.blockedReason, "duplicate-input-event");
});

test("createMediaObject rejects occupied surface and stop clears active object", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create",
    surfaceId: "debug-main",
    objectType: "surface-test-card",
    objectId: "obj-1",
    nowMs: 1
  });
  const occupied = createMediaObject(created.room, "host", {
    commandId: "cmd-create-2",
    surfaceId: "debug-main",
    objectType: "surface-test-card",
    objectId: "obj-2",
    nowMs: 2
  });
  assert.equal(occupied.result.accepted, false);
  assert.equal(occupied.result.blockedReason, "surface-occupied");

  const stopped = stopMediaObject(created.room, "host", {
    commandId: "cmd-stop",
    surfaceId: "debug-main",
    objectId: "obj-1"
  });
  assert.equal(stopped.result.accepted, true);
  assert.equal(stopped.room.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
  assert.equal(stopped.room.mediaObjects.objects["obj-1"], undefined);
});

test("whiteboard object appends strokes and enforces draw and clear permissions", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-whiteboard",
    surfaceId: "debug-main",
    objectType: "whiteboard",
    objectId: "board-1",
    nowMs: 1
  });
  assert.equal(created.result.accepted, true);

  const memberRoom = joinRoom(created.room, "member", { role: "member" });
  const appended = patchMediaObjectState(memberRoom, "member", {
    commandId: "cmd-stroke",
    surfaceId: "debug-main",
    objectId: "board-1",
    expectedRevision: 0,
    patch: {
      type: "append-stroke",
      inputEventId: "member:stroke:1",
      stroke: {
        strokeId: "stroke-1",
        participantId: "spoofed",
        tool: "pen",
        color: "#2563eb",
        width: 4,
        points: [
          { u: 0.1, v: 0.2, t: 10, pressure: 0.5 },
          { u: 0.2, v: 0.3, t: 12 }
        ]
      }
    },
    nowMs: 2
  });
  assert.equal(appended.result.accepted, true);
  assert.equal(appended.result.permission, "whiteboard.draw");
  assert.equal(appended.result.revision, 1);
  const appendedState = appended.room.mediaObjects.objects["board-1"]?.state as { strokes?: Array<{ participantId?: string }>; lastInputEventId?: string } | undefined;
  assert.equal(appendedState?.strokes?.length, 1);
  assert.equal(appendedState?.strokes?.[0]?.participantId, "member");
  assert.equal(appendedState?.lastInputEventId, "member:stroke:1");

  const duplicate = patchMediaObjectState(appended.room, "member", {
    commandId: "cmd-duplicate-stroke",
    surfaceId: "debug-main",
    objectId: "board-1",
    expectedRevision: 1,
    patch: {
      type: "append-stroke",
      inputEventId: "member:stroke:1",
      stroke: {
        strokeId: "stroke-1",
        participantId: "member",
        tool: "pen",
        color: "#2563eb",
        width: 4,
        points: [{ u: 0.1, v: 0.2, t: 10 }]
      }
    },
    nowMs: 3
  });
  assert.equal(duplicate.result.accepted, false);
  assert.equal(duplicate.result.blockedReason, "duplicate-input-event");

  const guestRoom = joinRoom(appended.room, "guest");
  const guestDraw = patchMediaObjectState(guestRoom, "guest", {
    commandId: "cmd-guest-draw",
    surfaceId: "debug-main",
    objectId: "board-1",
    expectedRevision: 1,
    patch: {
      type: "append-stroke",
      inputEventId: "guest:stroke:1",
      stroke: {
        strokeId: "stroke-guest",
        participantId: "guest",
        tool: "pen",
        color: "#111827",
        width: 2,
        points: [{ u: 0.5, v: 0.5, t: 20 }]
      }
    },
    nowMs: 4
  });
  assert.equal(guestDraw.result.accepted, false);
  assert.equal(guestDraw.result.permission, "whiteboard.draw");
  assert.equal(guestDraw.result.blockedReason, "missing-permission");

  const memberClear = patchMediaObjectState(appended.room, "member", {
    commandId: "cmd-member-clear",
    surfaceId: "debug-main",
    objectId: "board-1",
    expectedRevision: 1,
    patch: { type: "clear", inputEventId: "member:clear:1" },
    nowMs: 5
  });
  assert.equal(memberClear.result.accepted, false);
  assert.equal(memberClear.result.permission, "whiteboard.clear");
  assert.equal(memberClear.result.blockedReason, "missing-permission");

  const cleared = patchMediaObjectState(appended.room, "host", {
    commandId: "cmd-clear",
    surfaceId: "debug-main",
    objectId: "board-1",
    expectedRevision: 1,
    patch: { type: "clear", inputEventId: "host:clear:1" },
    nowMs: 6
  });
  assert.equal(cleared.result.accepted, true);
  assert.equal(cleared.result.permission, "whiteboard.clear");
  assert.deepEqual((cleared.room.mediaObjects.objects["board-1"]?.state as { strokes?: unknown[] } | undefined)?.strokes, []);
});

test("screen-share object state updates through host-only revisioned reducer", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create",
    surfaceId: "debug-main",
    objectType: "screen-share",
    objectId: "share-1",
    nowMs: 1
  });
  assert.equal(created.result.accepted, true);
  assert.deepEqual(created.room.mediaObjects.objects["share-1"]?.state, {
    status: "idle",
    ownerParticipantId: "host",
    surfaceId: "debug-main"
  });

  const selecting = patchMediaObjectState(created.room, "host", {
    commandId: "cmd-selecting",
    surfaceId: "debug-main",
    objectId: "share-1",
    expectedRevision: 0,
    patch: { type: "mark-selecting" },
    nowMs: 2
  });
  assert.equal(selecting.result.accepted, true);
  assert.equal(selecting.result.revision, 1);

  const active = patchMediaObjectState(selecting.room, "host", {
    commandId: "cmd-active",
    surfaceId: "debug-main",
    objectId: "share-1",
    expectedRevision: 1,
    patch: { type: "mark-active", mediaTrackSid: "track-1" },
    nowMs: 3
  });
  assert.equal(active.result.accepted, true);
  const activeState = active.room.mediaObjects.objects["share-1"]?.state as {
    status?: string;
    ownerParticipantId?: string;
    surfaceId?: string;
    mediaTrackSid?: string;
    startedAtMs?: number;
  } | undefined;
  assert.equal(activeState?.status, "active");
  assert.equal(activeState?.ownerParticipantId, "host");
  assert.equal(activeState?.surfaceId, "debug-main");
  assert.equal(activeState?.mediaTrackSid, "track-1");
  assert.equal(activeState?.startedAtMs, 3);

  const memberRoom = joinRoom(active.room, "member", { role: "member" });
  const memberPatch = patchMediaObjectState(memberRoom, "member", {
    commandId: "cmd-member",
    surfaceId: "debug-main",
    objectId: "share-1",
    expectedRevision: 2,
    patch: { type: "mark-stopped" },
    nowMs: 4
  });
  assert.equal(memberPatch.result.accepted, false);
  assert.equal(memberPatch.result.permission, "screen-share.start");
  assert.equal(memberPatch.result.blockedReason, "missing-permission");

  const stale = patchMediaObjectState(active.room, "host", {
    commandId: "cmd-stale",
    surfaceId: "debug-main",
    objectId: "share-1",
    expectedRevision: 1,
    patch: { type: "mark-stopped" },
    nowMs: 5
  });
  assert.equal(stale.result.accepted, false);
  assert.equal(stale.result.blockedReason, "revision-mismatch");
});

test("remote-browser object opens URL, streams input, and enforces controller lock", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-browser",
    surfaceId: "debug-main",
    objectType: "remote-browser",
    objectId: "browser-1",
    nowMs: 1
  });
  assert.equal(created.result.accepted, true);

  const opened = patchMediaObjectState(created.room, "host", {
    commandId: "cmd-open",
    surfaceId: "debug-main",
    objectId: "browser-1",
    expectedRevision: 0,
    patch: {
      type: "open-url",
      url: "https://example.com/remote-browser-demo.html",
      inputEventId: "host:open:1"
    },
    nowMs: 2
  });
  assert.equal(opened.result.accepted, true);
  assert.equal(opened.result.permission, "remote-browser.open-url");
  const openedState = opened.room.mediaObjects.objects["browser-1"]?.state as {
    status?: string;
    controllerParticipantId?: string;
    executorSessionId?: string;
    frameStreamId?: string;
    mediaParticipantId?: string;
    mediaTrackSid?: string;
    audioTrackSid?: string;
    currentUrl?: string;
  } | undefined;
  assert.equal(openedState?.status, "loading");
  assert.equal(openedState?.controllerParticipantId, "host");
  assert.equal(openedState?.executorSessionId, "remote-browser:browser-1");
  assert.equal(openedState?.frameStreamId, undefined);
  assert.equal(openedState?.mediaParticipantId, "remote-browser:browser-1");
  assert.equal(openedState?.mediaTrackSid, undefined);
  assert.equal(openedState?.audioTrackSid, undefined);
  assert.equal(openedState?.currentUrl, "https://example.com/remote-browser-demo.html");

  const publishing = patchRemoteBrowserExecutorState(opened.room, {
    commandId: "cmd-publishing",
    surfaceId: "debug-main",
    objectId: "browser-1",
    executorSessionId: "remote-browser:browser-1",
    patch: {
      type: "mark-publishing",
      mediaParticipantId: "remote-browser:browser-1",
      inputEventId: "executor:publishing:1"
    },
    nowMs: 3
  });
  assert.equal(publishing.result.accepted, true);
  assert.equal((publishing.room.mediaObjects.objects["browser-1"]?.state as { status?: string; streamUpdatedAtMs?: number } | undefined)?.status, "publishing");
  assert.equal((publishing.room.mediaObjects.objects["browser-1"]?.state as { streamUpdatedAtMs?: number } | undefined)?.streamUpdatedAtMs, 3);

  const active = patchRemoteBrowserExecutorState(publishing.room, {
    commandId: "cmd-browser-active",
    surfaceId: "debug-main",
    objectId: "browser-1",
    executorSessionId: "remote-browser:browser-1",
    patch: {
      type: "mark-active",
      mediaParticipantId: "remote-browser:browser-1",
      mediaTrackSid: "TR_VP",
      audioTrackSid: "TR_AUDIO",
      mediaSourceRect: { x: 12.345, y: 34.567, width: 640.111, height: 360.222, viewportWidth: 1280, viewportHeight: 720 },
      inputEventId: "executor:active:1"
    },
    nowMs: 4
  });
  assert.equal(active.result.accepted, true);
  const activeRemoteBrowserState = active.room.mediaObjects.objects["browser-1"]?.state as {
    status?: string;
    mediaTrackSid?: string;
    audioTrackSid?: string;
    mediaSourceRect?: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number };
    loadedAtMs?: number;
    streamStartedAtMs?: number;
  } | undefined;
  assert.equal(activeRemoteBrowserState?.status, "active");
  assert.equal(activeRemoteBrowserState?.mediaTrackSid, "TR_VP");
  assert.equal(activeRemoteBrowserState?.audioTrackSid, "TR_AUDIO");
  assert.deepEqual(activeRemoteBrowserState?.mediaSourceRect, { x: 12.35, y: 34.57, width: 640.11, height: 360.22, viewportWidth: 1280, viewportHeight: 720 });
  assert.equal(activeRemoteBrowserState?.loadedAtMs, 4);
  assert.equal(activeRemoteBrowserState?.streamStartedAtMs, 4);

  const staleInput = patchMediaObjectState(active.room, "host", {
    commandId: "cmd-input-stale-revision",
    surfaceId: "debug-main",
    objectId: "browser-1",
    expectedRevision: 0,
    patch: {
      type: "pointer",
      inputEventId: "host:pointer:1",
      event: {
        eventId: "host:pointer:1",
        roomId: "demo",
        surfaceId: "debug-main",
        objectId: "browser-1",
        participantId: "host",
        source: "mouse",
        kind: "click",
        uv: { u: 0.5, v: 0.5 },
        pixel: { x: 960, y: 540 },
        clientTimeMs: 3,
        seq: 1
      }
    },
    nowMs: 5
  });
  assert.equal(staleInput.result.accepted, true);
  assert.equal(staleInput.result.permission, "remote-browser.input");
  assert.equal((staleInput.room.mediaObjects.objects["browser-1"]?.state as { lastInputSeq?: number } | undefined)?.lastInputSeq, 1);

  const inputApplied = patchRemoteBrowserExecutorState(staleInput.room, {
    commandId: "cmd-input-applied",
    surfaceId: "debug-main",
    objectId: "browser-1",
    executorSessionId: "remote-browser:browser-1",
    patch: {
      type: "mark-input-applied",
      input: {
        inputEventId: "host:pointer:1",
        inputType: "pointer",
        eventKind: "click",
        x: 640.123,
        y: 360.456,
        receivedAtMs: 5,
        appliedAtMs: 7,
        status: "applied",
        pageUrl: "https://example.com/remote-browser-demo.html",
        pageClosed: false,
        targetDetail: "target=VIDEO;events=pointermove:1"
      },
      inputEventId: "executor:input-applied:1"
    },
    nowMs: 7
  });
  assert.equal(inputApplied.result.accepted, true);
  assert.deepEqual((inputApplied.room.mediaObjects.objects["browser-1"]?.state as { lastExecutorInput?: unknown } | undefined)?.lastExecutorInput, {
    inputEventId: "host:pointer:1",
    inputType: "pointer",
    eventKind: "click",
    x: 640.12,
    y: 360.46,
    receivedAtMs: 5,
    appliedAtMs: 7,
    status: "applied",
    pageUrl: "https://example.com/remote-browser-demo.html",
    pageClosed: false,
    targetDetail: "target=VIDEO;events=pointermove:1",
    errorDetail: undefined
  });

  const adminRoom = joinRoom(inputApplied.room, "admin", { role: "admin" });
  const adminInput = patchMediaObjectState(adminRoom, "admin", {
    commandId: "cmd-admin-input",
    surfaceId: "debug-main",
    objectId: "browser-1",
    expectedRevision: inputApplied.result.revision ?? 5,
    patch: {
      type: "pointer",
      inputEventId: "admin:pointer:1",
      event: {
        eventId: "admin:pointer:1",
        roomId: "demo",
        surfaceId: "debug-main",
        objectId: "browser-1",
        participantId: "admin",
        source: "mouse",
        kind: "click",
        uv: { u: 0.5, v: 0.5 },
        pixel: { x: 960, y: 540 },
        clientTimeMs: 6,
        seq: 1
      }
    },
    nowMs: 6
  });
  assert.equal(adminInput.result.accepted, false);
  assert.equal(adminInput.result.blockedReason, "invalid-patch");

  const hostLeft = leaveRoom(adminRoom, "host");
  assert.equal(hostLeft.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
  assert.equal(hostLeft.mediaObjects.objects["browser-1"], undefined);
});

test("remote-browser executor failure stores sanitized diagnostic detail", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create-browser-failed",
    surfaceId: "debug-main",
    objectType: "remote-browser",
    objectId: "browser-failed",
    nowMs: 1
  });
  const opened = patchMediaObjectState(created.room, "host", {
    commandId: "cmd-open-browser-failed",
    surfaceId: "debug-main",
    objectId: "browser-failed",
    expectedRevision: 0,
    patch: {
      type: "open-url",
      url: "https://example.com/remote-browser-demo.html",
      inputEventId: "host:open-failed:1"
    },
    nowMs: 2
  });
  const failed = patchRemoteBrowserExecutorState(opened.room, {
    commandId: "cmd-browser-failed",
    surfaceId: "debug-main",
    objectId: "browser-failed",
    executorSessionId: "remote-browser:browser-failed",
    patch: {
      type: "mark-failed",
      errorCode: "viewport_capture_failed",
      errorDetail: "NotReadableError:\nCould not start video source",
      inputEventId: "executor:failed:1"
    },
    nowMs: 3
  });

  assert.equal(failed.result.accepted, true);
  const failedState = failed.room.mediaObjects.objects["browser-failed"]?.state as { status?: string; errorCode?: string; errorDetail?: string } | undefined;
  assert.equal(failedState?.status, "failed");
  assert.equal(failedState?.errorCode, "viewport_capture_failed");
  assert.equal(failedState?.errorDetail, "NotReadableError: Could not start video source");
});

test("leaveRoom clears owned active screen-share object", () => {
  const hostRoom = joinRoom(createRoomState("demo"), "host", { role: "host" });
  const created = createMediaObject(hostRoom, "host", {
    commandId: "cmd-create",
    surfaceId: "debug-main",
    objectType: "screen-share",
    objectId: "share-1",
    nowMs: 1
  });
  const left = leaveRoom(created.room, "host");
  assert.equal(left.mediaObjects.surfaces["debug-main"]?.activeObjectId, null);
  assert.equal(left.mediaObjects.objects["share-1"], undefined);
});
