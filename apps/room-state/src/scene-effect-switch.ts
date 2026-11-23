import type { SceneEffectSwitchState } from "@vrata/shared-types";
import type { ParticipantAccessState } from "./state.js";

export function admitSceneEffectSwitches(current: SceneEffectSwitchState | undefined, access: ParticipantAccessState) {
  if (current && current.versionId === access.sceneEffectVersionId) return current;
  return access.sceneEffectSwitches?.versionId === access.sceneEffectVersionId ? access.sceneEffectSwitches : undefined;
}

export function setSceneEffectSwitch(current: SceneEffectSwitchState | undefined, access: ParticipantAccessState | null,
  command: { versionId?: unknown; effectId?: unknown; enabled?: unknown }) {
  if (!current || access?.role !== "host" || current.versionId !== access.sceneEffectVersionId ||
      current.versionId !== command.versionId || typeof command.enabled !== "boolean" ||
      typeof command.effectId !== "string" || command.effectId.length > 64) return current;
  const target = current.switches.find(item => item.id === command.effectId);
  if (!target || command.enabled === target.enabled) return current;
  const enabled = command.enabled;
  return { ...current, switches: current.switches.map(item => item === target ? { ...item, enabled } : item) };
}
