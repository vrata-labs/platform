import assert from "node:assert/strict";
import test from "node:test";
import type { RoomSessionControlState } from "../storage-contracts.js";
import { LegacyAdmissionDeadlineExpired } from "./legacy-admission-write.js";
import {
  assertLegacyControlLease, captureLegacyRoomControl, LegacyRoomControlInvariant, reduceLegacyRoomControl,
  type LegacyControlActor, type LegacyRoomControlCommand, type LegacyRoomControlDecision, type LegacyRoomControlSnapshot, type LegacyRoomPresence
} from "./legacy-room-control.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const EXP = NOW + 600_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const AT = iso(NOW);
const SCOPE = Object.freeze({ tenantId: "tenant-1", roomId: "room-1" });
const FORBIDDEN = "403:forbidden:permission_denied";
const NOT_FOUND = "404:participant_not_found:-";
const INVALID = "invalid_legacy_room_control";
const blocked = (reason: string) => `403:room_access_denied:${reason}`;

type Session = Extract<LegacyControlActor, { kind: "session" }>;
const ADMIN: LegacyControlActor = { kind: "admin", actorId: "control-plane-admin" };
const host = (over: Partial<Session> = {}): Session => ({ kind: "session", tenantId: "tenant-1", roomId: "room-1", participantId: "host-1",
  role: "host", roleSource: "trusted", lease: { kind: "bearer", expiresAtMs: EXP }, ...over });
const LOCK = { type: "lock" } as const, UNLOCK = { type: "unlock" } as const, END = { type: "end" } as const;
const remove = (targetParticipantId: string, reason: string | null = null) => ({ type: "remove", targetParticipantId, reason }) as const;
const grant = (targetParticipantId: string) => ({ type: "grant-presenter", targetParticipantId }) as const;
const revoke = (targetParticipantId: string) => ({ type: "revoke-presenter", targetParticipantId }) as const;
const transfer = (targetParticipantId: string) => ({ type: "transfer-host", targetParticipantId }) as const;
const SEVEN: LegacyRoomControlCommand[] = [LOCK, UNLOCK, END, remove("p-2"), grant("p-2"), revoke("p-2"), transfer("p-2")];

interface Extra { presence?: LegacyRoomPresence; scope?: { tenantId: string; roomId: string }; snapshot?: Partial<LegacyRoomControlSnapshot>;
  hostControlsEnabled?: boolean; atMs?: number }
const fresh = (rawControl: unknown, over: Partial<LegacyRoomControlSnapshot> = {}): LegacyRoomControlSnapshot =>
  ({ ...SCOPE, status: "active", disabledAt: null, rawControl, ...over });
function guard(actor: LegacyControlActor, command: LegacyRoomControlCommand, extra: Extra = {}) {
  const sampled = command.type === "grant-presenter" || command.type === "transfer-host";
  return captureLegacyRoomControl({ scope: extra.scope ?? SCOPE, actor, command, hostControlsEnabled: extra.hostControlsEnabled ?? true,
    ...(sampled ? { presence: extra.presence ?? (() => true) } : {}) }, {});
}
function reduce(actor: LegacyControlActor, command: LegacyRoomControlCommand, rawControl: unknown, extra: Extra = {}): LegacyRoomControlDecision {
  return reduceLegacyRoomControl(guard(actor, command, extra), fresh(rawControl, { ...extra.scope, ...extra.snapshot }), extra.atMs ?? NOW);
}
// Scalar summaries keep whole records out of assertion diffs.
function label(error: unknown): string {
  if (error instanceof LegacyAdmissionDeadlineExpired) return `expired:${error.kind}`;
  if (error instanceof LegacyRoomControlInvariant) return error.code;
  throw error;
}
function thrown(run: () => unknown): string {
  try { run(); return "ok"; } catch (error) { return label(error); }
}
function outcome(...args: Parameters<typeof reduce>): string {
  try {
    const d = reduce(...args);
    return d.kind === "refused" ? `${d.status}:${d.error}:${d.reason ?? "-"}` : d.kind;
  } catch (error) { return label(error); }
}
function patch(...args: Parameters<typeof reduce>): Readonly<RoomSessionControlState> {
  const d = reduce(...args);
  if (d.kind !== "apply") return assert.fail(`expected a patch, got ${d.kind}`);
  return d.patch;
}

