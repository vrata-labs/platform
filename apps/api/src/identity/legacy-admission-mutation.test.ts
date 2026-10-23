import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseError, Pool, type PoolClient } from "pg";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { MemoryStorage, PostgresStorage } from "../storage.js";
import type { LegacyAdmissionWriteInput, LegacyAdmissionWriteReceipt, LegacyRoomCredentialSnapshot, RoomRecord, Storage } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { uncertainRoomCommit } from "./fence-transaction.js";
import { decideLegacyAdmissionWrite, LegacyAdmissionDeadlineExpired, LegacyAdmissionWriteInvariant, planLegacyAdmissionWrite } from "./legacy-admission-write.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import { evaluateLegacyAdmission, type LegacyAdmissionRequest } from "./legacy-state-admission.js";

const PG_SKIP = !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI;
const SECRET = "legacy-admission-store-fixture-key";
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const MAC_EXP = NOW + 600_000;
const WRITE = /^(update rooms|insert into room_waiting_requests)/;
const iso = (ms: number) => new Date(ms).toISOString();
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
/** Backends transitively queued behind $1, read from the server's own wait graph rather than a timer. */
const WAITERS = `with recursive w(pid) as (select a.pid from pg_stat_activity a where $1=any(pg_blocking_pids(a.pid))
  union select a.pid from pg_stat_activity a join w on w.pid=any(pg_blocking_pids(a.pid))) select count(*)>=$2 as ok from w`;

interface Clock { now: number; onRead?: () => void }
interface Fixture { s: Storage; peer: Storage; reader: Storage; clock: Clock; pool?: Pool; peerPool?: Pool; probe?: Pool; options?: string }

async function fixture(t: TestContext, postgres: boolean): Promise<Fixture> {
  const clock: Clock = { now: NOW };
  // The store's injected instant; a test may hook one read to schedule a later lapse.
  const identityNow = () => { const value = clock.now; clock.onRead?.(); return value; };
  if (!postgres) { const s = new MemoryStorage(identityNow); return { s, peer: s, reader: s, clock }; }
  const connectionString = process.env.VRATA_TEST_POSTGRES_URL;
  assert.ok(connectionString, "CI must supply VRATA_TEST_POSTGRES_URL");
  // Only the owned schema is on the path: init, fault triggers and the floor never reach public.
  const schema = `legacy_admission_${randomUUID().replaceAll("-", "")}`, options = `-c search_path=${schema}`;
  const root = new Pool({ connectionString, max: 1 });
  await root.query(`create schema "${schema}"`);
  // max 1: a second borrow inside a write times out rather than silently passing.
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, options });
  const peerPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, options });
  const probe = new Pool({ connectionString, max: 12, options });
  t.after(async () => {
    await Promise.allSettled([pool.end(), peerPool.end(), probe.end()]);
    await root.query(`drop schema "${schema}" cascade`); await root.end();
  });
  const s = new PostgresStorage(pool, identityNow);
  await s.init();
  return { s, peer: new PostgresStorage(peerPool, identityNow), reader: new PostgresStorage(probe), clock, pool, peerPool, probe, options };
}

async function seed(f: Fixture, over: Partial<RoomRecord> = {}) {
  const room = await f.s.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Admission", visibility: "private", ...over });
  const invite = await f.s.createRoomInvite({ roomId: room.roomId, tokenHash: `hash-${room.roomId}`, role: "member", protocolVersion: 1,
    waitingRoomEnabled: true, expiresAt: iso(NOW + HOUR) });
  return { room, invite };
}
const mac = (room: RoomRecord, participantId: string, role: "host" | "member" = "host", expMs = MAC_EXP) => signRoomSessionToken({ tenantId: room.tenantId,
  roomId: room.roomId, participantId, displayName: participantId, role, roleSource: role === "host" ? "trusted" : "default", permissions: [],
  sessionId: `session-${participantId}`, iat: NOW / 1000 - 60, exp: expMs / 1000, jti: `jti-${participantId}` }, SECRET);

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
  // Unfrozen copies, so a caller can still mutate them after the call.
  return { selector: { ...selector }, mode: plan.mode, deadline: plan.deadline && { ...plan.deadline },
    presentedBearerDeadline: plan.presentedBearerDeadline && { ...plan.presentedBearerDeadline },
    displayName: plan.mode === "pending" ? plan.displayName : null,
    decide: (fresh, atMs) => decideLegacyAdmissionWrite(plan, req, fresh, { ...ctx, nowMs: atMs }) };
}

