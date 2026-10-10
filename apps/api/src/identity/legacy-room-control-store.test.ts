import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseError, Pool, type PoolClient } from "pg";
import type { RoomRole } from "@vrata/shared-types";
import { signRoomSessionToken, verifyRoomSessionToken, type RoomSessionRoleSource } from "@vrata/shared-types/session-token";
import { sanitizeSessionControlState } from "../room-session-control.js";
import { MemoryStorage, PostgresStorage } from "../storage.js";
import type { RoomRecord, RoomSessionControlState, Storage } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { identityFenceUnavailable, uncertainRoomCommit } from "./fence-transaction.js";
import { LegacyAdmissionDeadlineExpired } from "./legacy-admission-write.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import {
  captureLegacyRoomControl, LEGACY_CONTROL_ADMIN_ID, LegacyRoomControlInvariant, reduceLegacyRoomControl,
  type LegacyControlActor, type LegacyRoomControlCommand, type LegacyRoomControlInput, type LegacyRoomControlSnapshot, type LegacyRoomPresence
} from "./legacy-room-control.js";

const PG_SKIP = !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI;
const SECRET = "legacy-room-control-store-fixture-key";
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const MAC_EXP = NOW + 600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const FORBIDDEN = "403:forbidden:permission_denied";
const NOT_FOUND = "404:participant_not_found:-";
const UPGRADE = "409:identity_upgrade_required";
const blocked = (reason: string) => `403:room_access_denied:${reason}`;

type Session = Extract<LegacyControlActor, { kind: "session" }>;
type Scope = Pick<RoomRecord, "tenantId" | "roomId">;
const ADMIN: LegacyControlActor = { kind: "admin", actorId: LEGACY_CONTROL_ADMIN_ID };
// Fresh objects per call, so a caller can still mutate them after capture.
const lock = (): LegacyRoomControlCommand => ({ type: "lock" });
const unlock = (): LegacyRoomControlCommand => ({ type: "unlock" });
const end = (): LegacyRoomControlCommand => ({ type: "end" });
const remove = (targetParticipantId: string, reason: string | null = null): LegacyRoomControlCommand => ({ type: "remove", targetParticipantId, reason });
const grant = (targetParticipantId: string): LegacyRoomControlCommand => ({ type: "grant-presenter", targetParticipantId });
const revoke = (targetParticipantId: string): LegacyRoomControlCommand => ({ type: "revoke-presenter", targetParticipantId });
const transfer = (targetParticipantId: string): LegacyRoomControlCommand => ({ type: "transfer-host", targetParticipantId });
const seven = () => [lock(), unlock(), end(), remove("p-2"), grant("p-2"), revoke("p-2"), transfer("p-2")];
const SAMPLED: readonly string[] = ["grant-presenter", "transfer-host"];

/** Live presence as the route wires it: a synchronous read of the current roster. `presence` records each sample; `has` does not. */
function roster() {
  const live = new Set<string>(), calls: string[] = [];
  const has = (roomId: string, participantId: string) => live.has(`${roomId}/${participantId}`);
  const presence: LegacyRoomPresence = (roomId, participantId) => { calls.push(`${roomId}/${participantId}`); return has(roomId, participantId); };
  return { calls, has, presence, join: (roomId: string, participantId: string) => { live.add(`${roomId}/${participantId}`); } };
}

interface Clock { now: number; onRead?: () => void }
interface Fixture { s: Storage; clock: Clock; live: ReturnType<typeof roster>; rooms?: Map<string, RoomRecord>; pool?: Pool; probe?: Pool }

async function fixture(t: TestContext, postgres: boolean): Promise<Fixture> {
  const clock: Clock = { now: NOW }, live = roster();
  // The store's injected instant; a test may hook one read to schedule a later lapse.
  const identityNow = () => { const value = clock.now; clock.onRead?.(); return value; };
  if (!postgres) {
    const s = new MemoryStorage(identityNow);
    // Fixture-only: the raw map stands where the probe's SQL does for Postgres.
    return { s, clock, live, rooms: Reflect.get(s, "rooms") as Map<string, RoomRecord> };
  }
  const connectionString = process.env.VRATA_TEST_POSTGRES_URL;
  assert.ok(connectionString, "CI must supply VRATA_TEST_POSTGRES_URL");
  // Only the owned schema is on the path: init, the fault trigger and the floor never reach public.
  const schema = `legacy_control_${randomUUID().replaceAll("-", "")}`, options = `-c search_path=${schema}`;
  // max 1: a second borrow inside the fence times out rather than silently passing.
  const root = new Pool({ connectionString, max: 1 }), pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, options });
  const probe = new Pool({ connectionString, max: 4, options });
  t.after(async () => {
    await Promise.allSettled([pool.end(), probe.end()]);
    try { await root.query(`drop schema if exists "${schema}" cascade`); } finally { await root.end(); }
  });
  await root.query(`create schema "${schema}"`);
  const s = new PostgresStorage(pool, identityNow);
  await s.init();
  return { s, clock, live, pool, probe };
}

