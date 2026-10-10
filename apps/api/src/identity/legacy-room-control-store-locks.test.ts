import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseError, Pool, type PoolClient } from "pg";
import type { RoomRole } from "@vrata/shared-types";
import { signRoomSessionToken, verifyRoomSessionToken, type RoomSessionRoleSource } from "@vrata/shared-types/session-token";
import { PostgresStorage } from "../storage.js";
import type { LegacyAdmissionWriteInput, LegacyRoomCredentialSnapshot, RoomRecord, RoomSessionControlState } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { uncertainRoomCommit } from "./fence-transaction.js";
import { decideLegacyAdmissionWrite, LegacyAdmissionDeadlineExpired, planLegacyAdmissionWrite } from "./legacy-admission-write.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import {
  LEGACY_CONTROL_ADMIN_ID, LegacyRoomControlInvariant, type LegacyControlActor, type LegacyRoomControlCommand, type LegacyRoomControlInput, type LegacyRoomPresence
} from "./legacy-room-control.js";
import { evaluateLegacyAdmission, type LegacyAdmissionRequest } from "./legacy-state-admission.js";

const PG_SKIP = !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI;
const SECRET = "legacy-room-control-locks-fixture-key";
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const MAC_EXP = NOW + 600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const FORBIDDEN = "403:forbidden:permission_denied";
const NOT_FOUND = "404:participant_not_found:-";
const UPGRADE = "409:identity_upgrade_required";
/** Backends transitively queued behind $1, read from the server's own wait graph rather than a timer. */
const WAITERS = `with recursive w(pid) as (select a.pid from pg_stat_activity a where $1=any(pg_blocking_pids(a.pid))
  union select a.pid from pg_stat_activity a join w on w.pid=any(pg_blocking_pids(a.pid))) select count(*)>=$2 as ok from w`;
/** $1 is queued on $2 while holding no policy lock: rooms strictly before the policy. */
const NO_POLICY = `select $2=any(pg_blocking_pids($1)) and not exists(select 1 from pg_locks where pid=$1
  and relation='room_identity_protocol_policy'::regclass) as ok`;

type Session = Extract<LegacyControlActor, { kind: "session" }>;
type Scope = Pick<RoomRecord, "tenantId" | "roomId">;
const ADMIN: LegacyControlActor = { kind: "admin", actorId: LEGACY_CONTROL_ADMIN_ID };
const lock = (): LegacyRoomControlCommand => ({ type: "lock" });
const unlock = (): LegacyRoomControlCommand => ({ type: "unlock" });
const end = (): LegacyRoomControlCommand => ({ type: "end" });
const remove = (targetParticipantId: string, reason: string | null = null): LegacyRoomControlCommand => ({ type: "remove", targetParticipantId, reason });
const grant = (targetParticipantId: string): LegacyRoomControlCommand => ({ type: "grant-presenter", targetParticipantId });
const revoke = (targetParticipantId: string): LegacyRoomControlCommand => ({ type: "revoke-presenter", targetParticipantId });
const transfer = (targetParticipantId: string): LegacyRoomControlCommand => ({ type: "transfer-host", targetParticipantId });
const SAMPLED: readonly string[] = ["grant-presenter", "transfer-host"];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** Live presence as the route wires it: a synchronous read of the current roster, each sample recorded. */
function roster() {
  const live = new Set<string>(), calls: string[] = [];
  const presence: LegacyRoomPresence = (roomId, participantId) => { calls.push(`${roomId}/${participantId}`); return live.has(`${roomId}/${participantId}`); };
  return { calls, presence, join: (roomId: string, participantId: string) => { live.add(`${roomId}/${participantId}`); },
    leave: (roomId: string, participantId: string) => { live.delete(`${roomId}/${participantId}`); } };
}

interface Fixture { s: PostgresStorage; peer: PostgresStorage; reader: PostgresStorage; clock: { now: number }; live: ReturnType<typeof roster>;
  pool: Pool; peerPool: Pool; probe: Pool; options: string }
