import * as THREE from "three";

import { createLocalAvatarController, createFailedLocalAvatarDiagnostics, type AvatarSelectionStorage, type LocalAvatarController } from "./avatar-controller.js";
import { createAvatarLoadingDiagnostics, type AvatarDiagnostics } from "./avatar-debug.js";
import { resetAvatarSandbox, type AvatarFallbackElements } from "./avatar-fallback.js";
import { loadAvatarCatalog } from "./avatar-loader.js";
import { bootAvatarSandbox } from "./avatar-sandbox.js";
import type { AvatarRegistry } from "./avatar-registry.js";

export interface AvatarSessionResult {
  registry: AvatarRegistry | null;
  diagnostics: AvatarDiagnostics;
  note: "avatar_sandbox_booted" | "avatar_sandbox_failed";
  statusMessage: string;
  yaw: number;
  pitch: number;
}

export interface LocalAvatarSessionResult {
  controller: LocalAvatarController | null;
  diagnostics: AvatarDiagnostics;
  statusMessage: string;
  note: "local_avatar_ready" | "local_avatar_failed";
  presetOptions: Array<{ avatarId: string; label: string }>;
}

export function resetAvatarSession(input: {
  previousRegistry: AvatarRegistry | null;
  elements: AvatarFallbackElements;
  sandboxEntryPoint: string;
}): { registry: null; diagnostics: AvatarDiagnostics } {
  const result = resetAvatarSandbox({
    previousRegistry: input.previousRegistry,
    elements: input.elements,
    sandboxEntryPoint: input.sandboxEntryPoint
  });
  return {
    registry: result.registry,
    diagnostics: result.diagnostics
  };
}

export async function startAvatarSandboxSession(input: {
  catalogUrl: string;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  player: THREE.Group;
  previousRegistry: AvatarRegistry | null;
  elements: AvatarFallbackElements;
}): Promise<AvatarSessionResult> {
  input.elements.panelEl.hidden = false;
  const loadingDiagnostics = createAvatarLoadingDiagnostics(input.catalogUrl);
  const sandboxResult = await bootAvatarSandbox({
    catalogUrl: input.catalogUrl,
    renderer: input.renderer,
    scene: input.scene,
    player: input.player,
    previousRegistry: input.previousRegistry,
    elements: input.elements
  });

  return {
    registry: sandboxResult.registry,
    diagnostics: sandboxResult.diagnostics.state === "loading" ? loadingDiagnostics : sandboxResult.diagnostics,
    note: sandboxResult.diagnostics.state === "loaded" ? "avatar_sandbox_booted" : "avatar_sandbox_failed",
    statusMessage: sandboxResult.statusMessage,
    yaw: sandboxResult.yaw,
    pitch: sandboxResult.pitch
  };
}

export async function startLocalAvatarSession(input: {
  catalogUrl: string;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  storage?: AvatarSelectionStorage;
  preferredAvatarId?: string;
}): Promise<LocalAvatarSessionResult> {
  try {
    const loaded = await loadAvatarCatalog({
      catalogUrl: input.catalogUrl,
      renderer: input.renderer
    });
    const controller = createLocalAvatarController({
      presets: loaded.presets,
      diagnosticsInput: {
        catalogId: loaded.diagnostics.catalogId,
        packUrl: loaded.diagnostics.packUrl,
        packFormat: loaded.diagnostics.packFormat,
        presetCount: loaded.diagnostics.presetCount,
        validatorSummary: loaded.diagnostics.validatorSummary,
        sandboxEntryPoint: input.catalogUrl
      },
      storage: input.storage,
      preferredAvatarId: input.preferredAvatarId
    });
    input.scene.add(controller.root);
    return {
      controller,
      diagnostics: controller.diagnostics,
      statusMessage: `Local avatar ready: ${controller.selectedAvatarId}`,
      note: "local_avatar_ready",
      presetOptions: loaded.presets.map((preset) => ({
        avatarId: preset.preset.avatarId,
        label: preset.preset.label
      }))
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "avatar_room_session_failed";
    return {
      controller: null,
      diagnostics: createFailedLocalAvatarDiagnostics(input.catalogUrl, reason),
      statusMessage: "Local avatar disabled, room flow fallback active",
      note: "local_avatar_failed",
      presetOptions: []
    };
  }
}