const seed = (f: Fixture, sessionControl: RoomSessionControlState = {}, name = "Control") =>
  f.s.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name, visibility: "private", sessionControl });
/** Fixture-only: a raw column no route writes (an unknown key, a drifted shape), set beneath every API. */
async function seedRaw(f: Fixture, roomId: string, raw: unknown) {
  if (f.probe) await f.probe.query("update rooms set session_control=$2::jsonb where room_id=$1", [roomId, JSON.stringify(raw)]);
  else f.rooms!.set(roomId, { ...f.rooms!.get(roomId)!, sessionControl: structuredClone(raw) as RoomSessionControlState });
}

/** The store actor from verified MAC claims only, as the route builds it: never the DTO, and the lease is the signed exp. */
function macActor(room: Scope, participantId: string, role: RoomRole = "host", roleSource: RoomSessionRoleSource = "trusted"): Session {
  const token = signRoomSessionToken({ tenantId: room.tenantId, roomId: room.roomId, participantId, displayName: participantId, role, roleSource,
    permissions: [], sessionId: `session-${participantId}`, iat: NOW / 1000 - 60, exp: MAC_EXP / 1000, jti: `jti-${participantId}` }, SECRET);
  const verified = verifyRoomSessionToken(token, SECRET, { nowSeconds: NOW / 1000, roomId: room.roomId });
  assert.ok(verified.ok, "the fixture MAC verifies");
  const { tenantId, roomId, participantId: subject, role: signed, roleSource: source = "default", exp } = verified.payload;
  return { kind: "session", tenantId, roomId, participantId: subject, role: signed, roleSource: source, lease: { kind: "bearer", expiresAtMs: exp * 1000 } };
}
function input(f: Fixture, room: Scope, actor: LegacyControlActor, command: LegacyRoomControlCommand): LegacyRoomControlInput {
  return { scope: { tenantId: room.tenantId, roomId: room.roomId }, actor, command, hostControlsEnabled: true,
    ...(SAMPLED.includes(command.type) ? { presence: f.live.presence } : {}) };
}

type Answer = { readonly kind: string; readonly status?: number; readonly error?: string; readonly reason?: string };
const summary = (answer: Answer) => answer.kind === "refused" ? `${answer.status}:${answer.error}:${answer.reason ?? "-"}`
  : answer.kind === "apply" ? "applied" : answer.kind;
// Assertion output carries only fixed codes and SQLSTATEs, never a token, a row or a raw driver error.
function label(error: unknown): string {
  if (error instanceof assert.AssertionError) throw error;
  if (error instanceof LegacyAdmissionDeadlineExpired) return `expired:${error.kind}`;
  if (error instanceof LegacyRoomControlInvariant || error instanceof IdentityStorageError) return error.code;
  if (error instanceof IdentityBoundaryError) return `${error.status}:${error.reason}`;
  if (uncertainRoomCommit(error)) return "uncertain";
  if (error instanceof DatabaseError) return `db:${error.code}`;
  return "unexpected_error";
}
const control = (s: Storage, i: LegacyRoomControlInput) => s.applyLegacyRoomControl(i, {}).then(summary, label);
/** applyLegacyRoomControlReceipt's pass-through classes; the route answers anything else as its one fixed 503. */
const routed = (error: unknown) => error instanceof LegacyAdmissionDeadlineExpired || error instanceof LegacyRoomControlInvariant
  || (error instanceof IdentityStorageError && error.code === "room_not_found") || (error instanceof IdentityBoundaryError && error.status === 409)
  ? label(error) : "503";

