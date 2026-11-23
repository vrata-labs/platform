import type { SceneEffectSwitchState } from "@vrata/shared-types";
import type { Ray } from "three";
import type { SceneEffects } from "../scene-effects.js";

/** Bind the confirmed switch state to the exact scene being displayed. */
export function createSceneSwitchRuntime(input: {
  canActivate(): boolean;
  send(command: { versionId: string; effectId: string; enabled: boolean }): void;
}) {
  let effects: SceneEffects | undefined;
  let version: string | undefined;
  let state: SceneEffectSwitchState | undefined;
  let lastActivation = -Infinity;
  const scoped = () => version && version === state?.versionId ? state : undefined;
  const sync = () => effects?.applySwitchState(scoped());
  return {
    bind(next: SceneEffects | undefined, versionId?: string) {
      effects = next;
      version = versionId;
      lastActivation = -Infinity;
      sync();
    },
    update(next?: SceneEffectSwitchState) { state = next; sync(); },
    pick(ray: Ray, max: number) {
      return input.canActivate() ? effects?.pickSwitch(ray, max) : undefined;
    },
    activate(effectId: string, now = performance.now()) {
      const active = scoped();
      const target = active?.switches.find(item => item.id === effectId);
      if (!active || !target || !input.canActivate() || now - lastActivation < 250) return;
      lastActivation = now;
      input.send({ versionId: active.versionId, effectId, enabled: !target.enabled });
    }
  };
}
