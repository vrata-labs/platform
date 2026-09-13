import assert from "node:assert/strict";
import test from "node:test";

import type { RoomRecord } from "./storage.js";
import { isPersonalRoom, isPersonalRoomOwner, normalizeDisplayName, personalRoomName, normalizePersonalState } from "./personal-room-rules.js";

// These rules read only the supplied room fields; storage is never initialized.
const room = (fields: Partial<RoomRecord>): RoomRecord => fields as RoomRecord;
const pose = () => ({ position: { x: 1, y: 2, z: 3 }, yaw: 0.5, pitch: -0.25 });
const fixedTime = new Date("2026-01-02T03:04:05.000Z");

test("personal room detection accepts only the exact room type", () => {
  assert.equal(isPersonalRoom(null), false);
  assert.equal(isPersonalRoom(undefined), false);
  assert.equal(isPersonalRoom(room({ roomType: "personal" })), true);
  for (const roomType of [undefined, null, "standard", "Personal", " personal", "personal ", false, 0, {}]) {
    assert.equal(isPersonalRoom({ roomType } as RoomRecord), false);
  }
});

test("ownership requires a personal room and an exact participant match", () => {
  assert.equal(isPersonalRoomOwner(room({ roomType: "personal", ownerParticipantId: "Owner" }), "Owner"), true);
  for (const participantId of [undefined, null, "", "owner", " Owner", "Owner ", "other"]) {
    assert.equal(isPersonalRoomOwner(room({ roomType: "personal", ownerParticipantId: "Owner" }), participantId), false);
  }
  for (const roomType of [undefined, "standard"] as const) {
    assert.equal(isPersonalRoomOwner(room({ roomType, ownerParticipantId: "Owner" }), "Owner"), false);
  }
});

test("ownership rejects empty identities but does not trim nonempty ones", () => {
  for (const participantId of [undefined, null, ""]) {
    assert.equal(isPersonalRoomOwner(room({ roomType: "personal", ownerParticipantId: participantId }), participantId), false);
  }
  assert.equal(isPersonalRoomOwner(room({ roomType: "personal", ownerParticipantId: " " }), " "), true);
});

test("room ownership does not apply access, session or disabled-room policy", () => {
  const input = Object.freeze(room({ roomType: "personal", ownerParticipantId: "owner", status: "disabled", visibility: "private", sessionControl: { endedAt: "ended", lockedAt: "locked" } }));
  assert.equal(isPersonalRoom(input), true);
  assert.equal(isPersonalRoomOwner(input, "owner"), true);
});

test("display names fall back for nonstrings and blank strings", () => {
  for (const input of [undefined, null, false, 12, {}, ["Name"], new String("Name"), "", " \t\n\u00a0 "]) {
    assert.equal(normalizeDisplayName(input, "AbCdEf"), "Guest-AbCd");
  }
  assert.equal(normalizeDisplayName(null, "xy"), "Guest-xy");
  assert.equal(normalizeDisplayName(null, ""), "Guest-");
});

test("display names trim and collapse whitespace without changing other characters", () => {
  assert.equal(normalizeDisplayName(" \tАнна\n\r Иванова\u00a0 ", "id"), "Анна Иванова");
  assert.equal(normalizeDisplayName("<Name>&\"'", "id"), "<Name>&\"'");
  assert.equal(normalizeDisplayName("a\u200bb", "id"), "a\u200bb");
});

test("display names normalize before the 40-code-unit truncation", () => {
  assert.equal(normalizeDisplayName(`  ${"a".repeat(39)}\t\n  b  `, "id"), `${"a".repeat(39)} `);
  assert.equal(normalizeDisplayName("a".repeat(41), "id"), "a".repeat(40));
  assert.equal(normalizeDisplayName(`${"a".repeat(39)}😀`, "id"), `${"a".repeat(39)}\ud83d`);
});

test("personal room names remove angle brackets before trimming", () => {
  assert.equal(personalRoomName("  <Alice>  "), "Alice Personal Room");
  assert.equal(personalRoomName("<  >"), "Personal Room");
  assert.equal(personalRoomName(""), "Personal Room");
  assert.equal(personalRoomName("a<>b & \"c\""), "ab & \"c\" Personal Room");
});

test("personal room names preserve inner whitespace and the 48-code-unit limit", () => {
  assert.equal(personalRoomName("a\t  b"), "a\t  b Personal Room");
  assert.equal(personalRoomName(`${"a".repeat(47)} b`), `${"a".repeat(47)}  Personal Room`);
  assert.equal(personalRoomName(`<${"a".repeat(49)}>`), `${"a".repeat(48)} Personal Room`);
  assert.equal(personalRoomName(`${"a".repeat(47)}😀`), `${"a".repeat(47)}\ud83d Personal Room`);
});

test("personal state rejects nonobjects without coercion", () => {
  for (const input of [undefined, null, false, true, 0, 1, "", "{}", () => ({})]) {
    assert.equal(normalizePersonalState(input, null), null);
  }
});

test("missing or nonobject lastPose clears state instead of rejecting it", () => {
  for (const lastPose of [undefined, null, false, 0, 1, "", "pose", () => ({})]) {
    assert.deepEqual(normalizePersonalState({ lastPose, unknown: 1 }, "owner"), {});
  }
  const first = normalizePersonalState({}, null);
  const second = normalizePersonalState({}, null);
  assert.deepEqual(first, {});
  assert.notEqual(first, second);
});

test("object lastPose requires an object position and complete numeric fields", () => {
  for (const position of [undefined, null, false, 0, 1, "", "position", () => ({})]) {
    assert.equal(normalizePersonalState({ lastPose: { ...pose(), position } }, null), null);
  }
  assert.equal(normalizePersonalState({ lastPose: {} }, null), null);
  assert.equal(normalizePersonalState({ lastPose: { position: {} } }, null), null);
});

