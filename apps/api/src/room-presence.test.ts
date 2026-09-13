import test from "node:test";
import assert from "node:assert/strict";

import { createRoomPresence, type PresenceRecord } from "./room-presence.js";

const now = Date.parse("2026-09-13T12:00:00.000Z");

function record(participantId = "p1", ageMs = 0): PresenceRecord {
  return {
    participantId, displayName: "Guest", role: "member", permissions: ["room.join"],
    mode: "desktop", rootTransform: { x: 1, y: 2, z: 3 }, muted: false,
    activeMedia: { audio: true, screenShare: false }, updatedAt: new Date(now - ageMs).toISOString()
  };
}

function fixture(ttl = 15000) {
  const rooms = new Map<string, Map<string, PresenceRecord>>();
  return { rooms, ...createRoomPresence(rooms, ttl) };
}

test("creation and missing-room operations do not read the clock or allocate rooms", (t) => {
  t.mock.method(Date, "now", () => { throw new Error("unexpected clock read"); });
  const presence = fixture();
  assert.deepEqual(presence.getPresence("missing"), []);
  assert.equal(presence.deletePresence("missing", "p1"), undefined);
  assert.equal(presence.cleanupAllPresence(), undefined);
  assert.equal(presence.activeParticipantCount(), 0);
  assert.equal(presence.rooms.size, 0);
});

test("upsert retains the exact record and nested references without modifying the payload", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  const payload = record();
  const before = structuredClone(payload);
  assert.equal(presence.upsertPresence("room", "p1", payload), undefined);
  assert.strictEqual(presence.rooms.get("room")?.get("p1"), payload);
  assert.strictEqual(presence.getPresence("room")[0]?.rootTransform, payload.rootTransform);
  assert.deepEqual(payload, before);
});

test("the explicit participant key is not replaced with the payload participant ID", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  const payload = record("different");
  presence.upsertPresence("room", "key", payload);
  assert.strictEqual(presence.rooms.get("room")?.get("key"), payload);
  assert.equal(presence.rooms.get("room")?.has("different"), false);
  presence.deletePresence("room", "different");
  assert.deepEqual(presence.getPresence("room"), [payload]);
});

test("get returns a new array while preserving record identity and insertion order", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  const first = record("z");
  const second = record("a");
  presence.upsertPresence("room", "z", first);
  presence.upsertPresence("room", "a", second);
  const result = presence.getPresence("room");
  assert.deepEqual(result, [first, second]);
  assert.notStrictEqual(result, presence.getPresence("room"));
  result.pop();
  assert.equal(presence.getPresence("room").length, 2);
  first.muted = true;
  assert.equal(presence.getPresence("room")[0]?.muted, true);
});

test("updating an existing participant replaces its record without reordering other entries", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  presence.upsertPresence("room", "a", record("a"));
  const second = record("b");
  presence.upsertPresence("room", "b", second);
  const replacement = record("a");
  presence.upsertPresence("room", "a", replacement);
  assert.deepEqual(presence.getPresence("room"), [replacement, second]);
  assert.strictEqual(presence.getPresence("room")[0], replacement);
});

for (const [age, retained] of [[14999, true], [15000, true], [15001, false]] as const) {
  test(`expiry retains the original strict TTL boundary at age ${age}`, (t) => {
    t.mock.method(Date, "now", () => now);
    const presence = fixture();
    const payload = record("p1", age);
    presence.upsertPresence("room", "p1", payload);
    assert.deepEqual(presence.getPresence("room"), retained ? [payload] : []);
    assert.equal(presence.rooms.has("room"), retained);
  });
}

test("get only cleans the requested room and removes it when its final record expires", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  presence.upsertPresence("first", "p1", record("p1", 15001));
  presence.upsertPresence("second", "p2", record("p2", 15001));
  assert.deepEqual(presence.getPresence("first"), []);
  assert.equal(presence.rooms.has("first"), false);
  assert.equal(presence.rooms.get("second")?.size, 1);
});

test("upsert cleans old records before inserting but does not validate the new timestamp", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  presence.upsertPresence("room", "old", record("old", 15001));
  const oldMap = presence.rooms.get("room");
  const stale = record("new", 15002);
  presence.upsertPresence("room", "new", stale);
  assert.equal(oldMap?.size, 0);
  assert.notStrictEqual(presence.rooms.get("room"), oldMap);
  assert.strictEqual(presence.rooms.get("room")?.get("new"), stale);
  assert.deepEqual(presence.getPresence("room"), []);
});

test("invalid and future timestamps retain the original Date.parse behavior", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  for (const [id, timestamp] of [["invalid", "not-a-date"], ["empty", ""], ["future", new Date(now + 100000).toISOString()]] as const) {
    presence.upsertPresence("room", id, { ...record(id), updatedAt: timestamp });
  }
  assert.equal(presence.getPresence("room").length, 3);
});

