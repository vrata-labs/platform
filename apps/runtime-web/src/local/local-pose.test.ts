import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createLocalPoseController } from "./local-pose.js";

function createRig() {
  const player = new THREE.Group();
  const pitch = new THREE.Group();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0.5, 1.6, 0);
  pitch.add(camera);
  player.add(pitch);
  const pose = createLocalPoseController({
    player,
    pitch,
    initialPose: {
      position: { x: 0, y: 0, z: 6 },
      yaw: 0,
      pitch: 0
    }
  });
  return { player, pitch, camera, pose };
}

test("local pose controller applies spawn pose to player rig", () => {
  const { player, pitch, pose } = createRig();

  pose.setPose({ position: { x: 1, y: 0.25, z: -2 }, yaw: 0.5, pitch: -0.2 }, "spawn");

  assert.equal(player.position.x, 1);
  assert.equal(player.position.y, 0.25);
  assert.equal(player.position.z, -2);
  assert.equal(player.rotation.y, 0.5);
  assert.equal(pitch.rotation.x, -0.2);
});

test("local pose controller restores persisted personal pose", () => {
  const { player, pitch, pose } = createRig();

  pose.setPose({ position: { x: 2.5, y: 0, z: 3.25 }, yaw: 0.4, pitch: -0.1 }, "personal_state_restore");

  assert.equal(player.position.x, 2.5);
  assert.equal(player.position.z, 3.25);
  assert.equal(player.rotation.y, 0.4);
  assert.equal(pitch.rotation.x, -0.1);
  assert.equal(pose.getLastMutationReason(), "personal_state_restore");
});

test("local pose controller preserves headset world xz during xr snap turn", () => {
  const { camera, pose } = createRig();
  const before = new THREE.Vector3();
  camera.getWorldPosition(before);

  pose.setYaw(Math.PI / 2, "snap_turn", { preserveCameraXz: true, camera });
  const after = new THREE.Vector3();
  camera.getWorldPosition(after);

  assert.equal(Number(after.x.toFixed(4)), Number(before.x.toFixed(4)));
  assert.equal(Number(after.z.toFixed(4)), Number(before.z.toFixed(4)));
});

test("local pose controller teleports with xr camera offset compensation", () => {
  const { player, camera, pose } = createRig();

  pose.teleportToFloor({ x: 3, y: 0, z: -4 }, 0.25, "teleport", { preserveCameraOffset: true, camera });

  assert.equal(Number(player.position.x.toFixed(4)), 2.5);
  assert.equal(player.position.y, 0.25);
  assert.equal(player.position.z, -4);
});

test("local pose controller locks to seat without changing yaw unless requested", () => {
  const { pose } = createRig();
  pose.setYaw(0.7, "desktop_move");

  const locked = pose.lockToSeat({ x: 1, y: 0.45, z: -2 }, "seat_lock");

  assert.deepEqual(locked.position, { x: 1, y: 0.45, z: -2 });
  assert.equal(locked.yaw, 0.7);

  const entered = pose.lockToSeat({ x: 1, y: 0.45, z: -2 }, "seat_enter", { yaw: Math.PI });
  assert.equal(entered.yaw, Math.PI);
});
