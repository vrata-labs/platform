import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { referenceTemplateContract } from "@vrata/templates";
import { uncertainRoomCommit } from "./identity/fence-transaction.js";
import { IdentityBoundaryError } from "./identity/legacy-boundary.js";
import { createPostgresIdentityProtocol } from "./identity/protocol.js";
import { activatedIdentityRoomGuard } from "./identity/protocol-guard.js";
import { resolveRoomTemplateCreate, roomTemplateSessionContext } from "./room-template-policy.js";
import { templateVersionContentHash } from "./storage-room-records.js";
import { MemoryStorage, PostgresStorage, type RoomRecord, type Storage } from "./storage.js";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const tenantId = "demo-tenant";
const roomId = (label: string) => `admin-${label}-${randomUUID().slice(0, 8)}`;
const upgradeRequired = (error: unknown) => error instanceof IdentityBoundaryError && error.status === 409 && error.reason === "identity_upgrade_required";
const duplicate = /room_slug_conflict|duplicate key/;
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}
function settled<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > end) throw new Error(`${label}_timeout`); await delay(20); }
}
function interceptCommit(client: PoolClient, commit: (send: () => Promise<unknown>) => Promise<unknown>): () => void {
  const query = client.query, send = query as (...args: unknown[]) => Promise<unknown>;
  client.query = ((...args: unknown[]) => args[0] === "commit" ? commit(() => send.call(client, "commit")) : send.apply(client, args)) as typeof client.query;
  return () => { client.query = query; };
}
async function legacyFloor(storage: Storage) {
  assert.equal(await storage.identityProtocol.minimum(), 1);
  const seeds = { ownerParticipantId: "seed-owner", sessionControl: { hostParticipantId: "seed-host", presenterParticipantId: "seed-presenter" } };
  const standard = await storage.createAdministrativeRoom({ roomId: roomId("standard"), tenantId, templateId: "meeting-room-basic", name: "Seeded", ...seeds });
  assert.deepEqual([standard.roomType, standard.ownerParticipantId, standard.sessionControl?.hostParticipantId, standard.sessionControl?.presenterParticipantId],
    ["standard", "seed-owner", "seed-host", "seed-presenter"]);
  const personal: RoomRecord[] = [];
  for (const label of ["personal-a", "personal-b"]) personal.push(await storage.createAdministrativeRoom({ roomId: roomId(label), tenantId, roomType: "personal", name: label, ...seeds }));
  assert.notEqual(personal[0].roomId, personal[1].roomId, "administrative creation does not deduplicate by owner");
  for (const room of personal) assert.equal((await storage.getRoom(room.roomId))?.ownerParticipantId, "seed-owner");
  const original = await storage.getRoom(standard.roomId);
  await assert.rejects(storage.createAdministrativeRoom({ roomId: standard.roomId, tenantId, templateId: "meeting-room-basic", name: "Overwrite", ownerParticipantId: "other-owner" }), duplicate);
  assert.deepEqual(await storage.getRoom(standard.roomId), original);
  const raceId = roomId("race");
  const race = await Promise.all(["First", "Second"].map(name => settled(storage.createAdministrativeRoom({ roomId: raceId, tenantId, templateId: "meeting-room-basic", name }))));
  const winners = race.flatMap(outcome => outcome.ok ? [outcome.value] : []);
  assert.equal(winners.length, 1);
  for (const outcome of race) if (!outcome.ok) assert.match(String(outcome.error), duplicate);
  assert.equal((await storage.getRoom(raceId))?.name, winners[0].name);
}
async function activatedFloor(storage: Storage, identityRows?: (roomId: string) => Promise<number>) {
  assert.equal(await storage.identityProtocol.raise(2), 2);
  for (const raw of [{ ownerParticipantId: "raw-owner" }, { sessionControl: { hostParticipantId: "raw-host" } }, { sessionControl: { presenterParticipantId: "raw-presenter" } }]) {
    const id = roomId("raw");
    await assert.rejects(storage.createAdministrativeRoom({ roomId: id, tenantId, templateId: "meeting-room-basic", name: "Raw seed", ...raw }), upgradeRequired);
    assert.equal(await storage.getRoom(id), null);
  }
  await storage.transitionReferenceTemplateCatalog("active");
  const id = roomId("ownerless");
  const { input } = await resolveRoomTemplateCreate(storage, { roomId: id, tenantId, name: "Ownerless", roomType: "personal" }, { allowUnownedPersonal: true });
  const room = await storage.createAdministrativeRoom(input);
  assert.deepEqual([room.templateId, room.ownerParticipantId, room.visibility, room.guestAllowed, room.sessionControl?.hostParticipantId], ["personal-room-basic", null, "private", false, null]);
  assert.deepEqual(Object.keys(room).filter(key => /identity|credential|proof/i.test(key)), []);
  const hash = templateVersionContentHash(referenceTemplateContract((await storage.getTemplateVersion(room.templateId, room.templateVersion))!)!);
  assert.equal(roomTemplateSessionContext(room)?.contentHash, hash);
  const renamed = await storage.updateRoom(id, { name: "Ownerless reference remains editable", theme: { primaryColor: "#111111", accentColor: "#222222" } });
  assert.equal(renamed?.ownerParticipantId, null); assert.equal(roomTemplateSessionContext(renamed)?.contentHash, hash);
  await storage.updateRoom(id, { status: "disabled", disabledAt: new Date().toISOString() });
  const enabled = await storage.updateRoom(id, { status: "active", disabledAt: null });
  assert.equal(enabled?.status, "active"); assert.equal(enabled?.sceneBundleUrl, room.sceneBundleUrl);
  await assert.rejects(storage.updateRoom(id, { ownerParticipantId: "late-owner" }), /personal_room_owner_immutable/);
  const reread = await storage.getRoom(id);
  assert.equal(reread?.ownerParticipantId, null); assert.equal(roomTemplateSessionContext(reread)?.contentHash, hash);
  assert.equal(await storage.hasRoomIdentityAuthority(id), false);
  if (identityRows) assert.equal(await identityRows(id), 0);
}
test("memory administrative creation preserves legacy seeds and admits only ownerless rooms at floor two", async () => {
  const storage = new MemoryStorage(); await legacyFloor(storage); await activatedFloor(storage);
  const input: Partial<RoomRecord> = { roomId: roomId("clone"), tenantId, templateId: "personal-room-basic", name: "Clone" };
  const pending = settled(storage.createAdministrativeRoom(input));
  Object.assign(input, { ownerParticipantId: "late-owner", sessionControl: { hostParticipantId: "late-host" } });
  const outcome = await pending; assert.ok(outcome.ok);
  assert.deepEqual([outcome.value.ownerParticipantId, outcome.value.sessionControl?.hostParticipantId], [null, null]);
});