async function fixture(t: TestContext): Promise<Fixture> {
  const clock = { now: NOW }, identityNow = () => clock.now, connectionString = process.env.VRATA_TEST_POSTGRES_URL;
  assert.ok(connectionString, "CI must supply VRATA_TEST_POSTGRES_URL");
  // Only the owned schema is on the path: init, probes and the floor never reach public.
  const schema = `legacy_control_locks_${randomUUID().replaceAll("-", "")}`, options = `-c search_path=${schema}`;
  // max 1: a second borrow inside the fence times out rather than silently passing.
  const root = new Pool({ connectionString, max: 1 }), pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, options });
  const peerPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, options }), probe = new Pool({ connectionString, max: 12, options });
  t.after(async () => {
    await Promise.allSettled([pool.end(), peerPool.end(), probe.end()]);
    try { await root.query(`drop schema if exists "${schema}" cascade`); } finally { await root.end(); }
  });
  await root.query(`create schema "${schema}"`);
  const s = new PostgresStorage(pool, identityNow);
  await s.init();
  return { s, peer: new PostgresStorage(peerPool, identityNow), reader: new PostgresStorage(probe), clock, live: roster(), pool, peerPool, probe, options };
}

const seed = (f: Fixture, sessionControl: RoomSessionControlState = {}) =>
  f.s.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Control", visibility: "private", sessionControl });
/** The stored row: other columns (minus `drop`) as exact text, and the raw control. */
async function stored(f: Fixture, roomId: string, drop: readonly string[] = []) {
  return (await f.probe.query(`select (to_jsonb(r) - 'session_control' - $2::text[])::text as columns, session_control as control
    from rooms r where room_id=$1`, [roomId, drop])).rows[0] as { columns: string; control: RoomSessionControlState } | undefined;
}
const mac = (room: Scope, participantId: string, role: RoomRole = "host", roleSource: RoomSessionRoleSource = "trusted") => signRoomSessionToken({
  tenantId: room.tenantId, roomId: room.roomId, participantId, displayName: participantId, role, roleSource, permissions: [],
  sessionId: `session-${participantId}`, iat: NOW / 1000 - 60, exp: MAC_EXP / 1000, jti: `jti-${participantId}` }, SECRET);
/** The store actor from verified MAC claims only, as the route builds it: never the DTO, and the lease is the signed exp. */
function macActor(room: Scope, participantId: string, role?: RoomRole, roleSource?: RoomSessionRoleSource): Session {
  const verified = verifyRoomSessionToken(mac(room, participantId, role, roleSource), SECRET, { nowSeconds: NOW / 1000, roomId: room.roomId });
  assert.ok(verified.ok, "the fixture MAC verifies");
  const { tenantId, roomId, participantId: subject, role: signed, roleSource: source = "default", exp } = verified.payload;
  return { kind: "session", tenantId, roomId, participantId: subject, role: signed, roleSource: source, lease: { kind: "bearer", expiresAtMs: exp * 1000 } };
}
function input(f: Fixture, room: Scope, actor: LegacyControlActor, command: LegacyRoomControlCommand): LegacyRoomControlInput {
  return { scope: { tenantId: room.tenantId, roomId: room.roomId }, actor, command, hostControlsEnabled: true,
    ...(SAMPLED.includes(command.type) ? { presence: f.live.presence } : {}) };
}
/** The admission path: a real initial read, the pure evaluator and plan, then the pure decide over the store's fresh clones. */
async function planned(f: Fixture, room: RoomRecord, participantId: string, hash: string | null, rawBearer: string | null = null): Promise<LegacyAdmissionWriteInput> {
  const req: LegacyAdmissionRequest = Object.freeze({ mode: "admit", requestId: randomUUID(), explicitParticipantId: participantId, participantId,
    displayName: participantId, requested: { role: "member", roleSource: "default" } as const, inviteTokenHash: hash });
  const ctx = Object.freeze({ rawBearer, secret: SECRET, nowMs: f.clock.now, accessPolicyEnabled: true, hostControlsEnabled: true });
  const selector = { tenantId: room.tenantId, roomId: room.roomId, participantId, inviteTokenHash: hash };
  let initial!: LegacyRoomCredentialSnapshot;
  await f.s.releaseLegacyRoomCredential(selector, {}, fresh => { initial = fresh; return undefined; });
  const plan = planLegacyAdmissionWrite(evaluateLegacyAdmission(req, initial, ctx), req, initial, ctx);
  assert.ok(plan, "the initial admission plans a deferred write");
  return { selector, mode: plan.mode, deadline: plan.deadline, presentedBearerDeadline: plan.presentedBearerDeadline,
    displayName: plan.mode === "pending" ? plan.displayName : null, decide: (fresh, atMs) => decideLegacyAdmissionWrite(plan, req, fresh, { ...ctx, nowMs: atMs }) };
}

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
const control = (s: PostgresStorage, i: LegacyRoomControlInput) => s.applyLegacyRoomControl(i, {})
  .then(r => r.kind === "refused" ? `${r.status}:${r.error}:${r.reason ?? "-"}` : r.kind, label);
