import assert from "node:assert/strict";
import test from "node:test";
import { Group, AnimationClip, VectorKeyframeTrack } from "three";
import { isSceneClipEffects, type SceneClipEffect } from "@vrata/shared-types";
import { SceneEffects } from "./scene-effects.js";
import { sceneEffectGain } from "./scene-effect-audio.js";

const spec: SceneClipEffect = { id: "flight", kind: "clip-loop", root: "carrier", clips: ["orbit"] };
function fixture(target = "carrier") {
  const scene = new Group(),
    carrier = new Group(),
    prop = new Group();
  carrier.name = "carrier";
  prop.name = "prop";
  scene.add(carrier, prop);
  const clip = new AnimationClip("orbit", 1, [
    new VectorKeyframeTrack(`${target}.position`, [0, 1], [0, 0, 0, 2, 0, 0]),
  ]);
  const runtime = new SceneEffects(scene, [clip], [spec]);
  return { runtime, carrier };
}
test("clip effects require live owners, loop from the embedded clip, and release independently", () => {
  const { runtime, carrier } = fixture();
  let live = true;
  assert.equal(carrier.visible, false);
  assert.equal(
    runtime.set("a", "undeclared", true, () => true),
    false,
  );
  assert.ok(runtime.set("a", "flight", true, () => live));
  runtime.tick(0.25);
  assert.equal(carrier.position.x, 0.5);
  runtime.set("a", "flight", true, () => live);
  runtime.tick(1);
  assert.equal(carrier.position.x, 0.5);
  live = false;
  runtime.tick(0.1);
  assert.equal(carrier.visible, false);
  live = true;
  runtime.set("b", "flight", true, () => true);
  runtime.retire("a");
  runtime.tick(0.5);
  assert.equal(carrier.position.x, 1);
  runtime.set("b", "flight", false, () => true);
  runtime.tick(0.1);
  assert.equal(carrier.visible, false);
  runtime.dispose();
  assert.deepEqual(runtime.diagnostics(), []);
});
test("foreign tracks, duplicate bindings, URLs and undeclared fields are rejected", () => {
  assert.throws(() => fixture("prop"), /invalid_scene_effect_track/);
  for (const invalid of [
    [spec, spec],
    [{ ...spec, root: "https://invalid.local" }],
    [{ ...spec, clips: ["clip", "clip"] }],
    [{ ...spec, url: "other.glb" }],
  ]) {
    assert.equal(isSceneClipEffects(invalid), false);
  }
});

test("scene sound is bounded near the emitter and fades to zero at the authored radius", () => {
  const spec = { gain: 0.2, nearM: 5, farM: 45 };
  assert.equal(sceneEffectGain(spec, 0), 0.2);
  assert.equal(sceneEffectGain(spec, 5), 0.2);
  assert.equal(sceneEffectGain(spec, 25), 0.05);
  assert.equal(sceneEffectGain(spec, 45), 0);
  assert.equal(sceneEffectGain(spec, 100), 0);
  assert.equal(sceneEffectGain(spec, NaN), 0);
});