test("each command patches exactly its legacy keys, stamped at the store instant by the fixed actor id", () => {
  const trio = (by: string) => ({ presenterParticipantId: null, presenterRevokedAt: AT, presenterRevokedBy: by });
  const entry = (by: string, reason: string | null) => ({ removedAt: AT, removedBy: by, reason });
  for (const [actor, by] of [[host(), "host-1"], [ADMIN, "control-plane-admin"]] as const) {
    const rows: Array<[LegacyRoomControlCommand, RoomSessionControlState]> = [
      [LOCK, { lockedAt: AT, lockedBy: by }],
      [UNLOCK, { lockedAt: null, lockedBy: null }],
      [END, { endedAt: AT, endedBy: by, ...trio(by) }],
      [remove("p-2", "noisy"), { removedParticipants: { "p-2": entry(by, "noisy") } }],
      [remove("p-3"), { ...trio(by), removedParticipants: { "p-3": entry(by, null) } }],
      [grant("p-2"), { presenterParticipantId: "p-2", presenterGrantedAt: AT, presenterGrantedBy: by, presenterRevokedAt: null, presenterRevokedBy: null }],
      [revoke("p-3"), trio(by)],
      [transfer("p-2"), { hostParticipantId: "p-2" }],
      [transfer("p-3"), { ...trio(by), hostParticipantId: "p-3" }]
    ];
    for (const [command, expected] of rows) {
      const result = patch(actor, command, { presenterParticipantId: "p-3" });
      assert.deepEqual([result, Object.isFrozen(result)], [expected, true], `${by} ${command.type}`);
    }
  }
});

test("removal merges the current map verbatim and leaves every other raw key to the store's merge", () => {
  const old = { removedAt: "2026-09-01T00:00:00.000Z", removedBy: "host-0", reason: null, spare: { kept: true } };
  const raw = { spare: { kept: true }, lockedAt: "2026-09-30T00:00:00.000Z", removedParticipants: { "p-9": old } };
  const before = structuredClone(raw);
  const result = patch(host(), remove("p-2"), raw);
  assert.deepEqual(Object.keys(result), ["removedParticipants"]);
  assert.deepEqual(result.removedParticipants, { "p-9": old, "p-2": { removedAt: AT, removedBy: "host-1", reason: null } });
  assert.deepEqual([result.removedParticipants?.["p-9"] === old, Object.isFrozen(result.removedParticipants), raw], [true, true, before]);
  // A repeated removal re-stamps its own entry in place.
  assert.deepEqual(patch(ADMIN, remove("p-9", "again"), raw, { atMs: NOW + 1000 }).removedParticipants,
    { "p-9": { removedAt: iso(NOW + 1000), removedBy: "control-plane-admin", reason: "again" } });
});

test("stored maps are read through own keys only", () => {
  assert.deepEqual([outcome(host(), grant("constructor"), {}), outcome(host({ participantId: "toString" }), LOCK, { hostParticipantId: "toString" }),
    outcome(host(), revoke("hasOwnProperty"), { presenterParticipantId: "hasOwnProperty" }),
    outcome(host(), LOCK, Object.create({ hostParticipantId: "host-2", endedAt: AT })),
    outcome(host(), LOCK, { removedParticipants: { "host-1": null } })], ["apply", "apply", "apply", "apply", "apply"]);
  const parsed: unknown = JSON.parse('{"removedParticipants":{"__proto__":{"removedAt":"2026-09-01T00:00:00.000Z"}}}');
  assert.deepEqual([outcome(host(), grant("__proto__"), parsed), outcome(host(), transfer("__proto__"), parsed)], [NOT_FOUND, NOT_FOUND]);
  const merged = patch(host(), remove("p-2"), parsed).removedParticipants!;
  assert.deepEqual([Object.keys(merged), Object.getPrototypeOf(merged) === Object.prototype], [["__proto__", "p-2"], true]);
  const single = patch(host(), remove("__proto__"), {}).removedParticipants!;
  assert.deepEqual([Object.hasOwn(single, "__proto__"), Object.getPrototypeOf(single) === Object.prototype], [true, true]);
});