const admit = (s: PostgresStorage, i: LegacyAdmissionWriteInput) => s.writeLegacyAdmission(i, {}).then(r => r.kind === "refused" ? `refused:${r.reason}` : r.kind, label);
const ok = (pending: Promise<unknown>) => pending.then(value => typeof value === "boolean" ? String(value) : "ok", label);
function sqlstates(error: unknown): unknown[] {
  const codes: unknown[] = [];
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) { codes.push((error as { code?: unknown }).code); error = error.cause; }
  return codes;
}

type Around = (sql: string, run: () => Promise<unknown>) => Promise<unknown>;
/** Wraps a max-1 pool's only client, which its next borrower reuses. Callers restore it in finally. */
async function borrowed(t: TestContext, pool: Pool, around: Around) {
  const client = await pool.connect();
  const pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  client.release();
  const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
  const hook = t.mock.method(client, "query", ((...args: unknown[]) => around(
    String(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text).trim().toLowerCase(),
    () => query(...args))) as unknown as PoolClient["query"]);
  return { pid, restore: () => hook.mock.restore() };
}
const pidOf = async (pool: Pool) => (await borrowed({ mock: { method: () => ({ mock: { restore() {} } }) } } as unknown as TestContext, pool, () => Promise.resolve())).pid;
async function until(probe: Pool, sql: string, params: unknown[], what: string) {
  const stop = Date.now() + 10_000;
  while (!(await probe.query(sql, params)).rows[0].ok) { if (Date.now() > stop) assert.fail(what); await delay(10); }
}
/** Holds one real call at a statement on the pool's only client; `during` runs while every lock it took is held. */
async function paused(t: TestContext, pool: Pool, start: () => Promise<string>, at: string, during: (pid: number) => Promise<void>, seen: string[] = []) {
  const reached = deferred(), gate = deferred();
  let armed = true;
  const hook = await borrowed(t, pool, async (sql, run) => {
    seen.push(sql);
    if (armed && sql.startsWith(at)) { armed = false; reached.resolve(); await gate.promise; }
    return run();
  });
  const done = start();
  try {
    assert.equal(await Promise.race([reached.promise.then(() => "paused"), done]), "paused", `the call reaches ${at}`);
    await during(hook.pid);
  } finally { gate.resolve(); await done; hook.restore(); }
  return done;
}