const summary = (receipt: LegacyAdmissionWriteReceipt) => receipt.kind === "pending" ? `pending:${receipt.created}`
  : receipt.kind === "refused" ? `refused:${receipt.reason}:${receipt.accessRequestId === undefined ? "-" : "row"}` : receipt.kind;
// Assertion output carries only fixed codes and SQLSTATEs, never a token, hash or raw driver error.
function label(error: unknown): string {
  if (error instanceof assert.AssertionError) throw error;
  if (error instanceof LegacyAdmissionDeadlineExpired) return `expired:${error.kind}`;
  if (error instanceof LegacyAdmissionWriteInvariant || error instanceof IdentityStorageError) return error.code;
  if (error instanceof IdentityBoundaryError) return `${error.status}:${error.reason}`;
  if (uncertainRoomCommit(error)) return "uncertain";
  if (error instanceof DatabaseError) return `db:${error.code}`;
  return "unexpected_error";
}
const write = (s: Storage, input: LegacyAdmissionWriteInput) => s.writeLegacyAdmission(input, {}).then(summary, label);
const ok = (pending: Promise<unknown>) => pending.then(() => "ok", label);

/** The committed truth for one subject: the host seat and that subject's waiting rows. */
async function facts(f: Fixture, roomId: string, participantId: string) {
  const room = await f.reader.getRoom(roomId);
  const rows = (await f.reader.listWaitingRoomRequests(roomId)).filter(row => row.participantId === participantId)
    .map(row => [row.requestId, row.status, row.displayName, row.createdAt, row.decidedAt ?? "", row.decidedBy ?? ""].join("|"));
  return { host: room?.sessionControl?.hostParticipantId ?? null, rows };
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
async function pidOf(pool: Pool) {
  const client = await pool.connect();
  try { return (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number; } finally { client.release(); }
}
async function until(probe: Pool, sql: string, params: unknown[], what: string) {
  const stop = Date.now() + 10_000;
  while (!(await probe.query(sql, params)).rows[0].ok) { if (Date.now() > stop) assert.fail(what); await delay(10); }
}
/** Pauses a real write at a statement; `during` runs while every lock it took is held. */
async function paused(t: TestContext, f: Fixture, input: LegacyAdmissionWriteInput, at: string, during: (pid: number) => Promise<void>) {
  const reached = deferred(), gate = deferred();
  let armed = true;
  const hook = await borrowed(t, f.pool!, async (sql, run) => {
    if (armed && sql.startsWith(at)) { armed = false; reached.resolve(); await gate.promise; }
    return run();
  });
  const done = write(f.s, input);
  try {
    assert.equal(await Promise.race([reached.promise.then(() => "paused"), done]), "paused", `the write reaches ${at}`);
    await during(hook.pid);
  } finally { gate.resolve(); await done; hook.restore(); }
  return done;
}
function sqlstates(error: unknown): unknown[] {
  const codes: unknown[] = [];
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) { codes.push((error as { code?: unknown }).code); error = error.cause; }
  return codes;
}

for (const postgres of [false, true]) test(`${postgres ? "Postgres" : "Memory"}: one host CAS and one canonical pending row over fresh clones`, {
  skip: postgres && PG_SKIP, timeout: 90_000
}, async t => {
  const f = await fixture(t, postgres);
  const raw = async (roomId: string) => (await f.probe?.query(`select to_jsonb(r) - 'session_control' as columns,
    session_control - 'hostParticipantId' as control, session_control->'hostParticipantId' as host from rooms r where room_id=$1`, [roomId]))?.rows[0];
  const updates: string[] = [];
  const spy = () => Promise.all([f.pool, f.peerPool].filter((pool): pool is Pool => pool !== undefined).map(pool => borrowed(t, pool, (sql, run) => {
    if (sql.startsWith("update rooms")) updates.push(sql);
    return run();
  })));
  // A locked room still seats its trusted host; lifecycle flags, removals, spare raw keys and every column survive.
  const { room } = await seed(f, { sessionControl: { lockedAt: iso(NOW - 1000), lockedBy: "admin", presenterParticipantId: "presenter-1",
    removedParticipants: { gone: { removedAt: iso(NOW - 1000) } } } });
  await f.probe?.query(`update rooms set session_control = session_control || '{"spare":{"kept":true}}'::jsonb where room_id=$1`, [room.roomId]);
  const claim = await planned(f, room, "host-a", null, mac(room, "host-a")), rival = await planned(f, room, "host-b", null, mac(room, "host-b"));
  const before = (await f.reader.getRoom(room.roomId))!, rawBefore = await raw(room.roomId);
  assert.equal(await write(f.s, claim), "host_ready");
  const seated = { ...before, sessionControl: { ...before.sessionControl, hostParticipantId: "host-a" } };
  assert.deepEqual(await f.reader.getRoom(room.roomId), seated);
  if (rawBefore) assert.deepEqual(await raw(room.roomId), { ...rawBefore, host: "host-a" }, "only the raw host key changes");
  const quiet = await spy();
  try { assert.deepEqual([await write(f.s, claim), await write(f.s, rival)], ["host_ready", "changed"]); } finally { quiet.forEach(item => item.restore()); }
  assert.deepEqual([updates.length, await f.reader.getRoom(room.roomId)], [0, seated], "a current seat or another host never reaches the CAS");

  // Concurrent claimers: two subjects seat exactly one; the same subject twice issues one UPDATE.
  const duel = (await seed(f)).room, twin = (await seed(f)).room;
  const duelists = [await planned(f, duel, "host-c", null, mac(duel, "host-c")), await planned(f, duel, "host-d", null, mac(duel, "host-d"))];
  const twins = [await planned(f, twin, "host-e", null, mac(twin, "host-e")), await planned(f, twin, "host-e", null, mac(twin, "host-e"))];
  assert.deepEqual((await Promise.all([write(f.s, duelists[0]!), write(f.peer, duelists[1]!)])).sort(), ["changed", "host_ready"]);
  assert.ok(["host-c", "host-d"].includes((await facts(f, duel.roomId, "-")).host ?? ""));
  const counted = await spy();
  try { assert.deepEqual(await Promise.all([write(f.s, twins[0]!), write(f.peer, twins[1]!)]), ["host_ready", "host_ready"]); }
  finally { counted.forEach(item => item.restore()); }
  if (postgres) assert.equal(updates.length, 1, "the same subject seats once; its twin reads itself current");

  // Raw vacancy is an absent, null or empty host; a non-object control is drift and is never stomped.
  if (f.probe) for (const [control, expected] of [["{}", "host_ready"], ['{"hostParticipantId":""}', "host_ready"],
    ['{"hostParticipantId":null}', "host_ready"], ["[]", "changed"]] as const) {
    const vacant = (await seed(f)).room, input = await planned(f, vacant, "host-f", null, mac(vacant, "host-f"));
    await f.probe.query("update rooms set session_control=$2::jsonb where room_id=$1", [vacant.roomId, control]);
    const rawVacant = await raw(vacant.roomId);
    assert.equal(await write(f.s, input), expected, control);
    assert.deepEqual(await raw(vacant.roomId), expected === "host_ready" ? { ...rawVacant, host: "host-f" } : rawVacant, control);
  }
  // Ended or removed after the plan: refused, and nothing overwritten.
  for (const [control, reason] of [[{ endedAt: iso(NOW) }, "session_ended"],
    [{ removedParticipants: { "host-g": { removedAt: iso(NOW) } } }, "participant_removed"]] as const) {
    const closed = (await seed(f)).room, input = await planned(f, closed, "host-g", null, mac(closed, "host-g"));
    await f.s.updateRoom(closed.roomId, { sessionControl: control });
    const current = await f.reader.getRoom(closed.roomId);
    assert.equal(await write(f.s, input), `refused:${reason}:-`);
    assert.deepEqual(await f.reader.getRoom(closed.roomId), current);
  }

  // Pending: one row at the store's own instant, then the same key is current and never duplicated.
  const { room: lobby, invite } = await seed(f), hash = invite.tokenHash;
  const first = await planned(f, lobby, "guest", hash), again = await planned(f, lobby, "guest", hash);
  f.clock.now = NOW + 5_000;
  const created = await f.s.writeLegacyAdmission(first, {});
  assert.ok(created.kind === "pending" && created.created, "the first write inserts");
  assert.deepEqual((await facts(f, lobby.roomId, "guest")).rows, [`${created.accessRequestId}|pending|guest|${iso(NOW + 5_000)}||`]);
  assert.deepEqual(await f.s.writeLegacyAdmission(again, {}), { kind: "pending", accessRequestId: created.accessRequestId, created: false });
  // A decided row is never reset: status, name and decision metadata stay.
  for (const [status, expected] of [["approved", "changed"], ["rejected", "refused:waiting_room_rejected:row"]] as const) {
    const who = `waiter-${status}`;
    const row = await f.s.createWaitingRoomRequest({ roomId: lobby.roomId, inviteId: invite.inviteId, participantId: who, displayName: "Original" });
    const input = await planned(f, lobby, who, hash);
    await f.s.updateWaitingRoomRequest(lobby.roomId, row.requestId, { status, decidedAt: iso(NOW), decidedBy: "host" });
    const decided = await facts(f, lobby.roomId, who);
    assert.equal(await write(f.s, input), expected);
    assert.deepEqual(await facts(f, lobby.roomId, who), decided, status);
  }
  // Only the closed family reaches a write; any other answer is a fault that changes nothing.
  const toy = await planned(f, lobby, "toy", hash);
  const state = async () => JSON.stringify([await f.reader.getRoom(lobby.roomId), await f.reader.listWaitingRoomRequests(lobby.roomId)]);
  const untouched = await state();
  for (const answer of [Promise.resolve({ write: "insert_pending" }), { write: "grant" }, { write: "set_host" },
    { write: "none_pending", accessRequestId: created.accessRequestId }, { write: "insert_pending", requestId: "chosen" }]) {
    assert.equal(await write(f.s, { ...toy, decide: () => answer } as unknown as LegacyAdmissionWriteInput), "invalid_legacy_admission_plan");
  }
  assert.equal(await state(), untouched);
  // The personal owner's raw ID claims at floor 1 with no lease and never creates a v2 binding.
  const personal = await f.s.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Personal", roomType: "personal", ownerParticipantId: "owner" });
  const owner = await planned(f, personal, "owner", null);
  f.clock.now = NOW + 10 * HOUR;
  assert.deepEqual([owner.deadline, await write(f.s, owner), (await facts(f, personal.roomId, "owner")).host, await f.s.hasRoomIdentityAuthority(personal.roomId)],
    [null, "host_ready", "owner", false]);
});

test("Postgres: a write decides on the change it waited for, and caller mutation during either wait widens nothing", {
  skip: PG_SKIP, timeout: 120_000
}, async t => {
  const f = await fixture(t, true), probe = f.probe!;
  type Kind = "host" | "pending" | "held";
  const end = (c: PoolClient, roomId: string) => c.query(`update rooms set session_control = session_control
    || jsonb_build_object('endedAt', now()::text) where room_id=$1`, [roomId]);
  const expiry = (at: number) => (c: PoolClient, roomId: string) => c.query("update room_invites set expires_at=$2 where room_id=$1", [roomId, iso(at)]);
  const changes: Array<[string, Kind, (c: PoolClient, roomId: string, who: string) => Promise<unknown>, number, string]> = [
    ["room end", "host", end, NOW, "refused:session_ended:-"],
    ["subject removal", "host", (c, roomId, who) => c.query(`update rooms set session_control = session_control || jsonb_build_object('removedParticipants',
      jsonb_build_object($2::text, jsonb_build_object('removedAt', now()::text))) where room_id=$1`, [roomId, who]), NOW, "refused:participant_removed:-"],
    ["room disable", "host", (c, roomId) => c.query("update rooms set status='disabled', disabled_at=now(), disabled_by='admin' where room_id=$1", [roomId]),
      NOW, "refused:room_disabled:-"],
    ["a different host", "host", (c, roomId) => c.query(`update rooms set session_control = session_control || '{"hostParticipantId":"rival"}'::jsonb
      where room_id=$1`, [roomId]), NOW, "changed"],
    ["room end", "pending", end, NOW, "refused:session_ended:-"],
    ["invite revoke", "pending", (c, roomId) => c.query("update room_invites set revoked_at=now(), revoked_by='admin' where room_id=$1", [roomId]),
      NOW, "refused:invite_revoked:-"],
    // The fresh invite only ever shortens the original lease; either way its exact instant has lapsed.
    ["an expedited invite", "pending", expiry(NOW + 60_000), NOW + 60_000, "expired:invite"],
    ["an extended invite", "pending", expiry(NOW + 2 * HOUR), NOW + HOUR, "expired:invite"],
    ["a waiting decision", "held", (c, roomId, who) => c.query(`update room_waiting_requests set status='rejected', decided_at=now(), decided_by='admin'
      where room_id=$1 and participant_id=$2`, [roomId, who]), NOW, "refused:waiting_room_rejected:row"]
  ];
  for (const [name, kind, change, at, expected] of changes) {
    const { room, invite } = await seed(f), decoy = (await seed(f)).room, who = `subject-${kind}`;
    if (kind === "held") await f.s.createWaitingRoomRequest({ roomId: room.roomId, inviteId: invite.inviteId, participantId: who, displayName: who });
    const input = kind === "host" ? await planned(f, room, who, null, mac(room, who)) : await planned(f, room, who, invite.tokenHash);
    const before = await facts(f, room.roomId, who), writerPid = await pidOf(f.pool!), holder = await probe.connect();
    let done: Promise<string> | undefined;
    try {
      const holderPid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await holder.query("begin");
      await change(holder, room.roomId, who);
      done = write(f.s, input);
      await until(probe, "select $2=any(pg_blocking_pids($1)) as ok", [writerPid, holderPid], `${name}: the ${kind} write waits on the uncommitted change`);
      // Scope, mode, name, leases and the callback were all captured before the wait.
      Object.assign(input.selector, { roomId: decoy.roomId, participantId: "intruder", inviteTokenHash: null });
      Object.assign(input, { mode: "claim_host", displayName: "Intruder", decide: () => ({ write: "set_host" }) });
      if (input.deadline) Object.assign(input.deadline, { expiresAtMs: NOW + 9 * HOUR });
      f.clock.now = at;
      await holder.query("commit");
      assert.equal(await done, expected, name);
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); await done; f.clock.now = NOW; }
    const after = await facts(f, room.roomId, who);
    assert.deepEqual([after.host === who, after.rows.length], [false, before.rows.length], `${name}: no seat and no new row`);
    assert.equal((await facts(f, decoy.roomId, "intruder")).host, null, `${name}: the mutated selector reached nothing`);
  }
  // Queued for the pool's only client: the same capture holds, and the original MAC lapses during the wait.
  const { room } = await seed(f), queued = await planned(f, room, "queued", null, mac(room, "queued"));
  const busy = await f.pool!.connect();
  let done: Promise<string> | undefined;
  try {
    done = write(f.s, queued);
    for (const stop = Date.now() + 5000; f.pool!.waitingCount !== 1;) { if (Date.now() > stop) assert.fail("the write queues for the pool"); await delay(10); }
    Object.assign(queued.selector, { participantId: "intruder" });
    for (const lease of [queued.deadline, queued.presentedBearerDeadline]) Object.assign(lease!, { expiresAtMs: NOW + 9 * HOUR });
    f.clock.now = MAC_EXP;
  } finally { busy.release(); }
  assert.equal(await done, "expired:bearer");
  f.clock.now = NOW;
  assert.deepEqual([(await facts(f, room.roomId, "queued")).host, (await facts(f, room.roomId, "intruder")).host], [null, null]);
});

