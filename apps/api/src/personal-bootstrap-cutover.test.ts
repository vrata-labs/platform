import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { MemoryStorage, PostgresStorage } from "./storage.js";
import { IdentityBoundaryError } from "./identity/legacy-boundary.js";

const upgrade = (error: unknown) => error instanceof IdentityBoundaryError && error.reason === "identity_upgrade_required";

test("Memory legacy personal bootstrap creates once and cannot create after activation or reopen a binding", async () => {
  const storage = new MemoryStorage();
  const input = { roomId: "personal-room", tenantId: "demo-tenant", ownerParticipantId: "legacy-owner",
    templateId: "personal-workspace-basic", name: "Personal", roomType: "personal" as const };
  const results = await Promise.all([storage.createLegacyPersonalRoom(input), storage.createLegacyPersonalRoom(input)]);
  assert.deepEqual(results.map(result => result.created), [true, false]);
  await storage.roomIdentities.create({ tenantId: input.tenantId, roomId: input.roomId, displayName: "Binding", baseRole: "guest", provenance: { kind: "guest" } });
  await assert.rejects(storage.createLegacyPersonalRoom(input), upgrade);
  await storage.identityProtocol.raise(2);
  await assert.rejects(storage.createLegacyPersonalRoom({ ...input, roomId: "after", ownerParticipantId: "new-owner" }), upgrade);
  assert.equal(await storage.getRoom("after"), null);
});

test("Postgres bootstraps use one client, match init lock order and serialize against activation", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `bootstrap_cutover_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool);
  await storage.init();
  const input = (owner: string) => ({ roomId: `personal-${owner}`, tenantId: "demo-tenant", ownerParticipantId: owner,
    templateId: "personal-workspace-basic", name: "Personal", roomType: "personal" as const });
  const singlePool = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 1000 });
  try {
    const single = new PostgresStorage(singlePool);
    assert.equal((await single.createLegacyPersonalRoom(input("single"))).created, true);
  } finally { await singlePool.end(); }
   const templateHolder = await pool.connect();
   let duplicates: Promise<Awaited<ReturnType<typeof storage.createLegacyPersonalRoom>>[]> | undefined;
   try {
     await templateHolder.query("begin");
     await templateHolder.query("select 1 from templates where template_id='personal-workspace-basic' for no key update");
     const pid = (await templateHolder.query("select pg_backend_pid() as pid")).rows[0].pid;
     duplicates = Promise.all([storage.createLegacyPersonalRoom(input("same")), storage.createLegacyPersonalRoom(input("same"))]);
     const settled = duplicates.then(value => ({ value }), error => ({ error }));
     let waiters = 0;
     for (let attempt = 0; attempt < 100; attempt++) {
       waiters = Number((await pool.query("select count(*) as n from pg_stat_activity where $1=any(pg_blocking_pids(pid))", [pid])).rows[0].n);
       if (waiters === 2) break;
       await delay(10);
     }
     assert.equal(waiters, 2, "both bootstraps read no room and wait inside INSERT before either can commit");
     await templateHolder.query("commit");
     const result = await settled;
     assert.ok("value" in result);
     const duplicate = result.value;
     assert.equal(duplicate.filter(result => result.created).length, 1);
     assert.equal(duplicate[0]!.room.roomId, duplicate[1]!.room.roomId);
     assert.equal((await pool.query("select count(*)::integer as n from rooms where owner_participant_id='same'")).rows[0].n, 1);
   } finally {
     await templateHolder.query("rollback").catch(() => undefined); templateHolder.release();
     if (duplicates) await duplicates.catch(() => undefined);
   }
  const holder = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query("begin");
    await holder.query("lock table rooms in access exclusive mode");
    const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
    pending = storage.createLegacyPersonalRoom(input("queued-legacy"));
    const settled = pending.then(value => ({ value }), error => ({ error }));
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = (await pool.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
      if (blocked) break;
      await delay(10);
    }
    assert.equal(blocked, true);
    await holder.query("lock table room_identity_protocol_policy in exclusive mode nowait");
    await holder.query("commit");
    assert.equal("value" in await settled, true, "bootstrap blocked on rooms holds no policy lock");
  } finally {
    await holder.query("rollback").catch(() => undefined); holder.release();
    if (pending) await pending.catch(() => undefined);
  }
  const policyHolder = await pool.connect();
  let creation: Promise<unknown> | undefined;
  let raising: Promise<unknown> | undefined;
  try {
    await policyHolder.query("begin");
    await policyHolder.query("lock table room_identity_protocol_policy in row exclusive mode");
    raising = storage.identityProtocol.raise(2);
    const raised = raising.then(value => ({ value }), error => ({ error }));
    let queued = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      queued = (await pool.query("select exists(select 1 from pg_locks where relation='room_identity_protocol_policy'::regclass and mode='ExclusiveLock' and not granted) as waiting")).rows[0].waiting;
      if (queued) break;
      await delay(10);
    }
    assert.equal(queued, true);
    creation = storage.createLegacyPersonalRoom(input("after-raise"));
    const result = creation.then(() => null, error => error);
    await policyHolder.query("commit");
    assert.deepEqual(await raised, { value: 2 });
    assert.ok(upgrade(await result));
    assert.equal(await storage.getRoom("personal-after-raise"), null);
  } finally {
    await policyHolder.query("rollback").catch(() => undefined); policyHolder.release();
    if (creation) await creation.catch(() => undefined);
    if (raising) await raising.catch(() => undefined);
  }
  const one = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 1000 });
  try {
    const owned = await new PostgresStorage(one).createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "personal-workspace-basic", displayName: "Owner" });
    assert.equal(owned.room.ownerParticipantId, owned.identity.participantId);
    assert.equal((await storage.roomIdentities.resolve(owned.identity))!.isOwner, true);
  } finally { await one.end(); }
  const two = new Pool({ connectionString: connection.href, max: 2, connectionTimeoutMillis: 1000 });
  try {
    const concurrent = new PostgresStorage(two);
    const owned = await Promise.all([concurrent.createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "personal-workspace-basic", displayName: "One" }),
      concurrent.createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "personal-workspace-basic", displayName: "Two" })]);
    assert.notEqual(owned[0]!.identity.participantId, owned[1]!.identity.participantId);
  } finally { await two.end(); }
});
