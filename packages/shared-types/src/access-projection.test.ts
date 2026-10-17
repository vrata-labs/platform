import test from "node:test";
import assert from "node:assert/strict";
import { createRoomAccessDebugState, createRoomAccessFromPermissions, getRoomPermissions, type RoomPermission, type RoomRole } from "./access.js";

test("access projection does not restore capabilities from a stronger role label", () => {
  const access = createRoomAccessFromPermissions("host", ["room.join", "audio.join", "surface.view"]);
  assert.equal(access.role, "host");
  for (const [key, value] of Object.entries(access)) if (key.startsWith("can")) assert.equal(value, false, key);
  assert.deepEqual(access.permissions, ["room.join", "audio.join", "surface.view"]);
});
test("default role access delegates without changing the existing role matrix", () => {
  for (const role of ["guest", "member", "presenter", "host", "admin"] as RoomRole[]) {
    assert.deepEqual(createRoomAccessDebugState(role), createRoomAccessFromPermissions(role, getRoomPermissions(role)));
  }
});
test("projection copies and deduplicates explicit permissions", () => {
  const permissions: RoomPermission[] = ["document.upload", "document.upload", "room.join"];
  const access = createRoomAccessFromPermissions("presenter", permissions); permissions.push("room.admin");
  assert.deepEqual(access.permissions, ["document.upload", "room.join"]); assert.equal(access.canManageRoomSession, false);
});