test("metadata-only PostgreSQL patches preserve sparse and concurrently changed frozen columns", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `admin_patch_${randomUUID().replaceAll("-", "")}`, connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  await root.query(`create schema "${schema}"`);
  const storage = new PostgresStorage(pool); await storage.init();
  const sparse = await storage.createAdministrativeRoom({ name: "Sparse legacy config" });
  await pool.query("update rooms set session_control='{}'::jsonb where room_id=$1", [sparse.roomId]);
  const same = await storage.createAdministrativeRoom({ name: "Same-type legacy config", ownerParticipantId: "owner-old", sessionControl: { hostParticipantId: "host-old" } });
  const stale = await storage.createAdministrativeRoom({ name: "Concurrent legacy config", ownerParticipantId: "owner-old", sessionControl: { hostParticipantId: "host-old" } });
  let target = "", read = deferred(), proceed = deferred();
  const reader = new class extends PostgresStorage {
    override async getRoom(id: string) {
      const room = await super.getRoom(id);
      if (id === target) { target = ""; read.resolve(); await proceed.promise; }
      return room;
    }
  }(pool);
  const metadata = { name: "Only requested metadata changes" };
  async function race(id: string, change: Partial<RoomRecord>) {
    target = id; read = deferred(); proceed = deferred();
    const pending = settled(reader.updateRoom(id, metadata));
    try { await read.promise; await storage.updateRoom(id, change); } finally { proceed.resolve(); }
    return pending;
  }
  const kept = await race(same.roomId, { ownerParticipantId: "owner-new", sessionControl: { hostParticipantId: "host-new" } });
  assert.ok(kept.ok);
  assert.deepEqual([kept.value?.name, kept.value?.roomType, kept.value?.ownerParticipantId, kept.value?.sessionControl?.hostParticipantId], [metadata.name, "standard", "owner-new", "host-new"]);
  const raced = await race(stale.roomId, { roomType: "personal", visibility: "private", guestAllowed: false, ownerParticipantId: "owner-new", sessionControl: { hostParticipantId: "host-new" } });
  assert.ok(!raced.ok && /room_template_binding_changed/.test(String(raced.error)));
  const raw = (await pool.query(`select name,room_type,visibility,guest_allowed,owner_participant_id,session_control->>'hostParticipantId' as host,
    template_snapshot->'roomConfig' as config from rooms where room_id=$1`, [stale.roomId])).rows[0];
  assert.deepEqual([raw.name, raw.room_type, raw.visibility, raw.guest_allowed, raw.owner_participant_id, raw.host], ["Concurrent legacy config", "personal", "private", false, "owner-new", "host-new"]);
  assert.deepEqual([raw.config.roomType, raw.config.visibility, raw.config.guestAllowed], ["personal", "private", false]);
  await storage.identityProtocol.raise(2);
  const retried = await storage.updateRoom(stale.roomId, metadata), reread = await storage.getRoom(stale.roomId);
  const fields = (room: RoomRecord | null) => [room?.name, room?.roomType, room?.visibility, room?.guestAllowed, room?.ownerParticipantId, room?.sessionControl?.hostParticipantId, room?.templateSnapshot?.roomConfig];
  assert.deepEqual(fields(retried), fields(reread));
  assert.deepEqual(fields(retried).slice(0, 6), [metadata.name, "personal", "private", false, "owner-new", "host-new"]);
  assert.equal((await storage.updateRoom(sparse.roomId, { name: "Sparse config unchanged" }))?.name, "Sparse config unchanged");
  for (const change of [{ sessionControl: { hostParticipantId: "forbidden" } }, { ownerParticipantId: "forbidden" }, { roomType: "personal" as const }]) {
    await assert.rejects(storage.updateRoom(sparse.roomId, change), /room_identity_lifecycle_requires_v2/);
  }
  assert.deepEqual(Object.values((await pool.query("select room_type,owner_participant_id,session_control from rooms where room_id=$1", [sparse.roomId])).rows[0]), ["standard", null, {}]);
});
test("postgres administrative creation queues on policy and preserves committed metadata after a lost ACK", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `admin_room_${randomUUID().replaceAll("-", "")}`, connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href, max: 1, idleTimeoutMillis: 0 });
  const probe = new Pool({ connectionString: connection.href, max: 2 });
  const gates: Array<() => void> = [], restores: Array<() => void> = [];
  t.after(async () => {
    for (const open of gates) open(); for (const restore of restores) restore();
    await pool.end(); await probe.query(`drop schema if exists "${schema}" cascade`); await probe.end();
  });
  await probe.query(`create schema "${schema}"`);
  const storage = new PostgresStorage(pool); await storage.init();
  const identityRows = async (id: string) => (await probe.query(`select ((select count(*) from room_identity_authority_v2 where room_id=$1)
    + (select count(*) from room_identities_v2 where room_id=$1))::int as n`, [id])).rows[0].n as number;
  const storageBackend = async () => {
    const client = await pool.connect();
    try { return { client, pid: (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number }; }
    finally { client.release(); }
  };
  const blocked = (pid: number) => until(async () => (await probe.query("select cardinality(pg_blocking_pids($1)) > 0 as waiting", [pid])).rows[0].waiting, "policy_wait");
  const blocking = (pid: number) => until(async () => (await probe.query("select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting, "policy_queue");
  await legacyFloor(storage); await storage.transitionReferenceTemplateCatalog("active");
  const backend = await storageBackend(), raiseHeld = deferred(), raiseOpen = deferred();
  gates.push(raiseOpen.resolve);
  const raising = settled(createPostgresIdentityProtocol({ connect: async () => {
    const client = await probe.connect();
    restores.push(interceptCommit(client, async send => { raiseHeld.resolve(); await raiseOpen.promise; return send(); }));
    return client;
  } } as unknown as Pool).raise(2));
  assert.equal(await Promise.race([raiseHeld.promise.then(() => null), raising]), null);
  assert.equal(await storage.identityProtocol.minimum(), 1);
  const rawId = roomId("queued-raw");
  const raw = settled(storage.createAdministrativeRoom({ roomId: rawId, tenantId, templateId: "meeting-room-basic", name: "Queued raw seed", ownerParticipantId: "queued-owner", sessionControl: { hostParticipantId: "queued-host" } }));
  const cloneInput: Partial<RoomRecord> = { roomId: roomId("queued-clone"), tenantId, templateId: "personal-room-basic", name: "Queued ownerless" };
  const clone = settled(storage.createAdministrativeRoom(cloneInput));
  await blocked(backend.pid);
  Object.assign(cloneInput, { ownerParticipantId: "late-owner", sessionControl: { hostParticipantId: "late-host" } });
  raiseOpen.resolve(); const raised = await raising; for (const restore of restores.splice(0)) restore();
  assert.ok(raised.ok && raised.value === 2);
  assert.equal((await probe.query("select prosrc from pg_proc where proname='vrata_identity_v2_room_boundary' and pronamespace=current_schema()::regnamespace")).rows[0].prosrc, activatedIdentityRoomGuard);
  const rawOutcome = await raw; assert.ok(!rawOutcome.ok && upgradeRequired(rawOutcome.error)); assert.equal(await storage.getRoom(rawId), null);
  const cloneOutcome = await clone; assert.ok(cloneOutcome.ok);
  assert.deepEqual([cloneOutcome.value.ownerParticipantId, cloneOutcome.value.sessionControl?.hostParticipantId, cloneOutcome.value.guestAllowed], [null, null, false]);
  assert.equal(await identityRows(cloneOutcome.value.roomId), 0);
  await activatedFloor(storage, identityRows);
  const holder = await storageBackend(), createHeld = deferred(), createOpen = deferred(); gates.push(createOpen.resolve);
  restores.push(interceptCommit(holder.client, async send => { createHeld.resolve(); await createOpen.promise; return send(); }));
  const heldId = roomId("held-share"), creating = settled(storage.createAdministrativeRoom({ roomId: heldId, tenantId, templateId: "meeting-room-basic", name: "Holds policy share" }));
  assert.equal(await Promise.race([createHeld.promise.then(() => null), creating]), null);
  const queuedRaise = settled(createPostgresIdentityProtocol(probe).raise(2)); await blocking(holder.pid);
  createOpen.resolve(); const created = await creating; for (const restore of restores.splice(0)) restore(); assert.ok(created.ok);
  const requeued = await queuedRaise; assert.ok(requeued.ok && requeued.value === 2);
  assert.equal((await storage.getRoom(heldId))?.name, "Holds policy share");
  const lost = await storageBackend();
  restores.push(interceptCommit(lost.client, async send => { await send(); throw new Error("Connection terminated unexpectedly"); }));
  const lostId = roomId("lost-ack");
  const uncertain = await settled(storage.createAdministrativeRoom({ roomId: lostId, tenantId, templateId: "meeting-room-basic", name: "Committed before lost ack" }));
  for (const restore of restores.splice(0)) restore(); assert.ok(!uncertain.ok && uncertainRoomCommit(uncertain.error));
  const survivor = await storage.getRoom(lostId); assert.equal(survivor?.name, "Committed before lost ack");
  assert.equal((await probe.query("select count(*)::int as n from rooms where room_id=$1", [lostId])).rows[0].n, 1);
  assert.equal(await identityRows(lostId), 0); assert.equal(await storage.hasRoomIdentityAuthority(lostId), false);
  await assert.rejects(storage.createAdministrativeRoom({ roomId: lostId, tenantId, templateId: "meeting-room-basic", name: "Retry after lost ack" }), duplicate);
  assert.deepEqual(await storage.getRoom(lostId), survivor);
});
