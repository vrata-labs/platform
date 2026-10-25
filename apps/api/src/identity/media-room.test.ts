import assert from "node:assert/strict";
import test from "node:test";
import { roomMediaGrantName } from "./media-room.js";

test("activated grants stay off the old room while preserving the legacy floor-one name", () => {
  const namespace = "a".repeat(32);
  assert.equal(roomMediaGrantName("meeting", "vrata-", null), "vrata-meeting");
  assert.equal(roomMediaGrantName("meeting", "vrata-", namespace), `vrata-v2:${namespace}:meeting`);
  assert.notEqual(roomMediaGrantName("meeting", "vrata-", namespace), roomMediaGrantName("meeting", "vrata-", null));
  assert.notEqual(roomMediaGrantName("meeting", "vrata-", namespace), roomMediaGrantName("v2:meeting", "vrata-", null));
  assert.notEqual(roomMediaGrantName("meeting", "vrata-", namespace), roomMediaGrantName("meeting", "vrata-", "b".repeat(32)));
  assert.equal(roomMediaGrantName("private", "custom-", namespace), `custom-v2:${namespace}:private`);
  assert.throws(() => roomMediaGrantName("meeting", "vrata-", "guessed"), /identity_protocol_namespace_invalid/);
});

test("codec-3 grants name one room incarnation", () => {
  const namespace = "a".repeat(32), first = "1".repeat(32), recreated = "2".repeat(32);
  const name = roomMediaGrantName("meeting", "vrata-", namespace, first);
  assert.equal(name, `vrata-v3:${namespace}:${first}:meeting`);
  assert.notEqual(name, roomMediaGrantName("meeting", "vrata-", namespace, recreated));
  assert.notEqual(name, roomMediaGrantName("meeting", "vrata-", namespace));
  assert.throws(() => roomMediaGrantName("meeting", "vrata-", namespace, "short"), /media_room_incarnation_invalid/);
  assert.throws(() => roomMediaGrantName("meeting", "vrata-", namespace, "A".repeat(32)), /media_room_incarnation_invalid/);
  assert.throws(() => roomMediaGrantName("meeting", "vrata-", null, first), /invalid_media_room_scope/);
});
