import assert from "node:assert/strict";
import { test } from "node:test";
import { Ray } from "three";
import type { SceneEffects } from "../scene-effects.js";
import { createSceneSwitchRuntime } from "./scene-switch-runtime.js";

test("switch input sends a single explicit command based on the confirmed exact scene state", () => {
  const sent: unknown[] = [];
  const applied: unknown[] = [];
  const marker = { kind: "effect-switch", effectId: "hearth" };
  const effects = { applySwitchState: (state: unknown) => applied.push(state), pickSwitch: () => marker } as unknown as SceneEffects;
  let canActivate = true;
  const runtime = createSceneSwitchRuntime({ canActivate: () => canActivate, send: command => sent.push(command) });
  runtime.bind(effects, "scene-2");
  runtime.update({ versionId: "scene-1", switches: [{ id: "hearth", enabled: true }] });
  assert.equal(applied.at(-1), undefined);
  runtime.activate("hearth", 100);
  const state = { versionId: "scene-2", switches: [{ id: "hearth", enabled: false }] };
  runtime.update(state);
  assert.equal(applied.at(-1), state);
  assert.equal(runtime.pick(new Ray(), 3), marker);
  runtime.activate("hearth", 101);
  runtime.activate("hearth", 102);
  canActivate = false;
  assert.equal(runtime.pick(new Ray(), 3), undefined);
  runtime.activate("hearth", 550);
  assert.deepEqual(sent, [{ versionId: "scene-2", effectId: "hearth", enabled: true }]);
});
