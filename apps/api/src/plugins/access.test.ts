import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { MemoryStorage, PostgresStorage } from "../storage.js";
import type { Storage } from "../storage-contracts.js";
import { IdentityStorageError, type RoomIdentityRecord } from "../identity/contracts.js";
import { RoomFenceCommitUncertain } from "../identity/fence-transaction.js";
import { RoomPluginAccessError, type RoomPluginAuthorAccess, type RoomPluginCleanupTicket, type RoomPluginRuntimeSnapshot,
  type RoomPluginSessionActor, type RoomPluginUploadTicket } from "./access-contracts.js";
import { assertPluginAuthor } from "./access-policy.js";
import { RoomPluginStorageError, type RoomPluginPackage, type RoomPluginScope } from "./contracts.js";
import { deleteRoomWithPluginCleanup } from "./package-service.js";

const fingerprint = "b".repeat(64);
function artifact(id = "welcome-status", version = "1.0.0") {
  return createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id, version, displayName: id,
    requestedCapabilities: ["status.set"], configSchema: { greeting: { type: "string", required: true, minLength: 0, maxLength: 40 } } },
  "globalThis.pluginAccessMustNeverExecute = true; export function init() {}").bytes;
}
function binding(value: RoomPluginPackage, enabled = true) {
  return { packageId: value.packageId, version: value.version, artifactSha256: value.artifactSha256,
    enabled, approvedCapabilities: ["status.set" as const], config: { greeting: "Hello" } };
}
function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof IdentityStorageError || error instanceof RoomPluginStorageError || error instanceof RoomPluginAccessError);
    assert.equal(error.code, expected); return true;
  };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