test("deletion neither reads time nor eagerly removes the empty room map", (t) => {
  const presence = fixture();
  presence.upsertPresence("room", "p1", record());
  t.mock.method(Date, "now", () => { throw new Error("unexpected clock read"); });
  assert.equal(presence.deletePresence("room", "p1"), undefined);
  assert.equal(presence.rooms.has("room"), true);
  assert.equal(presence.rooms.get("room")?.size, 0);
});

test("deleting a missing participant does not clean expired peers or other rooms", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  presence.upsertPresence("room", "p1", record("p1", 15001));
  presence.upsertPresence("other", "p1", record("p1", 15001));
  presence.deletePresence("room", "missing");
  assert.equal(presence.rooms.get("room")?.size, 1);
  assert.equal(presence.rooms.get("other")?.size, 1);
});

test("cleanupAllPresence removes expired and empty rooms while retaining fresh peers", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  const fresh = record("fresh");
  presence.rooms.set("mixed", new Map([["old", record("old", 15001)], ["fresh", fresh]]));
  presence.rooms.set("old", new Map([["old", record("old", 15001)]]));
  presence.rooms.set("empty", new Map());
  presence.cleanupAllPresence();
  assert.deepEqual([...presence.rooms.keys()], ["mixed"]);
  assert.deepEqual([...presence.rooms.get("mixed")!.values()], [fresh]);
});

test("activeParticipantCount cleans all rooms and counts the same identity once per room", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  presence.rooms.set("a", new Map([["same", record("same")], ["old", record("old", 15001)]]));
  presence.rooms.set("b", new Map([["same", record("same")]]));
  presence.rooms.set("empty", new Map());
  assert.equal(presence.activeParticipantCount(), 2);
  assert.equal(presence.rooms.size, 2);
  assert.equal(presence.rooms.get("a")?.size, 1);
});

for (const [ttl, ages] of [
  [0, [-1, 0]], [-1, [-1]], [NaN, [-1, 0, 1]], [Infinity, [-1, 0, 1]], [-Infinity, []]
] as Array<[number, number[]]>) {
  test(`TTL ${ttl} is used unchanged without clamping or a fallback`, (t) => {
    t.mock.method(Date, "now", () => now);
    const presence = fixture(ttl);
    presence.rooms.set("room", new Map([-1, 0, 1].map((age) => [String(age), record(String(age), age)])));
    assert.deepEqual(presence.getPresence("room").map((p) => Number(p.participantId)), ages);
  });
}

test("each room cleanup samples time once, rather than once per participant or globally", (t) => {
  let clockReads = 0;
  t.mock.method(Date, "now", () => now + clockReads++);
  const presence = fixture(0);
  presence.rooms.set("a", new Map([["1", record("1")], ["2", record("2")]]));
  presence.rooms.set("b", new Map([["3", record("3")]]));
  assert.equal(presence.activeParticipantCount(), 2);
  assert.equal(clockReads, 2);
  assert.equal(presence.rooms.has("b"), false);
});

test("cleanupAllPresence snapshots room keys before traversing them", (t) => {
  const presence = fixture(0);
  presence.rooms.set("a", new Map([["1", record("1")]]));
  t.mock.method(Date, "now", () => {
    presence.rooms.set("later", new Map([["old", record("old", 15001)]]));
    return now;
  });
  presence.cleanupAllPresence();
  assert.equal(presence.rooms.get("later")?.size, 1);
});

test("an injected map remains shared with external room deletion and record insertion", (t) => {
  t.mock.method(Date, "now", () => now);
  const rooms = new Map<string, Map<string, PresenceRecord>>();
  const presence = createRoomPresence(rooms, 15000);
  presence.upsertPresence("room", "p1", record());
  rooms.delete("room");
  assert.deepEqual(presence.getPresence("room"), []);
  const payload = record();
  rooms.set("room", new Map([["p1", payload]]));
  assert.strictEqual(presence.getPresence("room")[0], payload);
});

test("independent registries retain separate state and TTL values", (t) => {
  t.mock.method(Date, "now", () => now);
  const first = fixture(10);
  const second = fixture(20);
  first.upsertPresence("room", "p1", record("p1", 15));
  second.upsertPresence("room", "p1", record("p1", 15));
  assert.deepEqual(first.getPresence("room"), []);
  assert.equal(second.getPresence("room").length, 1);
});

test("timestamp getter failures propagate without discarding remaining entries", (t) => {
  t.mock.method(Date, "now", () => now);
  const presence = fixture();
  const error = new Error("timestamp read failed");
  const payload = Object.defineProperty(record(), "updatedAt", { get() { throw error; } });
  presence.rooms.set("room", new Map([["old", record("old", 15001)], ["bad", payload], ["fresh", record("fresh")]]));
  assert.throws(() => presence.getPresence("room"), (value) => value === error);
  assert.deepEqual([...presence.rooms.get("room")!.keys()], ["bad", "fresh"]);
});
