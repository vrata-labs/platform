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
    xrInputProfile: "none",
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
  assert.equal(controller.diagnostics.xrInputProfile, "none");
  assert.equal(controller.snapshot.leftHand.visible, true);
  assert.equal(controller.snapshot.rightHand.visible, true);
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
    xrInputProfile: null,
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
    xrInputProfile: null,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    moveX: 0,
    moveZ: 1,
    turnRate: 0
  });

  const torso = controller.root.children[0]!;
  const lowerBody = controller.root.children[1]!;
  const leftHand = controller.root.children[3];
  const rightHand = controller.root.children[4];
  assert.equal(torso.position.y > 1.12, true);
  assert.equal(torso.rotation.x > 0, true);
  assert.notEqual(lowerBody.rotation.z, 0);
  assert.notEqual(leftHand.position.z, 0.12);
  assert.notEqual(rightHand.position.z, 0.12);
  assert.equal(controller.diagnostics.locomotionTransitioned, true);
  assert.equal(controller.diagnostics.footingCorrectionActive, true);
  assert.equal(controller.diagnostics.skatingMetric > 0, true);
  assert.notEqual(controller.diagnostics.bodyLean, 0);
});

test("createLocalAvatarController reduces torso pitch for tracked vr movement", () => {
  const preset = createPreset("preset-01");
  preset.preset.validation.animationClips = ["idle", "walk"];

  const desktop = createLocalAvatarController({
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
  desktop.update({
    deltaSeconds: 0.25,
    inputMode: "desktop",
    xrPresenting: false,
    xrInputProfile: null,
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    moveX: 0,
    moveZ: 1,
    turnRate: 0
  });

  const vr = createLocalAvatarController({
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
  vr.update({
    deltaSeconds: 0.25,
    inputMode: "vr-controller",
    xrPresenting: true,
    xrInputProfile: "dual",
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    leftHand: { x: -0.2, y: 1.2, z: 0.2 },
    rightHand: { x: 0.2, y: 1.2, z: 0.2 },
    moveX: 0,
    moveZ: 1,
    turnRate: 0
  });

  assert.equal(Math.abs(vr.root.children[0]!.rotation.x) < Math.abs(desktop.root.children[0]!.rotation.x), true);
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
    xrInputProfile: null,
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

test("createLocalAvatarController keeps fallback right hand for single left vr controller", () => {
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
    xrInputProfile: "left-only",
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
  assert.equal(rightHand.visible, true);
  assert.equal(controller.diagnostics.controllerProfile, "vr_single_left_controller");
  assert.equal(controller.diagnostics.fallbackReason, "xr_input_partial_fallback:left_only");
  assert.equal(controller.diagnostics.xrInputProfile, "left-only");
  assert.equal(controller.snapshot.leftHand.visible, true);
  assert.equal(controller.snapshot.rightHand.visible, true);
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
    xrInputProfile: "dual",
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
  assert.equal(controller.diagnostics.xrInputProfile, "dual");
});

test("createLocalAvatarController preserves lateral hand tracking after yaw and movement", () => {
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
    xrInputProfile: "dual",
    rootPosition: { x: 3, y: 0, z: 4 },
    yaw: Math.PI / 2,
    headPosition: { x: 3, y: 1.6, z: 4 },
    leftHand: { x: 3, y: 1.2, z: 4.25 },
    rightHand: { x: 3, y: 1.2, z: 3.75 },
    moveX: 0,
    moveZ: -1,
    turnRate: 0
  });

  assert.equal(controller.snapshot.leftHand.visible, true);
  assert.equal(controller.snapshot.rightHand.visible, true);
  assert.equal(controller.snapshot.leftHand.x < 0, true);
  assert.equal(controller.snapshot.rightHand.x > 0, true);
  assert.equal(Math.abs(controller.snapshot.leftHand.x), Math.abs(controller.snapshot.rightHand.x));
});

test("createLocalAvatarController preserves hand spread after VR strafe update", () => {
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
    xrInputProfile: "dual",
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    leftHand: { x: -0.25, y: 1.2, z: 0.2 },
    rightHand: { x: 0.25, y: 1.2, z: 0.2 },
    moveX: 1,
    moveZ: 0,
    turnRate: 0
  });

  const handDistance = controller.snapshot.rightHand.x - controller.snapshot.leftHand.x;
  assert.equal(handDistance > 0.2, true);
  assert.equal(controller.snapshot.leftHand.z !== controller.snapshot.rightHand.z, false);
});

test("createLocalAvatarController does not add procedural forward offsets to VR hands", () => {
  const preset = createPreset("preset-01");
  preset.preset.validation.animationClips = ["idle", "strafe"];
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
    inputMode: "vr-controller",
    xrPresenting: true,
    xrInputProfile: "dual",
    rootPosition: { x: 0, y: 0, z: 0 },
    yaw: 0,
    headPosition: { x: 0, y: 1.6, z: 0 },
    leftHand: { x: -0.25, y: 1.2, z: 0.2 },
    rightHand: { x: 0.25, y: 1.2, z: 0.2 },
    moveX: 1,
    moveZ: 0,
    turnRate: 0
  });

  assert.equal(Math.round(controller.snapshot.leftHand.z * 100) / 100, 0.2);
  assert.equal(Math.round(controller.snapshot.rightHand.z * 100) / 100, 0.2);
});
