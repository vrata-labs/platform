import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { applySeatAnchorToPlayer, createAvatarSeatAnchorMap, resolveLocalSeatId, resolveSeatRootPosition } from "./avatar-seating.js";

const anchor = {
  id: "seat-a",
  position: { x: 1, y: 0, z: -2 },
  yaw: Math.PI / 2,
  seatHeight: 0.45,
  radius: 0.5,
  label: "Seat A"
};

test("createAvatarSeatAnchorMap indexes anchors by id", () => {
  const map = createAvatarSeatAnchorMap([anchor]);
  assert.equal(map.get("seat-a")?.label, "Seat A");
});

test("resolveSeatRootPosition applies seat height to anchor base", () => {
  assert.deepEqual(resolveSeatRootPosition(anchor), { x: 1, y: 0.45, z: -2 });
});

test("applySeatAnchorToPlayer fixes player transform to seat anchor", () => {
  const player = new THREE.Group();
  player.rotation.y = 0.25;
  applySeatAnchorToPlayer(player, anchor);
  assert.equal(player.position.x, 1);
  assert.equal(player.position.y, 0.45);
  assert.equal(player.position.z, -2);
  assert.equal(player.rotation.y, 0.25);
});

test("resolveLocalSeatId finds participant seat in occupancy map", () => {
  assert.equal(resolveLocalSeatId({ "seat-a": "p-1", "seat-b": "p-2" }, "p-2"), "seat-b");
  assert.equal(resolveLocalSeatId({ "seat-a": "p-1" }, "p-3"), null);
});
