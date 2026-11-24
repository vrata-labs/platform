import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Ray, Texture, Vector3 } from "three";
import { isSceneEffects, type SceneSpriteEffect } from "@vrata/shared-types";
import { SceneEffects } from "./scene-effects.js";

const hearth: SceneSpriteEffect = {
  id: "hearth", kind: "sprite-loop", root: "flames", atlas: { columns: 10, rows: 10, cycleSeconds: 3 },
  switch: { mount: "control", handle: "handle", offQuaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2], initiallyOn: true }
};

test("a scene switch affects only its own sprites, moves the handle and does not pick through walls", () => {
  const scene = new Group();
  const texture = new Texture();
  const source = new MeshStandardMaterial({ map: texture, emissiveMap: texture });
  const flames = new Group();
  flames.name = "flames";
  const sprite = new Mesh(new BoxGeometry(1, 1, 1), source);
  flames.add(sprite);
  const mount = new Mesh(new BoxGeometry(.4,.4,.4), new MeshStandardMaterial());
  mount.name = "control";
  const handle = new Group();
  handle.name = "handle";
  mount.add(handle);
  const obstacle = new Mesh(new BoxGeometry(1, 1, .1), new MeshStandardMaterial());
  obstacle.position.set(5, 0, 1);
  scene.add(flames, mount, obstacle);
  scene.updateMatrixWorld(true);
  const effects = new SceneEffects(scene, [], [hearth]);
  const ray = new Ray(new Vector3(0, 0, 2), new Vector3(0, 0, -1));
  assert.equal(flames.visible, false);
  assert.equal(effects.pickSwitch(ray, 3), undefined);
  assert.equal(effects.set("plugin", hearth.id, true, () => true), false);
  effects.applySwitchState({ versionId: "v1", switches: [{ id: "hearth", enabled: true }] });
  effects.tick(.2);
  assert.equal(flames.visible, true);
  assert.equal(effects.pickSwitch(ray, 3)?.effectId, "hearth");
  obstacle.position.x = 0;
  scene.updateMatrixWorld(true);
  assert.equal(effects.pickSwitch(ray, 3), undefined);
  effects.applySwitchState({ versionId: "v1", switches: [{ id: "hearth", enabled: false }] });
  effects.tick(.2);
  assert.equal(flames.visible, false);
  assert(handle.quaternion.angleTo(new Quaternion(...hearth.switch.offQuaternion)) < .001);
  assert.notEqual(sprite.material, source);
  effects.dispose();
  assert.equal(sprite.material, source);
});

test("sprite declarations reject unbounded atlases, overlapping switches and non-unit rotations", () => {
  assert(isSceneEffects([hearth]));
  assert(!isSceneEffects([{ ...hearth, atlas: { ...hearth.atlas, rows: 100 } }]));
  assert(!isSceneEffects([{ ...hearth, switch: { ...hearth.switch, offQuaternion: [0, 0, 2, 0] } }]));
  assert(!isSceneEffects([hearth, { ...hearth, id: "other", root: "other" }]));
});