test("a malformed raw control is drift and is never overwritten with defaults", () => {
  for (const actor of [host(), ADMIN]) {
    for (const raw of [undefined, {}, { removedParticipants: null }, { removedParticipants: {} }]) assert.equal(outcome(actor, LOCK, raw), "apply");
    for (const raw of [null, [], "x", 1, true, { removedParticipants: [] }, { removedParticipants: "x" }, { removedParticipants: 1 }]) {
      assert.deepEqual(SEVEN.map(command => outcome(actor, command, raw)), SEVEN.map(() => "changed"));
    }
  }
  // A statically unauthorized actor learns nothing about the stored shape.
  assert.equal(outcome(host({ role: "member" }), LOCK, null), FORBIDDEN);
});

test("authority is decided on the fresh locked row: exact scope, a trusted host MAC, and the current seat", () => {
  const long = "t".repeat(201), wide = { scope: { tenantId: long, roomId: "room-1" } };
  const rows: Array<[string, Session, unknown, Extra, string]> = [
    ["vacant seat", host(), {}, {}, "apply"],
    ["empty seat", host(), { hostParticipantId: "" }, {}, "apply"],
    ["null seat", host(), { hostParticipantId: null }, {}, "apply"],
    ["own seat", host(), { hostParticipantId: "host-1" }, {}, "apply"],
    ["another seat", host(), { hostParticipantId: "host-2" }, {}, FORBIDDEN],
    ["member MAC", host({ role: "member" }), {}, {}, FORBIDDEN],
    ["presenter MAC", host({ role: "presenter" }), {}, {}, FORBIDDEN],
    ["admin-role MAC is not the admin token", host({ role: "admin" }), {}, {}, FORBIDDEN],
    ["default source", host({ roleSource: "default" }), {}, {}, FORBIDDEN],
    ["dev-query source", host({ roleSource: "dev-query" }), {}, {}, FORBIDDEN],
    ["another tenant", host({ tenantId: "tenant-2" }), {}, {}, FORBIDDEN],
    ["tenant differs by case", host({ tenantId: "Tenant-1" }), {}, {}, FORBIDDEN],
    ["another room", host({ roomId: "room-2" }), {}, {}, FORBIDDEN],
    ["saved 201-char tenant, exact", host({ tenantId: long }), {}, wide, "apply"],
    ["saved 201-char tenant, other MAC tenant", host(), {}, wide, FORBIDDEN]
  ];
  for (const [name, actor, raw, extra, expected] of rows) {
    assert.equal(outcome(actor, LOCK, raw, extra), expected, name);
    if (expected === FORBIDDEN) assert.deepEqual(SEVEN.map(command => outcome(actor, command, raw, extra)), SEVEN.map(() => FORBIDDEN), name);
  }
});

test("the actor's own lifecycle is checked as an existing session; a lock never blocks the host; the admin bypasses", () => {
  const ended = { endedAt: AT }, removedHost = { hostParticipantId: "host-1", removedParticipants: { "host-1": { removedAt: AT } } };
  const disabled = { snapshot: { status: "disabled" } }, stamped = { snapshot: { disabledAt: AT } };
  const rows: Array<[string, unknown, Extra, string]> = [
    ["ended", ended, {}, blocked("session_ended")],
    ["a removed host keeps no control", removedHost, {}, blocked("participant_removed")],
    ["disabled status", {}, disabled, blocked("room_disabled")],
    ["disabled stamp", {}, stamped, blocked("room_disabled")],
    ["disabled before ended", ended, disabled, blocked("room_disabled")],
    ["locked", { lockedAt: AT, lockedBy: "host-1" }, {}, "apply"],
    ["captured flag off ignores ended", ended, { hostControlsEnabled: false }, "apply"],
    ["captured flag off ignores removal", removedHost, { hostControlsEnabled: false }, "apply"],
    ["captured flag off still honours disable", {}, { ...disabled, hostControlsEnabled: false }, blocked("room_disabled")]
  ];
  for (const [name, raw, extra, expected] of rows) assert.equal(outcome(host(), LOCK, raw, extra), expected, name);
  assert.deepEqual(SEVEN.map(command => outcome(host(), command, ended)), SEVEN.map(() => blocked("session_ended")));
  const closed = { endedAt: "2026-09-30T00:00:00.000Z", endedBy: "host-1", presenterParticipantId: "p-2" };
  const off = { snapshot: { status: "disabled", disabledAt: AT } };
  assert.deepEqual(SEVEN.map(command => outcome(ADMIN, command, closed, off)), SEVEN.map(() => "apply"));
  const later = iso(NOW + 1000);
  assert.deepEqual(patch(ADMIN, END, closed, { ...off, atMs: NOW + 1000 }), { endedAt: later, endedBy: "control-plane-admin",
    presenterParticipantId: null, presenterRevokedAt: later, presenterRevokedBy: "control-plane-admin" });
});

