import test from "node:test";
import assert from "node:assert/strict";

import type {
  AvatarCatalogV1,
  AvatarRecipeCatalogV1,
  AvatarReliableState,
  ClientMode,
  CompactPoseFrame,
  UserRole
} from "./index.js";

test("shared role and mode types compile in tests", () => {
  const role: UserRole = "guest";
  const mode: ClientMode = "desktop";
  assert.equal(`${role}:${mode}`, "guest:desktop");
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
