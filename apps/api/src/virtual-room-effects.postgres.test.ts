import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseError, Pool, type PoolClient } from "pg";
import { PostgresStorage, type RuntimeDiagnosticRecord } from "./storage.js";
import type { VirtualRoomEffectOptions, VirtualRoomEffectStorage } from "./storage-contracts.js";
import { IdentityBoundaryError } from "./identity/legacy-boundary.js";
import { uncertainRoomCommit } from "./identity/fence-transaction.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const EXPIRES = NOW / 1000 + 60;
const KNOWN = new Set(["callback_failed", "room_effect_room_mismatch", "room_effect_scope_closed", "room_effect_response_released",
  "room_write_fence_required", "virtual_room_release_requires_read_fence"]);
const write = (): VirtualRoomEffectOptions => ({ roomWrite: true, expiresAtSeconds: EXPIRES, lockTimeoutMs: 20_000 });
const read = (): VirtualRoomEffectOptions => ({ expiresAtSeconds: EXPIRES, lockTimeoutMs: 20_000 });
const diagnostic = (value: string) => ({ participantId: value }) as unknown as RuntimeDiagnosticRecord;

// Assertion output carries only allow-listed reasons and SQLSTATEs, never raw driver errors.
function label(error: unknown): string {
  if (error instanceof assert.AssertionError) throw error;
  if (error instanceof IdentityBoundaryError) return `${error.status}:${error.reason}`;
  if (uncertainRoomCommit(error)) {
    const cause = (error as Error).cause;
    return cause instanceof Error && cause.message === "lost_ack" ? "uncertain:lost_ack" : "uncertain";
  }
  if (error instanceof DatabaseError) return `db:${error.code}`;
  return error instanceof Error && KNOWN.has(error.message) ? error.message : "unexpected_error";
}
const outcome = (pending: Promise<unknown>) => pending.then(() => "ok", label);
function attempt(operation: () => unknown): string {
  try { operation(); return "ok"; } catch (error) { return label(error); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(what: string, probe: () => boolean | Promise<boolean>): Promise<void> {
  const stop = Date.now() + 15_000;
  while (!(await probe())) { if (Date.now() > stop) throw new Error(`wait_timeout:${what}`); await delay(10); }
}

test("PostgreSQL virtual room effects fence actual rooms, the floor and telemetry on one borrowed client", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `vfx_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 1 });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  // Only the owned schema is on the path: init, the fault trigger and the v2 floor never reach public.
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const pools: Pool[] = [];
  const open = (name: string, max: number) => {
    const opened = new Pool({ connectionString: connection.href, max, application_name: `${schema}_${name}` });
    pools.push(opened);
    return opened;
  };
  let created = false;
  t.after(async () => {
    await Promise.allSettled(pools.map(item => item.end()));
    if (created) await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  await admin.query(`create schema "${schema}"`); created = true;
  const pool = open("m", 8);
  const storage = new PostgresStorage(pool);
  await storage.init();
  assert.equal((await pool.query("select current_schema() as schema")).rows[0].schema, schema);

  const clock = { now: NOW };
  // max 1: the fence and every staged write must share the one borrowed client.
  const virtualPool = open("v", 1);
  const virtual = new PostgresStorage(virtualPool, () => clock.now);
  const other = new PostgresStorage(open("a", 1), () => NOW);
  const creating = new PostgresStorage(open("c", 3));
  let entered = 0;
  const run = <T>(roomId: string, options: VirtualRoomEffectOptions, effect: (scoped: VirtualRoomEffectStorage) => Promise<T>, on = virtual) =>
    on.withLegacyVirtualRoomEffect(roomId, options, scoped => { entered += 1; return effect(scoped); });
  const both = async (scoped: VirtualRoomEffectStorage, roomId: string, value: string) => {
    await scoped.addDiagnostic(roomId, diagnostic(value));
    await scoped.addXrTelemetry(roomId, "virtual-participant", { label: value });
  };
  const counts = async (roomId: string) => (await pool.query(`select
    (select count(*)::integer from runtime_diagnostics where room_id=$1) as diagnostics,
    (select count(*)::integer from xr_telemetry where room_id=$1) as xr`, [roomId])).rows[0];
  const backend = async (client: PoolClient) => (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  const pidOf = async (name: string) => (await pool.query("select pid from pg_stat_activity where application_name=$1",
    [`${schema}_${name}`])).rows[0].pid as number;
  const waitingOn = async (blocker: number, name: string) => (await pool.query(`select count(*)::integer as n from pg_stat_activity
    where application_name=$2 and $1=any(pg_blocking_pids(pid))`, [blocker, `${schema}_${name}`])).rows[0].n as number;
  async function holdWriter(roomId: string, value: string) {
    const reached = deferred(), gate = deferred();
    const done = outcome(run(roomId, write(), async scoped => { await both(scoped, roomId, value); reached.resolve(); await gate.promise; }, other));
    await Promise.race([reached.promise, done]);
    return { pid: await pidOf("a"), done, release: gate.resolve };
  }

  for (const expiresAtSeconds of [null, String(EXPIRES), EXPIRES + 0.5, Number.MAX_SAFE_INTEGER, NOW / 1000]) {
    const options = { roomWrite: true, expiresAtSeconds } as unknown as VirtualRoomEffectOptions;
    assert.equal(await outcome(run(randomUUID(), options, async () => undefined)), "401:identity_session_expired");
  }
  assert.deepEqual([entered, virtualPool.totalCount], [0, 0], "malformed or elapsed deadlines fail closed before borrowing a client");

  const room = randomUUID();
  assert.equal(await outcome(run(room, write(), scoped => both(scoped, room, "once"))), "ok");
  assert.deepEqual(await counts(room), { diagnostics: 1, xr: 1 });
  assert.equal(await storage.getRoom(room), null, "a virtual effect never materializes an actual room");
  assert.equal(await outcome(run(room, write(), async scoped => { await both(scoped, room, "thrown"); throw new Error("callback_failed"); })),
    "callback_failed");
  assert.equal(await outcome(run(room, write(), async scoped => { await both(scoped, room, "expired"); clock.now = EXPIRES * 1000; })),
    "401:identity_session_expired");
  clock.now = NOW;
  assert.deepEqual(await counts(room), { diagnostics: 1, xr: 1 }, "a throw or in-callback expiry rolls back inserts and retention");
  let sent = 0;
  assert.equal(await outcome(run(room, read(), async scoped => {
    scoped.releaseResponse(() => { sent += 1; }); await delay(0); clock.now = EXPIRES * 1000;
  })), "ok");
  clock.now = NOW;
  assert.equal(await outcome(run(room, read(), async () => { await delay(0); clock.now = EXPIRES * 1000; })), "401:identity_session_expired");
  clock.now = NOW;
  assert.equal(sent, 1, "a timely terminal release is not denied after a later await and clock advance");

  const taken = randomUUID();
  await storage.createTenant({ tenantId: "other-tenant", name: "Other" });
  await storage.createRoom({ roomId: taken, tenantId: "other-tenant", templateId: "meeting-room-basic", name: "Other tenant room" });
  const beforeTaken = entered;
  for (const options of [write(), read()]) assert.equal(await outcome(run(taken, options, async () => undefined)), "409:room_state_changed");
  assert.equal(entered, beforeTaken);

  const facade = randomUUID();
  let escaped!: VirtualRoomEffectStorage;
  const widened = read(), mutated = deferred();
  const shape = run(facade, widened, async scoped => {
    escaped = scoped;
    await mutated.promise;
    return [Object.keys(scoped).sort().join(), Object.isFrozen(scoped), attempt(() => scoped.addDiagnostic(facade, diagnostic("widened"))),
      attempt(() => scoped.releaseResponse(() => undefined)), attempt(() => scoped.releaseResponse(() => undefined))];
  }).catch(label);
  widened.roomWrite = true; mutated.resolve();
  assert.deepEqual(await shape, ["addDiagnostic,addXrTelemetry,releaseResponse", true, "room_write_fence_required", "ok", "room_effect_response_released"]);
  assert.equal(attempt(() => escaped.releaseResponse(() => undefined)), "room_effect_scope_closed");
  assert.deepEqual(await run(facade, write(), async scoped => [attempt(() => scoped.addXrTelemetry(randomUUID(), "p", {})),
    attempt(() => scoped.releaseResponse(() => undefined))]).catch(label), ["room_effect_room_mismatch", "virtual_room_release_requires_read_fence"]);
  assert.deepEqual(await counts(facade), { diagnostics: 0, xr: 0 });

  // Each wait is real; the original deadline passes during it and caller mutation cannot extend it or change the mode.
  async function expiresWhileWaiting(options: VirtualRoomEffectOptions, queued: () => Promise<boolean>, release: () => unknown) {
    const before = entered;
    const pending = outcome(run(randomUUID(), options, async () => undefined));
    Object.assign(options, { roomWrite: !options.roomWrite, expiresAtSeconds: EXPIRES + 3600 });
    try { await until("virtual_wait", queued); clock.now = EXPIRES * 1000; }
    finally { await release(); }
    assert.equal(await pending, "401:identity_session_expired", "the original deadline is rechecked after the wait");
    assert.equal(entered, before);
    clock.now = NOW;
  }
  const borrowed = await virtualPool.connect();
  await expiresWhileWaiting(write(), async () => virtualPool.waitingCount === 1, () => borrowed.release());
  const holder = await pool.connect();
  try {
    const pid = await backend(holder);
    await holder.query("begin"); await holder.query("lock table rooms in row exclusive mode");
    await expiresWhileWaiting(write(), async () => await waitingOn(pid, "v") === 1, () => holder.query("commit"));
    await holder.query("begin"); await holder.query("select 1 from room_identity_protocol_policy where singleton=true for update");
    await expiresWhileWaiting(read(), async () => await waitingOn(pid, "v") === 1, () => holder.query("commit"));
  } finally { await holder.query("rollback").catch(() => undefined); holder.release(); }
  const contended = randomUUID();
  const holding = await holdWriter(contended, "holder");
  const expired = outcome(run(contended, write(), scoped => both(scoped, contended, "expired")));
  try { await until("telemetry_lock_wait", async () => await waitingOn(holding.pid, "v") === 1); clock.now = EXPIRES * 1000; }
  finally { holding.release(); }
  assert.deepEqual([await holding.done, await expired], ["ok", "401:identity_session_expired"]);
  clock.now = NOW;
  assert.deepEqual(await counts(contended), { diagnostics: 1, xr: 1 }, "only the holder commits; the waiter expired behind its telemetry lock");

  const fenced = randomUUID();
  const fenceReached = deferred(), fenceGate = deferred();
  const fence = outcome(run(fenced, write(), async scoped => { await both(scoped, fenced, "fenced"); fenceReached.resolve(); await fenceGate.promise; }));
  await Promise.race([fenceReached.promise, fence]);
  const sharePid = await pidOf("v");
  const actual = Promise.all([
    creating.createAdministrativeRoom({ roomId: fenced, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Admin" }),
    creating.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Ordinary" }),
    creating.createLegacyPersonalRoom({ roomId: randomUUID(), tenantId: "demo-tenant", ownerParticipantId: randomUUID(),
      templateId: "personal-workspace-basic", name: "Personal", roomType: "personal" })
  ]).then(() => "ok", label);
  try {
    await until("actual_creators_wait_on_virtual_share", async () => await waitingOn(sharePid, "c") === 3);
    assert.equal(await storage.getRoom(fenced), null);
  } finally { fenceGate.resolve(); }
  assert.deepEqual([await fence, await actual], ["ok", "ok"], "admin, ordinary and legacy creation proceed only after the virtual commit");
  assert.equal((await storage.getRoom(fenced))?.roomId, fenced);
  assert.deepEqual(await counts(fenced), { diagnostics: 1, xr: 1 });

  const reverse = randomUUID();
  const templateHolder = await pool.connect();
  let creation: Promise<string> | undefined, queuedVirtual: Promise<string> | undefined;
  try {
    const holderPid = await backend(templateHolder);
    await templateHolder.query("begin");
    await templateHolder.query("select 1 from templates where template_id='meeting-room-basic' for no key update");
    creation = creating.createAdministrativeRoom({ roomId: reverse, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Reverse" })
      .then(item => item.roomId, label);
    await until("actual_create_inside_insert", async () => await waitingOn(holderPid, "c") === 1);
    const creatorPid = (await pool.query("select pid from pg_stat_activity where application_name=$1 and $2=any(pg_blocking_pids(pid))",
      [`${schema}_c`, holderPid])).rows[0].pid as number;
    const before = entered;
    queuedVirtual = outcome(run(reverse, write(), async () => undefined));
    await until("virtual_waits_on_actual_create", async () => await waitingOn(creatorPid, "v") === 1);
    await templateHolder.query("commit");
    assert.deepEqual([await creation, await queuedVirtual], [reverse, "409:room_state_changed"]);
    assert.equal(entered, before);
  } finally {
    await templateHolder.query("rollback").catch(() => undefined); templateHolder.release();
    await Promise.allSettled([creation, queuedVirtual]);
  }

  const exclusive = await pool.connect();
  try {
    await exclusive.query("begin"); await exclusive.query("lock table rooms in exclusive mode");
    let polled = 0;
    assert.equal(await outcome(run(randomUUID(), { ...read(), lockTimeoutMs: 2000 }, async scoped => { scoped.releaseResponse(() => { polled += 1; }); })),
      "ok");
    assert.equal(polled, 1, "read polling takes only ACCESS SHARE on rooms, which EXCLUSIVE admits");
    assert.equal(await outcome(run(randomUUID(), { ...write(), lockTimeoutMs: 50 }, async () => undefined)), "db:55P03",
      "write mode really requests table SHARE");
  } finally { await exclusive.query("rollback").catch(() => undefined); exclusive.release(); }

  const busy = randomUUID();
  await pool.query(`insert into runtime_diagnostics (room_id,payload)
    select $1,jsonb_build_object('participantId','seed-'||n) from generate_series(1,200) n`, [busy]);
  await pool.query(`insert into xr_telemetry (room_id,participant_id,payload)
    select $1,'seed',jsonb_build_object('label','seed-'||n) from generate_series(1,1000) n`, [busy]);
  const retained = async () => (await pool.query(`select
    (select json_agg(payload->>'participantId' order by id) from runtime_diagnostics where room_id=$1) as diagnostics,
    (select json_agg(payload->>'label' order by id) from xr_telemetry where room_id=$1) as xr`, [busy])).rows[0] as { diagnostics: string[]; xr: string[] };
  const first = await holdWriter(busy, "first");
  const second = outcome(run(busy, write(), scoped => both(scoped, busy, "second")));
  try {
    await until("second_writer_serialized", async () => await waitingOn(first.pid, "v") === 1);
    const seeded = await retained();
    assert.deepEqual([seeded.diagnostics.length, seeded.xr.length, seeded.diagnostics.at(-1), seeded.xr.at(-1)], [200, 1000, "seed-200", "seed-1000"]);
  } finally { first.release(); }
  assert.deepEqual([await first.done, await second], ["ok", "ok"]);
  const { diagnostics, xr } = await retained();
  assert.deepEqual([diagnostics.length, diagnostics[0], ...diagnostics.slice(-2)], [200, "seed-3", "first", "second"]);
  assert.deepEqual([xr.length, xr[0], ...xr.slice(-2)], [1000, "seed-3", "first", "second"], "serialized retention evicts one distinct row per write");

  const ledger = randomUUID();
  await pool.query(`create function virtual_commit_fault() returns trigger language plpgsql as $$ begin
    if new.payload->>'participantId'='reject-commit' then raise exception 'virtual_commit_rejected'; end if; return null; end $$`);
  await pool.query(`create constraint trigger virtual_commit_fault after insert on runtime_diagnostics
    deferrable initially deferred for each row execute function virtual_commit_fault()`);
  assert.equal(await outcome(run(ledger, write(), scoped => both(scoped, ledger, "reject-commit"))), "db:P0001");
  assert.deepEqual(await counts(ledger), { diagnostics: 0, xr: 0 }, "a server-rejected COMMIT rolls back both inserts");
  // max 1 means the fence borrows this same idle client; only its real COMMIT acknowledgement is dropped.
  const client = await virtualPool.connect();
  client.release();
  const query = client.query;
  let armed = true;
  client.query = function (this: PoolClient, ...args: unknown[]) {
    const reply: unknown = Reflect.apply(query, this, args);
    if (!armed || args[0] !== "commit") return reply;
    armed = false;
    return Promise.resolve(reply).then(() => { throw new Error("lost_ack"); });
  } as unknown as PoolClient["query"];
  let lost: string;
  try { lost = await outcome(run(ledger, write(), scoped => both(scoped, ledger, "lost-ack"))); }
  finally { client.query = query; }
  assert.deepEqual([armed, lost], [false, "uncertain:lost_ack"], "a lost COMMIT ACK is uncertain, never a semantic denial");
  assert.deepEqual(await counts(ledger), { diagnostics: 1, xr: 1 }, "the committed rows survive the lost acknowledgement");
  assert.equal(await outcome(run(ledger, write(), scoped => both(scoped, ledger, "after"))), "ok");
  assert.deepEqual(await counts(ledger), { diagnostics: 2, xr: 2 }, "the borrowed client and room stay usable");

  // A real init holds rooms ACCESS EXCLUSIVE before policy ALTER. Neither mode may
  // hold a policy lock while waiting for rooms, which would deadlock the initializer.
  const initPool = open("i", 1);
  const initClient = await initPool.connect();
  const initPid = await backend(initClient);
  assert.equal((await initClient.query("select current_schema() as schema")).rows[0].schema, schema);
  initClient.release();
  const initQuery = initClient.query;
  const signature = async () => (await pool.query(`select minimum_protocol,media_namespace,
    (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname=current_schema() and p.proname='vrata_identity_v2_room_boundary' and p.pronargs=0) as guard_hash
    from room_identity_protocol_policy where singleton=true`)).rows[0];
  const initial = await signature();
  assert.deepEqual([initial.minimum_protocol, initial.media_namespace], [1, null]);
  assert.match(initial.guard_hash, /^[a-f0-9]{32}$/);
  for (const [mode, options, roomLock] of [["read", read(), "AccessShareLock"], ["write", write(), "ShareLock"]] as const) {
    const target = randomUUID(), reachedPolicyAlter = deferred(), continueInit = deferred();
    let paused = false, released = 0;
    initClient.query = function (this: PoolClient, ...args: unknown[]) {
      if (paused || typeof args[0] !== "string" || !/alter table room_identity_protocol_policy/i.test(args[0])) {
        return Reflect.apply(initQuery, this, args);
      }
      paused = true; reachedPolicyAlter.resolve();
      return continueInit.promise.then(() => Reflect.apply(initQuery, this, args));
    } as unknown as PoolClient["query"];
    const initializing = new PostgresStorage(initPool).init().then(() => "ok", label);
    let request: Promise<string> | undefined;
    try {
      await Promise.race([reachedPolicyAlter.promise, initializing.then(result => {
        throw new Error(`initializer_did_not_reach_policy_alter:${result}`);
      })]);
      assert.equal((await pool.query(`select exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
        and mode='AccessExclusiveLock' and granted) as held`, [initPid])).rows[0].held, true,
      "the real init transaction holds rooms AccessExclusive before policy ALTER");
      request = outcome(run(target, options, mode === "read"
        ? async scoped => { scoped.releaseResponse(() => { released += 1; }); }
        : scoped => both(scoped, target, "after-init")));
      await until(`${mode}_virtual_waits_on_init_rooms`, async () => await waitingOn(initPid, "v") === 1);
      const waiting = (await pool.query(`select
        exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass and mode=$2 and not granted) as room_wait,
        exists(select 1 from pg_locks where pid=$1 and relation='room_identity_protocol_policy'::regclass) as policy_lock`,
      [await pidOf("v"), roomLock])).rows[0];
      assert.deepEqual([waiting.room_wait, waiting.policy_lock], [true, false],
        `${mode} mode queues on rooms ${roomLock} without obstructing init's policy ALTER`);
      continueInit.resolve();
      assert.deepEqual([await initializing, await request], ["ok", "ok"], `the real init and the ${mode} effect both succeed`);
    } finally {
      continueInit.resolve();
      await Promise.allSettled([initializing, request]);
      initClient.query = initQuery;
    }
    assert.deepEqual(await signature(), initial, "floor 1, null namespace and guard hash survive reinit unchanged");
    if (mode === "read") assert.equal(released, 1);
    else assert.deepEqual(await counts(target), { diagnostics: 1, xr: 1 });
  }

  const activating = new PostgresStorage(open("p", 1));
  const late = new PostgresStorage(open("l", 1), () => clock.now);
  const pinned = randomUUID();
  const pinnedReached = deferred(), pinnedGate = deferred();
  const current = outcome(run(pinned, write(), async scoped => { await both(scoped, pinned, "pinned"); pinnedReached.resolve(); await pinnedGate.promise; }));
  await Promise.race([pinnedReached.promise, current]);
  const policyPid = await pidOf("v");
  const raising = activating.identityProtocol.raise(2).then(String, label);
  let denied: Promise<string> | undefined;
  const beforeLate = entered;
  try {
    await until("activation_waits_on_policy_share", async () => await waitingOn(policyPid, "p") === 1);
    const activationPid = await pidOf("p");
    denied = outcome(run(pinned, write(), async () => undefined, late));
    await until("late_virtual_queues_behind_activation", async () => await waitingOn(activationPid, "l") === 1);
  } finally { pinnedGate.resolve(); }
  assert.deepEqual([await current, await raising, await denied], ["ok", "2", "409:identity_upgrade_required"]);
  assert.deepEqual(await counts(pinned), { diagnostics: 1, xr: 1 }, "the pinned floor-1 write commits before activation");
  for (const options of [write(), read()]) assert.equal(await outcome(run(randomUUID(), options, async () => undefined)), "409:identity_upgrade_required");
  assert.equal(entered, beforeLate, "neither the late call nor floor-2 calls reach the callback");
});