interface Stored { columns: string; rest: string; control: unknown; snap: LegacyRoomControlSnapshot }
const isBag = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** The row as stored: every other column, and the control without `keys`, as exact text; the raw control; the reducer's view. */
async function stored(f: Fixture, roomId: string, keys: readonly string[] = []): Promise<Stored> {
  if (f.probe) {
    const row = (await f.probe.query(`select tenant_id, room_id, status, disabled_at, session_control, (to_jsonb(r) - 'session_control')::text as columns,
      (case when jsonb_typeof(session_control)='object' then session_control - $2::text[] else session_control end)::text as rest
      from rooms r where room_id=$1`, [roomId, keys])).rows[0];
    assert.ok(row, "the fixture room exists");
    return { columns: row.columns, rest: row.rest, control: row.session_control, snap: { tenantId: row.tenant_id, roomId: row.room_id,
      status: row.status, disabledAt: row.disabled_at, rawControl: row.session_control } };
  }
  const room = f.rooms!.get(roomId);
  assert.ok(room, "the fixture room exists");
  const { sessionControl: raw, ...columns } = room;
  const rest = isBag(raw) ? Object.fromEntries(Object.entries(raw).filter(([key]) => !keys.includes(key))) : raw;
  return { columns: JSON.stringify(columns), rest: JSON.stringify(rest), control: structuredClone(raw),
    snap: { tenantId: room.tenantId, roomId: room.roomId, status: room.status ?? null, disabledAt: room.disabledAt, rawControl: structuredClone(raw) } };
}

/** One command against the pure reducer on the raw row the store reads at its own instant: an applied patch merges over that column,
 * every other control key and room column stays byte-equal and the receipt is the column as written; any other answer writes nothing. */
async function checked(f: Fixture, i: LegacyRoomControlInput): Promise<string> {
  const { roomId } = i.scope;
  // The same genuine roster for the expectation, read without recording a sample.
  const expected = reduceLegacyRoomControl(captureLegacyRoomControl(i.presence ? { ...i, presence: f.live.has } : i, {}),
    (await stored(f, roomId)).snap, f.clock.now);
  const keys = expected.kind === "apply" ? Object.keys(expected.patch) : [], want = summary(expected), name = `${i.command.type}: ${want}`;
  const before = await stored(f, roomId, keys), outcome = await f.s.applyLegacyRoomControl(i, {}).catch(label);
  const after = await stored(f, roomId, keys);
  assert.equal(typeof outcome === "string" ? outcome : summary(outcome), want, `${i.command.type}: the store answers as the reducer`);
  assert.deepEqual([after.columns === before.columns, after.rest === before.rest], [true, true], `${name}: every other byte survives`);
  assert.deepEqual(after.control, expected.kind === "apply" ? { ...(before.control as object), ...expected.patch } : before.control, name);
  if (typeof outcome !== "string" && outcome.kind === "applied") {
    assert.deepEqual(outcome.state, sanitizeSessionControlState(after.control as RoomSessionControlState), `${name}: the receipt is the written column`);
  }
  return want;
}
/** A refusal outside the reducer (scope, floor, binding, wiring): its label, and not one stored byte changed. */
async function unchanged(f: Fixture, i: LegacyRoomControlInput): Promise<string> {
  const before = await stored(f, i.scope.roomId), outcome = await control(f.s, i);
  assert.deepEqual(await stored(f, i.scope.roomId), before, outcome);
  return outcome;
}

type Around = (sql: string, run: () => Promise<unknown>) => Promise<unknown>;
/** Wraps a max-1 pool's only client, which its next borrower reuses. Callers restore it in finally. */
async function borrowed(t: TestContext, pool: Pool, around: Around) {
  const client = await pool.connect();
  client.release();
  const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
  const hook = t.mock.method(client, "query", ((...args: unknown[]) => around(
    String(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text).trim().toLowerCase(),
    () => query(...args))) as unknown as PoolClient["query"]);
  return { restore: () => hook.mock.restore() };
}