test("Postgres: rooms FOR NO KEY UPDATE, then the policy FOR SHARE, are held through COMMIT on one client, applied or refused", {
  skip: PG_SKIP, timeout: 90_000
}, async t => {
  const f = await fixture(t), probe = f.probe;
  const nowait = (sql: string, params: unknown[]) => probe.query(`${sql} nowait`, params).then(() => "free", label);
  const held = async (pid: number) => (await probe.query(`select string_agg(relation::regclass::text || ':' || mode, ','
    order by relation::regclass::text collate "C", mode collate "C") as modes from pg_locks where pid=$1 and granted
    and relation in ('rooms'::regclass, 'room_identity_protocol_policy'::regclass)`, [pid])).rows[0].modes as string;
  const tag = (sql: string) => sql.startsWith("begin") ? "begin" : /from rooms .*for no key update$/s.test(sql) ? "rooms"
    : /room_identity_protocol_policy .*for share$/s.test(sql) ? "policy" : sql.includes("room_identity_authority_v2") ? "binding"
    : sql.startsWith("update rooms") ? "update" : sql === "commit" ? "commit" : "other";
  for (const [role, expected, modes, order] of [
    ["host", "applied", "room_identity_protocol_policy:RowShareLock,rooms:RowExclusiveLock,rooms:RowShareLock", "begin,other,rooms,policy,binding,update,commit"],
    ["member", FORBIDDEN, "room_identity_protocol_policy:RowShareLock,rooms:RowShareLock", "begin,other,rooms,policy,binding,commit"]
  ] as const) {
    const r = await seed(f, { hostParticipantId: "host-1" }), seen: string[] = [];
    const i = input(f, r, macActor(r, "host-1", role, role === "host" ? "trusted" : "default"), lock());
    assert.equal(await paused(t, f.pool, () => control(f.s, i), "commit", async pid => {
      assert.deepEqual([await held(pid), await nowait("select 1 from rooms where room_id=$1 for key share", [r.roomId]),
        await nowait("select 1 from rooms where room_id=$1 for share", [r.roomId]),
        await nowait("select 1 from room_identity_protocol_policy where singleton=true for update", [])],
      [modes, "free", "db:55P03", "db:55P03"], `${role}: parent and policy are held up to COMMIT`);
    }, seen), expected, role);
    assert.equal(seen.map(tag).join(), order, `${role}: parent first, then policy, all on the pool's only client`);
  }
});

test("Postgres: rename, disable, delete, a v2 binding and another control queue behind a held control and keep its merge", {
  skip: PG_SKIP, timeout: 120_000
}, async t => {
  const f = await fixture(t), other = new PostgresStorage(f.probe, () => f.clock.now);
  const facts = async (roomId: string) => (await f.probe.query("select name, status from rooms where room_id=$1", [roomId])).rows[0];
  const queued: Array<[string, (r: RoomRecord) => Promise<string>, string[], string, unknown]> = [
    ["rename", r => ok(other.updateRoom(r.roomId, { name: "Renamed" })), ["name"], "ok", { name: "Renamed", status: "active" }],
    ["disable", r => ok(other.updateRoom(r.roomId, { status: "disabled", disabledAt: iso(NOW), disabledBy: "admin" })),
      ["status", "disabled_at", "disabled_by"], "ok", { name: "Control", status: "disabled" }],
    ["delete", r => ok(other.deleteRoom(r.roomId)), [], "true", undefined],
    ["v2 binding", r => ok(other.roomIdentities.create({ tenantId: r.tenantId, roomId: r.roomId, displayName: "Bound", baseRole: "guest",
      provenance: { kind: "guest" } })), [], "ok", { name: "Control", status: "active" }],
    ["control", r => control(f.peer, input(f, r, ADMIN, lock())), [], "applied", { name: "Control", status: "active" }]
  ];
  for (const [name, method, drop, expected, fact] of queued) {
    const r = await seed(f);
    // Fixture-only: an unknown raw key and a prior removal, then one administrative write so its own normalization is already in place.
    await f.probe.query("update rooms set session_control = session_control || $2::jsonb where room_id=$1", [r.roomId, JSON.stringify({
      hostParticipantId: "host-1", fixtureSpare: { kept: true }, removedParticipants: { "p-9": { removedAt: iso(NOW - HOUR) } } })]);
    await other.updateRoom(r.roomId, { name: "Control" });
    const before = (await stored(f, r.roomId, drop))!;
    let later: Promise<string> | undefined;
    try {
      assert.equal(await paused(t, f.pool, () => control(f.s, input(f, r, macActor(r, "host-1"), remove("p-2", "noisy"))), "commit", async pid => {
        later = method(r);
        await until(f.probe, WAITERS, [pid, 1], `${name} waits on the held control`);
      }), "applied", name);
    } finally { await later; }
    const after = await stored(f, r.roomId, drop);
    const merged = { ...before.control, removedParticipants: { ...before.control.removedParticipants, "p-2": { removedAt: iso(NOW), removedBy: "host-1", reason: "noisy" } } };
    assert.deepEqual([await later, await facts(r.roomId)], [expected, fact], name);
    if (name === "v2 binding") assert.equal(await control(f.s, input(f, r, ADMIN, unlock())), UPGRADE, "the binding committed after the control");
    else if (after) assert.deepEqual([after.columns === before.columns, after.control], [true,
      name === "control" ? { ...merged, lockedAt: iso(NOW), lockedBy: LEGACY_CONTROL_ADMIN_ID } : merged], `${name}: both writes survive, nothing else moved`);
  }
});

