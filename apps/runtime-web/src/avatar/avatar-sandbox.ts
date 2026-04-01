import * as THREE from "three";

import {
  createAvatarFailedDiagnostics,
  createAvatarLoadedDiagnostics,
  type AvatarDiagnostics
} from "./avatar-debug.js";
import { createProceduralAvatarInstance, positionAvatarRing } from "./avatar-instance.js";
import { loadAvatarCatalog } from "./avatar-loader.js";
import { createAvatarRegistry, type AvatarRegistry } from "./avatar-registry.js";

export interface AvatarSandboxElements {
  panelEl: HTMLDivElement;
  presetSelectEl: HTMLSelectElement;
  statusEl: HTMLDivElement;
}

export interface AvatarSandboxBootResult {
  registry: AvatarRegistry | null;
  diagnostics: AvatarDiagnostics;
  statusMessage: string;
  selectedAvatarId: string | null;
  yaw: number;
  pitch: number;
}

export function setAvatarSandboxStatus(statusEl: HTMLDivElement, message: string): void {
  statusEl.textContent = message;
}

export async function bootAvatarSandbox(input: {
  catalogUrl: string;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  player: THREE.Group;
  elements: AvatarSandboxElements;
  previousRegistry: AvatarRegistry | null;
}): Promise<AvatarSandboxBootResult> {
  const { panelEl, presetSelectEl, statusEl } = input.elements;
  panelEl.hidden = false;
  presetSelectEl.replaceChildren();
  presetSelectEl.disabled = true;
  setAvatarSandboxStatus(statusEl, "Loading avatar presets...");

  try {
    const loaded = await loadAvatarCatalog({
      catalogUrl: input.catalogUrl,
      renderer: input.renderer
    });
    const instances = loaded.presets.map((preset) => createProceduralAvatarInstance(preset));
    positionAvatarRing(instances);
    input.previousRegistry?.root.removeFromParent();
    const registry = createAvatarRegistry(instances);
    input.scene.add(registry.root);

    const selectedAvatarId = instances[0]?.avatarId ?? null;
    if (selectedAvatarId) {
      registry.selectAvatar(selectedAvatarId);
    }

    for (const instance of instances) {
      const option = document.createElement("option");
      option.value = instance.avatarId;
      option.textContent = instance.label;
      option.selected = instance.avatarId === selectedAvatarId;
      presetSelectEl.appendChild(option);
    }

    presetSelectEl.disabled = instances.length === 0;
    presetSelectEl.onchange = () => {
      registry.selectAvatar(presetSelectEl.value);
      setAvatarSandboxStatus(statusEl, `Selected ${presetSelectEl.value}`);
    };

    input.player.position.set(0, 0, 8.5);
    setAvatarSandboxStatus(statusEl, `Loaded ${instances.length} presets`);
    return {
      registry,
      diagnostics: createAvatarLoadedDiagnostics({
        sandboxEntryPoint: input.catalogUrl,
        selectedAvatarId,
        catalogId: loaded.diagnostics.catalogId,
        packUrl: loaded.diagnostics.packUrl,
        packFormat: loaded.diagnostics.packFormat,
        presetCount: loaded.diagnostics.presetCount,
        validatorSummary: loaded.diagnostics.validatorSummary
      }),
      statusMessage: `Loaded ${instances.length} presets`,
      selectedAvatarId,
      yaw: Math.PI,
      pitch: -0.08
    };
  } catch (error) {
    return {
      registry: null,
      diagnostics: createAvatarFailedDiagnostics(
        input.catalogUrl,
        error instanceof Error ? error.message : "avatar_sandbox_failed"
      ),
      statusMessage: "Avatar sandbox failed, capsule fallback active",
      selectedAvatarId: null,
      yaw: Math.PI,
      pitch: -0.08
    };
  }
}
