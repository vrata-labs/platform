import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createLocalPoseController } from "./local-pose.js";
import { NON_XR_CAMERA_HEIGHT, resolveLocalSeatRootPosition } from "./seat-pose.js";

const seat = { id: "seat", position: { x: 2, y: .1, z: -3 }, yaw: Math.PI / 2, seatHeight: .48, radius: .35 };

test("desktop seat transition places camera and published head above cushion and teleport restores standing eye", () => {
  const player = new THREE.Group(), pitch = new THREE.Group(), camera = new THREE.PerspectiveCamera();
  camera.position.y = NON_XR_CAMERA_HEIGHT;
  player.add(pitch); pitch.add(camera);
  const pose = createLocalPoseController({ player, pitch });
  pose.lockToSeat(resolveLocalSeatRootPosition(seat, false), "seat_enter", { yaw: seat.yaw });
  const eye = camera.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(eye.y - 1.3) < 1e-9);
  assert.ok(Math.abs(pose.getPosition().y + NON_XR_CAMERA_HEIGHT - eye.y) < 1e-9);
  assert.equal(eye.x, 2); assert.equal(eye.z, -3);
  pose.teleportToFloor({ x: 0, y: 0, z: 4 }, 0, "teleport");
  assert.deepEqual(camera.getWorldPosition(new THREE.Vector3()).toArray(), [0, 1.6, 4]);
});

test("XR seat root retains the tracked-headset baseline, independent of desktop eye offset", () => {
  assert.deepEqual(resolveLocalSeatRootPosition(seat, true), { x: 2, y: .58, z: -3 });
});
