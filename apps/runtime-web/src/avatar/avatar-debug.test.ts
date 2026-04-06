import test from "node:test";
import assert from "node:assert/strict";

import {
  createAvatarFailedDiagnostics,
  createAvatarLoadedDiagnostics,
  createAvatarLoadingDiagnostics,
  createEmptyAvatarDiagnostics
} from "./avatar-debug.js";

test("createEmptyAvatarDiagnostics returns idle baseline", () => {
  assert.deepEqual(createEmptyAvatarDiagnostics(), {
    state: "idle",
    catalogId: null,
    packUrl: null,
    packFormat: null,
    presetCount: 0,
    selectedAvatarId: null,
    inputMode: null,
    locomotionState: null,
    locomotionTransitioned: false,
    qualityMode: null,
    skatingMetric: 0,
    footLockStrength: 0,
    footingCorrectionActive: false,
    visibilityState: null,
    headVisible: false,
    leftHandVisible: false,
    rightHandVisible: false,
    solveState: null,
    animationState: null,
    bodyLean: 0,
    activeControllerCount: 0,
    controllerProfile: null,
    xrInputProfile: null,
    fallbackActive: false,
    fallbackReason: null,
    sandboxEntryPoint: null,
    validatorSummary: []
  });
});

test("createAvatarLoadingDiagnostics marks loading state", () => {
  const diagnostics = createAvatarLoadingDiagnostics("/assets/avatars/catalog.v1.json");
  assert.equal(diagnostics.state, "loading");
  assert.equal(diagnostics.sandboxEntryPoint, "/assets/avatars/catalog.v1.json");
});

test("createAvatarFailedDiagnostics enables fallback state", () => {
  const diagnostics = createAvatarFailedDiagnostics("/assets/avatars/catalog.v1.json", "failed_to_load_avatar_catalog:404");
  assert.equal(diagnostics.state, "failed");
  assert.equal(diagnostics.fallbackActive, true);
  assert.equal(diagnostics.fallbackReason, "failed_to_load_avatar_catalog:404");
});

test("createAvatarLoadedDiagnostics stores selected preset and validation summary", () => {
  const diagnostics = createAvatarLoadedDiagnostics({
    sandboxEntryPoint: "/assets/avatars/catalog.v1.json",
    selectedAvatarId: "preset-01",
    catalogId: "technical-v1",
      packUrl: "/assets/avatars/avatar-pack.v1.glb",
      packFormat: "procedural-debug-v1",
      presetCount: 10,
      validatorSummary: ["preset-01:11800"],
      inputMode: "desktop",
      locomotionState: "idle",
      locomotionTransitioned: false,
      qualityMode: "near",
      skatingMetric: 0.2,
      footLockStrength: 0.3,
      footingCorrectionActive: true,
      visibilityState: "full-body",
      headVisible: true,
      leftHandVisible: true,
      rightHandVisible: true,
      solveState: "active",
      animationState: "idle",
      bodyLean: 0.1,
      activeControllerCount: 0,
      controllerProfile: "desktop_no_controllers",
      xrInputProfile: "none"
    });
  assert.equal(diagnostics.state, "loaded");
  assert.equal(diagnostics.selectedAvatarId, "preset-01");
  assert.deepEqual(diagnostics.validatorSummary, ["preset-01:11800"]);
  assert.equal(diagnostics.skatingMetric, 0.2);
  assert.equal(diagnostics.footLockStrength, 0.3);
  assert.equal(diagnostics.footingCorrectionActive, true);
  assert.equal(diagnostics.qualityMode, "near");
  assert.equal(diagnostics.visibilityState, "full-body");
  assert.equal(diagnostics.headVisible, true);
  assert.equal(diagnostics.leftHandVisible, true);
  assert.equal(diagnostics.rightHandVisible, true);
  assert.equal(diagnostics.animationState, "idle");
  assert.equal(diagnostics.bodyLean, 0.1);
  assert.equal(diagnostics.controllerProfile, "desktop_no_controllers");
  assert.equal(diagnostics.xrInputProfile, "none");
});
