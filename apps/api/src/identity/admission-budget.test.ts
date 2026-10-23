import assert from "node:assert/strict";
import test from "node:test";
import { admissionWindows, MAX_ROOM_IDENTITIES, MAX_ROOM_WAITING_REQUESTS,
  roomIdentityCapacityAvailable, waitingRequestCapacityAvailable } from "./admission-limits.js";
import { createMemoryAdmissionBudget } from "./admission-budget.js";

test("immutable room identities and waiting requests have a finite lifetime capacity", () => {
  for (const count of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(roomIdentityCapacityAvailable(count), false);
  assert.equal(roomIdentityCapacityAvailable(MAX_ROOM_IDENTITIES - 1), true);
  assert.equal(roomIdentityCapacityAvailable(MAX_ROOM_IDENTITIES), false);
  assert.equal(waitingRequestCapacityAvailable(MAX_ROOM_WAITING_REQUESTS - 1), true);
  assert.equal(waitingRequestCapacityAvailable(MAX_ROOM_WAITING_REQUESTS), false);
});

test("budget is atomic across its windows, keeps scopes separate, and expires by clock", async () => {
  let at = 86_400_000;
  const budget = createMemoryAdmissionBudget(() => at);
  const a = "a".repeat(64), b = "b".repeat(64);
  assert.deepEqual(admissionWindows("room").map(value => value.limit), [180, 3000]);
  for (let i = 0; i < 180; i++) assert.equal(await budget({ originHash: a, kind: "room" }), true);
  assert.equal(await budget({ originHash: a, kind: "room" }), false);
  assert.equal(await budget({ originHash: b, kind: "room" }), true);
  for (let i = 0; i < 20; i++) assert.equal(await budget({ originHash: a, kind: "personal" }), true);
  assert.equal(await budget({ originHash: a, kind: "personal" }), false);
  at += 60_000;
  assert.equal(await budget({ originHash: a, kind: "room" }), true, "denial must not consume the daily window");
  assert.equal(await budget({ originHash: a, kind: "personal" }), false);
  at += 3_600_000;
  assert.equal(await budget({ originHash: a, kind: "personal" }), true);
  await assert.rejects(budget({ originHash: "not-a-hash", kind: "room" }), /invalid_identity_admission_budget/);
  at = Number.NaN;
  await assert.rejects(budget({ originHash: a, kind: "room" }), /invalid_identity_admission_clock/);
});