test("Postgres: an uncommitted host claim holds the control off the policy, and each side decides on the other's committed row", {
  skip: PG_SKIP, timeout: 90_000
}, async t => {
  const f = await fixture(t), peerPid = await pidOf(f.peerPool);
  // The route reads its room outside the primitive while the seat is vacant; the guarded control must not decide on that snapshot.
  const r = await seed(f), snapshot = (await f.reader.getRoom(r.roomId))!, claim = await planned(f, r, "host-b", null, mac(r, "host-b"));
  const i = input(f, snapshot, macActor(snapshot, "host-x"), lock());
  let late: Promise<string> | undefined;
  try {
    assert.equal(await paused(t, f.pool, () => admit(f.s, claim), "commit", async pid => {
      late = control(f.peer, i);
      await until(f.probe, NO_POLICY, [peerPid, pid], "the control waits on the claimed parent holding no policy lock");
    }), "host_ready");
  } finally { await late; }
  const seated = (await stored(f, r.roomId))!.control;
  assert.deepEqual([snapshot.sessionControl?.hostParticipantId ?? null, await late, seated.hostParticipantId, seated.lockedAt],
    [null, FORBIDDEN, "host-b", null], "the actor's host MAC lost the seat before the fence: no mutation");
  // Opposite order: the claim waits on a held control; an end refuses it, a lock still seats it and keeps its stamp.
  for (const [command, who, expected, seat, ended] of [[end(), "host-c", "refused:session_ended", null, iso(NOW)],
    [lock(), "host-d", "host_ready", "host-d", null]] as const) {
    const o = await seed(f), queuedClaim = await planned(f, o, who, null, mac(o, who));
    let claimed: Promise<string> | undefined;
    try {
      assert.equal(await paused(t, f.pool, () => control(f.s, input(f, o, ADMIN, command)), "commit", async pid => {
        claimed = admit(f.peer, queuedClaim);
        await until(f.probe, WAITERS, [pid, 1], `${command.type}: the claim waits on the held control`);
      }), "applied");
    } finally { await claimed; }
    const after = (await stored(f, o.roomId))!.control;
    assert.deepEqual([await claimed, after.hostParticipantId, after.endedAt, after.lockedAt], [expected, seat, ended, command.type === "lock" ? iso(NOW) : null]);
  }
});

