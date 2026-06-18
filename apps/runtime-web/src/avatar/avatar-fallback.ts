import { createAvatarFailedDiagnostics, createEmptyAvatarDiagnostics, type AvatarDiagnostics } from "./avatar-debug.js";
import type { AvatarRegistry } from "./avatar-registry.js";

export interface AvatarFallbackElements {
  panelEl: HTMLDivElement;
  presetSelectEl: HTMLSelectElement;
  statusEl: HTMLDivElement;
}

export interface AvatarFallbackResult {
  registry: null;
  diagnostics: AvatarDiagnostics;
  statusMessage: string;
}

export function resetAvatarSandbox(input: {
  previousRegistry: AvatarRegistry | null;
  elements: AvatarFallbackElements;
  reason?: string;
  sandboxEntryPoint?: string | null;
}): AvatarFallbackResult {
  input.previousRegistry?.root.removeFromParent();
  input.elements.panelEl.hidden = true;
  input.elements.presetSelectEl.replaceChildren();
  input.elements.presetSelectEl.disabled = true;
  input.elements.presetSelectEl.onchange = null;

  if (input.reason) {
    input.elements.statusEl.textContent = "Avatar fallback active";
    return {
      registry: null,
      diagnostics: createAvatarFailedDiagnostics(input.sandboxEntryPoint ?? "", input.reason),
      statusMessage: "Avatar fallback active"
    };
  }

  const diagnostics = createEmptyAvatarDiagnostics();
  diagnostics.sandboxEntryPoint = input.sandboxEntryPoint ?? null;
  input.elements.statusEl.textContent = "Avatar sandbox idle";
  return {
    registry: null,
    diagnostics,
    statusMessage: "Avatar sandbox idle"
  };
}