test("target checks keep the legacy order and answers, repeats re-stamp, and a transfer moves authority", () => {
  const gone = { removedParticipants: { "p-2": { removedAt: AT } } }, absent = { presence: () => false };
  const rows: Array<[string, LegacyControlActor, LegacyRoomControlCommand, unknown, Extra, string]> = [
    ["self removal", host(), remove("host-1"), { hostParticipantId: "host-1" }, {}, "400:cannot_remove_self:-"],
    ["self removal from a vacant seat", host(), remove("host-1"), {}, {}, "400:cannot_remove_self:-"],
    ["admin removes the current host", ADMIN, remove("host-1"), { hostParticipantId: "host-1" }, {}, "apply"],
    ["grant to a removed target", host(), grant("p-2"), gone, {}, NOT_FOUND],
    ["grant to an absent target", host(), grant("p-2"), {}, absent, NOT_FOUND],
    ["revoke of a removed presenter", host(), revoke("p-2"), { ...gone, presenterParticipantId: "p-2" }, {}, NOT_FOUND],
    ["revoke of another presenter", host(), revoke("p-2"), { presenterParticipantId: "p-3" }, {}, "404:presenter_not_found:-"],
    ["revoke after a revoke", host(), revoke("p-2"), { presenterParticipantId: null, presenterRevokedAt: AT }, {}, "404:presenter_not_found:-"],
    ["transfer to a removed target", host(), transfer("p-2"), gone, {}, NOT_FOUND],
    ["transfer to an absent target", host(), transfer("p-2"), {}, absent, NOT_FOUND],
    ["removal of a removed target", host(), remove("p-2"), gone, {}, "apply"]
  ];
  for (const [name, actor, command, raw, extra, expected] of rows) assert.equal(outcome(actor, command, raw, extra), expected, name);
  const later = { atMs: NOW + 1000 }, stamp = iso(NOW + 1000);
  assert.deepEqual(patch(host(), LOCK, { lockedAt: AT, lockedBy: "host-0" }, later), { lockedAt: stamp, lockedBy: "host-1" });
  assert.deepEqual(patch(host(), grant("p-2"), { presenterParticipantId: "p-2", presenterGrantedAt: AT }, later), { presenterParticipantId: "p-2",
    presenterGrantedAt: stamp, presenterGrantedBy: "host-1", presenterRevokedAt: null, presenterRevokedBy: null });
  const raw = { hostParticipantId: "host-1", spare: true }, moved = { ...raw, ...patch(host(), transfer("p-2"), raw) };
  assert.deepEqual([outcome(host(), LOCK, moved), outcome(host(), transfer("host-1"), moved), outcome(host({ participantId: "p-2" }), LOCK, moved)],
    [FORBIDDEN, FORBIDDEN, "apply"]);
});