test("Postgres: parent, policy and child locks hold through COMMIT, and every lease is rechecked after SQL and before COMMIT", {
  skip: PG_SKIP, timeout: 120_000
}, async t => {
  const f = await fixture(t, true), probe = f.probe!, other = new PostgresStorage(probe);
  const nowait = (sql: string, params: unknown[]) => probe.query(`${sql} nowait`, params).then(() => "free", label);
  const policy = () => nowait("select 1 from room_identity_protocol_policy where singleton=true for update", []);
  // A host claim: the room FOR NO KEY UPDATE, which still admits KEY SHARE, and the policy FOR SHARE.
  const { room: seat } = await seed(f), claim = await planned(f, seat, "host-l", null, mac(seat, "host-l"));
  const queued: Array<Promise<string>> = [];
  assert.equal(await paused(t, f, claim, "commit", async pid => {
    assert.deepEqual([await nowait("select 1 from rooms where room_id=$1 for key share", [seat.roomId]),
      await nowait("select 1 from rooms where room_id=$1 for share", [seat.roomId]), await policy()], ["free", "db:55P03", "db:55P03"]);
    queued.push(ok(other.updateRoom(seat.roomId, { name: "Renamed" })), other.roomIdentities.create({ tenantId: seat.tenantId, roomId: seat.roomId,
      displayName: "Bound", baseRole: "guest", provenance: { kind: "guest" } }).then(() => "settled", () => "settled"));
    await until(probe, WAITERS, [pid, 2], "an admin update and a v2 binding wait on the claim");
  }), "host_ready");
  assert.deepEqual(await Promise.all(queued), ["ok", "settled"]);
  // A pending write: the room only FOR SHARE, then the policy, the invite and the subject's row.
  const { room: lobby, invite } = await seed(f);
  const row = await f.s.createWaitingRoomRequest({ roomId: lobby.roomId, inviteId: invite.inviteId, participantId: "guest-l", displayName: "guest-l" });
  const pending = await planned(f, lobby, "guest-l", invite.tokenHash), controls: Array<Promise<string>> = [];
  assert.equal(await paused(t, f, pending, "commit", async pid => {
    assert.deepEqual([await nowait("select 1 from rooms where room_id=$1 for share", [lobby.roomId]),
      await nowait("select 1 from rooms where room_id=$1 for no key update", [lobby.roomId]),
      await nowait("select 1 from room_invites where invite_id=$1 for update", [invite.inviteId]),
      await nowait("select 1 from room_waiting_requests where request_id=$1 for update", [row.requestId]), await policy()],
    ["free", "db:55P03", "db:55P03", "db:55P03", "db:55P03"]);
    controls.push(ok(other.revokeRoomInvite(lobby.roomId, invite.inviteId, iso(NOW), "admin")),
      ok(other.updateWaitingRoomRequest(lobby.roomId, row.requestId, { status: "approved", decidedBy: "admin" })));
    await until(probe, WAITERS, [pid, 2], "an invite revoke and a waiting decision wait on the pending write");
  }), "pending:false");
  assert.deepEqual(await Promise.all(controls), ["ok", "ok"]);

  // A same-key race: the loser's insert waits on the winner's uncommitted key, then re-reads and never inserts again.
  const { room: race, invite: raceInvite } = await seed(f);
  const winner = await planned(f, race, "racer", raceInvite.tokenHash), loser = await planned(f, race, "racer", raceInvite.tokenHash);
  const loserSql: string[] = [];
  const loserSpy = await borrowed(t, f.peerPool!, (sql, run) => { loserSql.push(sql); return run(); });
  let lost!: Promise<LegacyAdmissionWriteReceipt>;
  try {
    assert.equal(await paused(t, f, winner, "commit", async pid => {
      lost = f.peer.writeLegacyAdmission(loser, {});
      await until(probe, WAITERS, [pid, 1], "the loser's insert waits on the winner's natural key");
    }), "pending:true");
    const receipt = await lost, rows = (await facts(f, race.roomId, "racer")).rows;
    assert.deepEqual([summary(receipt), rows.length, receipt.kind === "pending" && rows[0]!.startsWith(`${receipt.accessRequestId}|pending|`)],
      ["pending:false", 1, true]);
    assert.ok(loserSql.some(sql => sql.startsWith("insert into room_waiting_requests")), "the loser reached its insert, then re-decided");
  } finally { loserSpy.restore(); await lost?.catch(() => undefined); }

  // The lease lapses during the actual statement, at its exact instant: the post-SQL check rolls back.
  const lapses = [["primary MAC", "host", MAC_EXP, "expired:bearer"], ["primary invite", "pending", NOW + HOUR, "expired:invite"],
    ["presented MAC", "presented", NOW + 30_000, "expired:bearer"]] as const;
  for (const [name, kind, lapse, expected] of lapses) {
    const { room, invite } = await seed(f), who = `lapse-${kind}`;
    const input = kind === "host" ? await planned(f, room, who, null, mac(room, who))
      : await planned(f, room, who, invite.tokenHash, kind === "presented" ? mac(room, who, "member", NOW + 30_000) : null);
    const sql: string[] = [];
    const hook = await borrowed(t, f.pool!, async (text, run) => {
      sql.push(text);
      const result = await run();
      if (WRITE.test(text)) f.clock.now = lapse;
      return result;
    });
    try { assert.equal(await write(f.s, input), expected, name); } finally { hook.restore(); f.clock.now = NOW; }
    assert.deepEqual([sql.some(text => WRITE.test(text)), sql.at(-1)], [true, "rollback"], `${name}: the statement ran, then rolled back`);
    assert.deepEqual(await facts(f, room.roomId, who), { host: null, rows: [] }, name);
  }
  // The gap after the effect resolves: a lapse scheduled behind its own post-SQL read is caught by the pre-COMMIT check.
  const { room: gap } = await seed(f), late = await planned(f, gap, "gap", null, mac(gap, "gap"));
  const sql: string[] = [], reads: number[] = [];
  const hook = await borrowed(t, f.pool!, async (text, run) => {
    sql.push(text);
    const result = await run();
    if (text.startsWith("update rooms")) f.clock.onRead = () => {
      reads.push(f.clock.now); f.clock.onRead = undefined;
      queueMicrotask(() => { f.clock.now = MAC_EXP; });
    };
    return result;
  });
  try { assert.equal(await write(f.s, late), "expired:bearer"); } finally { hook.restore(); f.clock.onRead = undefined; f.clock.now = NOW; }
  assert.deepEqual([reads, sql.includes("commit"), sql.at(-1)], [[NOW], false, "rollback"], "the effect resolved live and COMMIT was never sent");
  assert.equal((await facts(f, gap.roomId, "gap")).host, null);
});

