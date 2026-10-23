import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool } from "pg";
import { createRoomIdentityCodec, type RoomIdentityProof, type RoomIdentityScope } from "@vrata/shared-types/identity-credential";
import { PostgresStorage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";
import { createPostgresRoomIdentities } from "./identity/postgres.js";
import { IdentityStorageError } from "./identity/contracts.js";

type Outcome<T> = { value: T } | { error: unknown };
const code = (expected: string) => (error: unknown) => error instanceof IdentityStorageError && error.code === expected;
const failure = (outcome: Outcome<unknown>) => "value" in outcome ? null
  : outcome.error instanceof IdentityStorageError ? outcome.error.code : outcome.error;
function settle<T>(call: () => Promise<T>) {
  const state = { done: false };
  const outcome: Promise<Outcome<T>> = call().then(value => ({ value }), (error: unknown) => ({ error }))
    .finally(() => { state.done = true; });
  return { state, outcome };
}
async function until(label: string, probe: () => boolean | Promise<boolean>): Promise<void> {
  const stop = Date.now() + 15_000;
  while (!(await probe())) {
    if (Date.now() > stop) throw new Error(`wait_timeout:${label}`);
    await delay(10);
  }
}

test("RI2 host mutations and post-read mints honour the original proof deadline in PostgreSQL", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `identity_proof_deadline_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, max: 1 });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: connection.href });
  const waitPool = new Pool({ connectionString: connection.href, max: 1 });
  let created = false;
  t.after(async () => {
    await Promise.all([pool.end(), waitPool.end()]);
    if (created) await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  await admin.query(`create schema "${schema}"`); created = true;
  let nowMs = Date.now();
  const clock = () => nowMs;
  const storage = new PostgresStorage(pool, clock);
  await storage.init();
  assert.equal((await pool.query("select current_schema() as schema")).rows[0].schema, schema);
  await storage.identityProtocol.raise(2);
  const secret = "identity-proof-deadline-synthetic-key-32-bytes";
  const codec = createRoomIdentityCodec(secret);
  const service = createRoomIdentityService(storage.roomIdentities, secret, clock);
  const adminActor = { actorType: "admin-token", actorId: "test-admin", role: "admin" } as const;
  const reset = () => { nowMs = Math.floor(Date.now() / 1000) * 1000; return nowMs / 1000 + 60; };
  const sign = (proof: RoomIdentityProof) => codec.sign(proof, { nowSeconds: nowMs / 1000, lifetimeSeconds: 60 });
  async function fixture(name: string) {
    const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name });
    const scope = { tenantId: room.tenantId, roomId: room.roomId };
    const create = (displayName: string, role: "host" | "member") => storage.roomIdentities.create({ ...scope, displayName,
      baseRole: "member", provenance: { kind: "invite", role, inviteId: randomUUID() } });
    return { scope, host: await create("Invited host", "host"), create };
  }
  const authority = async (scope: RoomIdentityScope) => {
    const current = await storage.roomIdentities.authority(scope); assert.ok(current);
    return { revision: current.revision, host: current.hostIdentityId, presenter: current.presenterIdentityId };
  };
  async function heldRoom<T>(scope: RoomIdentityScope, call: () => Promise<T>, whileBlocked: () => void): Promise<Outcome<T>> {
    const holder = await pool.connect();
    let pending: Promise<Outcome<T>> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select 1 from rooms where tenant_id=$1 and room_id=$2 for update", [scope.tenantId, scope.roomId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const started = settle(call); pending = started.outcome;
      await until("room lock wait", async () => {
        if (started.state.done) throw new Error("call settled before waiting on the room lock");
        return (await pool.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting as boolean;
      });
      whileBlocked(); await holder.query("commit"); return await pending;
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); await pending; }
  }

  for (const [offsetMs, admitted] of [[0, false], [-1, true]] as const) {
    const deadline = reset();
    const { scope, host } = await fixture(`Claim deadline ${offsetMs}`);
    const credential = sign(host), before = await authority(scope);
    assert.deepEqual(before, { revision: 0, host: null, presenter: null });
    const outcome = await heldRoom(scope, () => service.claimHost(credential, scope, 0), () => { nowMs = deadline * 1000 + offsetMs; });
    assert.equal(failure(outcome), admitted ? null : "identity_not_active");
    assert.deepEqual(await authority(scope), admitted ? { revision: 1, host: host.identityId, presenter: null } : before);
  }
  for (const [offsetMs, admitted] of [[0, false], [-1, true]] as const) {
    const deadline = reset();
    const { scope, host, create } = await fixture(`Transfer deadline ${offsetMs}`);
    await storage.roomIdentities.claimHost({ ...host, expiresAtSeconds: deadline }, 0);
    const target = await create("Presenter target", "member");
    await storage.roomIdentities.transition(scope, adminActor, 1, { type: "grant-presenter", targetParticipantId: target.participantId });
    const credential = sign(host), before = await authority(scope);
    assert.deepEqual(before, { revision: 2, host: host.identityId, presenter: target.identityId });
    const outcome = await heldRoom(scope, () => service.transferHost(credential, scope, target.identityId, 2), () => { nowMs = deadline * 1000 + offsetMs; });
    assert.equal(failure(outcome), admitted ? null : "identity_not_active");
    assert.deepEqual(await authority(scope), admitted ? { revision: 3, host: target.identityId, presenter: null } : before);
  }
  {
    const deadline = reset();
    const { scope, host } = await fixture("Caller-mutated proof");
    const proof = { tenantId: host.tenantId, roomId: host.roomId, identityId: host.identityId,
      participantId: host.participantId, authEpoch: host.authEpoch, expiresAtSeconds: deadline };
    const outcome = await heldRoom(scope, () => storage.roomIdentities.claimHost(proof, 0), () => {
      proof.expiresAtSeconds = deadline + 3600; nowMs = deadline * 1000;
    });
    assert.equal(failure(outcome), "identity_not_active");
    assert.deepEqual(await authority(scope), { revision: 0, host: null, presenter: null });
  }
  {
    const deadline = reset();
    const { scope, host } = await fixture("Deadline precedence");
    const direct = { ...host, expiresAtSeconds: deadline };
    await assert.rejects(storage.roomIdentities.claimHost(direct, 7), code("authority_conflict"));
    nowMs = deadline * 1000;
    await assert.rejects(storage.roomIdentities.claimHost(direct, 7), code("identity_not_active"));
    await storage.roomIdentities.transition(scope, adminActor, 0, { type: "end" });
    await assert.rejects(storage.roomIdentities.claimHost(direct, 7), code("room_blocked"));
    const ended = await authority(scope); assert.equal(ended.host, null); assert.equal(ended.revision, 1);
  }

  // A parent row lock does not block MVCC reads; this wait owns the sole pool client.
  const waitingService = createRoomIdentityService(createPostgresRoomIdentities(waitPool, clock), secret, clock);
  reset();
  const { scope: mintScope, host: minted } = await fixture("Post-read mint deadline");
  for (const method of ["renewCredential", "issueSession"] as const) for (const [offsetMs, admitted] of [[0, false], [-1, true]] as const) {
    const deadline = reset(), credential = sign(minted);
    const held = await waitPool.connect();
    const started = settle(async () => ({ identity: (await waitingService[method](credential, mintScope)).identity }));
    try {
      await until(`${method} pool wait`, () => {
        if (started.state.done) throw new Error(`${method} settled before waiting on the pool`);
        return waitPool.waitingCount === 1;
      });
      nowMs = deadline * 1000 + offsetMs;
    } finally { held.release(); }
    const outcome = await started.outcome;
    assert.equal(failure(outcome), admitted ? null : "identity_not_active");
    if ("value" in outcome) assert.equal(outcome.value.identity.identityId, minted.identityId);
  }
});
