import * as THREE from "three";

import { createAvatarLoadingDiagnostics, type AvatarDiagnostics } from "./avatar-debug.js";
import { resetAvatarSandbox, type AvatarFallbackElements } from "./avatar-fallback.js";
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