test("Postgres: presence is sampled once, after the parent lock it waited for; the captured input never widens", { skip: PG_SKIP, timeout: 90_000 }, async t => {
  const f = await fixture(t), writerPid = await pidOf(f.pool);
  type Change = (c: PoolClient, roomId: string) => Promise<unknown>;
  const touch: Change = (c, roomId) => c.query("update rooms set name = name where room_id=$1", [roomId]);
  const removal: Change = (c, roomId) => c.query(`update rooms set session_control = jsonb_set(session_control, '{removedParticipants,p-2}',
    '{"removedAt":"2026-09-30T00:00:00.000Z"}'::jsonb) where room_id=$1`, [roomId]);
  const cases: Array<[string, LegacyRoomControlCommand, boolean, (roomId: string) => void, Change, string, number]> = [
    ["target left during the wait", grant("p-2"), true, roomId => f.live.leave(roomId, "p-2"), touch, NOT_FOUND, 1],
    ["target appeared during the wait", transfer("p-2"), false, roomId => f.live.join(roomId, "p-2"), touch, "applied", 1],
    ["target removed during the wait", grant("p-2"), true, () => undefined, removal, NOT_FOUND, 0]
  ];
  for (const [name, command, present, move, change, expected, samples] of cases) {
    const r = await seed(f, { hostParticipantId: "host-1" }), decoy = await seed(f, { hostParticipantId: "host-1" });
    if (present) f.live.join(r.roomId, "p-2");
    f.live.join(decoy.roomId, "intruder");
    const i = input(f, r, macActor(r, "host-1"), command), untouched = await stored(f, decoy.roomId), holder = await f.probe.connect();
    f.live.calls.length = 0;
    let done: Promise<string> | undefined;
    try {
      const holderPid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await holder.query("begin");
      await change(holder, r.roomId);
      done = control(f.s, i);
      await until(f.probe, "select $2=any(pg_blocking_pids($1)) as ok", [writerPid, holderPid], `${name}: the control waits on the parent`);
      assert.deepEqual(f.live.calls, [], `${name}: nothing is sampled before the parent lock`);
      move(r.roomId);
      // Scope, subject, lease, command, flag and the presence function were all captured before the wait.
      Object.assign(i.scope, { roomId: decoy.roomId }); Object.assign(i.command, { targetParticipantId: "intruder" });
      Object.assign(i.actor, { participantId: "intruder" }); Object.assign((i.actor as Session).lease, { expiresAtMs: NOW + 9 * HOUR });
      Object.assign(i, { presence: () => true, hostControlsEnabled: false });
      await holder.query("commit");
      assert.equal(await done, expected, name);
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); await done; }
    assert.deepEqual([f.live.calls, (await stored(f, r.roomId))!.control.hostParticipantId, await stored(f, decoy.roomId)],
      [Array(samples).fill(`${r.roomId}/p-2`), expected === "applied" ? "p-2" : "host-1", untouched], name);
  }
});

test("Postgres: a control queued behind a concurrent init holds no policy lock, then applies; the policy signature survives", {
  skip: PG_SKIP, timeout: 120_000
}, async t => {
  const f = await fixture(t);
  const signature = `select minimum_protocol, media_namespace, (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=current_schema() and p.proname='vrata_identity_v2_room_boundary' and p.pronargs=0) as guard_hash
    from room_identity_protocol_policy where singleton=true`;
  const before = (await f.probe.query(signature)).rows[0];
  const initPool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 1, options: f.options });
  t.after(() => initPool.end());
  for (const command of [lock(), grant("p-2")]) {
    const r = await seed(f, { hostParticipantId: "host-1" }), reached = deferred(), proceed = deferred();
    f.live.join(r.roomId, "p-2");
    let paused = false;
    // Pause the real initializer at its policy ALTER batch, after its rooms ALTERs.
    const hook = await borrowed(t, initPool, async (sql, run) => {
      if (!paused && /alter table room_identity_protocol_policy/.test(sql)) { paused = true; reached.resolve(); await proceed.promise; }
      return run();
    });
    const initializing = ok(new PostgresStorage(initPool).init());
    let done: Promise<string> | undefined;
    try {
      const writerPid = await pidOf(f.pool);
      assert.equal(await Promise.race([reached.promise.then(() => "paused"), initializing]), "paused");
      await until(f.probe, `select exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
        and mode='AccessExclusiveLock' and granted) as ok`, [hook.pid], "init holds rooms AccessExclusive before its policy ALTER");
      done = control(f.s, input(f, r, macActor(r, "host-1"), command));
      await until(f.probe, NO_POLICY, [writerPid, hook.pid], `${command.type}: the control waits on rooms holding no policy lock`);
      proceed.resolve();
      assert.deepEqual([await initializing, await done], ["ok", "applied"], `${command.type}: no 40P01, and the control applies after init`);
    } finally { proceed.resolve(); await initializing; await done; hook.restore(); }
    assert.deepEqual((await f.probe.query(signature)).rows[0], before, "floor, namespace and guard hash survive reinit");
  }
});