for (const field of ["x", "y", "z", "yaw", "pitch"] as const) {
  test(`personal state rejects missing or nonfinite ${field} without numeric conversion`, () => {
    for (const value of [undefined, null, false, true, "0", "1.5", NaN, Infinity, -Infinity, {}, [], new Number(1)]) {
      const input = pose();
      Object.assign(field === "yaw" || field === "pitch" ? input : input.position, { [field]: value });
      assert.equal(normalizePersonalState({ lastPose: input }, "owner"), null);
    }
  });
}

test("valid state has the original field order and server-owned audit fields", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  const input = { extra: 1, lastPose: { ...pose(), extra: 2, updatedAt: "untrusted", updatedBy: "untrusted" } };
  const result = normalizePersonalState(input, "owner");
  assert.deepEqual(result, { lastPose: { ...pose(), updatedAt: fixedTime.toISOString(), updatedBy: "owner" } });
  assert.equal(JSON.stringify(result), '{"lastPose":{"position":{"x":1,"y":2,"z":3},"yaw":0.5,"pitch":-0.25,"updatedAt":"2026-01-02T03:04:05.000Z","updatedBy":"owner"}}');
});

for (const [field, limit] of [["x", 1000], ["y", 100], ["z", 1000], ["yaw", Math.PI * 4], ["pitch", Math.PI / 2]] as const) {
  test(`personal state clamps ${field} at both original bounds`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
    for (const value of [-Number.MAX_VALUE, -limit - 1, -limit, -0.25, 0, 0.25, limit, limit + 1, Number.MAX_VALUE]) {
      const input = pose();
      Object.assign(field === "yaw" || field === "pitch" ? input : input.position, { [field]: value });
      const actual = normalizePersonalState({ lastPose: input }, null)?.lastPose;
      assert.ok(actual);
      const actualValue = field === "yaw" || field === "pitch" ? actual[field] : actual.position[field];
      const expected = value < -limit ? -limit : value > limit ? limit : value;
      assert.equal(actualValue, expected);
    }
  });
}

test("zero, signed zero and fractional coordinates are preserved", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  const input = { position: { x: -0, y: 0, z: Number.MIN_VALUE }, yaw: -0, pitch: -Number.MIN_VALUE };
  const result = normalizePersonalState({ lastPose: input }, "");
  assert.deepEqual(result, { lastPose: { ...input, updatedAt: fixedTime.toISOString(), updatedBy: "" } });
});

test("normalization copies state, pose and position without mutating input", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  const position = Object.freeze({ x: 2000, y: -200, z: 3, extra: "discarded" });
  const lastPose = Object.freeze({ position, yaw: 0.5, pitch: -0.25, updatedAt: "original" });
  const input = Object.freeze({ lastPose, extra: 1 });
  const before = JSON.stringify(input);
  const result = normalizePersonalState(input, null);
  assert.ok(result?.lastPose);
  assert.notEqual(result, input);
  assert.notEqual(result.lastPose, lastPose);
  assert.notEqual(result.lastPose.position, position);
  assert.deepEqual(result.lastPose.position, { x: 1000, y: -100, z: 3 });
  assert.equal(JSON.stringify(input), before);
});

test("timestamps are read at each successful call and updatedBy is passed through", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  const input = { lastPose: pose() };
  assert.equal(normalizePersonalState(input, null)?.lastPose?.updatedBy, null);
  assert.equal(normalizePersonalState(input, "owner")?.lastPose?.updatedAt, fixedTime.toISOString());
  t.mock.timers.tick(1500);
  const later = normalizePersonalState(input, " owner ");
  assert.equal(later?.lastPose?.updatedAt, "2026-01-02T03:04:06.500Z");
  assert.equal(later?.lastPose?.updatedBy, " owner ");
});

test("arrays retain the original object semantics at every nesting level", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  assert.deepEqual(normalizePersonalState([], null), {});
  assert.equal(normalizePersonalState({ lastPose: [] }, null), null);
  assert.equal(normalizePersonalState({ lastPose: { ...pose(), position: [1, 2, 3] } }, null), null);
  const position = Object.assign([], { x: 1, y: 2, z: 3 });
  const lastPose = Object.assign([], { position, yaw: 0.5, pitch: -0.25 });
  const input = Object.assign([], { lastPose });
  assert.deepEqual(normalizePersonalState(input, null), { lastPose: { ...pose(), updatedAt: fixedTime.toISOString(), updatedBy: null } });
});

test("inherited state fields retain their original lookup semantics", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  const position = Object.create({ x: 1, y: 2, z: 3 });
  const lastPose = Object.create({ position, yaw: 0.5, pitch: -0.25 });
  const input = Object.create({ lastPose });
  assert.deepEqual(normalizePersonalState(input, null), { lastPose: { ...pose(), updatedAt: fixedTime.toISOString(), updatedBy: null } });
});

test("normalization reads fields in the original order and propagates getter errors", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: fixedTime });
  const reads: string[] = [];
  const observe = (value: object) => new Proxy(value, { get(target, key, receiver) { reads.push(String(key)); return Reflect.get(target, key, receiver); } });
  const position = observe({ x: 1, y: 2, z: 3 });
  normalizePersonalState(observe({ lastPose: observe({ position, yaw: 0.5, pitch: -0.25 }) }), null);
  assert.deepEqual(reads, ["lastPose", "position", "x", "y", "z", "yaw", "pitch"]);
  const error = new Error("getter_failed");
  assert.throws(() => normalizePersonalState({ get lastPose() { throw error; } }, null), (actual) => actual === error);
});
