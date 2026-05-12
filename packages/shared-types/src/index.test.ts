import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MEDIA_SURFACE_ID, SURFACE_TEST_CARD_TYPE, createDefaultRoomMediaObjectsState, createRoomAccessDebugState } from "./index.js";
import type {
  AvatarCatalogV1,
  AvatarRecipeCatalogV1,
  AvatarReliableState,
  ClientMode,
  CompactPoseFrame,
  MediaObjectCommandResult,
  SurfaceInputEvent,
  SurfaceInputDebugState,
  SurfaceTestCardState,
  UserRole
} from "./index.js";

test("shared role and mode types compile in tests", () => {
  const role: UserRole = "guest";
  const mode: ClientMode = "desktop";
  assert.equal(`${role}:${mode}`, "guest:desktop");
});

test("room access policy grants screen share to host only", () => {
  assert.equal(createRoomAccessDebugState("guest").canStartScreenShare, false);
  assert.equal(createRoomAccessDebugState("host").canStartScreenShare, true);
  assert.equal(createRoomAccessDebugState("admin").permissions.includes("room.admin"), true);
});

test("surface input shared contracts compile in tests", () => {
  const event: SurfaceInputEvent = {
    eventId: "evt-1",
    roomId: "room-1",
    surfaceId: "debug-main",
    participantId: "p-1",
    source: "mouse",
    kind: "click",
    uv: { u: 0.5, v: 0.5 },
    pixel: { x: 960, y: 540 },
    clientTimeMs: 42,
    seq: 1
  };
  const state: SurfaceInputDebugState = {
    enabled: true,
    debugSurfaceId: event.surfaceId,
    focusedSurfaceId: event.surfaceId,
    lastHit: null,
    lastEvent: event,
    blockedReason: null,
    acceptedEventCount: 1,
    seq: event.seq
  };

  assert.equal(state.lastEvent?.source, "mouse");
  assert.equal(state.lastEvent?.uv?.v, 0.5);
});

test("media object shared contracts compile in tests", () => {
  const mediaObjects = createDefaultRoomMediaObjectsState("room-1");
  const cardState: SurfaceTestCardState = {
    clickCount: 1,
    lastInputEventId: "p-1:1"
  };
  const result: MediaObjectCommandResult = {
    accepted: true,
    commandId: "cmd-1",
    role: "host",
    permission: "surface.create-object",
    blockedReason: null,
    surfaceId: DEFAULT_MEDIA_SURFACE_ID,
    objectId: "obj-1",
    objectType: SURFACE_TEST_CARD_TYPE,
    revision: 1
  };

  assert.equal(mediaObjects.surfaces[DEFAULT_MEDIA_SURFACE_ID]?.activeObjectId, null);
  assert.equal(cardState.clickCount, 1);
  assert.equal(result.accepted, true);
});

test("avatar shared contracts compile in tests", () => {
  const reliableState: AvatarReliableState = {
    participantId: "p-1",
    avatarId: "preset-01",
    recipeVersion: 1,
    inputMode: "desktop",
    seated: false,
    muted: true,
    audioActive: false,
    updatedAt: new Date(0).toISOString()
  };

  const poseFrame: CompactPoseFrame = {
    seq: 1,
    sentAtMs: 42,
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: -0.2, y: 1.2, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    rightHand: { x: 0.2, y: 1.2, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 0, speed: 0, angularVelocity: 0 }
  };

  const catalog: AvatarCatalogV1 = {
    schemaVersion: 1,
    catalogId: "technical-v1",
    assetVersion: "v1",
    rig: "humanoid-v1",
    packUrl: "/assets/avatars/avatar-pack.v1.glb",
    packFormat: "procedural-debug-v1",
    presets: [{
      avatarId: reliableState.avatarId,
      label: "Preset 01",
      recipeId: "preset-01",
      validation: {
        triangleCount: 12000,
        materialCount: 1,
        textureCount: 1,
        morphTargets: ["viseme-aa", "blink"],
        animationClips: ["idle"],
        skeletonSignature: "humanoid-v1/base"
      }
    }]
  };

  const recipes: AvatarRecipeCatalogV1 = {
    schemaVersion: 1,
    recipes: [{
      schemaVersion: 1,
      avatarId: "preset-01",
      rig: "humanoid-v1",
      bodyVariant: "base",
      headVariant: "round",
      hairVariant: "short",
      outfitVariant: "hoodie",
      palette: {
        skin: "#f2d1b3",
        primary: "#355c7d",
        accent: "#f67280"
      },
      accessories: []
    }]
  };

  assert.equal(catalog.presets[0]?.avatarId, poseFrame.seq === 1 ? "preset-01" : "broken");
  assert.equal(recipes.recipes[0]?.avatarId, "preset-01");
});