interface Fixture { storage: Storage; now(): number; setNow(value: number): void; pool?: Pool; probe?: Pool }
async function fixture(engine: "Memory" | "Postgres", t: TestContext): Promise<Fixture> {
  let current = Date.now();
  const f: Fixture = { storage: undefined!, now: () => current, setNow: value => { current = value; } };
  if (engine === "Memory") { f.storage = new MemoryStorage(f.now); return f; }
  const connectionString = process.env.VRATA_TEST_POSTGRES_URL;
  assert.ok(connectionString, "CI must supply VRATA_TEST_POSTGRES_URL for guarded access tests");
  const schema = `plugin_access_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString });
  await root.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3000, options: `-c search_path=${schema},public` });
  const probe = new Pool({ connectionString, max: 2, options: `-c search_path=${schema},public` });
  t.after(async () => { await pool.end(); await probe.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool, f.now);
  await storage.init();
  f.storage = storage; f.pool = pool; f.probe = probe;
  return f;
}
function actor(f: Fixture, proof: RoomIdentityRecord): RoomPluginSessionActor {
  return { actorType: "room-session", proof, expiresAtSeconds: Math.ceil((f.now() + 60_000) / 1000) };
}
async function room(f: Fixture) {
  const value = await f.storage.createRoom({ tenantId: "demo-tenant", name: "Guarded plugins" });
  const scope = { tenantId: value.tenantId, roomId: value.roomId };
  const host = await f.storage.roomIdentities.create({ ...scope, displayName: "Host", baseRole: "member",
    provenance: { kind: "invite", inviteId: randomUUID(), role: "host" } });
  await f.storage.roomIdentities.claimHost(host, 0);
  const session = actor(f, host), author = f.storage.roomPluginAccess.author(session);
  return { scope, host, session, author };
}
async function participant(f: Fixture, scope: RoomPluginScope, role: "member" | "guest" = "member") {
  return f.storage.roomIdentities.create({ ...scope, displayName: role, baseRole: role,
    provenance: role === "guest" ? { kind: "guest" } : { kind: "invite", inviteId: randomUUID(), role } });
}
async function publish(f: Fixture, author: RoomPluginAuthorAccess, bytes = artifact()) {
  const ticket = await author.reservePackage(bytes, fingerprint);
  assert.equal(ticket.disposition, "write");
  assert.equal(await f.storage.roomPluginAccess.continuation.settleUpload(ticket, "acked"), null);
  return { ticket, package: await author.publishPackage(ticket), bytes };
}

for (const engine of ["Memory", "Postgres"] as const) {
  test(`${engine}: guarded room plugin access`, { timeout: 120_000,
    skip: engine === "Postgres" && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI }, async t => {
    const f = await fixture(engine, t);
    await t.test("floor one denies sessions and scoped administrators without creating plugin state", async () => {
      const r = await room(f), runtime = f.storage.roomPluginAccess.runtime(r.session);
      const admin = f.storage.roomPluginAccess.author({ actorType: "administrator", scope: r.scope });
      for (const operation of [() => r.author.authorize(), () => r.author.reservePackage(artifact(), fingerprint),
        () => admin.authorize(), () => admin.reservePackage(artifact(), fingerprint),
        () => runtime.releaseSnapshot(() => undefined), () => runtime.prepareBoundContent("unknown"),
        () => r.author.releaseLibrary(() => undefined), () => r.author.removeBinding("unknown", 0)]) {
        await assert.rejects(operation(), code("plugin_identity_not_active"));
      }
      assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
      assert.deepEqual(await f.storage.roomPlugins.readBindings(r.scope), { revision: 0, bindings: [] });
      if (f.pool) assert.equal((await f.pool.query("select count(*) as n from room_plugin_state")).rows[0].n, "0");
      assert.equal(await f.storage.identityProtocol.minimum(), 1);
    });
    // Isolated fixture only. Production/shared floor is untouched.
    await f.storage.identityProtocol.raise(2);

    await t.test("author path applies the same NUL persistence guard without leaving admission state", async () => {
      const r = await room(f);
      const invalid = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "author-persisted-text", version: "1.0.0",
        displayName: "Author persisted text", requestedCapabilities: ["status.set"],
        configSchema: { greeting: { type: "enum", required: true, values: ["valid", "invalid\0choice"] } }
      }, "export function init() {}").bytes;
      await assert.rejects(r.author.reservePackage(invalid, fingerprint), code("plugin_invalid_persisted_text"));
      assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
      assert.deepEqual(await f.storage.roomPlugins.readBindings(r.scope), { revision: 0, bindings: [] });
      if (f.pool) assert.equal((await f.pool.query("select count(*) as n from room_plugin_state where room_id=$1", [r.scope.roomId])).rows[0].n, "0");
      const uploaded = await publish(f, r.author);
      await assert.rejects(r.author.putBinding(uploaded.package.pluginId, { ...binding(uploaded.package), config: { greeting: "before\0after" } }, 0), code("plugin_invalid_persisted_text"));
      assert.deepEqual(await f.storage.roomPlugins.readBindings(r.scope), { revision: 0, bindings: [] });
      const greeting = "preserved\nnewline\u001f";
      const allowed = await r.author.putBinding(uploaded.package.pluginId, { ...binding(uploaded.package), config: { greeting } }, 0);
      assert.equal(allowed.revision, 1);
      assert.deepEqual(allowed.bindings[0].config, { greeting });
    });

    await t.test("Host installs without admin, metadata agrees with T04 and runtime releases enabled exact packages", async () => {
      const r = await room(f), uploaded = await publish(f, r.author);
      assert.equal(uploaded.package.state, "ready");
      const reserved = await r.author.reservePackage(artifact("unsettled"), fingerprint);
      const disabled = await publish(f, r.author, artifact("disabled"));
      await r.author.putBinding(uploaded.package.pluginId, binding(uploaded.package), 0);
      const bindings = await r.author.putBinding(disabled.package.pluginId, binding(disabled.package, false), 1);
      let library: unknown;
      await r.author.releaseLibrary(value => { library = value; return undefined; });
      assert.deepEqual(library, { ...bindings, packages: await f.storage.roomPlugins.listPackages(r.scope) });
      const guest = actor(f, await participant(f, r.scope, "guest"));
      const runtime = f.storage.roomPluginAccess.runtime(guest);
      let snapshot!: RoomPluginRuntimeSnapshot;
      await runtime.releaseSnapshot(value => { snapshot = value; return undefined; });
      assert.deepEqual(snapshot.bindings, bindings.bindings.filter(value => value.enabled));
      assert.equal(snapshot.revision, bindings.revision);
      assert.ok(snapshot.leaseExpiresAtMs <= f.now() + 5000);
      assert.ok(snapshot.leaseExpiresAtMs <= guest.expiresAtSeconds * 1000);
      assert.ok(snapshot.leaseExpiresAtMs > f.now());
      await assert.rejects(runtime.prepareBoundContent(disabled.package.packageId), code("plugin_content_not_bound"));
      await assert.rejects(runtime.prepareBoundContent(reserved.package.packageId), code("plugin_content_not_bound"));
      const ticket = await runtime.prepareBoundContent(uploaded.package.packageId), bytes = new Uint8Array(uploaded.bytes);
      let sent!: Uint8Array;
      const releasing = runtime.releaseBoundContent(ticket, bytes, value => { sent = value; return undefined; });
      bytes.fill(0);
      await releasing;
      assert.deepEqual(sent, uploaded.bytes);
      assert.equal((globalThis as { pluginAccessMustNeverExecute?: boolean }).pluginAccessMustNeverExecute, undefined);
      assert.equal(JSON.stringify(ticket), "{}"); assert.equal(JSON.stringify(uploaded.ticket), "{}");
      assert.equal(Object.isFrozen(ticket.package.manifest), true);
    });

    await t.test("same identity is rechecked after transfers; former Host denied, Member/Guest transfers allowed", async () => {
      const r = await room(f), member = await participant(f, r.scope), guest = await participant(f, r.scope, "guest");
      const memberAuthor = f.storage.roomPluginAccess.author(actor(f, member)), guestAuthor = f.storage.roomPluginAccess.author(actor(f, guest));
      await assert.rejects(memberAuthor.authorize(), code("plugin_author_forbidden"));
      await assert.rejects(guestAuthor.reservePackage(artifact(), fingerprint), code("plugin_author_forbidden"));
      await f.storage.roomIdentities.transferHost(r.host, member.identityId, 1);
      await assert.rejects(r.author.authorize(), code("plugin_author_forbidden"));
      await memberAuthor.authorize();
      await publish(f, memberAuthor);
      await f.storage.roomIdentities.transferHost(member, guest.identityId, 2);
      await assert.rejects(memberAuthor.authorize(), code("plugin_author_forbidden"));
      await guestAuthor.authorize();
      await publish(f, guestAuthor, artifact("transferred-guest"));
      await f.storage.roomIdentities.revoke(r.scope, guest.identityId, guest.authEpoch);
      await assert.rejects(guestAuthor.authorize(), code("identity_not_active"));
      // An empty Host slot never authorizes an arbitrary current Member.
      await assert.rejects(memberAuthor.authorize(), code("plugin_author_forbidden"));
    });

    await t.test("Presenter is not author; admin author is scoped and cannot become runtime", async () => {
      const r = await room(f), member = await participant(f, r.scope);
      await f.storage.roomIdentities.transition(r.scope, r.session, 1, { type: "grant-presenter", targetParticipantId: member.participantId });
      await assert.rejects(f.storage.roomPluginAccess.author(actor(f, member)).authorize(), code("plugin_author_forbidden"));
      const admin = { actorType: "administrator" as const, scope: r.scope };
      await publish(f, f.storage.roomPluginAccess.author(admin));
      assert.throws(() => f.storage.roomPluginAccess.runtime(admin as unknown as RoomPluginSessionActor), code("plugin_identity_not_active"));
      assert.throws(() => f.storage.roomPluginAccess.author({ actorType: "admin-token", scope: r.scope, role: "admin" } as unknown as typeof admin), code("plugin_author_forbidden"));
      await assert.rejects(f.storage.roomPluginAccess.author({ ...admin, scope: { ...r.scope, tenantId: "other-tenant" } }).authorize(), code("room_not_found"));
    });

    await t.test("personal Owner remains author as Member; former Owner loses author access", async () => {
      const owned = await f.storage.createPersonalOwnedRoom({ tenantId: "demo-tenant", displayName: "Owner" });
      const scope = { tenantId: owned.room.tenantId, roomId: owned.room.roomId }, owner = owned.identity;
      const next = await participant(f, scope), ownerAuthor = f.storage.roomPluginAccess.author(actor(f, owner));
      await f.storage.roomIdentities.transferHost(owner, next.identityId, 1);
      assert.equal((await f.storage.roomIdentities.resolve(owner))?.role, "member");
      await publish(f, ownerAuthor);
      await f.storage.roomIdentities.transition(scope, actor(f, owner), 2, { type: "transfer-owner", targetParticipantId: next.participantId });
      await assert.rejects(ownerAuthor.authorize(), code("plugin_author_forbidden"));
      await f.storage.roomPluginAccess.author(actor(f, next)).authorize();
      const standard = await room(f);
      await assert.rejects(f.storage.roomPluginAccess.author({ ...actor(f, owner), proof: { ...owner, ...standard.scope } }).authorize(), code("identity_not_active"));
    });

    await t.test("proof epoch/participant/tenant, removal, end and expired original admission deny release", async () => {
      const r = await room(f), member = await participant(f, r.scope), uploaded = await publish(f, r.author);
      await r.author.putBinding(uploaded.package.pluginId, binding(uploaded.package), 0);
      for (const proof of [{ ...r.host, authEpoch: r.host.authEpoch + 1 }, { ...r.host, participantId: member.participantId },
        { ...r.host, tenantId: "other-tenant" }]) {
        await assert.rejects(f.storage.roomPluginAccess.author({ ...r.session, proof }).authorize(), error => {
          assert.ok(error instanceof IdentityStorageError || error instanceof RoomPluginStorageError);
          assert.ok(["room_not_found", "identity_not_active"].includes(error.code)); return true;
        });
      }
      const session = actor(f, member), runtime = f.storage.roomPluginAccess.runtime(session), ticket = await runtime.prepareBoundContent(uploaded.package.packageId);
      await f.storage.roomIdentities.transition(r.scope, r.session, 1, { type: "remove", targetParticipantId: member.participantId });
      let sends = 0;
      await assert.rejects(runtime.releaseBoundContent(ticket, uploaded.bytes, () => { sends++; return undefined; }), code("identity_not_active"));
      assert.equal(sends, 0);
      const original = actor(f, r.host), deadline = original.expiresAtSeconds * 1000;
      const expiring = f.storage.roomPluginAccess.author(original);
      // Mutation of the caller's actor cannot extend the already-created access facet.
      original.expiresAtSeconds += 600;
      f.setNow(deadline);
      await assert.rejects(expiring.authorize(), code("identity_session_expired"));
      f.setNow(deadline - 1);
      await f.storage.roomIdentities.transition(r.scope, actor(f, r.host), 2, { type: "end" });
      await assert.rejects(r.author.authorize(), code("room_blocked"));
      await assert.rejects(f.storage.roomPluginAccess.author({ actorType: "administrator", scope: r.scope }).authorize(), code("room_blocked"));
    });

    await t.test("content release rechecks config revision, version, disable, unbind and room revision", async () => {
      const r = await room(f), first = await publish(f, r.author), next = await publish(f, r.author, artifact("welcome-status", "2.0.0"));
      const runtime = f.storage.roomPluginAccess.runtime(r.session);
      let current = await r.author.putBinding(first.package.pluginId, binding(first.package), 0), sends = 0;
      const deny = async (change: () => Promise<unknown>, id = first.package.packageId) => {
        const ticket = await runtime.prepareBoundContent(id);
        await change();
        await assert.rejects(runtime.releaseBoundContent(ticket, id === first.package.packageId ? first.bytes : next.bytes,
          () => { sends++; return undefined; }), code("plugin_binding_changed"));
      };
      await deny(async () => { current = await r.author.putBinding(first.package.pluginId, { ...binding(first.package), config: { greeting: "Changed" } }, current.revision); });
      await deny(async () => { current = await r.author.putBinding(next.package.pluginId, binding(next.package), current.revision); });
      await deny(async () => { current = await r.author.putBinding(next.package.pluginId, binding(next.package, false), current.revision); }, next.package.packageId);
      current = await r.author.putBinding(first.package.pluginId, binding(first.package), current.revision);
      await deny(async () => { current = await r.author.removeBinding(first.package.pluginId, current.revision); });
      current = await r.author.putBinding(first.package.pluginId, binding(first.package), current.revision);
      const unrelated = await publish(f, r.author, artifact("unrelated"));
      await deny(async () => { current = await r.author.putBinding(unrelated.package.pluginId, binding(unrelated.package, false), current.revision); });
      assert.equal(sends, 0);
      const valid = await runtime.prepareBoundContent(first.package.packageId);
      await assert.rejects(runtime.releaseBoundContent(valid, artifact("wrong-bytes"), () => { sends++; return undefined; }), { code: "artifact_checksum_mismatch" });
      assert.equal(sends, 0);
    });

    await t.test("ticket capabilities reject JSON clones, foreign factories and foreign access facets", async () => {
      const r = await room(f), uploaded = await publish(f, r.author), second = f.storage.roomPluginAccess.author(r.session);
      const clone = JSON.parse(JSON.stringify(uploaded.ticket)) as RoomPluginUploadTicket;
      await assert.rejects(second.publishPackage(uploaded.ticket), code("plugin_ticket_invalid"));
      await assert.rejects(r.author.publishPackage(clone), code("plugin_ticket_invalid"));
      const foreign = new MemoryStorage().roomPluginAccess;
      await assert.rejects(foreign.continuation.settleUpload(uploaded.ticket, "acked"), code("plugin_ticket_invalid"));
      await r.author.putBinding(uploaded.package.pluginId, binding(uploaded.package), 0);
      const runtime = f.storage.roomPluginAccess.runtime(r.session), ticket = await runtime.prepareBoundContent(uploaded.package.packageId);
      await assert.rejects(f.storage.roomPluginAccess.runtime(r.session).releaseBoundContent(ticket, uploaded.bytes, () => undefined), code("plugin_ticket_invalid"));
      await assert.rejects(runtime.releaseBoundContent(JSON.parse(JSON.stringify(ticket)), uploaded.bytes, () => undefined), code("plugin_ticket_invalid"));
      await assert.rejects(f.storage.roomPluginAccess.continuation.confirmDeletion(uploaded.ticket as unknown as RoomPluginCleanupTicket), code("plugin_ticket_invalid"));
      await assert.rejects(runtime.releaseBoundContent(ticket, uploaded.bytes, (async () => undefined) as unknown as (value: Uint8Array) => undefined), /plugin_release_callback_not_synchronous/);
    });

    await t.test("reserve is ready-idempotent, unsettled stays pending, settled resume does not admit a second writer", async () => {
      const r = await room(f), ticket = await r.author.reservePackage(artifact(), fingerprint);
      await assert.rejects(r.author.reservePackage(artifact(), fingerprint), code("plugin_upload_pending"));
      await assert.rejects(f.storage.roomPluginAccess.continuation.abandonUnpublished(ticket), code("plugin_upload_pending"));
      assert.equal((await f.storage.roomPlugins.getPackage(r.scope, ticket.package.packageId))?.uploadSettled, false);
      await f.storage.roomPluginAccess.continuation.settleUpload(ticket, "acked");
      // T04's legacy reserve behavior is deliberately unchanged.
      await assert.rejects(f.storage.roomPlugins.reservePackage(r.scope, artifact(), fingerprint), code("plugin_upload_pending"));
      const nextAuthor = f.storage.roomPluginAccess.author(r.session), resumed = await nextAuthor.reservePackage(artifact(), fingerprint);
      assert.equal(resumed.disposition, "resume"); assert.equal(resumed.package.packageId, ticket.package.packageId);
      await assert.rejects(f.storage.roomPluginAccess.continuation.settleUpload(resumed, "rejected"), code("plugin_ticket_invalid"));
      const published = await nextAuthor.publishPackage(resumed), ready = await nextAuthor.reservePackage(artifact(), fingerprint);
      assert.equal(ready.disposition, "ready"); assert.deepEqual(await nextAuthor.publishPackage(ready), published);
      assert.equal(await f.storage.roomPluginAccess.continuation.abandonUnpublished(ticket), null);
      await assert.rejects(nextAuthor.reservePackage(artifact("welcome-status", "1.0.0").map((b, i) => i === 0 ? 0 : b), fingerprint));
      assert.equal((await f.storage.roomPlugins.listPackages(r.scope)).length, 1);
    });

    await t.test("continuations settle/abandon admitted uploads after revoke, never publish or delete current ready", async () => {
      const r = await room(f), unknown = await r.author.reservePackage(artifact("unknown"), fingerprint);
      const rejected = await r.author.reservePackage(artifact("rejected"), fingerprint), acked = await r.author.reservePackage(artifact("acked"), fingerprint);
      await f.storage.roomIdentities.revoke(r.scope, r.host.identityId, r.host.authEpoch);
      const continuation = f.storage.roomPluginAccess.continuation;
      await assert.rejects(r.author.publishPackage(acked), code("identity_not_active"));
      await assert.rejects(continuation.abandonUnpublished(unknown), code("plugin_upload_pending"));
      const cleanup = await continuation.settleUpload(rejected, "rejected"); assert.ok(cleanup);
      await continuation.confirmDeletion(cleanup); await continuation.confirmDeletion(cleanup);
      await assert.rejects(continuation.settleUpload(rejected, "acked"), code("plugin_ticket_invalid"));
      assert.equal(await continuation.settleUpload(acked, "acked"), null);
      const abandoned = await continuation.abandonUnpublished(acked); assert.ok(abandoned);
      await continuation.confirmDeletion(abandoned);
      assert.deepEqual((await f.storage.roomPlugins.listPackages(r.scope)).map(value => [value.packageId, value.state, value.uploadSettled]),
        [[unknown.package.packageId, "reserved", false]]);
      assert.equal("publishPackage" in continuation, false); assert.equal("putBinding" in continuation, false);
    });

    await t.test("author deletion requires unbind; committed cleanup intent survives auth loss and room-delete retry", async () => {
      const r = await room(f), uploaded = await publish(f, r.author);
      await r.author.putBinding(uploaded.package.pluginId, binding(uploaded.package), 0);
      await assert.rejects(r.author.beginPackageDeletion(uploaded.package.packageId), code("plugin_package_bound"));
      await r.author.removeBinding(uploaded.package.pluginId, 1);
      const cleanup = await r.author.beginPackageDeletion(uploaded.package.packageId);
      await f.storage.roomIdentities.revoke(r.scope, r.host.identityId, r.host.authEpoch);
      await f.storage.roomPluginAccess.continuation.confirmDeletion(cleanup);
      const deletion = await f.storage.roomPlugins.beginRoomDeletion(r.scope);
      assert.equal(await f.storage.deleteRoom(r.scope.roomId, { tenantId: r.scope.tenantId, deletionId: deletion.deletionId }), true);
      const racing = await room(f), pending = await racing.author.reservePackage(artifact(), fingerprint);
      const intent = await f.storage.roomPlugins.beginRoomDeletion(racing.scope);
      await assert.rejects(f.storage.deleteRoom(racing.scope.roomId, { tenantId: racing.scope.tenantId, deletionId: intent.deletionId }), code("room_plugin_cleanup_pending"));
      const terminal = await f.storage.roomPluginAccess.continuation.settleUpload(pending, "acked"); assert.ok(terminal);
      await f.storage.roomPluginAccess.continuation.confirmDeletion(terminal);
      assert.equal((await f.storage.roomPlugins.beginRoomDeletion(racing.scope)).deletionId, intent.deletionId);
      assert.equal(await f.storage.deleteRoom(racing.scope.roomId, { tenantId: racing.scope.tenantId, deletionId: intent.deletionId }), true);
    });

    await t.test("room deletion recovers an ACK-settled orphan with no surviving upload ticket or producer callback", async st => {
      const r = await room(f), bytes = artifact("ticketless-orphan"), objects = new Map<string, Uint8Array>();
      const admitted = await (async () => {
        const ticket = await r.author.reservePackage(bytes, fingerprint);
        objects.set(ticket.package.storageKey, new Uint8Array(bytes)); // the original PUT received its known ACK
        await f.storage.roomPluginAccess.continuation.settleUpload(ticket, "acked");
        // Only metadata and a non-capability JSON copy survive the publisher's request.
        return { package: ticket.package, lostTicket: JSON.parse(JSON.stringify(ticket)) as RoomPluginUploadTicket };
      })();
      const fresh = f.pool ? new PostgresStorage(f.pool, f.now) : f.storage;
      if (fresh instanceof PostgresStorage) await fresh.init();
      // Memory has no disk restart: retained metadata is shared, while a new factory models loss of request tickets.
      const freshAccess = f.pool ? fresh.roomPluginAccess : new MemoryStorage(f.now).roomPluginAccess;
      await assert.rejects(freshAccess.continuation.abandonUnpublished(admitted.lostTicket), code("plugin_ticket_invalid"));
      await assert.rejects(freshAccess.continuation.confirmDeletion(admitted.lostTicket as unknown as RoomPluginCleanupTicket), code("plugin_ticket_invalid"));
      let producerCallbacks = 0;
      for (const method of ["settleUpload", "abandonUnpublished", "confirmDeletion"] as const) {
        st.mock.method(f.storage.roomPluginAccess.continuation, method, async () => {
          producerCallbacks++; throw new Error("original_ticket_producer_is_gone");
        });
      }
      const persisted = await fresh.roomPlugins.getPackage(r.scope, admitted.package.packageId);
      assert.equal(persisted?.state, "reserved"); assert.equal(persisted?.uploadSettled, true);
      const intent = await fresh.roomPlugins.beginRoomDeletion(r.scope);
      assert.equal(intent.packages[0].state, "cleanup-pending");
      await assert.rejects(fresh.roomPluginAccess.author(r.session).reservePackage(bytes, fingerprint), code("room_plugin_cleanup_pending"));
      let deletes = 0, reads = 0;
      assert.equal(await deleteRoomWithPluginCleanup(fresh, r.scope, () => ({ backendFingerprint: fingerprint,
        async put() { throw new Error("room_deletion_must_not_start_a_second_PUT"); },
        async read() { reads++; throw new Error("room_deletion_must_not_guess_settlement"); },
        async delete(scope, key) { assert.deepEqual(scope, r.scope); deletes++; objects.delete(key); }
      })), true);
      assert.equal(objects.size, 0); assert.equal(deletes, 1); assert.equal(reads, 0);
      assert.equal(producerCallbacks, 0);
      assert.equal(await fresh.getRoom(r.scope.roomId), null);
    });

    await t.test("lease never exceeds the original short session deadline", async () => {
      const r = await room(f), expiresAtSeconds = Math.ceil((f.now() + 1000) / 1000);
      const runtime = f.storage.roomPluginAccess.runtime({ ...r.session, expiresAtSeconds });
      await runtime.releaseSnapshot(value => { assert.equal(value.leaseExpiresAtMs, expiresAtSeconds * 1000); return undefined; });
    });

    if (f.pool && f.probe) {
      await t.test("concurrent init holds rooms exclusively while settlement waits without holding policy", async st => {
        const r = await room(f), ticket = await r.author.reservePackage(artifact("init-settlement"), fingerprint);
        const observer = await f.probe!.connect();
        const initClient = await f.probe!.connect();
        const initPid = (await initClient.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        initClient.release();
        const pluginClient = await f.pool!.connect();
        const pluginPid = (await pluginClient.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        pluginClient.release();
        const signatureSql = `select minimum_protocol,media_namespace,
          (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname=current_schema() and p.proname='vrata_identity_v2_room_boundary' and p.pronargs=0) as guard_hash
          from room_identity_protocol_policy where singleton=true`;
        const before = (await observer.query(signatureSql)).rows[0];
        assert.equal(before.minimum_protocol, 2); assert.match(before.guard_hash, /^[a-f0-9]{32}$/);
        const reachedPolicyAlter = deferred(), continueInit = deferred();
        const query = initClient.query.bind(initClient);
        let paused = false;
        const intercepted = st.mock.method(initClient, "query", (async (...args: Parameters<PoolClient["query"]>) => {
          // Pause the real initializer before its schema batch containing policy ALTER, after its rooms ALTERs.
          // No lock or production hook is synthesized: pg_locks below verifies the actual held room lock.
          if (!paused && typeof args[0] === "string" && /alter table room_identity_protocol_policy/i.test(args[0])) {
            paused = true; reachedPolicyAlter.resolve(); await continueInit.promise;
          }
          return (query as (...a: unknown[]) => Promise<unknown>)(...args);
        }) as PoolClient["query"]);
        const initializer = new PostgresStorage(f.probe!, f.now);
        const initializing = initializer.init().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        let settling: Promise<{ ok: true; value: RoomPluginCleanupTicket | null } | { ok: false; error: unknown }> | undefined;
        try {
          await Promise.race([reachedPolicyAlter.promise, initializing.then(result => {
            if (!result.ok) throw result.error;
            throw new Error("initializer_did_not_reach_policy_alter");
          })]);
          assert.equal((await observer.query(`select exists(select 1 from pg_locks
            where pid=$1 and relation='rooms'::regclass and mode='AccessExclusiveLock' and granted) as held`, [initPid])).rows[0].held,
          true, "the real init transaction must hold rooms AccessExclusive before policy ALTER");
          settling = f.storage.roomPluginAccess.continuation.settleUpload(ticket, "acked")
            .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
          let blockers: number[] = [];
          const until = Date.now() + 3000;
          do {
            blockers = (await observer.query("select pg_blocking_pids($1) as blockers", [pluginPid])).rows[0].blockers as number[];
            if (blockers.includes(initPid)) break;
            await delay(10);
          } while (Date.now() < until);
          assert.ok(blockers.includes(initPid), "settlement must really wait behind the initializer, not a timer or fabricated lock");
          const waiting = (await observer.query(`select
            exists(select 1 from pg_locks where pid=$1 and relation='rooms'::regclass
              and mode='RowShareLock' and not granted) as room_wait,
            exists(select 1 from pg_locks where pid=$1 and relation='room_identity_protocol_policy'::regclass) as policy_lock`, [pluginPid])).rows[0];
          assert.equal(waiting.room_wait, true);
          assert.equal(waiting.policy_lock, false, "a plugin waiting for rooms must not obstruct init's policy ALTER");
          continueInit.resolve();
          const [initialized, settled] = await Promise.all([initializing, settling]);
          assert.equal(initialized.ok, true, !initialized.ok ? String(initialized.error) : undefined);
          assert.equal(settled.ok, true, !settled.ok ? String(settled.error) : undefined);
          if (settled.ok) assert.equal(settled.value, null);
          assert.deepEqual((await observer.query(signatureSql)).rows[0], before, "floor, namespace and activated guard hash survive reinit unchanged");
          const persisted = await f.storage.roomPlugins.getPackage(r.scope, ticket.package.packageId);
          assert.equal(persisted?.state, "reserved"); assert.equal(persisted?.uploadSettled, true);
          assert.equal((await r.author.publishPackage(ticket)).state, "ready");
        } finally {
          continueInit.resolve();
          await Promise.all([initializing, settling]);
          intercepted.mock.restore(); observer.release();
        }
      });
      await t.test("guarded reads share the parent fence and all successful operations acquire exactly one client", async () => {
        const r = await room(f), holder = await f.probe!.connect();
        const connects = t.mock.method(f.pool!, "connect");
        try {
          await holder.query("begin");
          await holder.query("select 1 from rooms where tenant_id=$1 and room_id=$2 for share", [r.scope.tenantId, r.scope.roomId]);
          await r.author.authorize();
          await r.author.releaseLibrary(() => undefined);
          await f.storage.roomPluginAccess.runtime(r.session).releaseSnapshot(() => undefined);
          assert.equal(connects.mock.callCount(), 3, "reads must not recursively connect through the identity effect facade");
          let finished = false;
          const waiting = r.author.reservePackage(artifact(), fingerprint).then(value => { finished = true; return value; });
          await delay(50); assert.equal(finished, false, "writes must conflict with the existing parent SHARE lock");
          await holder.query("rollback");
          await waiting;
          assert.equal(connects.mock.callCount(), 4);
        } finally { connects.mock.restore(); await holder.query("rollback"); holder.release(); }
      });
      await t.test("parent DB-held wait rechecks original session deadline, one client and no plugin state on denial", async () => {
        const r = await room(f), deadline = r.session.expiresAtSeconds * 1000;
        const holder = await f.probe!.connect();
        try {
          await holder.query("begin");
          await holder.query("select 1 from rooms where tenant_id=$1 and room_id=$2 for update", [r.scope.tenantId, r.scope.roomId]);
          const connects = t.mock.method(f.pool!, "connect");
          let finished = false;
          const waiting = r.author.reservePackage(artifact(), fingerprint).finally(() => { finished = true; });
          const denied = assert.rejects(waiting, code("identity_session_expired"));
          await delay(50); assert.equal(finished, false);
          f.setNow(deadline);
          await holder.query("rollback");
          await denied;
          assert.equal(connects.mock.callCount(), 1); connects.mock.restore();
          assert.equal((await f.pool!.query("select count(*) as n from room_plugin_state where room_id=$1", [r.scope.roomId])).rows[0].n, "0");
        } finally { await holder.query("rollback"); holder.release(); }
      });
      await t.test("expiry after awaited insert rolls metadata back, rather than committing an expired write", async () => {
        const r = await room(f), originalTime = f.now(), deadline = r.session.expiresAtSeconds * 1000;
        const client = await f.pool!.connect(), query = client.query.bind(client);
        client.release();
        const intercepted = t.mock.method(client, "query", (async (...args: Parameters<PoolClient["query"]>) => {
          const result = await (query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("insert into room_plugin_packages")) f.setNow(deadline);
          return result;
        }) as PoolClient["query"]);
        try { await assert.rejects(r.author.reservePackage(artifact(), fingerprint), code("identity_session_expired")); }
        finally { intercepted.mock.restore(); f.setNow(originalTime); }
        assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
        assert.equal((await f.pool!.query("select count(*) as n from room_plugin_state where room_id=$1", [r.scope.roomId])).rows[0].n, "0");
      });
      await t.test("uncertain publish commit never generates an automatic compensating deletion", async () => {
        const r = await room(f), ticket = await r.author.reservePackage(artifact(), fingerprint);
        await f.storage.roomPluginAccess.continuation.settleUpload(ticket, "acked");
        const client = await f.pool!.connect(), query = client.query.bind(client);
        client.release();
        const intercepted = t.mock.method(client, "query", (async (...args: Parameters<PoolClient["query"]>) => {
          const result = await (query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (args[0] === "commit") throw new Error("publish_commit_ack_lost");
          return result;
        }) as PoolClient["query"]);
        try { await assert.rejects(r.author.publishPackage(ticket), RoomFenceCommitUncertain); }
        finally { intercepted.mock.restore(); }
        assert.equal((await f.storage.roomPlugins.getPackage(r.scope, ticket.package.packageId))?.state, "ready");
        assert.equal(await f.storage.roomPluginAccess.continuation.abandonUnpublished(ticket), null);
        assert.equal((await f.storage.roomPlugins.getPackage(r.scope, ticket.package.packageId))?.state, "ready");
        // A separate, explicit room deletion is authorized to retire ready state even after a lost publish ACK.
        const intent = await f.storage.roomPlugins.beginRoomDeletion(r.scope);
        assert.equal(intent.packages[0].state, "cleanup-pending");
        await f.storage.roomPlugins.confirmPackageDeletion(r.scope, ticket.package.packageId);
        assert.equal(await f.storage.deleteRoom(r.scope.roomId, { tenantId: r.scope.tenantId, deletionId: intent.deletionId }), true);
      });
      await t.test("expiry after awaited binding metadata prevents content and snapshot release", async () => {
        const r = await room(f), uploaded = await publish(f, r.author);
        await r.author.putBinding(uploaded.package.pluginId, binding(uploaded.package), 0);
        const runtime = f.storage.roomPluginAccess.runtime(r.session), ticket = await runtime.prepareBoundContent(uploaded.package.packageId);
        const originalTime = f.now(), deadline = r.session.expiresAtSeconds * 1000;
        const client = await f.pool!.connect(), query = client.query.bind(client);
        client.release();
        let sends = 0;
        const intercepted = t.mock.method(client, "query", (async (...args: Parameters<PoolClient["query"]>) => {
          const result = await (query as (...a: unknown[]) => Promise<unknown>)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("select * from room_plugin_bindings")) f.setNow(deadline);
          return result;
        }) as PoolClient["query"]);
        try {
          await assert.rejects(runtime.releaseBoundContent(ticket, uploaded.bytes, () => { sends++; return undefined; }), code("identity_session_expired"));
          f.setNow(originalTime);
          await assert.rejects(runtime.releaseSnapshot(() => { sends++; return undefined; }), code("identity_session_expired"));
          assert.equal(sends, 0);
        } finally { intercepted.mock.restore(); f.setNow(originalTime); }
      });
    }
  });
}

test("Owner exception is personal-only, not a generic isOwner override", () => {
  const current = { role: "member", isOwner: true } as Parameters<typeof assertPluginAuthor>[0];
  assert.doesNotThrow(() => assertPluginAuthor(current, "personal"));
  assert.throws(() => assertPluginAuthor(current, "standard"), code("plugin_author_forbidden"));
});

test("Memory queue wait checks the original deadline before private state creation", async () => {
  let now = Date.now();
  const f: Fixture = { storage: new MemoryStorage(() => now), now: () => now, setNow: value => { now = value; } };
  await f.storage.identityProtocol.raise(2);
  const r = await room(f), started = deferred();
  const read = r.author.releaseLibrary(() => { started.resolve(); return undefined; });
  await started.promise;
  const waiting = r.author.reservePackage(artifact(), fingerprint);
  const denied = assert.rejects(waiting, code("identity_session_expired"));
  now = r.session.expiresAtSeconds * 1000;
  // The already-released reader may fail its final clock check, but the queued writer must also deny.
  await Promise.allSettled([read]); await denied;
  assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
});

test("Memory expiry immediately before private-copy commit rolls back inserted metadata", async () => {
  let now = Date.now(), deadline = 0, checks = 0, expireAtCommit = false;
  const clock = () => { if (expireAtCommit && ++checks === 3) now = deadline; return now; };
  const f: Fixture = { storage: new MemoryStorage(clock), now: clock, setNow: value => { now = value; } };
  await f.storage.identityProtocol.raise(2);
  const r = await room(f); deadline = r.session.expiresAtSeconds * 1000;
  expireAtCommit = true;
  await assert.rejects(r.author.reservePackage(artifact(), fingerprint), code("identity_session_expired"));
  assert.equal(checks, 3);
  expireAtCommit = false;
  assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
});

test("Memory transfer during awaited metadata prevents a private-copy commit", async () => {
  let checks = 0, tracking = false;
  const admitted = deferred();
  const clock = () => { if (tracking && ++checks === 1) admitted.resolve(); return Date.now(); };
  const f: Fixture = { storage: new MemoryStorage(clock), now: clock, setNow() {} };
  await f.storage.identityProtocol.raise(2);
  const r = await room(f), next = await participant(f, r.scope);
  checks = 0; tracking = true;
  const reserving = r.author.reservePackage(artifact(), fingerprint);
  const denied = assert.rejects(reserving, code("plugin_author_forbidden"));
  await admitted.promise;
  assert.equal(checks, 1, "the initial guard has passed and metadata is already operating on the private copy");
  await f.storage.roomIdentities.transferHost(r.host, next.identityId, 1);
  await denied;
  assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
});

test("Memory administrator does not cache room-active admission", async () => {
  const f: Fixture = { storage: new MemoryStorage(), now: Date.now, setNow() {} };
  await f.storage.identityProtocol.raise(2);
  const r = await room(f), admin = f.storage.roomPluginAccess.author({ actorType: "administrator", scope: r.scope });
  await admin.authorize();
  const reserving = admin.reservePackage(artifact(), fingerprint);
  const denied = assert.rejects(reserving, code("room_blocked"));
  await Promise.resolve();
  await f.storage.roomIdentities.transition(r.scope, r.session, 1, { type: "end" });
  await denied;
  assert.deepEqual(await f.storage.roomPlugins.listPackages(r.scope), []);
});
