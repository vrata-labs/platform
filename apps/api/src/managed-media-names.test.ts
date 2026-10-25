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
  assert.deepEqual(parseMediaRoomName(name, "vrata-", namespace), { codec: 2, roomId, incarnation: null, epoch });
  assert.deepEqual(parseMediaRoomName(roomMediaGrantName("weekly-sync", "vrata-", namespace), "vrata-", namespace),
    { codec: 2, roomId: "weekly-sync", incarnation: null, epoch: null });
  assert.equal(parseMediaRoomName(`vrata-v2:${"c".repeat(32)}:${roomId}`, "vrata-", namespace), null, "another namespace is foreign");
  assert.equal(parseMediaRoomName(`vrata-v2:${namespace}:a:b`, "vrata-", namespace), null);
  assert.throws(() => managedMediaRoomName(roomId, "1", "vrata-", namespace), /managed_media_epoch_invalid/);

  const managed = { roomId, managed: { accessEpoch: epoch } } as unknown as RoomRecord;
  assert.equal(currentMediaRoomName(managed, roomId, "vrata-", namespace), name);
  assert.equal(currentMediaRoomName(managed, roomId, "vrata-", null), roomMediaGrantName(roomId, "vrata-", null), "before v2 there is no epoch room");
  assert.equal(currentMediaRoomName({ roomId } as RoomRecord, roomId, "vrata-", namespace), roomMediaGrantName(roomId, "vrata-", namespace));
});

test("codec-3 names carry the room generation, with the access epoch for managed rooms, and parse only by round trip", () => {
  const first = "1".repeat(32), recreated = "2".repeat(32);
  const plain = roomMediaGrantName("weekly-sync", "vrata-", namespace, first);
  assert.equal(plain, `vrata-v3:${namespace}:${first}:weekly-sync`);
  assert.deepEqual(parseMediaRoomName(plain, "vrata-", namespace), { codec: 3, roomId: "weekly-sync", incarnation: first, epoch: null });
  const managed = managedMediaRoomName(roomId, epoch, "vrata-", namespace, first);
  assert.equal(managed, `vrata-v3:${namespace}:${first}:${roomId}:${epoch}`);
  assert.deepEqual(parseMediaRoomName(managed, "vrata-", namespace), { codec: 3, roomId, incarnation: first, epoch });
  assert.notEqual(managed, managedMediaRoomName(roomId, epoch, "vrata-", namespace, recreated));
  const record = { roomId, managed: { accessEpoch: epoch } } as unknown as RoomRecord;
  assert.equal(currentMediaRoomName(record, roomId, "vrata-", namespace, first), managed);
  assert.equal(currentMediaRoomName({ roomId } as RoomRecord, roomId, "vrata-", namespace, first), roomMediaGrantName(roomId, "vrata-", namespace, first));
  for (const foreign of [roomMediaGrantName("weekly-sync", "vrata-", "c".repeat(32), first), roomMediaGrantName("weekly-sync", "other-", namespace, first),
    `vrata-v3:${namespace}:${first}:`, `vrata-v3:${namespace}:${first}weekly-sync`, `vrata-v3:${namespace}:${"g".repeat(32)}:weekly-sync`,
    `vrata-v3:${namespace}:${first}:a:b`, `vrata-v3:${namespace}:${first}:${"x".repeat(201)}`, `vrata-v2:${namespace}:`, "vrata-weekly-sync",
    `vrata-v4:${namespace}:${first}:weekly-sync`, `${managed}:${epoch}`]) {
    assert.equal(parseMediaRoomName(foreign, "vrata-", namespace), null, foreign);
  }
  assert.equal(parseMediaRoomName(plain, "vrata-", "guessed"), null);
});