for (const postgres of [false, true]) test(`${postgres ? "Postgres" : "Memory"}: a control merges only its own keys into the raw row it decided on`, {
  skip: postgres && PG_SKIP, timeout: 120_000
}, async t => {
  const f = await fixture(t, postgres);
  const old = { removedAt: iso(NOW - HOUR), removedBy: "host-0", reason: null, fixtureExtra: [1, "x"] };
  const raw = { hostParticipantId: "host-1", presenterParticipantId: "p-2", lockedAt: null, fixtureSpare: { kept: true }, removedParticipants: { "p-9": old } };
  const room = async (value: unknown = raw) => { const r = await seed(f); await seedRaw(f, r.roomId, value); return r; };

  // All seven by the administrator and by the seated host's verified trusted MAC, then the same command a second later:
  // an applied repeat re-stamps; the rest answer as the legacy routes did.
  const again: Record<"admin" | "host", string[]> = { admin: [], host: [] };
  for (const who of ["admin", "host"] as const) for (const command of seven()) {
    const r = await room();
    const actor: LegacyControlActor = who === "admin" ? ADMIN : macActor(r, "host-1");
    f.live.join(r.roomId, "p-2");
    assert.equal(await checked(f, input(f, r, actor, command)), "applied", `${who} ${command.type}`);
    f.clock.now = NOW + 1000;
    try { again[who].push(await checked(f, input(f, r, actor, command))); } finally { f.clock.now = NOW; }
  }
  const none = "404:presenter_not_found:-";
  assert.deepEqual(again, { admin: ["applied", "applied", "applied", "applied", "applied", none, "applied"],
    host: ["applied", "applied", blocked("session_ended"), "applied", "applied", none, FORBIDDEN] });

  // A drifted column is changed and kept exactly as stored, never rebuilt from defaults, and presence is never sampled for it.
  f.live.calls.length = 0;
  for (const drift of [null, [], "x", 7, { removedParticipants: [] }, { removedParticipants: "x" }, { ...raw, removedParticipants: [old] }]) {
    const r = await room(drift);
    f.live.join(r.roomId, "p-2");
    assert.deepEqual([await checked(f, input(f, r, ADMIN, lock())), await checked(f, input(f, r, macActor(r, "host-1"), grant("p-2")))],
      ["changed", "changed"], JSON.stringify(drift));
  }
  assert.deepEqual(f.live.calls, []);

  // Authority is the fresh row's: the MAC's tenant and room, a trusted host role, the current seat, then status. The
  // administrator bypasses seat and lifecycle but never the scope, which the store reads by tenant and room.
  const a = await room(), elsewhere = { ...a, tenantId: "tenant-x" };
  assert.deepEqual([await checked(f, input(f, a, macActor(a, "host-2"), lock())),
    await checked(f, input(f, a, macActor(a, "host-1", "member", "default"), lock())),
    await checked(f, input(f, a, macActor(a, "host-1", "host", "dev-query"), lock())),
    await checked(f, input(f, a, macActor(elsewhere, "host-1"), lock())), await unchanged(f, input(f, elsewhere, ADMIN, lock()))],
  [FORBIDDEN, FORBIDDEN, FORBIDDEN, FORBIDDEN, "room_not_found"]);
  await f.s.updateRoom(a.roomId, { status: "disabled", disabledAt: iso(NOW), disabledBy: "admin" });
  assert.deepEqual([await checked(f, input(f, a, macActor(a, "host-1"), unlock())), await checked(f, input(f, a, ADMIN, unlock()))],
    [blocked("room_disabled"), "applied"]);

  // Presence is the genuine roster, sampled exactly once and only when every stored fact allows it.
  const p = await room({ ...raw, removedParticipants: { "p-4": old } });
  const sampled = async (i: LegacyRoomControlInput) => [await checked(f, i), f.live.calls.splice(0)];
  f.live.calls.length = 0;
  const absent = await sampled(input(f, p, ADMIN, grant("p-3")));
  f.live.join(p.roomId, "p-3");
  assert.deepEqual([absent, await sampled(input(f, p, macActor(p, "host-1"), transfer("p-3"))), await sampled(input(f, p, ADMIN, grant("p-4"))),
    await sampled(input(f, p, macActor(p, "p-5", "member", "default"), grant("p-3")))],
  [[NOT_FOUND, [`${p.roomId}/p-3`]], ["applied", [`${p.roomId}/p-3`]], [NOT_FOUND, []], [FORBIDDEN, []]]);
  // Only an explicit non-boolean answer, a Promise included, is a wiring fault; it writes nothing.
  for (const answer of [Promise.resolve(true), 1, "true"]) {
    assert.equal(await unchanged(f, { ...input(f, p, ADMIN, grant("p-3")), presence: () => answer as unknown as boolean }), "invalid_legacy_room_control");
  }
  if (f.rooms) {
    // Memory: a row renamed or corrupted from inside the sample fails the row identity check; nothing is merged over it.
    const rooms = f.rooms;
    for (const corrupt of [false, true]) {
      const r = await seed(f, { hostParticipantId: "host-1" }), before = await stored(f, r.roomId);
      f.live.join(r.roomId, "p-2");
      const swapping: LegacyRoomPresence = (roomId, participantId) => {
        if (corrupt) rooms.set(roomId, { ...rooms.get(roomId)!, sessionControl: null as unknown as RoomSessionControlState });
        else void f.s.updateRoom(roomId, { name: "Swapped" });
        return f.live.presence(roomId, participantId);
      };
      assert.equal(await control(f.s, { ...input(f, r, ADMIN, grant("p-2")), presence: swapping }), "changed");
      const after = await stored(f, r.roomId);
      assert.deepEqual([after.control, JSON.parse(after.columns).name], [corrupt ? null : before.control, corrupt ? "Control" : "Swapped"]);
    }
  }

  // Floor and binding are rechecked in the store: refused before any decision, sample or byte. The floor is raised last.
  const b = await room(), c = await room();
  f.live.join(b.roomId, "p-2");
  await f.s.roomIdentities.create({ tenantId: b.tenantId, roomId: b.roomId, displayName: "Bound", baseRole: "guest", provenance: { kind: "guest" } });
  f.live.calls.length = 0;
  const bound = [await unchanged(f, input(f, b, ADMIN, lock())), await unchanged(f, input(f, b, macActor(b, "host-1"), grant("p-2")))];
  await f.s.identityProtocol.raise(2);
  assert.deepEqual([...bound, await unchanged(f, input(f, c, ADMIN, end())), f.live.calls.length], [UPGRADE, UPGRADE, UPGRADE, 0]);
});