test("Postgres: controls mixed with admission writes, releases, child and admin writers keep one lock order and never deadlock", {
  skip: PG_SKIP, timeout: 120_000
}, async t => {
  const f = await fixture(t), other = new PostgresStorage(f.probe, () => f.clock.now);
  const room = await seed(f), bound = await seed(f), scope = { tenantId: room.tenantId, roomId: room.roomId };
  const invite = await f.s.createRoomInvite({ roomId: room.roomId, tokenHash: `hash-${room.roomId}`, role: "member", protocolVersion: 1,
    waitingRoomEnabled: true, expiresAt: iso(NOW + HOUR) });
  const row = await f.s.createWaitingRoomRequest({ roomId: room.roomId, inviteId: invite.inviteId, participantId: "mixer", displayName: "mixer" });
  f.live.join(room.roomId, "p-2");
  const inputs: LegacyAdmissionWriteInput[][] = [];
  for (let round = 0; round < 6; round++) {
    inputs.push([await planned(f, room, `host-${round}`, null, mac(room, `host-${round}`)), await planned(f, room, `guest-${round}`, invite.tokenHash)]);
  }
  const commands = [lock(), remove("p-3"), grant("p-2"), revoke("p-2"), unlock(), end()], deadlocks: number[] = [];
  for (let round = 0; round < 6; round++) {
    const status = round % 2 ? "approved" : "rejected", at = iso(NOW), [claim, pending] = inputs[round]!;
    const results = await Promise.allSettled([
      f.s.applyLegacyRoomControl(input(f, room, ADMIN, commands[round]!), {}),
      other.applyLegacyRoomControl(input(f, room, macActor(room, "host-0"), transfer("p-2")), {}),
      f.peer.writeLegacyAdmission(pending!, {}), other.writeLegacyAdmission(claim!, {}),
      other.releaseLegacyRoomCredential({ ...scope, participantId: "mixer", inviteTokenHash: invite.tokenHash }, {}, () => undefined),
      other.withLegacyRoomEffect(scope, { roomWrite: true }, async scoped => {
        await scoped.updateWaitingRoomRequest(room.roomId, row.requestId, { status, decidedBy: "host" });
        await scoped.revokeRoomInvite(room.roomId, invite.inviteId, at, "host");
      }),
      other.revokeRoomInvite(room.roomId, invite.inviteId, at, "admin"),
      other.updateWaitingRoomRequest(room.roomId, row.requestId, { status, decidedBy: "admin" }),
      other.updateRoom(room.roomId, { name: `Round ${round}` }),
      ...(round === 5 ? [other.deleteRoom(room.roomId), other.roomIdentities.create({ tenantId: bound.tenantId, roomId: bound.roomId,
        displayName: "Bound", baseRole: "guest", provenance: { kind: "guest" } }), other.identityProtocol.raise(2)] : [])
    ]);
    for (const result of results) if (result.status === "rejected" && sqlstates(result.reason).includes("40P01")) deadlocks.push(round);
  }
  assert.deepEqual(deadlocks, [], "parent, policy, then child order never forms a cycle");
});

test("Postgres: a cutover queued behind a held control keeps that known receipt; the next legacy control is refused", {
  skip: PG_SKIP, timeout: 60_000
}, async t => {
  const f = await fixture(t), raiser = new PostgresStorage(f.probe), r = await seed(f, { hostParticipantId: "host-1" });
  let raised: Promise<string> | undefined;
  try {
    assert.equal(await paused(t, f.pool, () => control(f.s, input(f, r, macActor(r, "host-1"), lock())), "commit", async pid => {
      raised = raiser.identityProtocol.raise(2).then(String, label);
      await until(f.probe, WAITERS, [pid, 1], "the cutover queues behind the held policy share");
    }), "applied");
  } finally { await raised; }
  const kept = await stored(f, r.roomId);
  assert.deepEqual([await raised, kept?.control.lockedAt, await control(f.s, input(f, r, ADMIN, unlock())), await stored(f, r.roomId)],
    ["2", iso(NOW), UPGRADE, kept], "the acknowledged lock stands; the next legacy write is refused and changes nothing");
});