test("Postgres: a rejected COMMIT persists nothing; a lost acknowledgement leaves its row without a receipt, and the retry is current", {
  skip: PG_SKIP, timeout: 90_000
}, async t => {
  const f = await fixture(t, true), probe = f.probe!;
  // An owned deferred constraint rejects COMMIT itself with a real server error.
  await probe.query(`create function admission_commit_fault() returns trigger language plpgsql as $$ begin
    if to_jsonb(new)::text like '%reject-commit%' then raise exception 'admission_commit_rejected'; end if; return null; end $$`);
  try {
    for (const table of ["rooms", "room_waiting_requests"]) await probe.query(`create constraint trigger admission_commit_fault after insert or update
      on ${table} deferrable initially deferred for each row execute function admission_commit_fault()`);
    const { room, invite } = await seed(f);
    const claim = await planned(f, room, "reject-commit", null, mac(room, "reject-commit"));
    const pending = await planned(f, room, "reject-commit", invite.tokenHash);
    assert.deepEqual([await write(f.s, claim), await write(f.s, pending)], ["db:P0001", "db:P0001"]);
    assert.deepEqual(await facts(f, room.roomId, "reject-commit"), { host: null, rows: [] });
  } finally {
    for (const table of ["rooms", "room_waiting_requests"]) await probe.query(`drop trigger if exists admission_commit_fault on ${table}`);
    await probe.query("drop function if exists admission_commit_fault()");
  }
  const { room, invite } = await seed(f);
  const claim = await planned(f, room, "host-u", null, mac(room, "host-u")), pending = await planned(f, room, "guest-u", invite.tokenHash);
  const lose = async (input: LegacyAdmissionWriteInput) => {
    const hook = await borrowed(t, f.pool!, async (sql, run) => {
      const result = await run();
      // The server committed; only the acknowledgement is lost, as with a reset socket.
      if (sql === "commit") throw Object.assign(new Error("commit acknowledgement lost"), { code: "ECONNRESET" });
      return result;
    });
    try { return await write(f.s, input); } finally { hook.restore(); }
  };
  assert.deepEqual([await lose(claim), await lose(pending)], ["uncertain", "uncertain"]);
  const guest = await facts(f, room.roomId, "guest-u");
  assert.deepEqual([(await facts(f, room.roomId, "host-u")).host, guest.rows.length, f.pool!.totalCount], ["host-u", 1, 0],
    "both committed without a receipt; the suspect client was destroyed");
  assert.deepEqual([await write(f.s, claim), await write(f.s, pending)], ["host_ready", "pending:false"], "the same subject's retry is current");
  assert.deepEqual(await facts(f, room.roomId, "guest-u"), guest, "no duplicate and no reset row");
  // A revoke or a lapse after the uncertain COMMIT refuses the retry although the row exists.
  await f.s.revokeRoomInvite(room.roomId, invite.inviteId, iso(NOW), "admin");
  f.clock.now = MAC_EXP;
  assert.deepEqual([await write(f.s, claim), await write(f.s, pending)], ["expired:bearer", "refused:invite_revoked:-"]);
  f.clock.now = NOW;
  assert.deepEqual([(await facts(f, room.roomId, "host-u")).host, await facts(f, room.roomId, "guest-u")], ["host-u", guest]);
  // A known COMMIT is final: a floor raise right after it never retracts the receipt; the next write is refused.
  const last = (await seed(f)).room, raiser = new PostgresStorage(probe), cutover = await planned(f, last, "host-z", null, mac(last, "host-z"));
  const hook = await borrowed(t, f.pool!, async (sql, run) => {
    const result = await run();
    if (sql === "commit") await raiser.identityProtocol.raise(2);
    return result;
  });
  try { assert.equal(await write(f.s, cutover), "host_ready"); } finally { hook.restore(); }
  assert.deepEqual([(await facts(f, last.roomId, "host-z")).host, await write(f.s, cutover)], ["host-z", "409:identity_upgrade_required"]);
});

