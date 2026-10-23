import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DatabaseError, Pool } from "pg";
import { PostgresStorage, type RuntimeDiagnosticRecord } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";
import { IdentityStorageError } from "./identity/contracts.js";
import type { RoomEffectGuard } from "./identity/effect-write-guard.js";
import { uncertainRoomCommit } from "./identity/fence-transaction.js";
import { createXrTelemetryService } from "./xr-telemetry-service.js";
import type { XrTelemetryRecord } from "./xr-telemetry-buffer.js";

type Snapshot = { diagnostics: [number, string, string]; xr: [number, string, string] };
const diagnostic = (label: string) => ({ participantId: label, displayName: label }) as unknown as RuntimeDiagnosticRecord;
const storageError = (code: string) => (error: unknown) => error instanceof IdentityStorageError && error.code === code;

test("guarded PostgreSQL telemetry commits only within the original session deadline", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `identity_telemetry_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 1 });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  // Only the owned schema is on the path: init and the v2 floor cannot reach public.
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: connection.href });
  const singlePool = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 1000 });
  let created = false;
  t.after(async () => {
    await Promise.all([pool.end(), singlePool.end()]);
    if (created) await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  await admin.query(`create schema "${schema}"`); created = true;
  const storage = new PostgresStorage(pool);
  await storage.init();
  assert.equal((await pool.query("select current_schema() as schema")).rows[0].schema, schema);
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, "identity-telemetry-proof-key-32-bytes-or-longer");
  let pinnedNow: number | undefined;
  // One borrowed client must suffice: the guard never takes a second pool connection.
  const single = new PostgresStorage(singlePool, () => pinnedNow ?? Date.now());

  async function createHost() {
    const legacyId = randomUUID();
    const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Guarded telemetry",
      sessionControl: { hostParticipantId: legacyId } });
    const scope = { tenantId: room.tenantId, roomId: room.roomId };
    const recovery = await service.issueRecovery({ ...scope, targetParticipantId: legacyId, targetRole: "host",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      issuer: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
    const host = await service.redeemRecovery(recovery.credential, scope);
    const guard: RoomEffectGuard = { ...host.identity, expiresAtSeconds: Math.floor(Date.now() / 1000) + 120,
      permission: "room.join" };
    return { roomId: room.roomId, participantId: host.identity.participantId, guard };
  }
  const snapshot = async (roomId: string): Promise<Snapshot> => (await pool.query(`select
    (select json_build_array(count(*)::integer, min(id)::text, max(id)::text) from runtime_diagnostics where room_id=$1) as diagnostics,
    (select json_build_array(count(*)::integer, min(id)::text, max(id)::text) from xr_telemetry where room_id=$1) as xr`, [roomId])).rows[0];

  const host = await createHost();
  await pool.query(`insert into runtime_diagnostics (room_id,payload)
    select $1,jsonb_build_object('seed',n) from generate_series(1,200) n`, [host.roomId]);
  await pool.query(`insert into xr_telemetry (room_id,participant_id,payload)
    select $1,'seed',jsonb_build_object('seed',n) from generate_series(1,1000) n`, [host.roomId]);
  const write = (label: string, after: () => void = () => undefined) => single.withRoomIdentityEffect(host.guard, async scoped => {
    await scoped.addDiagnostic(host.roomId, diagnostic(label));
    await scoped.addXrTelemetry(host.roomId, host.participantId, { statusLine: label });
    after();
  });

  const seeded = await snapshot(host.roomId);
  assert.deepEqual([seeded.diagnostics[0], seeded.xr[0]], [200, 1000]);
  await write("committed");
  const committed = await snapshot(host.roomId);
  assert.deepEqual([committed.diagnostics[0], committed.xr[0]], [200, 1000], "retention keeps the room caps");
  assert.deepEqual([committed.diagnostics[1], committed.xr[1]],
    [String(BigInt(seeded.diagnostics[1]) + 1n), String(BigInt(seeded.xr[1]) + 1n)], "retention evicts the oldest row in the same transaction");
  const newest = await pool.query(`select (select payload->>'participantId' from runtime_diagnostics where id=$1) as diagnostic,
    (select payload->>'statusLine' from xr_telemetry where id=$2) as xr`, [committed.diagnostics[2], committed.xr[2]]);
  assert.deepEqual(newest.rows[0], { diagnostic: "committed", xr: "committed" });

  await assert.rejects(write("thrown", () => { throw new Error("abort_telemetry"); }), /abort_telemetry/);
  assert.deepEqual(await snapshot(host.roomId), committed, "a throwing callback rolls back inserts and retention");

  await assert.rejects(write("expired", () => { pinnedNow = host.guard.expiresAtSeconds * 1000; }),
    storageError("identity_session_expired"));
  pinnedNow = undefined;
  assert.deepEqual(await snapshot(host.roomId), committed, "expiry after awaited SQL denies and rolls back before COMMIT");

  await assert.rejects(single.withRoomIdentityEffect(host.guard, async scoped => {
    await scoped.addDiagnostic(host.roomId, diagnostic("between"));
    pinnedNow = host.guard.expiresAtSeconds * 1000;
    await scoped.addXrTelemetry(host.roomId, host.participantId, { statusLine: "between" });
  }), storageError("identity_session_expired"));
  pinnedNow = undefined;
  assert.deepEqual(await snapshot(host.roomId), committed, "expiry between operations denies the next one");

  let sent = 0;
  await single.withRoomIdentityEffect(host.guard, async scoped => {
    scoped.releaseResponse(() => { sent += 1; });
    pinnedNow = host.guard.expiresAtSeconds * 1000;
  });
  assert.equal(sent, 1, "a response released in time is not denied after it was sent");
  await assert.rejects(single.withRoomIdentityEffect(host.guard, async scoped => { scoped.releaseResponse(() => { sent += 1; }); }),
    storageError("identity_session_expired"));
  pinnedNow = undefined;
  assert.equal(sent, 1);

  // The upfront parent write lock serializes retention across participants.
  const racePool = new Pool({ connectionString: connection.href, max: 3, application_name: schema });
  const finalChecks = new Set<string>();
  let holding!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { holding = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const race = (label: string, after: () => Promise<void> = async () => undefined) => {
    let written = false;
    const concurrent = new PostgresStorage(racePool, () => { if (written) finalChecks.add(label); return Date.now(); });
    return concurrent.withRoomIdentityEffect({ ...host.guard, roomWrite: true }, async scoped => {
      await scoped.addDiagnostic(host.roomId, diagnostic(label));
      await scoped.addXrTelemetry(host.roomId, host.participantId, { statusLine: label });
      await after(); written = true;
    });
  };
  const raced: Promise<void>[] = [];
  try {
    raced.push(race("race-0", async () => { holding(); await gate; }));
    await held;
    for (let n = 1; n < 8; n += 1) raced.push(race(`race-${n}`));
    let lock = { blocked: 0, holding: 0 };
    for (let attempt = 0; attempt < 200 && lock.blocked < 2; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 10));
      lock = (await pool.query(`select count(*) filter (where cardinality(pg_blocking_pids(pid))>0
        and query like 'select 1 from rooms%')::integer as blocked,
        count(*) filter (where state='idle in transaction')::integer as holding from pg_stat_activity where application_name=$1`, [schema])).rows[0];
    }
    assert.deepEqual(lock, { blocked: 2, holding: 1 }, "both other writers wait on the holder's actual parent room lock");
    assert.deepEqual(await snapshot(host.roomId), committed, "nothing commits while the holder keeps the lock");
  } finally { release(); await Promise.allSettled(raced); await racePool.end(); }
  await Promise.all(raced);
  const final = await snapshot(host.roomId);
  assert.deepEqual([final.diagnostics[0], final.xr[0]], [200, 1000], "serialized retention keeps the exact room caps");
  assert.deepEqual([final.diagnostics[1], final.xr[1]], [String(BigInt(committed.diagnostics[1]) + 8n),
    String(BigInt(committed.xr[1]) + 8n)], "each write evicts one distinct oldest seed row");
  const kept = (await pool.query(`select
    (select count(*)::integer from runtime_diagnostics where room_id=$1 and payload->>'participantId' like 'race-%') as diagnostics,
    (select count(*)::integer from xr_telemetry where room_id=$1 and payload->>'statusLine' like 'race-%') as xr`, [host.roomId])).rows[0];
  assert.deepEqual(kept, { diagnostics: 8, xr: 8 });
  assert.equal(finalChecks.size, 8, "every write rechecked its original deadline after its last SQL");

  const slotsPool = new Pool({ connectionString: connection.href, max: 3, application_name: `${schema}_xr_slots` });
  const slotsStorage = new PostgresStorage(slotsPool);
  const limited = createXrTelemetryService(Promise.resolve({ addXrTelemetry: async () => {}, getXrTelemetry: async () => [] }));
  const hosts = await Promise.all([createHost(), createHost(), createHost()]);
  const holders = await Promise.all([pool.connect(), pool.connect()]);
  const entered = new Set<string>();
  const pending: Promise<void>[] = [];
  try {
    for (const [index, holder] of holders.entries()) {
      await holder.query("begin"); await holder.query("select 1 from rooms where room_id=$1 for update", [hosts[index].roomId]);
    }
    for (const item of hosts) pending.push(limited.upsertXrTelemetryWithFence(item.roomId, item.participantId,
      { roomId: item.roomId, participantId: item.participantId, updatedAt: new Date().toISOString(), kind: "input" },
      (record, persist) => {
        entered.add(item.roomId); assert.equal(persist, true);
        return slotsStorage.withRoomIdentityEffect({ ...item.guard, roomWrite: true }, scoped =>
          scoped.addXrTelemetry(item.roomId, item.participantId, record as unknown as Record<string, unknown>));
      }));
    let blocked = 0;
    for (let attempt = 0; attempt < 200 && blocked < 2; attempt += 1) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 10));
      blocked = (await pool.query("select count(*)::integer as count from pg_stat_activity where application_name=$1 and cardinality(pg_blocking_pids(pid))>0",
        [`${schema}_xr_slots`])).rows[0].count;
    }
    assert.equal(blocked, 2, "two XR operations reached real parent lock waits");
    assert.equal(entered.size, 2); assert.equal(entered.has(hosts[2].roomId), false, "the third XR room has not borrowed a client");
    const note = await slotsStorage.withRoomIdentityEffect({ ...hosts[2].guard, permission: "notes.edit" }, scoped =>
      scoped.upsertRoomNote({ roomId: hosts[2].roomId, scope: "shared", content: "ordinary route has pool capacity" }));
    assert.equal(note.content, "ordinary route has pool capacity");
    assert.equal(slotsPool.totalCount, 3);
  } finally {
    for (const holder of holders) { await holder.query("rollback").catch(() => undefined); holder.release(); }
    await Promise.allSettled(pending); await slotsPool.end();
  }
  await Promise.all(pending); assert.equal(entered.size, 3);

  const live = await createHost();
  const telemetry = createXrTelemetryService(Promise.resolve(single));
  const upsert = (statusLine: string, service = telemetry) => service.upsertXrTelemetryWithFence(live.roomId, live.participantId,
    { roomId: live.roomId, participantId: live.participantId, updatedAt: new Date().toISOString(), kind: "seat", statusLine },
    (record: XrTelemetryRecord, persist: boolean) => single.withRoomIdentityEffect(live.guard, async scoped => {
      assert.equal(persist, true);
      await scoped.addXrTelemetry(live.roomId, live.participantId, record as unknown as Record<string, unknown>);
    }));
  await upsert("projected");
  const projected = await telemetry.listXrTelemetry(live.roomId);
  assert.deepEqual(projected.map(entry => entry.statusLine), ["projected"]);
  await pool.query(`create function telemetry_commit_fault() returns trigger language plpgsql as $$ begin
    if new.payload->>'statusLine'='reject-commit' then raise exception 'telemetry_commit_rejected'; end if;
    if new.payload->>'statusLine'='uncertain-commit' then raise exception 'telemetry_commit_unconfirmed' using errcode='08006'; end if;
    return null; end $$`);
  await pool.query(`create constraint trigger telemetry_commit_fault after insert on xr_telemetry
    deferrable initially deferred for each row execute function telemetry_commit_fault()`);
  const rejected = await upsert("reject-commit").then(() => null, (error: unknown) => error);
  assert.ok(rejected instanceof DatabaseError && rejected.code === "P0001" && !uncertainRoomCommit(rejected),
    "a server-rejected COMMIT is a definite failure");
  assert.deepEqual(await telemetry.listXrTelemetry(live.roomId), projected);
  const unconfirmed = await upsert("uncertain-commit").then(() => null, (error: unknown) => error);
  assert.ok(uncertainRoomCommit(unconfirmed), "an unconfirmed COMMIT surfaces as uncertain, never as success");
  // This simulated loss rolls back server-side; a genuinely lost ACK may leave the row
  // persisted, but the caller still rejects and the service never projects it live.
  assert.deepEqual(await telemetry.listXrTelemetry(live.roomId), projected);
  await upsert("after-faults");
  assert.deepEqual((await telemetry.listXrTelemetry(live.roomId)).map(entry => entry.statusLine), ["after-faults"]);

  // The real COMMIT makes the row durable before its client acknowledgement is lost.
  // An empty persisted reader isolates the service's live projection from durable rows.
  const isolated = createXrTelemetryService(Promise.resolve({
    addXrTelemetry: async () => { throw new Error("unexpected_global_persist"); },
    getXrTelemetry: async () => []
  }));
  const durable = async (statusLine: string) => (await pool.query(`select count(*)::integer as count from xr_telemetry
    where room_id=$1 and payload->>'statusLine'=$2`, [live.roomId, statusLine])).rows[0].count;
  // max:1 means the fence borrows this same idle client; only its own query is wrapped.
  const client = await singlePool.connect();
  client.release();
  const query = client.query;
  let armed = true;
  client.query = function (this: typeof client, ...args: unknown[]) {
    const reply: unknown = Reflect.apply(query, this, args);
    if (!armed || args[0] !== "commit") return reply;
    armed = false;
    return Promise.resolve(reply).then(() => { throw new Error("lost_ack"); });
  } as unknown as typeof client.query;
  let lost: unknown;
  try {
    lost = await upsert("lost-ack-commit", isolated).then(() => null, (error: unknown) => error);
  } finally { client.query = query; }
  assert.equal(armed, false, "the real COMMIT ran through the wrapped client");
  const cause = lost instanceof Error ? lost.cause : undefined;
  assert.ok(uncertainRoomCommit(lost) && cause instanceof Error && cause.message === "lost_ack",
    "a lost COMMIT ACK surfaces as uncertain, never as success");
  assert.equal(await durable("lost-ack-commit"), 1, "the server committed the row before the ACK was lost");
  assert.deepEqual(await isolated.listXrTelemetry(live.roomId), [], "an uncertain commit is never projected live");
  await upsert("lost-ack-after", isolated);
  assert.equal(await durable("lost-ack-after"), 1);
  assert.deepEqual((await isolated.listXrTelemetry(live.roomId)).map(entry => entry.statusLine), ["lost-ack-after"],
    "the pair queue and the single pooled connection stay usable");
});
