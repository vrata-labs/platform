import assert from "node:assert/strict";
import test from "node:test";
import { createRoomIdentityTab } from "./identity-session-tab.js";

const identity = `ri2.${"a".repeat(40)}.${"b".repeat(43)}`;
const waiting = `rw2.12345678-1234-4234-8234-1234567890ab.${"c".repeat(43)}`;

test("tab continuity is room-keyed and cannot turn a public ID into proof", () => {
  const storage = new Map<string, string>([["vrata.participantId", "public-victim-id"]]);
  const tab = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); } };
  const first = createRoomIdentityTab(tab, "room-one");
  const other = createRoomIdentityTab(tab, "room-two");
  assert.equal(first.identityCredential(), null);
  first.rememberWaiting(waiting);
  assert.equal(first.waitingCredential(), waiting);
  assert.equal(other.waitingCredential(), null);
  first.rememberIdentity(identity);
  assert.equal(first.identityCredential(), identity);
  assert.equal(first.waitingCredential(), null);
  assert.equal(other.identityCredential(), null);
  assert.equal(storage.get("vrata.participantId"), "public-victim-id");
  assert.deepEqual([...storage.keys()].filter(key => key.includes("identity.v2")), ["vrata.identity.v2.room-one"]);
  assert.throws(() => first.rememberIdentity("public-victim-id"), /invalid_room_identity_credential/);
});

test("storage denial cannot throw into boot or expose a different room's credential", () => {
  const tab = createRoomIdentityTab({ getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); },
    removeItem() { throw new Error("unavailable"); } }, "private-room");
  assert.equal(tab.identityCredential(), null);
  assert.doesNotThrow(() => tab.rememberIdentity(identity));
  assert.equal(tab.identityCredential(), identity);
  assert.doesNotThrow(() => tab.rememberWaiting(waiting));
  assert.equal(tab.waitingCredential(), waiting);
  assert.doesNotThrow(() => tab.discardWaiting());
  assert.equal(tab.waitingCredential(), null);
});