test("Postgres: a write queued behind init holds no policy lock, and mixed legacy writers never deadlock", { skip: PG_SKIP, timeout: 120_000 }, async t => {
  const f = await fixture(t, true), probe = f.probe!;
  const signature = `select minimum_protocol, media_namespace, (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=current_schema() and p.proname='vrata_identity_v2_room_boundary' and p.pronargs=0) as guard_hash
    from room_identity_protocol_policy where singleton=true`;
  const before = (await probe.query(signature)).rows[0];
  assert.equal(before.minimum_protocol, 1);
  const initPool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 1, options: f.options });
  t.after(() => initPool.end());
  for (const kind of ["host", "pending"] as const) {
    const { room, invite } = await seed(f), who = `init-${kind}`;
    const input = kind === "host" ? await planned(f, room, who, null, mac(room, who)) : await planned(f, room, who, invite.tokenHash);
    const reached = deferred(), proceed = deferred();
    let held = false;
    // Pause the real initializer at its policy ALTER batch, after its rooms ALTERs.
    const hook = await borrowed(t, initPool, async (sql, run) => {
      if (!held && /alter table room_identity_protocol_policy/.test(sql)) { held = true; reached.resolve(); await proceed.promise; }
      return run();
    });
    const initializing = ok(new PostgresStorage(initPool).init());
    let done: Promise<string> | undefined;
    try {
      const writerPid = await pidOf(f.pool!);
      assert.equal(await Promise.race([reached.promise.then(() => "paused"), initializing]), "paused");
      await until(probe, `select exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
        and mode='AccessExclusiveLock' and granted) as ok`, [hook.pid], "init holds rooms AccessExclusive before its policy ALTER");
      done = write(f.s, input);
      await until(probe, `select $2=any(pg_blocking_pids($1)) and exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
        and mode='RowShareLock' and not granted) and not exists(select 1 from pg_locks where pid=$1
        and relation='room_identity_protocol_policy'::regclass) as ok`, [writerPid, hook.pid], `the ${kind} write waits on rooms holding no policy lock`);
      proceed.resolve();
      assert.deepEqual([await initializing, await done], ["ok", kind === "host" ? "host_ready" : "pending:true"]);
    } finally { proceed.resolve(); await initializing; await done; hook.restore(); }
    assert.deepEqual((await probe.query(signature)).rows[0], before, "floor, namespace and guard hash survive reinit");
  }
  // Native release, both admission writes, fenced and admin child updates, rename, deletion, binding and the floor: no 40P01.
  const other = new PostgresStorage(probe, () => f.clock.now);
  const { room, invite } = await seed(f), bound = (await seed(f)).room, scope = { tenantId: room.tenantId, roomId: room.roomId };
  const row = await f.s.createWaitingRoomRequest({ roomId: room.roomId, inviteId: invite.inviteId, participantId: "mixer", displayName: "mixer" });
  const inputs: LegacyAdmissionWriteInput[][] = [];
  for (let round = 0; round < 6; round++) {
    inputs.push([await planned(f, room, `host-${round}`, null, mac(room, `host-${round}`)), await planned(f, room, `guest-${round}`, invite.tokenHash)]);
  }
  const deadlocks: number[] = [];
  for (let round = 0; round < 6; round++) {
    const status = round % 2 ? "approved" : "rejected", at = iso(NOW), [claim, pending] = inputs[round]!;
    const results = await Promise.allSettled([
      other.releaseLegacyRoomCredential({ ...scope, participantId: "mixer", inviteTokenHash: invite.tokenHash }, {}, () => undefined),
      other.writeLegacyAdmission(claim!, {}), f.s.writeLegacyAdmission(pending!, {}),
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
