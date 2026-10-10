import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { MemoryStorage, PostgresStorage } from "../storage.js";
import type { LegacyRoomCredentialSelector, LegacyRoomCredentialSnapshot, RoomInviteRecord, RoomRecord, Storage,
  WaitingRoomRequestRecord } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { identityFenceUnavailable, RoomFenceCommitUncertain } from "./fence-transaction.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";

const PG_SKIP = !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI;
const notFound = (error: unknown) => error instanceof IdentityStorageError && error.code === "room_not_found";
const upgrade = (error: unknown) => error instanceof IdentityBoundaryError && error.status === 409 && error.reason === "identity_upgrade_required";
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
/** Backends transitively queued behind $1, read from the server's own wait graph rather than a timer. */
const WAITERS = `with recursive w(pid) as (select a.pid from pg_stat_activity a where $1=any(pg_blocking_pids(a.pid))
  union select a.pid from pg_stat_activity a join w on w.pid=any(pg_blocking_pids(a.pid))) select count(*)>=$2 as ok from w`;

interface Fixture {
  storage: Storage; pool?: Pool; probe?: Pool;
  room: RoomRecord; personal: RoomRecord; foreign: RoomRecord; inviteId: string; requestId: string;
}

async function fixture(t: TestContext, postgres: boolean): Promise<Fixture> {
  let pool: Pool | undefined, probe: Pool | undefined;
  if (postgres) {
    const connectionString = process.env.VRATA_TEST_POSTGRES_URL;
    assert.ok(connectionString, "CI must supply VRATA_TEST_POSTGRES_URL");
    const schema = `legacy_release_${randomUUID().replaceAll("-", "")}`, options = `-c search_path=${schema},public`;
    const root = new Pool({ connectionString });
    await root.query(`create schema "${schema}"`);
    // max 1: a second borrow inside a release times out rather than silently passing.
    const main = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3000, options });
    const observer = new Pool({ connectionString, max: 8, options });
    t.after(async () => { await main.end(); await observer.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
    pool = main; probe = observer;
  }
  const storage: Storage = pool ? new PostgresStorage(pool) : new MemoryStorage();
  if (storage instanceof PostgresStorage) await storage.init();
  const create = (name: string, extra: Partial<RoomRecord>) => storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name, ...extra });
  const room = await create("Release", { visibility: "public" }), foreign = await create("Foreign", { visibility: "public" });
  const personal = await create("Personal", { roomType: "personal", ownerParticipantId: "owner", sessionControl: { hostParticipantId: "owner" } });
  const invite = (roomId: string) => storage.createRoomInvite({ roomId, tokenHash: `hash-${roomId}`, role: "member", protocolVersion: 1,
    waitingRoomEnabled: true, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const { inviteId } = await invite(room.roomId);
  await invite(foreign.roomId);
  const request = await storage.createWaitingRoomRequest({ roomId: room.roomId, inviteId, participantId: "guest", displayName: "Guest" });
  await storage.createWaitingRoomRequest({ roomId: room.roomId, inviteId, participantId: "other-guest", displayName: "Other" });
  return { storage, pool, probe, room, personal, foreign, inviteId, requestId: request.requestId };
}

const sel = (f: Fixture, over: Partial<LegacyRoomCredentialSelector> = {}) => ({ tenantId: f.room.tenantId, roomId: f.room.roomId,
  participantId: "guest", inviteTokenHash: `hash-${f.room.roomId}` as string | null, ...over });

function start(storage: Storage, selector: LegacyRoomCredentialSelector, options: { lockTimeoutMs?: number } = {}) {
  const sent: LegacyRoomCredentialSnapshot[] = [];
  const done = storage.releaseLegacyRoomCredential(selector, options, fresh => { sent.push(fresh); return undefined; })
    .then(() => null, (error: unknown) => error);
  return { sent, done };
}
async function ok(storage: Storage, selector: LegacyRoomCredentialSelector) {
  const run = start(storage, selector);
  assert.ok(await run.done === null, "release succeeds");
  assert.equal(run.sent.length, 1, "send runs exactly once");
  return run.sent[0]!;
}
async function refused(storage: Storage, selector: LegacyRoomCredentialSelector, expected: (error: unknown) => boolean,
  label: string, options: { lockTimeoutMs?: number } = {}) {
  const run = start(storage, selector, options);
  assert.ok(expected(await run.done), label);
  assert.equal(run.sent.length, 0, `${label}: nothing is sent`);
}
async function until(probe: Pool, sql: string, params: unknown[], label: string) {
  const deadline = Date.now() + 5000;
  while (!(await probe.query(sql, params)).rows[0].ok) {
    if (Date.now() > deadline) assert.fail(label);
    await delay(10);
  }
}
async function pidOf(pool: Pool) {
  const client = await pool.connect();
  try { return (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number; } finally { client.release(); }
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

/** Pauses a real release after its send and before COMMIT; `during` runs while every lock it took is held. */
async function heldRelease(t: TestContext, f: Fixture, selector: LegacyRoomCredentialSelector, during: (pid: number) => Promise<void>) {
  const reached = deferred(), gate = deferred();
  let armed = true;
  const hook = await borrowed(t, f.pool!, async (sql, run) => {
    if (armed && sql === "commit") { armed = false; reached.resolve(); await gate.promise; }
    return run();
  });
  const run = start(f.storage, selector);
  try {
    assert.equal(await Promise.race([reached.promise.then(() => "paused"), run.done.then(() => "settled")]), "paused", "release reaches COMMIT");
    assert.equal(run.sent.length, 1, "send ran once, inside the transaction, before COMMIT");
    await during(hook.pid);
  } finally { gate.resolve(); await run.done; hook.restore(); }
  assert.ok(await run.done === null, "the read-only COMMIT succeeds");
  assert.equal(run.sent.length, 1);
  return run.sent[0]!;
}

for (const postgres of [false, true]) test(`${postgres ? "Postgres" : "Memory"}: legacy credential snapshot and release contract`, {
  skip: postgres && PG_SKIP, timeout: 60_000
}, async t => {
  const f = await fixture(t, postgres), s = f.storage;
  // One borrowed client, read-only statements, then exactly one send of fresh rows.
  const statements: string[] = [];
  const spy = f.pool && await borrowed(t, f.pool, (sql, run) => { statements.push(sql); return run(); });
  const connects = f.pool && t.mock.method(f.pool, "connect");
  const first = start(s, sel(f));
  if (!postgres) assert.equal(first.sent.length, 1, "Memory checks and sends within the caller's synchronous turn");
  try { assert.ok(await first.done === null, "release succeeds"); } finally { spy?.restore(); connects?.mock.restore(); }
  assert.equal(first.sent.length, 1);
  if (connects) {
    assert.equal(connects.mock.callCount(), 1, "the release borrows one client and never recurses into the pool");
    assert.deepEqual(statements.filter(sql => /^(insert|update|delete|merge|truncate)\b|\bfor (no key )?update\b/.test(sql)), [],
      "no writer statement or exclusive row lock");
    assert.equal(statements.at(-1), "commit");
  }
  const fresh = first.sent[0]!;
  assert.deepEqual(fresh.room, await s.getRoom(f.room.roomId), "full room mapping with its template version");
  assert.deepEqual(fresh.invite, await s.getRoomInvite(f.inviteId));
  assert.deepEqual(fresh.waiting, await s.getWaitingRoomRequest(f.requestId));
  const owner = await ok(s, sel(f, { roomId: f.personal.roomId, participantId: "owner", inviteTokenHash: null }));
  assert.deepEqual([owner.room.roomType, owner.room.ownerParticipantId, owner.invite, owner.waiting], ["personal", "owner", null, null]);
  const visitor = await ok(s, sel(f, { participantId: "visitor", inviteTokenHash: null }));
  assert.deepEqual([visitor.room.visibility, visitor.invite, visitor.waiting], ["public", null, null]);
  // Invite matches (room, hash); waiting matches (room, fresh invite, participant); anything else is null.
  const layout = async (over: Partial<LegacyRoomCredentialSelector>) => {
    const snapshot = await ok(s, sel(f, over));
    return [snapshot.invite?.inviteId ?? null, snapshot.waiting?.requestId ?? null];
  };
  assert.deepEqual(await layout({ inviteTokenHash: "unknown-hash" }), [null, null], "false hash");
  assert.deepEqual(await layout({ inviteTokenHash: `hash-${f.foreign.roomId}` }), [null, null], "another room's invite");
  assert.deepEqual(await layout({ participantId: "stranger" }), [f.inviteId, null], "another participant's request is never returned");
  // The snapshot is a deep copy; mutating it never reaches storage.
  const pristine = await ok(s, sel(f)), taken = await ok(s, sel(f));
  (taken.room as RoomRecord).ownerParticipantId = "intruder";
  (taken.room as RoomRecord).sessionControl!.hostParticipantId = "intruder";
  (taken.invite as RoomInviteRecord).revokedAt = new Date(0).toISOString();
  (taken.waiting as WaitingRoomRequestRecord).status = "approved";
  assert.deepEqual(await ok(s, sel(f)), pristine, "owner, host, revoke and decision are unchanged in storage");
  // A refusal sends nothing, a missing scope is never a virtual fallback, a send failure is returned unchanged.
  const unknownScopes: Partial<LegacyRoomCredentialSelector>[] = [{ tenantId: "" }, { tenantId: "other-tenant" }, { roomId: "missing-room" }, { roomId: "" }];
  for (const over of unknownScopes) await refused(s, sel(f, over), notFound, "unknown scope is room_not_found");
  const failure = new Error("send_failed");
  let attempts = 0;
  await assert.rejects(s.releaseLegacyRoomCredential(sel(f), {}, () => { attempts++; throw failure; }), (error: unknown) => error === failure);
  assert.equal(attempts, 1);
  await s.roomIdentities.create({ tenantId: f.foreign.tenantId, roomId: f.foreign.roomId, displayName: "Bound", baseRole: "guest", provenance: { kind: "guest" } });
  await refused(s, sel(f, { roomId: f.foreign.roomId, inviteTokenHash: null }), upgrade, "a v2-bound room");
  // The floor only rises, so floor 2 is the last case.
  await s.identityProtocol.raise(2);
  await refused(s, sel(f), upgrade, "floor 2");
});

for (const postgres of [false, true]) test(`${postgres ? "Postgres" : "Memory"}: a saved tenant key of any length releases; a non-string tenant is room_not_found`, {
  skip: postgres && PG_SKIP, timeout: 60_000
}, async t => {
  const f = await fixture(t, postgres), s = f.storage;
  // The tenant API accepts any string; 201 characters exceeds the identifier cap that still bounds roomId.
  const tenantId = `saved-tenant-${"t".repeat(188)}`;
  assert.equal(tenantId.length, 201);
  await s.createTenant({ tenantId, name: "Long tenant" });
  const room = await s.createRoom({ tenantId, templateId: "meeting-room-basic", name: "Long tenant", visibility: "public" });
  const { inviteId } = await s.createRoomInvite({ roomId: room.roomId, tokenHash: `hash-${room.roomId}`, role: "member", protocolVersion: 1,
    waitingRoomEnabled: true, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const request = await s.createWaitingRoomRequest({ roomId: room.roomId, inviteId, participantId: "guest", displayName: "Guest" });
  const selector = { tenantId, roomId: room.roomId, participantId: "guest", inviteTokenHash: `hash-${room.roomId}` as string | null };
  const fresh = await ok(s, selector);
  assert.deepEqual([fresh.room, fresh.invite, fresh.waiting], [await s.getRoom(room.roomId), await s.getRoomInvite(inviteId),
    await s.getWaitingRoomRequest(request.requestId)], "the stored long-tenant rows");
  assert.equal(fresh.room.tenantId, tenantId);
  // Exact stored equality still bounds the scope.
  for (const other of [tenantId.slice(0, 200), `${tenantId}t`, f.room.tenantId]) {
    await refused(s, { ...selector, tenantId: other }, notFound, "a near or foreign tenant is room_not_found");
  }
  await refused(s, sel(f, { tenantId }), notFound, "another tenant's room under the long tenant");
  const silent = (error: unknown) => notFound(error) && (error as Error).message === "room_not_found";
  for (const bad of [undefined, null, 201, [tenantId], { toString: () => tenantId }]) {
    await refused(s, { ...selector, tenantId: bad as unknown as string }, silent, "a non-string tenant is room_not_found and echoes nothing");
  }
  await refused(s, { ...selector, roomId: "r".repeat(201) }, notFound, "roomId keeps its identifier bound");
});

test("Postgres: room/invite/waiting writers and release lock ordering", { skip: PG_SKIP, timeout: 90_000 }, async t => {
  const f = await fixture(t, true), other = new PostgresStorage(f.probe!), scope = { tenantId: f.room.tenantId, roomId: f.room.roomId };
  const writes: Array<Promise<{ value: unknown } | { error: unknown }>> = [];
  const held = await heldRelease(t, f, sel(f), async pid => {
    writes.push(settle(other.updateRoom(scope.roomId, { name: "Renamed" })),
      settle(other.revokeRoomInvite(scope.roomId, f.inviteId, new Date().toISOString(), "admin")),
      settle(other.updateWaitingRoomRequest(scope.roomId, f.requestId, { status: "rejected", decidedBy: "admin" })),
      settle(other.roomIdentities.create({ ...scope, displayName: "Bound", baseRole: "guest", provenance: { kind: "guest" } })));
    await until(f.probe!, WAITERS, [pid, 4], "room update, admin revoke, admin decision and v2 binding all wait on the release");
  });
  assert.deepEqual((await Promise.all(writes)).map(result => "value" in result), [true, true, true, true]);
  assert.deepEqual([held.room.name, held.invite?.revokedAt, held.waiting?.status], ["Release", null, "pending"], "the sent rows predate every queued writer");
  assert.deepEqual([(await other.getRoom(scope.roomId))?.name, Boolean((await other.getRoomInvite(f.inviteId))?.revokedAt),
    (await other.getWaitingRoomRequest(f.requestId))?.status], ["Renamed", true, "rejected"]);
  await refused(f.storage, sel(f), upgrade, "the room bound after the release");
  const personal = sel(f, { roomId: f.personal.roomId, participantId: "owner", inviteTokenHash: null });
  let deletion!: Promise<{ value: boolean } | { error: unknown }>;
  await heldRelease(t, f, personal, async pid => {
    deletion = settle(other.deleteRoom(f.personal.roomId));
    await until(f.probe!, WAITERS, [pid, 1], "room deletion waits on the release");
  });
  assert.deepEqual(await deletion, { value: true });
  await refused(f.storage, personal, notFound, "a deleted room is room_not_found, not a virtual fallback");

  const g = await fixture(t, true), releasePid = await pidOf(g.pool!);
  const uncommitted = [
    ["room_invites", "update room_invites set revoked_at=now(), revoked_by='admin' where invite_id=$1", g.inviteId,
      (snap: LegacyRoomCredentialSnapshot) => Boolean(snap.invite?.revokedAt)],
    ["room_waiting_requests", "update room_waiting_requests set status='rejected', decided_at=now(), decided_by='admin' where request_id=$1", g.requestId,
      (snap: LegacyRoomCredentialSnapshot) => snap.waiting?.status === "rejected"],
    ["rooms", `update rooms set status='disabled', disabled_at=now(), disabled_by='admin', session_control=session_control || jsonb_build_object(
      'endedAt', now()::text, 'removedParticipants', jsonb_build_object('guest', jsonb_build_object('removedAt', now()::text))) where room_id=$1`, g.room.roomId,
      (snap: LegacyRoomCredentialSnapshot) => snap.room.status === "disabled" && Boolean(snap.room.sessionControl?.endedAt)
        && Boolean(snap.room.sessionControl?.removedParticipants?.guest)]
  ] as const;
  for (const [table, sql, id, committed] of uncommitted) {
    const holder = await g.probe!.connect(), selector = sel(g), options = { lockTimeoutMs: 5000 };
    let run: ReturnType<typeof start> | undefined;
    try {
      const holderPid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      await holder.query("begin");
      await holder.query(sql, [id]);
      run = start(g.storage, selector, options);
      await until(g.probe!, `select $2=any(pg_blocking_pids($1)) and exists(select 1 from pg_locks where pid=$1 and locktype='tuple'
        and relation=$3::text::regclass and granted) as ok`, [releasePid, holderPid, table], `release waits on the uncommitted ${table} row`);
      // Scope, hash, participant and timeout were captured as primitives before the wait.
      Object.assign(selector, { roomId: g.foreign.roomId, participantId: "other-guest", inviteTokenHash: `hash-${g.foreign.roomId}` });
      options.lockTimeoutMs = 1;
      assert.equal(run.sent.length, 0);
      await holder.query("commit");
      assert.ok(await run.done === null, `release completes after the ${table} commit`);
      assert.equal(run.sent.length, 1);
      const snap = run.sent[0]!;
      assert.deepEqual([snap.room.roomId, snap.invite?.inviteId, snap.waiting?.participantId], [g.room.roomId, g.inviteId, "guest"]);
      assert.equal(committed(snap), true, `the sent ${table} row is the committed one`);
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); if (run) await run.done; }
  }
  for (const [table, sql, id] of [["rooms", "select 1 from rooms where room_id=$1 for update", g.room.roomId],
    ["room_waiting_requests", "select 1 from room_waiting_requests where request_id=$1 for update", g.requestId]] as const) {
    const holder = await g.probe!.connect();
    try {
      await holder.query("begin");
      await holder.query(sql, [id]);
      await refused(g.storage, sel(g), identityFenceUnavailable, `${table} lock timeout is retryable unavailability`, { lockTimeoutMs: 50 });
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); }
  }
});

test("Postgres: concurrent init lock ordering", { skip: PG_SKIP, timeout: 60_000 }, async t => {
  const f = await fixture(t, true), probe = f.probe!;
  const signature = `select minimum_protocol, media_namespace, (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname=current_schema() and p.proname='vrata_identity_v2_room_boundary' and p.pronargs=0) as guard_hash
    from room_identity_protocol_policy where singleton=true`;
  const before = (await probe.query(signature)).rows[0];
  assert.deepEqual([before.minimum_protocol, before.media_namespace], [1, null]);
  assert.match(before.guard_hash, /^[a-f0-9]{32}$/);
  const initPool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 1, options: f.pool!.options.options });
  const reached = deferred(), proceed = deferred();
  let paused = false;
  // Pause the real initializer at its policy ALTER batch, after its rooms ALTERs; pg_locks verifies the held lock.
  const hook = await borrowed(t, initPool, async (sql, run) => {
    if (!paused && /alter table room_identity_protocol_policy/.test(sql)) { paused = true; reached.resolve(); await proceed.promise; }
    return run();
  });
  const initializing = settle(new PostgresStorage(initPool).init());
  let run: ReturnType<typeof start> | undefined;
  try {
    const releasePid = await pidOf(f.pool!);
    assert.equal(await Promise.race([reached.promise.then(() => "paused"), initializing.then(() => "settled")]), "paused");
    await until(probe, `select exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
      and mode='AccessExclusiveLock' and granted) as ok`, [hook.pid], "init holds rooms AccessExclusive before its policy ALTER");
    run = start(f.storage, sel(f));
    await until(probe, `select $2=any(pg_blocking_pids($1)) and exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
      and mode='RowShareLock' and not granted) and not exists(select 1 from pg_locks where pid=$1
      and relation='room_identity_protocol_policy'::regclass) as ok`, [releasePid, hook.pid], "release waits on rooms holding no policy lock");
    assert.equal(run.sent.length, 0);
    proceed.resolve();
    assert.ok("value" in await initializing, "concurrent init completes");
    assert.ok(await run.done === null, "the queued release completes");
    assert.equal(run.sent.length, 1);
    assert.deepEqual((await probe.query(signature)).rows[0], before, "floor, namespace and guard hash survive reinit");
  } finally { proceed.resolve(); await initializing; if (run) await run.done; hook.restore(); await initPool.end(); }
});

test("Postgres: completion failure and protocol cutover", { skip: PG_SKIP, timeout: 90_000 }, async t => {
  const f = await fixture(t, true), other = new PostgresStorage(f.probe!), scope = { tenantId: f.room.tenantId, roomId: f.room.roomId };
  for (let round = 0; round < 6; round++) {
    const status = round % 2 ? "approved" : "rejected", at = new Date().toISOString();
    const results = await Promise.all([
      settle(other.releaseLegacyRoomCredential(sel(f), {}, () => undefined)),
      settle(other.withLegacyRoomEffect(scope, { roomWrite: true }, async scoped => {
        await scoped.updateWaitingRoomRequest(scope.roomId, f.requestId, { status, decidedBy: "host" });
        await scoped.revokeRoomInvite(scope.roomId, f.inviteId, at, "host");
      })),
      settle(other.revokeRoomInvite(scope.roomId, f.inviteId, at, "admin")),
      settle(other.updateWaitingRoomRequest(scope.roomId, f.requestId, { status, decidedBy: "admin" }))
    ]);
    assert.deepEqual(results.map(result => "error" in result ? String((result.error as { code?: unknown }).code ?? "failed") : "ok"),
      ["ok", "ok", "ok", "ok"], "parent, policy, invite, waiting order never forms a cycle (no 40P01)");
  }
  const rows = async () => [await other.getRoom(scope.roomId), await other.listRoomInvites(scope.roomId), await other.listWaitingRoomRequests(scope.roomId)];
  const before = await rows();
  const hook = await borrowed(t, f.pool!, async (sql, run) => {
    const result = await run();
    // The server committed; only the acknowledgement is lost, as with a reset socket.
    if (sql === "commit") throw Object.assign(new Error("commit acknowledgement lost"), { code: "ECONNRESET" });
    return result;
  });
  let lost!: ReturnType<typeof start>;
  try { lost = start(f.storage, sel(f)); await lost.done; } finally { hook.restore(); }
  assert.ok(await lost.done instanceof RoomFenceCommitUncertain, "an unacknowledged read-only COMMIT is left to the API layer");
  assert.equal(lost.sent.length, 1, "send ran exactly once before the lost acknowledgement");
  assert.deepEqual([f.pool!.totalCount, f.pool!.waitingCount], [0, 0], "the suspect client is destroyed, not returned to the pool");
  assert.equal((await f.probe!.query(`select count(*)::int as n from pg_locks where pid<>pg_backend_pid() and relation in
    ('rooms'::regclass, 'room_identity_protocol_policy'::regclass, 'room_invites'::regclass, 'room_waiting_requests'::regclass)`)).rows[0].n, 0,
  "no lock outlives the transaction");
  assert.deepEqual(await rows(), before, "a read-only release changed no row");
  await ok(f.storage, sel(f));
  // The floor only rises, so cutover is the last case.
  let raised!: Promise<{ value: number } | { error: unknown }>;
  const pinned = await heldRelease(t, f, sel(f), async pid => {
    raised = settle(other.identityProtocol.raise(2));
    await until(f.probe!, WAITERS, [pid, 1], "the floor raise queues behind the pending release");
  });
  assert.equal(pinned.room.roomId, scope.roomId);
  assert.deepEqual(await raised, { value: 2 });
  await refused(f.storage, sel(f), upgrade, "the next legacy release after cutover");
});
