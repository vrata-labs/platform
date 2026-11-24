import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Texture, Vector3 } from "three";
import { isSceneEffects, type SceneHeldPropEffect } from "@vrata/shared-types";
import { bindHeldSceneProp } from "./scene-held-prop.js";

const spec: SceneHeldPropEffect = {
  id: "tethered", kind: "held-prop", root: "atlas", fixture: "body", handle: "handle",
  tip: "tip", connector: "connector", tether: "end", restHose: "rest", soundSource: "sound",
  pickupM: .35, reachM: 2, contactM: .14, hoseRadiusM: .008,
  burst: { columns: 6, rows: 6, durationSeconds: 3, intervalSeconds: 6.5 }
};

test("the held part moves independently, restores its resting geometry and emits from contact", () => {
  const scene = new Group();
  const fixture = new Group(), handle = new Group(), camera = new Object3D();
  const rest = new Mesh(new BoxGeometry(.5,.05,.05), new MeshStandardMaterial());
  const atlas = new Mesh(new BoxGeometry(1,1,1), new MeshStandardMaterial({ map: new Texture() }));
  const tip = new Object3D(), end = new Object3D(), connector = new Object3D(), sound = new Object3D();
  scene.add(fixture, atlas, camera);
  fixture.add(handle, rest, connector, sound);
  handle.add(tip, end);
  handle.position.set(.75, .9, 0);
  end.position.set(-.07, 0, 0);
  tip.position.set(.10, 0, 0);
  camera.position.set(1.4, 1.2, .085);
  const nodes = { body: fixture, handle, rest, atlas, tip, end, connector, sound };
  const prop = bindHeldSceneProp(scene, spec, name => nodes[name as keyof typeof nodes])();
  const resting = handle.getWorldPosition(new Vector3()).toArray();
  const update = (nowMs: number, x: number, y: number, pressed: boolean) => {
    prop.update({ nowMs, enabled: true, head: { position: camera.position, orientation: camera.quaternion }, hands: {
      left: { pressed: false, pose: null },
      right: { pressed, pose: { position: { x, y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, sourceIndex: 0 } }
    } });
    prop.tick(nowMs);
  };
  try {
    assert.equal(atlas.visible, false);
    update(0, .75, .9, true);
    assert.equal(prop.diagnostics().holding, "right");
    assert.equal(prop.diagnostics().bursts, 0);
    assert.equal(rest.visible, false);
    update(20, 1.3, 1.115, true);
    assert.equal(prop.diagnostics().bursts, 1);
    assert.equal(prop.diagnostics().playing, true);
    assert.deepEqual(fixture.getWorldPosition(new Vector3()).toArray(), [0,0,0]);
    update(40, 1.3, 1.115, false);
    assert.equal(prop.diagnostics().holding, null);
    assert.deepEqual(prop.diagnostics().position, resting);
    assert.equal(rest.visible, true);
    prop.tick(4000);
    assert.equal(prop.diagnostics().playing, false);
  } finally { prop.dispose(); }
  assert.equal(atlas.visible, false);
});

test("held prop declarations require bounded values and a single non-overlapping set of nodes", () => {
  assert(isSceneEffects([spec]));
  assert(!isSceneEffects([{ ...spec, reachM: 8 }]));
  assert(!isSceneEffects([{ ...spec, connector: spec.handle }]));
  assert(!isSceneEffects([{ ...spec, burst: { ...spec.burst, intervalSeconds: 1 } }]));
  assert(!isSceneEffects([spec, { ...spec, id: "other", root: "second" }]));
});