test("Postgres: the original MAC exp bounds the pool wait, the decision, the actual UPDATE and the gap before COMMIT", {
  skip: PG_SKIP, timeout: 90_000
}, async t => {
  const f = await fixture(t, true), pool = f.pool!;
  const hosted = () => seed(f, { hostParticipantId: "host-1" });
  const controlOf = async (roomId: string) => (await stored(f, roomId)).control as RoomSessionControlState;
  // Queued for the pool's only client: everything was captured first, caller mutation widens nothing, and the signed exp still lapses there.
  for (const lapse of [true, false]) {
    const r = await hosted(), decoy = await hosted(), i = input(f, r, macActor(r, "host-1"), lock()), busy = await pool.connect();
    let done: Promise<string> | undefined;
    try {
      done = control(f.s, i);
      for (const stop = Date.now() + 5000; pool.waitingCount !== 1;) { if (Date.now() > stop) assert.fail("the control queues for the pool"); await delay(10); }
      Object.assign(i.scope, { roomId: decoy.roomId }); Object.assign(i.command, { type: "end" }); Object.assign(i, { hostControlsEnabled: false });
      Object.assign(i.actor, { participantId: "intruder", role: "admin" }); Object.assign((i.actor as Session).lease, { expiresAtMs: NOW + 9 * HOUR });
      if (lapse) f.clock.now = MAC_EXP;
    } finally { busy.release(); await done; f.clock.now = NOW; }
    const [mine, theirs] = [await controlOf(r.roomId), await controlOf(decoy.roomId)];
    assert.deepEqual([await done, mine.lockedBy, mine.endedAt, theirs.lockedAt], [lapse ? "expired:bearer" : "applied", lapse ? null : "host-1", null, null]);
  }
  // The decision instant is exact: one millisecond before the signed exp writes; the exp itself is a fixed lapse with no cause.
  const edge = await hosted(), at = input(f, edge, macActor(edge, "host-1"), lock());
  let lapsed: unknown, applied: string;
  try {
    f.clock.now = MAC_EXP; lapsed = await f.s.applyLegacyRoomControl(at, {}).then(() => "receipt", (error: unknown) => error);
    f.clock.now = MAC_EXP - 1; applied = await control(f.s, at);
  } finally { f.clock.now = NOW; }
  assert.ok(lapsed instanceof LegacyAdmissionDeadlineExpired, "the exp lapses at its exact instant");
  assert.deepEqual([lapsed.kind, lapsed.message, lapsed.cause, applied, (await controlOf(edge.roomId)).lockedAt],
    ["bearer", "legacy_admission_deadline_expired", undefined, "applied", iso(MAC_EXP - 1)]);
  // The actual UPDATE runs, then the exp passes before the post-SQL check: rolled back, no receipt.
  const written = await hosted(), sql: string[] = [];
  let result: string;
  let hook = await borrowed(t, pool, async (text, run) => {
    sql.push(text);
    const value = await run();
    if (text.startsWith("update rooms")) f.clock.now = MAC_EXP;
    return value;
  });
  try { result = await control(f.s, input(f, written, macActor(written, "host-1"), lock())); } finally { hook.restore(); f.clock.now = NOW; }
  assert.deepEqual([result, sql.some(text => text.startsWith("update rooms")), sql.at(-1), (await controlOf(written.roomId)).lockedAt],
    ["expired:bearer", true, "rollback", null]);
  // The gap after the effect resolves: a lapse queued behind its own post-SQL read is caught before COMMIT is ever sent.
  const gap = await hosted(), reads: number[] = [];
  sql.length = 0;
  hook = await borrowed(t, pool, async (text, run) => {
    sql.push(text);
    const value = await run();
    if (text.startsWith("update rooms")) f.clock.onRead = () => {
      reads.push(f.clock.now); f.clock.onRead = undefined;
      queueMicrotask(() => { f.clock.now = MAC_EXP; });
    };
    return value;
  });
  try { result = await control(f.s, input(f, gap, macActor(gap, "host-1"), lock())); } finally { hook.restore(); f.clock.onRead = undefined; f.clock.now = NOW; }
  assert.deepEqual([result, reads, sql.includes("commit"), sql.at(-1), (await controlOf(gap.roomId)).lockedAt], ["expired:bearer", [NOW], false, "rollback", null]);
  // A lapse after the known COMMIT acknowledgement cannot retract its receipt; only the next call sees it.
  const acked = await hosted(), late = input(f, acked, macActor(acked, "host-1"), lock());
  hook = await borrowed(t, pool, async (text, run) => { const value = await run(); if (text === "commit") f.clock.now = MAC_EXP + HOUR; return value; });
  let next: string;
  try { result = await control(f.s, late); } finally { hook.restore(); }
  try { next = await control(f.s, late); } finally { f.clock.now = NOW; }
  assert.deepEqual([result, next, (await controlOf(acked.roomId)).lockedAt], ["applied", "expired:bearer", iso(NOW)]);
});

