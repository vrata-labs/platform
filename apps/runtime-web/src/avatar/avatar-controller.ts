import * as THREE from "three";

import {
  createAvatarFailedDiagnostics,
  createAvatarLoadedDiagnostics,
  type AvatarDiagnostics
} from "./avatar-debug.js";
import { computeAvatarAnimationPose, selectAvatarAnimationClip } from "./avatar-animation.js";
import { resolveAvatarLocomotion } from "./avatar-locomotion.js";
import { solveUpperBodyPose, type AvatarPosePoint } from "./avatar-ik.js";
import type { AvatarInputMode, LoadedAvatarPreset, LocalAvatarSnapshotV1 } from "./avatar-types.js";
import { resolveAvatarViewProfile } from "./avatar-visibility.js";

export interface AvatarSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocalAvatarController {
  root: THREE.Group;
  selectedAvatarId: string;
  diagnostics: AvatarDiagnostics;
  snapshot: LocalAvatarSnapshotV1;
  update(input: {
    deltaSeconds: number;
    inputMode: AvatarInputMode;
    xrPresenting: boolean;
    rootPosition: AvatarPosePoint;
    yaw: number;
    headPosition: AvatarPosePoint;
    leftHand?: AvatarPosePoint | null;
    rightHand?: AvatarPosePoint | null;
    moveX: number;
    moveZ: number;
    turnRate: number;
    xrInputProfile?: string | null;
  }): void;
  dispose(): void;
}

const AVATAR_SELECTION_KEY = "noah.avatarPresetId";

interface LocalAvatarVisual {
  root: THREE.Group;
  torso: THREE.Mesh;
  lowerBody: THREE.Mesh;
  head: THREE.Mesh;
  leftHand: THREE.Mesh;
  rightHand: THREE.Mesh;
  aura: THREE.Mesh;
}

type AvatarControllerProfile =
  | "desktop_no_controllers"
  | "mobile_touch_fallback"
  | "vr_no_controllers"
  | "vr_single_left_controller"
  | "vr_single_right_controller"
  | "vr_dual_controllers";

function createMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.02 });
}

function createLocalAvatarVisual(preset: LoadedAvatarPreset): LocalAvatarVisual {
  const root = new THREE.Group();
  root.name = `self-avatar:${preset.preset.avatarId}`;

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 6, 12), createMaterial(preset.recipe.palette.primary));
  torso.position.y = 1.12;
  root.add(torso);

  const lowerBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.46, 6, 12), createMaterial(preset.recipe.palette.primary));
  lowerBody.position.y = 0.52;
  root.add(lowerBody);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 18), createMaterial(preset.recipe.palette.skin));
  head.position.y = 1.58;
  root.add(head);

  const leftHand = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 14), createMaterial(preset.recipe.palette.accent));
  leftHand.position.set(-0.28, 1.16, 0.12);
  root.add(leftHand);

  const rightHand = leftHand.clone();
  rightHand.position.x = 0.28;
  root.add(rightHand);

  const aura = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.42, 24),
    new THREE.MeshBasicMaterial({ color: 0xf7f2e8, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
  );
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.02;
  root.add(aura);

  return { root, torso, lowerBody, head, leftHand, rightHand, aura };
}

function resolveSelectedAvatarPreset(input: {
  presets: LoadedAvatarPreset[];
  storage?: AvatarSelectionStorage;
  preferredAvatarId?: string;
}): LoadedAvatarPreset | null {
  const preferredId = input.preferredAvatarId ?? input.storage?.getItem(AVATAR_SELECTION_KEY) ?? null;
  if (preferredId) {
    const match = input.presets.find((preset) => preset.preset.avatarId === preferredId);
    if (match) {
      return match;
    }
  }
  return input.presets[0] ?? null;
}

function resolveControllerProfile(input: {
  inputMode: AvatarInputMode;
  xrPresenting: boolean;
  leftHand?: AvatarPosePoint | null;
  rightHand?: AvatarPosePoint | null;
}): AvatarControllerProfile {
  const hasLeft = Boolean(input.leftHand);
  const hasRight = Boolean(input.rightHand);

  if (input.xrPresenting || input.inputMode === "vr-controller" || input.inputMode === "vr-hand") {
    if (hasLeft && hasRight) {
      return "vr_dual_controllers";
    }
    if (hasLeft) {
      return "vr_single_left_controller";
    }
    if (hasRight) {
      return "vr_single_right_controller";
    }
    return "vr_no_controllers";
  }

  if (input.inputMode === "mobile") {
    return "mobile_touch_fallback";
  }

  return "desktop_no_controllers";
}

