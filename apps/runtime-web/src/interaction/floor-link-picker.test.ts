import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFloorLinkPicker } from "./floor-link-picker.js";

test("the same stair mesh has two destinations; aiming through another mesh, off a tread or from another level does not switch floors", () => {
  const root = new THREE.Group(), stairs = new THREE.Group();
  stairs.userData.name = "Model.001";
  const tread = new THREE.Mesh(new THREE.BoxGeometry(1, .2, 1));
  stairs.add(tread); root.add(stairs);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, .1));
  wall.position.set(2, 0, 1); root.add(wall); root.updateMatrixWorld(true);
  const links = [0, 2].map(y => ({ node: "Model.001", fromY: y, destination: { x: 0, y: 2-y, z: 0 } }));
  const pick = createFloorLinkPicker(root, links)!;
  const ray = new THREE.Ray(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -1));
  for (const link of links) assert.deepEqual(pick(ray, link.fromY, 4)?.destination, link.destination);
  assert.equal(pick(ray, 1, 4), null);
  assert.equal(pick(ray, 0, 1), null);
  wall.position.x = 0; root.updateMatrixWorld(true);
  assert.equal(pick(ray, 0, 4), null);
  ray.origin.x = 3;
  assert.equal(pick(ray, 2, 4), null);
});