test("Postgres: a COMMIT the server rejects keeps nothing; a lost acknowledgement may have committed and yields no receipt", {
  skip: PG_SKIP, timeout: 90_000
}, async t => {
  const f = await fixture(t, true), probe = f.probe!, caught = (pending: Promise<unknown>) => pending.then(() => "receipt", (error: unknown) => error);
  const rejected = await seed(f, { hostParticipantId: "host-1" }, "reject-commit"), before = await stored(f, rejected.roomId);
  // An owned deferred constraint makes the real COMMIT answer P0001 for that room alone.
  await probe.query(`create function control_commit_fault() returns trigger language plpgsql as $$ begin
    if new.name = 'reject-commit' then raise exception 'control_commit_rejected'; end if; return null; end $$`);
  let refused: unknown;
  try {
    await probe.query(`create constraint trigger control_commit_fault after update on rooms deferrable initially deferred
      for each row execute function control_commit_fault()`);
    refused = await caught(f.s.applyLegacyRoomControl(input(f, rejected, ADMIN, lock()), {}));
  } finally {
    await probe.query("drop trigger if exists control_commit_fault on rooms");
    await probe.query("drop function if exists control_commit_fault()");
  }
  assert.deepEqual([label(refused), uncertainRoomCommit(refused), routed(refused)], ["db:P0001", false, "503"]);
  assert.deepEqual(await stored(f, rejected.roomId), before, "the rejected COMMIT changed no byte");
  // The server commits; only the acknowledgement is lost: maybe committed, never a receipt, and the route's one 503.
  const r = await seed(f, { hostParticipantId: "host-1" }), i = input(f, r, macActor(r, "host-1"), lock());
  const hook = await borrowed(t, f.pool!, async (sql, run) => {
    const value = await run();
    if (sql === "commit") throw Object.assign(new Error("commit acknowledgement lost"), { code: "ECONNRESET" });
    return value;
  });
  let lost: unknown;
  try { lost = await caught(f.s.applyLegacyRoomControl(i, {})); } finally { hook.restore(); }
  const committed = (await stored(f, r.roomId)).control as RoomSessionControlState;
  assert.deepEqual([label(lost), identityFenceUnavailable(lost), routed(lost), committed.lockedAt, f.pool!.totalCount],
    ["uncertain", true, "503", iso(NOW), 0], "the actual COMMIT wrote; the suspect client was destroyed");
  // The same command again is a fresh decision on the committed row: it re-stamps and is acknowledged.
  f.clock.now = NOW + 1000;
  try { assert.equal(await checked(f, i), "applied"); } finally { f.clock.now = NOW; }
  assert.equal(((await stored(f, r.roomId)).control as RoomSessionControlState).lockedAt, iso(NOW + 1000));
});