export function createLocalAvatarController(input: {
  presets: LoadedAvatarPreset[];
  diagnosticsInput: {
    catalogId: string | null;
    packUrl: string | null;
    packFormat: string | null;
    presetCount: number;
    validatorSummary: string[];
    sandboxEntryPoint: string;
  };
  storage?: AvatarSelectionStorage;
  preferredAvatarId?: string;
}): LocalAvatarController {
  const selectedPreset = resolveSelectedAvatarPreset(input);
  if (!selectedPreset) {
    throw new Error("avatar_catalog_has_no_presets");
  }

  input.storage?.setItem(AVATAR_SELECTION_KEY, selectedPreset.preset.avatarId);

  const visual = createLocalAvatarVisual(selectedPreset);
  let animationElapsedSeconds = 0;
  const diagnostics = createAvatarLoadedDiagnostics({
    ...input.diagnosticsInput,
    selectedAvatarId: selectedPreset.preset.avatarId,
    inputMode: null,
    locomotionState: "idle",
    visibilityState: "full-body",
    solveState: "fallback",
    animationState: "idle",
    activeControllerCount: 0,
    controllerProfile: "desktop_no_controllers",
    xrInputProfile: "none"
  });
  const snapshot: LocalAvatarSnapshotV1 = {
    schemaVersion: 1,
    avatarId: selectedPreset.preset.avatarId,
    inputMode: "desktop",
    visibilityState: "full-body",
    controllerProfile: "desktop_no_controllers",
    locomotionState: "idle",
    animationState: "idle",
    fallbackReason: null,
    root: { x: 0, y: 0, z: 0, yaw: 0 },
    head: { x: 0, y: 1.58, z: 0 },
    leftHand: { x: -0.28, y: 1.16, z: 0.12, visible: true },
    rightHand: { x: 0.28, y: 1.16, z: 0.12, visible: true },
    updatedAt: new Date(0).toISOString()
  };

  return {
    root: visual.root,
    selectedAvatarId: selectedPreset.preset.avatarId,
    diagnostics,
    snapshot,
    update(frame): void {
      animationElapsedSeconds += Math.max(0, frame.deltaSeconds);
      const viewProfile = resolveAvatarViewProfile({
        inputMode: frame.inputMode,
        xrPresenting: frame.xrPresenting
      });
      const visibility = viewProfile.visibility;
      const locomotion = resolveAvatarLocomotion({
        moveX: frame.moveX,
        moveZ: frame.moveZ,
        turnRate: frame.turnRate
      });
      const solve = solveUpperBodyPose({
        root: frame.rootPosition,
        head: frame.headPosition,
        leftHand: frame.leftHand,
        rightHand: frame.rightHand,
        inputMode: frame.inputMode,
        poseProfile: viewProfile.poseProfile,
        rootYaw: frame.yaw
      });
      const controllerCount = Number(Boolean(frame.leftHand)) + Number(Boolean(frame.rightHand));
      const controllerProfile = resolveControllerProfile({
        inputMode: frame.inputMode,
        xrPresenting: frame.xrPresenting,
        leftHand: frame.leftHand,
        rightHand: frame.rightHand
      });
      const animation = selectAvatarAnimationClip({
        locomotionState: locomotion.state,
        availableClips: selectedPreset.preset.validation.animationClips
      });
      const pose = computeAvatarAnimationPose({
        clip: animation.clip,
        elapsedSeconds: animationElapsedSeconds,
        speed: locomotion.speed,
        turnRate: frame.turnRate
      });
      const vrDirectTracking = frame.xrPresenting && (frame.inputMode === "vr-controller" || frame.inputMode === "vr-hand");

      visual.root.position.set(frame.rootPosition.x, frame.rootPosition.y, frame.rootPosition.z);
      visual.root.rotation.y = frame.yaw;

      visual.torso.position.set(0, 1.12 + pose.bodyBob, 0);
      visual.torso.rotation.z = pose.bodyRoll;
      visual.lowerBody.position.set(0, 0.52 + pose.bodyBob * 0.35, 0);
      visual.lowerBody.rotation.z = pose.bodyRoll * 0.5;
      visual.head.position.set(
        solve.headLocal.x,
        vrDirectTracking ? solve.headLocal.y : Math.max(solve.headLocal.y, viewProfile.poseProfile.headHeight),
        solve.headLocal.z
      );
      visual.head.rotation.z = pose.headTilt;
      visual.leftHand.position.set(
        solve.leftHandLocal.x,
        solve.leftHandLocal.y + (vrDirectTracking ? 0 : pose.leftHandYOffset),
        solve.leftHandLocal.z + (vrDirectTracking ? 0 : pose.leftHandForward)
      );
      visual.rightHand.position.set(
        solve.rightHandLocal.x,
        solve.rightHandLocal.y + (vrDirectTracking ? 0 : pose.rightHandYOffset),
        solve.rightHandLocal.z + (vrDirectTracking ? 0 : pose.rightHandForward)
      );
      const auraScale = animation.fallback ? Math.max(1.02, pose.auraScale - 0.03) : pose.auraScale;
      visual.aura.scale.setScalar(auraScale);
      (visual.aura.material as THREE.MeshBasicMaterial).opacity = animation.fallback ? 0.14 : 0.18 + Math.min(0.18, locomotion.speed * 0.08);

      visual.torso.visible = visibility === "full-body" || visibility === "upper-body";
      visual.lowerBody.visible = visibility === "full-body";
      visual.head.visible = visibility === "full-body" || visibility === "upper-body";
      visual.leftHand.visible = visibility !== "hidden";
      visual.rightHand.visible = visibility !== "hidden";
      visual.aura.visible = visibility === "full-body" || visibility === "upper-body";

      diagnostics.inputMode = frame.inputMode;
      diagnostics.locomotionState = locomotion.state;
      diagnostics.visibilityState = visibility;
      diagnostics.solveState = solve.solveState;
      diagnostics.animationState = animation.clip;
      diagnostics.activeControllerCount = controllerCount;
      diagnostics.controllerProfile = controllerProfile;
      diagnostics.xrInputProfile = frame.xrInputProfile ?? null;
      diagnostics.fallbackActive = (
        (solve.solveState === "fallback" && frame.xrPresenting)
        || animation.fallback
        || controllerProfile === "vr_no_controllers"
        || controllerProfile === "vr_single_left_controller"
        || controllerProfile === "vr_single_right_controller"
      );
      diagnostics.fallbackReason = controllerProfile === "vr_no_controllers"
        ? "xr_input_missing_controllers"
        : controllerProfile === "vr_single_left_controller"
          ? "xr_input_partial_fallback:left_only"
          : controllerProfile === "vr_single_right_controller"
            ? "xr_input_partial_fallback:right_only"
            : solve.solveState === "fallback" && frame.xrPresenting
              ? "xr_input_partial_fallback"
              : animation.fallback
                ? `animation_clip_fallback:${locomotion.state}`
                : null;

      snapshot.avatarId = selectedPreset.preset.avatarId;
      snapshot.inputMode = frame.inputMode;
      snapshot.visibilityState = visibility;
      snapshot.controllerProfile = controllerProfile;
      snapshot.locomotionState = locomotion.state;
      snapshot.animationState = animation.clip;
      snapshot.fallbackReason = diagnostics.fallbackReason;
      snapshot.root = {
        x: frame.rootPosition.x,
        y: frame.rootPosition.y,
        z: frame.rootPosition.z,
        yaw: frame.yaw
      };
      snapshot.head = {
        x: visual.head.position.x,
        y: visual.head.position.y,
        z: visual.head.position.z
      };
      snapshot.leftHand = {
        x: visual.leftHand.position.x,
        y: visual.leftHand.position.y,
        z: visual.leftHand.position.z,
        visible: visual.leftHand.visible
      };
      snapshot.rightHand = {
        x: visual.rightHand.position.x,
        y: visual.rightHand.position.y,
        z: visual.rightHand.position.z,
        visible: visual.rightHand.visible
      };
      snapshot.updatedAt = new Date().toISOString();
    },
    dispose(): void {
      visual.root.removeFromParent();
    }
  };
}

export function createFailedLocalAvatarDiagnostics(catalogUrl: string, reason: string): AvatarDiagnostics {
  return createAvatarFailedDiagnostics(catalogUrl, reason);
}

export { AVATAR_SELECTION_KEY };
