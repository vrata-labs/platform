import test from "node:test";
import assert from "node:assert/strict";

import { AVATAR_SELECTION_KEY, createLocalAvatarController } from "./avatar-controller.js";
import type { LoadedAvatarPreset } from "./avatar-types.js";

function createPreset(avatarId: string): LoadedAvatarPreset {
  return {
    preset: {
      avatarId,
      label: avatarId,
      recipeId: avatarId,
      validation: {
        triangleCount: 1000,
        materialCount: 1,
        textureCount: 1,
        morphTargets: ["blink"],
        animationClips: ["idle"],
        skeletonSignature: "humanoid-v1/base"
      }
    },
    recipe: {
      schemaVersion: 1,
      avatarId,
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
    }
  };
}

test("createLocalAvatarController restores preferred preset from storage", () => {
  const storage = {
    value: "preset-02",
    getItem(key: string) {
      return key === AVATAR_SELECTION_KEY ? this.value : null;
    },
    setItem(key: string, value: string) {
      if (key === AVATAR_SELECTION_KEY) {
        this.value = value;
      }
    }
  };

  const controller = createLocalAvatarController({
    presets: [createPreset("preset-01"), createPreset("preset-02")],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 2,
      validatorSummary: ["preset-01:1000", "preset-02:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    },
    storage
  });

  assert.equal(controller.selectedAvatarId, "preset-02");
  assert.equal(controller.snapshot.avatarId, "preset-02");
});

test("createLocalAvatarController updates diagnostics for vr fallback hands-only mode", () => {
  const controller = createLocalAvatarController({
    presets: [createPreset("preset-01")],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 1,
      validatorSummary: ["preset-01:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    }
  });

  controller.update({
    deltaSeconds: 0.016,
    inputMode: "vr-controller",
    xrPresenting: true,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    moveX: 0,
    moveZ: 0,
    turnRate: 0
  });

  assert.equal(controller.diagnostics.visibilityState, "hands-only");
  assert.equal(controller.diagnostics.solveState, "fallback");
  assert.equal(controller.diagnostics.fallbackActive, true);
  assert.equal(controller.diagnostics.controllerProfile, "vr_no_controllers");
  assert.equal(controller.diagnostics.fallbackReason, "xr_input_missing_controllers");
});

test("createLocalAvatarController marks animation fallback when locomotion clip is unavailable", () => {
  const preset = createPreset("preset-01");
  preset.preset.validation.animationClips = ["idle"];

  const controller = createLocalAvatarController({
    presets: [preset],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 1,
      validatorSummary: ["preset-01:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    }
  });

  controller.update({
    deltaSeconds: 0.016,
    inputMode: "desktop",
    xrPresenting: false,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    moveX: 0,
    moveZ: 1,
    turnRate: 0
  });

  assert.equal(controller.diagnostics.locomotionState, "walk");
  assert.equal(controller.diagnostics.animationState, "idle");
  assert.equal(controller.diagnostics.fallbackReason, "animation_clip_fallback:walk");
});

test("createLocalAvatarController applies visible walk pose to body and hands", () => {
  const preset = createPreset("preset-01");
  preset.preset.validation.animationClips = ["idle", "walk"];

  const controller = createLocalAvatarController({
    presets: [preset],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 1,
      validatorSummary: ["preset-01:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    }
  });

  controller.update({
    deltaSeconds: 0.25,
    inputMode: "desktop",
    xrPresenting: false,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    moveX: 0,
    moveZ: 1,
    turnRate: 0
  });

  const torso = controller.root.children[0]!;
  const leftHand = controller.root.children[3];
  const rightHand = controller.root.children[4];
  assert.equal(torso.position.y > 1.12, true);
  assert.notEqual(leftHand.position.z, 0.12);
  assert.notEqual(rightHand.position.z, 0.12);
});

test("createLocalAvatarController hides lower body for mobile upper-body profile", () => {
  const controller = createLocalAvatarController({
    presets: [createPreset("preset-01")],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 1,
      validatorSummary: ["preset-01:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    }
  });

  controller.update({
    deltaSeconds: 0.016,
    inputMode: "mobile",
    xrPresenting: false,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.5, z: 0 },
    moveX: 0,
    moveZ: 0,
    turnRate: 0
  });

  const torso = controller.root.children[0]!;
  const lowerBody = controller.root.children[1]!;
  assert.equal(torso.visible, true);
  assert.equal(lowerBody.visible, false);
  assert.equal(controller.diagnostics.visibilityState, "upper-body");
  assert.equal(controller.diagnostics.controllerProfile, "mobile_touch_fallback");
});

test("createLocalAvatarController shows only left hand for single left vr controller", () => {
  const controller = createLocalAvatarController({
    presets: [createPreset("preset-01")],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 1,
      validatorSummary: ["preset-01:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    }
  });

  controller.update({
    deltaSeconds: 0.016,
    inputMode: "vr-controller",
    xrPresenting: true,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    leftHand: { x: -0.2, y: 1.2, z: 0.2 },
    moveX: 0,
    moveZ: 0,
    turnRate: 0
  });

  const leftHand = controller.root.children[3]!;
  const rightHand = controller.root.children[4]!;
  assert.equal(leftHand.visible, true);
  assert.equal(rightHand.visible, false);
  assert.equal(controller.diagnostics.controllerProfile, "vr_single_left_controller");
  assert.equal(controller.diagnostics.fallbackReason, "xr_input_partial_fallback:left_only");
  assert.equal(controller.snapshot.leftHand.visible, true);
  assert.equal(controller.snapshot.rightHand.visible, false);
});

test("createLocalAvatarController shows both hands for dual vr controllers", () => {
  const controller = createLocalAvatarController({
    presets: [createPreset("preset-01")],
    diagnosticsInput: {
      catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 1,
      validatorSummary: ["preset-01:1000"],
      sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
    }
  });

  controller.update({
    deltaSeconds: 0.016,
    inputMode: "vr-controller",
    xrPresenting: true,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    leftHand: { x: -0.2, y: 1.2, z: 0.2 },
    rightHand: { x: 0.2, y: 1.2, z: 0.2 },
    moveX: 0,
    moveZ: 0,
    turnRate: 0
  });

  const leftHand = controller.root.children[3]!;
  const rightHand = controller.root.children[4]!;
  assert.equal(leftHand.visible, true);
  assert.equal(rightHand.visible, true);
  assert.equal(controller.diagnostics.controllerProfile, "vr_dual_controllers");
  assert.equal(controller.diagnostics.fallbackReason, null);
  assert.equal(controller.snapshot.controllerProfile, "vr_dual_controllers");
  assert.equal(controller.snapshot.visibilityState, "hands-only");
});
