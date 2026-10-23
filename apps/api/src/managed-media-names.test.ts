import assert from "node:assert/strict";
import test from "node:test";

import { roomMediaGrantName } from "./identity/media-room.js";
import { currentMediaRoomName, managedMediaRoomName, parseMediaRoomName } from "./managed-media-names.js";
import type { RoomRecord } from "./storage-contracts.js";

const namespace = "b".repeat(32);
const roomId = "3f2b8c1e-5a6d-4e7f-9a1b-2c3d4e5f6a7b";
const epoch = "9b2d7f4a-1c3e-4f5a-8b6c-7d8e9f0a1b2c";

test("a managed room joins the LiveKit room of its current access epoch", () => {
  const name = managedMediaRoomName(roomId, epoch, "vrata-", namespace);
  assert.equal(name, `${roomMediaGrantName(roomId, "vrata-", namespace)}:${epoch}`);
  assert.deepEqual(parseMediaRoomName(name, "vrata-", namespace), { roomId, epoch });
  assert.deepEqual(parseMediaRoomName(roomMediaGrantName("weekly-sync", "vrata-", namespace), "vrata-", namespace), { roomId: "weekly-sync", epoch: null });
  assert.equal(parseMediaRoomName(`vrata-v2:${"c".repeat(32)}:${roomId}`, "vrata-", namespace), null, "another namespace is foreign");
  assert.equal(parseMediaRoomName(`vrata-v2:${namespace}:a:b`, "vrata-", namespace), null);
  assert.throws(() => managedMediaRoomName(roomId, "1", "vrata-", namespace), /managed_media_epoch_invalid/);

  const managed = { roomId, managed: { accessEpoch: epoch } } as unknown as RoomRecord;
  assert.equal(currentMediaRoomName(managed, roomId, "vrata-", namespace), name);
  assert.equal(currentMediaRoomName(managed, roomId, "vrata-", null), roomMediaGrantName(roomId, "vrata-", null), "before v2 there is no epoch room");
  assert.equal(currentMediaRoomName({ roomId } as RoomRecord, roomId, "vrata-", namespace), roomMediaGrantName(roomId, "vrata-", namespace));
});
