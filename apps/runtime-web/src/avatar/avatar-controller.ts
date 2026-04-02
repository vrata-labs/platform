import * as THREE from "three";

import {
  createAvatarFailedDiagnostics,
  createAvatarLoadedDiagnostics,
  type AvatarDiagnostics
} from "./avatar-debug.js";
import { computeAvatarAnimationPose, selectAvatarAnimationClip } from "./avatar-animation.js";
import { resolveAvatarLocomotion } from "./avatar-locomotion.js";
import { solveUpperBodyPose, type AvatarPosePoint } from "./avatar-ik.js";
import type { AvatarInputMode, LoadedAvatarPreset } from "./avatar-types.js";
import { resolveSelfAvatarVisibility } from "./avatar-visibility.js";

export interface AvatarSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocalAvatarController {
  root: THREE.Group;
  selectedAvatarId: string;
  diagnostics: AvatarDiagnostics;
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
  }): void;
  dispose(): void;
}

const AVATAR_SELECTION_KEY = "noah.avatarPresetId";

interface LocalAvatarVisual {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  leftHand: THREE.Mesh;
  rightHand: THREE.Mesh;
  aura: THREE.Mesh;
}

function createMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.02 });
}

function createLocalAvatarVisual(preset: LoadedAvatarPreset): LocalAvatarVisual {
  const root = new THREE.Group();
  root.name = `self-avatar:${preset.preset.avatarId}`;

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.8, 6, 12), createMaterial(preset.recipe.palette.primary));
  body.position.y = 0.92;
  root.add(body);

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

  return { root, body, head, leftHand, rightHand, aura };
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
     activeControllerCount: 0
   });

  return {
    root: visual.root,
    selectedAvatarId: selectedPreset.preset.avatarId,
    diagnostics,
    update(frame): void {
      animationElapsedSeconds += Math.max(0, frame.deltaSeconds);
      const visibility = resolveSelfAvatarVisibility({
        inputMode: frame.inputMode,
        xrPresenting: frame.xrPresenting
      });
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
        inputMode: frame.inputMode
      });
      const controllerCount = Number(Boolean(frame.leftHand)) + Number(Boolean(frame.rightHand));
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

      visual.root.position.set(frame.rootPosition.x, frame.rootPosition.y, frame.rootPosition.z);
      visual.root.rotation.y = frame.yaw;

      visual.body.position.set(0, 0.92 + pose.bodyBob, 0);
      visual.body.rotation.z = pose.bodyRoll;
      visual.head.position.set(solve.headLocal.x, solve.headLocal.y, solve.headLocal.z);
      visual.head.rotation.z = pose.headTilt;
      visual.leftHand.position.set(
        solve.leftHandLocal.x,
        solve.leftHandLocal.y + pose.leftHandYOffset,
        solve.leftHandLocal.z + pose.leftHandForward
      );
      visual.rightHand.position.set(
        solve.rightHandLocal.x,
        solve.rightHandLocal.y + pose.rightHandYOffset,
        solve.rightHandLocal.z + pose.rightHandForward
      );
      const auraScale = animation.fallback ? Math.max(1.02, pose.auraScale - 0.03) : pose.auraScale;
      visual.aura.scale.setScalar(auraScale);
      (visual.aura.material as THREE.MeshBasicMaterial).opacity = animation.fallback ? 0.14 : 0.18 + Math.min(0.18, locomotion.speed * 0.08);

      visual.body.visible = visibility === "full-body";
      visual.head.visible = visibility === "full-body";
      visual.leftHand.visible = visibility !== "hidden";
      visual.rightHand.visible = visibility !== "hidden";
      visual.aura.visible = visibility !== "hidden";

      diagnostics.inputMode = frame.inputMode;
      diagnostics.locomotionState = locomotion.state;
      diagnostics.visibilityState = visibility;
      diagnostics.solveState = solve.solveState;
      diagnostics.animationState = animation.clip;
      diagnostics.activeControllerCount = controllerCount;
      diagnostics.fallbackActive = (solve.solveState === "fallback" && frame.xrPresenting) || animation.fallback;
      diagnostics.fallbackReason = solve.solveState === "fallback" && frame.xrPresenting
        ? "xr_input_partial_fallback"
        : animation.fallback
          ? `animation_clip_fallback:${locomotion.state}`
          : null;
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