test("presence is sampled once, synchronously, only for grant and transfer, after every stored fact", () => {
  const calls: string[][] = [];
  const presence: LegacyRoomPresence = (roomId, participantId) => { calls.push([roomId, participantId]); return true; };
  const quiet: Array<[Session, unknown, Extra]> = [[host({ role: "member" }), {}, {}], [host({ tenantId: "tenant-2" }), {}, {}],
    [host(), { hostParticipantId: "host-2" }, {}], [host(), null, {}], [host(), { endedAt: AT }, {}],
    [host(), { removedParticipants: { "p-2": { removedAt: AT } } }, {}], [host(), {}, { atMs: EXP }]];
  for (const command of [grant("p-2"), transfer("p-2")]) {
    for (const [actor, raw, extra] of quiet) outcome(actor, command, raw, { ...extra, presence });
    assert.deepEqual(calls, [], command.type);
    assert.equal(outcome(host(), command, {}, { presence }), "apply");
    assert.deepEqual(calls.splice(0), [["room-1", "p-2"]], command.type);
  }
  const input = { scope: { ...SCOPE }, actor: host(), command: { ...grant("p-2") }, presence, hostControlsEnabled: true };
  const captured = captureLegacyRoomControl(input, {});
  Object.assign(input, { presence: () => false });
  Object.assign(input.command, { targetParticipantId: "p-9" });
  Object.assign(input.scope, { roomId: "room-9" });
  assert.equal(reduceLegacyRoomControl(captured, fresh({}), NOW).kind, "apply");
  assert.deepEqual(calls.splice(0), [["room-1", "p-2"]]);
  const answers: unknown[] = [Promise.resolve(true), { then() {} }, 1, "true", null, undefined];
  for (const answer of answers) assert.equal(outcome(host(), grant("p-2"), {}, { presence: () => answer as boolean }), INVALID);
  const base = { scope: SCOPE, actor: host(), hostControlsEnabled: true };
  for (const command of [grant("p-2"), transfer("p-2")]) {
    for (const extra of [{}, { presence: undefined }, { presence: "fn" }, { presence: {} }]) {
      assert.equal(thrown(() => captureLegacyRoomControl({ ...base, command, ...extra }, {})), INVALID);
    }
  }
  for (const command of [LOCK, UNLOCK, END, remove("p-2"), revoke("p-2")]) {
    assert.equal(thrown(() => captureLegacyRoomControl({ ...base, command, presence }, {})), INVALID, command.type);
  }
});

test("capture copies and freezes every field before any wait; later caller mutation widens nothing", () => {
  const lease = { kind: "bearer" as const, expiresAtMs: EXP }, actor = { ...host(), lease }, scope = { ...SCOPE };
  const command = { type: "remove" as const, targetParticipantId: "p-2", reason: "noisy" as string | null };
  const options = { lockTimeoutMs: 50, idleTimeoutMs: 75 }, input = { scope, actor, command, hostControlsEnabled: true };
  const g = captureLegacyRoomControl(input, options);
  Object.assign(scope, { tenantId: "tenant-9", roomId: "room-9" });
  Object.assign(actor, { participantId: "intruder", role: "admin", tenantId: "tenant-9" });
  Object.assign(lease, { expiresAtMs: EXP + HOUR });
  Object.assign(command, { type: "lock", targetParticipantId: "host-1", reason: null });
  Object.assign(input, { hostControlsEnabled: false });
  Object.assign(options, { lockTimeoutMs: 1, idleTimeoutMs: 1 });
  assert.deepEqual(g, { tenantId: "tenant-1", roomId: "room-1", actor: host(), command: remove("p-2", "noisy"), presence: null,
    hostControlsEnabled: true, lockTimeoutMs: 50, idleTimeoutMs: 75 });
  for (const part of [g, g.actor, g.command, g.actor.kind === "session" ? g.actor.lease : null]) assert.equal(Object.isFrozen(part), true);
  assert.deepEqual([thrown(() => reduceLegacyRoomControl(g, fresh({}), EXP - 1)), thrown(() => reduceLegacyRoomControl(g, fresh({}), EXP))],
    ["ok", "expired:bearer"]);
  let reads = 0;
  const counted = Object.defineProperty({ ...host() }, "role", { enumerable: true, get: () => (reads++ === 0 ? "host" : "admin") });
  assert.equal(captureLegacyRoomControl({ scope: SCOPE, actor: counted, command: LOCK, hostControlsEnabled: true }, {}).actor.kind, "session");
  assert.equal(reads, 1);
  for (const bad of [null, { lockTimeoutMs: 1.5 }, { idleTimeoutMs: "5" }, { lockTimeoutMs: 10n }]) {
    assert.equal(thrown(() => captureLegacyRoomControl({ scope: SCOPE, actor: ADMIN, command: LOCK, hostControlsEnabled: true }, bad)), INVALID);
  }
});

test("the original bearer expiry is checked first, at its exact instant, and every write moment can recheck it", () => {
  assert.deepEqual([outcome(host(), LOCK, {}, { atMs: EXP - 1 }), outcome(host(), LOCK, {}, { atMs: EXP }),
    outcome(host({ role: "member" }), LOCK, {}, { atMs: EXP }), outcome(host(), LOCK, null, { atMs: EXP }),
    outcome(ADMIN, LOCK, {}, { atMs: EXP + HOUR })], ["apply", "expired:bearer", "expired:bearer", "expired:bearer", "apply"]);
  const session = guard(host(), LOCK), admin = guard(ADMIN, LOCK);
  assert.deepEqual([thrown(() => assertLegacyControlLease(session, EXP - 1)), thrown(() => assertLegacyControlLease(session, EXP)),
    thrown(() => assertLegacyControlLease(admin, 8_640_000_000_000_000))], ["ok", "expired:bearer", "ok"]);
  assert.throws(() => assertLegacyControlLease(session, EXP), (error: unknown) => error instanceof LegacyAdmissionDeadlineExpired
    && error.message === "legacy_admission_deadline_expired");
  for (const nowMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001, 10n as unknown as number]) {
    for (const g of [session, admin]) {
      assert.deepEqual([thrown(() => assertLegacyControlLease(g, nowMs)), thrown(() => reduceLegacyRoomControl(g, fresh({}), nowMs))], [INVALID, INVALID]);
    }
  }
});

test("anything outside the closed actor, command and scope shapes is a parameterless wiring fault", () => {
  const marker = "leak-marker", bigId = `${marker}${"x".repeat(200)}`;
  const leases: unknown[] = [undefined, null, { kind: "invite", expiresAtMs: EXP }, { kind: "bearer", expiresAtMs: BigInt(EXP) },
    { kind: "bearer", expiresAtMs: 1.5 }, { kind: "bearer", expiresAtMs: 0 }, { kind: "bearer", expiresAtMs: -1 },
    { kind: "bearer", expiresAtMs: Number.MAX_SAFE_INTEGER + 2 }, { kind: "bearer", expiresAtMs: String(EXP) }, { kind: "bearer", expiresAtMs: EXP, extra: 1 }];
  const actors: unknown[] = [{ ...host(), identityProtocolVersion: 2 }, { ...host(), identityId: "id-1" }, { kind: "admin", actorId: marker },
    { ...ADMIN, participantId: "p-1" }, { kind: "v2" }, host({ role: marker as never }), host({ roleSource: marker as never }), host({ participantId: "" }),
    host({ participantId: bigId }), host({ roomId: bigId }), { ...host(), tenantId: 5 }, ...leases.map(lease => ({ ...host(), lease }))];
  const commands: unknown[] = [{ type: "lock", targetParticipantId: "p-2" }, { type: "remove", targetParticipantId: "p-2" }, remove("p-2", ""),
    remove("p-2", "r".repeat(121)), { ...remove("p-2"), reason: 5 }, { type: "grant-presenter" }, { type: "transfer-owner", targetParticipantId: "p-2" },
    { type: marker }, grant("p\u0000"), revoke(bigId), null, "lock"];
  const base = { scope: SCOPE, actor: host(), command: LOCK, hostControlsEnabled: true };
  const inputs: unknown[] = [null, "x", { scope: SCOPE, actor: host(), command: LOCK }, { ...base, hostControlsEnabled: "true" }, { ...base, extra: 1 },
    { ...base, scope: { tenantId: null, roomId: "room-1" } }, { ...base, scope: { ...SCOPE, roomId: bigId } }, { ...base, scope: { ...SCOPE, roomId: "" } },
    { ...base, scope: { ...SCOPE, region: "eu" } }, { ...base, scope: { tenantId: "tenant-1" } },
    ...actors.map(actor => ({ ...base, actor })), ...commands.map(command => ({ ...base, command }))];
  for (const input of inputs) {
    assert.throws(() => captureLegacyRoomControl(input, {}), (error: unknown) => error instanceof LegacyRoomControlInvariant
      && error.message === INVALID && !`${String(error)}${error.stack ?? ""}`.includes(marker));
  }
  assert.deepEqual([outcome(host(), remove("p-2", "r".repeat(120)), {}), outcome(host({ participantId: "h".repeat(200) }), LOCK, {}),
    outcome(host({ lease: { kind: "bearer", expiresAtMs: EXP + HOUR } }), LOCK, {})], ["apply", "apply", "apply"]);
  // A row from another scope is a store fault, never an answer.
  for (const over of [{ tenantId: "tenant-2" }, { roomId: "room-2" }, { status: 5 as unknown as string }]) {
    assert.equal(thrown(() => reduceLegacyRoomControl(guard(ADMIN, LOCK), fresh({}, over), NOW)), INVALID);
  }
});
