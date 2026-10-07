import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { ROOM_PLUGIN_LIMITS, validateRoomPluginConfig, validateRoomPluginData, type RoomPluginCapability } from "@vrata/room-plugin-sdk";
import { createRoomPluginArtifact, validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { MemoryStorage, PostgresStorage } from "../storage.js";
import type { Storage } from "../storage-contracts.js";
import { RoomPluginBlobWriteUncertain, type RoomPluginBlobStorage } from "./blob-storage.js";
import { RoomPluginStorageError, type RoomPluginPackage, type RoomPluginScope } from "./contracts.js";
import { createRoomPluginPackageService, deleteRoomWithPluginCleanup, RoomPluginOperationPending } from "./package-service.js";
import { roomPluginPrefix } from "./storage.js";
import { ROOM_PLUGIN_STORAGE_LIMITS } from "./policy.js";
import { RoomPluginBlobConfigurationError } from "./blob-errors.js";

const artifact = (id = "welcome-status", version = "1.0.0", capabilities: readonly RoomPluginCapability[] = ["status.set"], padding = 0) =>
  createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id, version, displayName: id, requestedCapabilities: capabilities,
    configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 40 } } },
  `globalThis.pluginStorageMustNeverExecute = true; export function init() {} /*${"x".repeat(padding)}*/`).bytes;

function binding(value: RoomPluginPackage, enabled = true) {
  return { packageId: value.packageId, version: value.version, artifactSha256: value.artifactSha256,
    enabled, approvedCapabilities: ["status.set"] as RoomPluginCapability[], config: { greeting: "Hello" } };
}
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof RoomPluginStorageError);
  assert.equal(error.code, expected);
  return true;
};
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

interface Fixture {
  storage: Storage;
  concurrentStorage: Storage;
  fenceProbesEnabled: boolean;
  restart(): Promise<Storage>;
  checkNoFence(scope: RoomPluginScope): Promise<void>;
  pool?: Pool;
  lockPool?: Pool;
}
async function fixture(engine: "Memory" | "Postgres", t: TestContext): Promise<Fixture> {
  if (engine === "Memory") { const storage = new MemoryStorage(); return { storage, concurrentStorage: storage, fenceProbesEnabled: true,
    async restart() { return storage; }, async checkNoFence() {} }; }
  const connectionString = process.env.VRATA_TEST_POSTGRES_URL;
  assert.ok(connectionString, "VRATA_TEST_POSTGRES_URL is required for real PG verification");
  const schema = `plugin_contract_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString });
  await root.query(`create schema "${schema}"`);
  // max=1 makes accidental pool access inside a transaction observable, rather than hiding a deadlock.
  const pool = new Pool({ connectionString, max: 1, options: `-c search_path=${schema},public` });
  const probe = new Pool({ connectionString, max: 1, options: `-c search_path=${schema},public` });
  const racingPool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` });
  t.after(async () => { await pool.end(); await probe.end(); await racingPool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool);
  await storage.init();
  const f: Fixture = {
    storage, pool, lockPool: probe, concurrentStorage: new PostgresStorage(racingPool), fenceProbesEnabled: true,
    async restart() { const reopened = new PostgresStorage(pool); await reopened.init(); return reopened; },
    async checkNoFence(scope) {
      // In parallel-upload cases a different request may legitimately own the same parent lock.
      // The dedicated single-upload/failure/reconciliation cases keep this NOWAIT assertion enabled.
      if (!f.fenceProbesEnabled) return;
      const client = await probe.connect();
      try {
        await client.query("begin");
        await client.query("select 1 from rooms where tenant_id=$1 and room_id=$2 for update nowait", [scope.tenantId, scope.roomId]);
      } finally { await client.query("rollback"); client.release(); }
    }
  };
  return f;
}
async function concurrentOperations<T>(f: Fixture, operation: () => Promise<T>): Promise<T> {
  f.fenceProbesEnabled = false;
  try { return await operation(); } finally { f.fenceProbesEnabled = true; }
}
async function room(f: Fixture): Promise<RoomPluginScope> {
  const value = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Plugin storage contract" });
  return { tenantId: value.tenantId, roomId: value.roomId };
}
function blobs(f: Fixture) {
  const objects = new Map<string, Uint8Array>();
  const calls = { put: 0, delete: 0 };
  const adapter: RoomPluginBlobStorage = {
    backendFingerprint: "b".repeat(64),
    async put(scope, key, bytes) { await f.checkNoFence(scope); calls.put++; assert.ok(!objects.has(key)); objects.set(key, new Uint8Array(bytes)); },
    async read(scope, key) { await f.checkNoFence(scope); const bytes = objects.get(key); if (!bytes) throw new Error("object_not_found"); return new Uint8Array(bytes); },
    async delete(scope, key) { await f.checkNoFence(scope); calls.delete++; objects.delete(key); }
  };
  return { objects, calls, adapter };
}

for (const engine of ["Memory", "Postgres"] as const) {
  test(`${engine}: room plugin package/binding persistence contract`, {
    skip: engine === "Postgres" && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI,
    timeout: 240_000
  }, async t => {
    const f = await fixture(engine, t);
    await t.test("reads use the parent share fence and leave an uninitialized room at revision zero", async () => {
      const scope = await room(f);
      const holder = await f.lockPool?.connect();
      try {
        if (holder) {
          await holder.query("begin");
          await holder.query("select 1 from rooms where tenant_id=$1 and room_id=$2 for share", [scope.tenantId, scope.roomId]);
        }
        const [packages, missing, bindings] = await Promise.all([
          f.storage.roomPlugins.listPackages(scope), f.storage.roomPlugins.getPackage(scope, "absent"), f.storage.roomPlugins.readBindings(scope)
        ]);
        assert.deepEqual(packages, []); assert.equal(missing, null);
        assert.deepEqual(bindings, { revision: 0, bindings: [] });
        if (f.pool) assert.equal((await f.pool.query("select count(*) as n from room_plugin_state where tenant_id=$1 and room_id=$2", [scope.tenantId, scope.roomId])).rows[0].n, "0");
      } finally { if (holder) { await holder.query("rollback"); holder.release(); } }
      if (f.lockPool) {
        const writer = await f.lockPool.connect();
        try {
          await writer.query("begin");
          await writer.query("select 1 from rooms where tenant_id=$1 and room_id=$2 for update", [scope.tenantId, scope.roomId]);
          let completed = false;
          const waiting = f.storage.roomPlugins.readBindings(scope).then(value => { completed = true; return value; });
          await delay(30); assert.equal(completed, false, "reads must observe the authoritative parent write fence");
          await writer.query("rollback");
          assert.deepEqual(await waiting, { revision: 0, bindings: [] });
        } finally { await writer.query("rollback"); writer.release(); }
      }
    });
    await t.test("original bytes, SDK validation, immutability and room/tenant scope", async () => {
      const scope = await room(f), other = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const bytes = Buffer.concat([Buffer.from(" \n"), Buffer.from(artifact()), Buffer.from(" \n")]);
      const expected = validateRoomPluginArtifact(bytes);
      const saved = await service.savePackage(scope, bytes);
      bytes.fill(0);
      assert.equal(saved.artifactSha256, expected.artifactSha256);
      assert.equal(saved.byteLength, expected.byteLength);
      assert.deepEqual(await service.readPackage(scope, saved.packageId), expected.bytes);
      assert.equal(saved.state, "ready");
      assert.ok(saved.storageKey.startsWith(roomPluginPrefix(scope)));
      assert.equal(objects.calls.put, 1);
      assert.equal((await service.savePackage(scope, expected.bytes)).packageId, saved.packageId);
      assert.equal(objects.calls.put, 1);
      await assert.rejects(service.savePackage(scope, artifact()), code("plugin_version_conflict"));
      assert.equal(await f.storage.roomPlugins.getPackage(other, saved.packageId), null);
      const wrongTenant = { ...scope, tenantId: "not-this-tenant" };
      await assert.rejects(service.readPackage(wrongTenant, saved.packageId), code("room_not_found"));
      await assert.rejects(service.deletePackage(other, saved.packageId), code("plugin_package_not_found"));
      await assert.rejects(f.storage.roomPlugins.putBinding(other, saved.pluginId, binding(saved), 0), code("plugin_package_not_found"));
      await assert.rejects(service.savePackage(scope, new Uint8Array(ROOM_PLUGIN_LIMITS.artifactBytes + 1)), { code: "artifact_too_large" });
      await assert.rejects(service.savePackage(scope, Buffer.from('{"entry":"while(true){}","manifest":{}}')));
      assert.equal((await f.storage.roomPlugins.listPackages(scope)).length, 1);
      assert.equal((globalThis as { pluginStorageMustNeverExecute?: boolean }).pluginStorageMustNeverExecute, undefined);
      // Returned DTOs cannot mutate metadata.
      const mutableCopy = (await f.storage.roomPlugins.getPackage(scope, saved.packageId))!;
      mutableCopy.manifest.displayName = "Mutated copy";
      assert.equal((await f.storage.roomPlugins.getPackage(scope, saved.packageId))?.manifest.displayName, "welcome-status");
      objects.objects.set(saved.storageKey, artifact("another-plugin"));
      await assert.rejects(service.readPackage(scope, saved.packageId), { code: "artifact_checksum_mismatch" });
    });

    await t.test("SDK-valid NUL enum values fail before reservation, quota changes or blob IO", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      // 'default' is a legal config field name. Its enum strings are persisted inside the manifest too.
      for (const field of ["greeting", "default"]) {
        const bytes = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "nul-enum", version: "1.0.0",
          displayName: "NUL enum", requestedCapabilities: ["status.set"],
          configSchema: { [field]: { type: "enum", required: true, values: ["normal", "invalid\0choice"] } }
        }, "export function init() {}").bytes;
        assert.equal(validateRoomPluginArtifact(bytes).artifact.manifest.configSchema[field].type, "enum");
        await assert.rejects(service.savePackage(scope, bytes), code("plugin_invalid_persisted_text"));
        assert.deepEqual(await f.storage.roomPlugins.listPackages(scope), []);
        assert.deepEqual(await f.storage.roomPlugins.readBindings(scope), { revision: 0, bindings: [] });
      }
      assert.deepEqual(objects.calls, { put: 0, delete: 0 });
      if (f.pool) {
        assert.equal((await f.pool.query("select count(*) as n from room_plugin_state where room_id=$1", [scope.roomId])).rows[0].n, "0");
        assert.equal((await f.pool.query("select count(*) as n,coalesce(sum(byte_length),0) as bytes from room_plugin_packages where room_id=$1", [scope.roomId])).rows[0].n, "0");
      }
      // A refused version has no tombstone or reservation: corrected bytes can claim that same release.
      const corrected = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "nul-enum", version: "1.0.0",
        displayName: "NUL enum", requestedCapabilities: ["status.set"],
        configSchema: { greeting: { type: "enum", required: true, values: ["normal", "line\nbreak\u001f"] } }
      }, "export function init() {}").bytes;
      const saved = await service.savePackage(scope, corrected);
      assert.equal(saved.state, "ready"); assert.equal(objects.calls.put, 1);
      assert.deepEqual((saved.manifest.configSchema.greeting as { values: readonly string[] }).values, ["normal", "line\nbreak\u001f"]);
    });

    await t.test("config NUL denial leaves revision and package quota intact and issues no SQL writes", async st => {
      const scope = await room(f), objects = blobs(f);
      const saved = await createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter).savePackage(scope, artifact("nul-config"));
      const initial = await f.storage.roomPlugins.putBinding(scope, saved.pluginId, binding(saved), 0);
      const packages = await f.storage.roomPlugins.listPackages(scope), writes: string[] = [];
      const client = await f.pool?.connect(), query = client?.query.bind(client);
      client?.release();
      const intercepted = client && st.mock.method(client, "query", ((...args: unknown[]) => {
        if (typeof args[0] === "string" && /^\s*(?:insert|update|delete)\b/i.test(args[0])) writes.push(args[0]);
        return (query as (...args: unknown[]) => unknown)(...args);
      }) as PoolClient["query"]);
      try {
        for (const greeting of ["\0", "before\0after", "suffix\0"]) {
          const input = { ...binding(saved), config: { greeting } };
          assert.deepEqual({ ...validateRoomPluginConfig(saved.manifest.configSchema, input.config) }, input.config);
          await assert.rejects(f.storage.roomPlugins.putBinding(scope, saved.pluginId, input, initial.revision), code("plugin_invalid_persisted_text"));
          assert.deepEqual(await f.storage.roomPlugins.readBindings(scope), initial);
          assert.deepEqual(await f.storage.roomPlugins.listPackages(scope), packages);
          assert.equal(input.config.greeting, greeting, "refused input is not normalized or mutated");
        }
        assert.deepEqual(writes, [], "validation denial must precede every SQL mutation, including state initialization");
      } finally { intercepted?.mock.restore(); }
      const greeting = "line 1\nline 2\t\r\u001f";
      const updated = await f.storage.roomPlugins.putBinding(scope, saved.pluginId, { ...binding(saved), config: { greeting } }, initial.revision);
      assert.equal(updated.revision, initial.revision + 1);
      assert.deepEqual(updated.bindings[0].config, { greeting });
      assert.deepEqual((await (await f.restart()).roomPlugins.readBindings(scope)).bindings[0].config, { greeting });
      assert.deepEqual(await f.storage.roomPlugins.listPackages(scope), packages);
    });

    await t.test("entry source NUL and JS escapes are blob bytes, while unsupported schema defaults remain SDK errors", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const entry = 'export function init() { const literal = "before\0after"; const escaped = "\\u0000"; return escaped; }';
      const bytes = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "entry-nul", version: "1.0.0",
        displayName: "Entry bytes", requestedCapabilities: ["status.set"],
        configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 40 } }
      }, entry).bytes;
      assert.equal(validateRoomPluginArtifact(bytes).artifact.entry, entry);
      const saved = await service.savePackage(scope, bytes);
      assert.deepEqual(await service.readPackage(scope, saved.packageId), bytes);
      assert.equal(saved.artifactSha256, validateRoomPluginArtifact(bytes).artifactSha256);
      const original = validateRoomPluginArtifact(bytes).artifact;
      // SDK v1 intentionally has no defaults. Do not turn that existing rejection into new SDK semantics.
      for (const value of ["plain default", "invalid\0default"]) {
        const unsupported = Buffer.from(JSON.stringify({ ...original, manifest: { ...original.manifest, id: "unsupported-default",
          configSchema: { greeting: { ...original.manifest.configSchema.greeting, default: value } } } }));
        await assert.rejects(service.savePackage(scope, unsupported), { code: "unknown_field" });
      }
      assert.equal(objects.calls.put, 1);
      assert.deepEqual(await f.storage.roomPlugins.listPackages(scope), [saved]);
    });

    await t.test("exact hash/version, config, explicit capability escalation and monotonic last-unbind revision", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const old = await service.savePackage(scope, artifact());
      const next = await service.savePackage(scope, artifact(old.pluginId, "2.0.0", ["status.set", "seating.claimSelfOnEntry"]));
      assert.deepEqual(await f.storage.roomPlugins.readBindings(scope), { revision: 0, bindings: [] });
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, old.pluginId, { ...binding(old), artifactSha256: "a".repeat(64) }, 0), code("plugin_invalid_binding"));
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, old.pluginId, { ...binding(old), version: "2.0.0" }, 0), code("plugin_invalid_binding"));
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, "other-plugin", binding(old), 0), code("plugin_invalid_binding"));
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, old.pluginId, { ...binding(old), config: {} }, 0), { code: "missing_field" });
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, old.pluginId, { ...binding(old), config: { greeting: "ok", extra: true } }, 0), { code: "unknown_field" });
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, old.pluginId, { ...binding(old), approvedCapabilities: ["seating.claimSelfOnEntry"] }, 0), code("plugin_invalid_binding"));
      const first = await f.storage.roomPlugins.putBinding(scope, old.pluginId, binding(old), 0);
      assert.equal(first.revision, 1);
      const expanded = { ...binding(next), approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"] as RoomPluginCapability[] };
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, next.pluginId, expanded, 1), code("plugin_capability_approval_required"));
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, next.pluginId, { ...expanded,
        capabilityApproval: { artifactSha256: old.artifactSha256, capabilities: expanded.approvedCapabilities } }, 1), code("plugin_capability_approval_required"));
      const updated = await f.storage.roomPlugins.putBinding(scope, next.pluginId, { ...expanded,
        capabilityApproval: { artifactSha256: next.artifactSha256, capabilities: expanded.approvedCapabilities } }, 1);
      assert.equal(updated.revision, 2);
      assert.equal(updated.bindings[0].bindingId, first.bindings[0].bindingId);
      assert.equal(updated.bindings[0].artifactSha256, next.artifactSha256);
      assert.ok(updated.bindings[0].generation > first.bindings[0].generation);
      await assert.rejects(service.deletePackage(scope, next.packageId), code("plugin_package_bound"));
      const disabled = await f.storage.roomPlugins.putBinding(scope, next.pluginId, { ...expanded, enabled: false }, 2);
      assert.equal(disabled.revision, 3);
      await assert.rejects(service.deletePackage(scope, next.packageId), code("plugin_package_bound"));
      const empty = await f.storage.roomPlugins.removeBinding(scope, next.pluginId, 3);
      assert.deepEqual(empty, { revision: 4, bindings: [] });
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, old.pluginId, binding(old), 0), code("plugin_revision_conflict"));
      assert.equal((await f.storage.roomPlugins.removeBinding(scope, next.pluginId, 4)).revision, 4);
      const restarted = await f.restart();
      assert.deepEqual(await restarted.roomPlugins.readBindings(scope), empty);
      const readded = await restarted.roomPlugins.putBinding(scope, old.pluginId, binding(old), 4);
      assert.equal(readded.revision, 5);
      assert.notEqual(readded.bindings[0].bindingId, first.bindings[0].bindingId);
      assert.ok(readded.bindings[0].generation > disabled.bindings[0].generation);
      assert.deepEqual((await (await f.restart()).roomPlugins.readBindings(scope)).bindings[0].config, { greeting: "Hello" });
    });

    await t.test("simultaneous package quota admissions and immutable-version races", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.concurrentStorage.roomPlugins, objects.adapter);
      const saved = await concurrentOperations(f, () => Promise.allSettled(Array.from({ length: 14 }, (_, i) => service.savePackage(scope, artifact(`quota-${i}`, "1.0.0", ["status.set"], 900_000)))));
      assert.equal(saved.filter(value => value.status === "fulfilled").length, 10);
      for (const result of saved) if (result.status === "rejected") code("plugin_quota_exceeded")(result.reason);
      const list = await f.storage.roomPlugins.listPackages(scope);
      assert.equal(list.length, 10);
      assert.ok(list.reduce((sum, value) => sum + value.byteLength, 0) <= ROOM_PLUGIN_LIMITS.roomArtifactBytes);
      assert.equal(objects.calls.put, 10);
      await service.deletePackage(scope, list[0].packageId);
      await service.savePackage(scope, artifact("replacement"));
      const raceScope = await room(f);
      const raced = await concurrentOperations(f, () => Promise.allSettled([service.savePackage(raceScope, artifact("race")), service.savePackage(raceScope, artifact("race", "1.0.0", []))]));
      assert.equal(raced.filter(value => value.status === "fulfilled").length, 1);
      for (const result of raced) if (result.status === "rejected") code("plugin_version_conflict")(result.reason);
    });

    await t.test("lifetime quota counts deleted/failed versions, survives restart and serializes its last admission", async () => {
      const scope = await room(f);
      for (let index = 0; index < ROOM_PLUGIN_STORAGE_LIMITS.lifetimePackagesPerRoom - 1; index++) {
        const value = (await f.storage.roomPlugins.reservePackage(scope, artifact("history", `0.0.${index}`), "b".repeat(64))).package;
        // This owner never started blob IO, so its rejection is known to be settled.
        await f.storage.roomPlugins.failPackageUpload(scope, value.packageId);
        await f.storage.roomPlugins.confirmPackageDeletion(scope, value.packageId);
      }
      assert.deepEqual(await f.storage.roomPlugins.listPackages(scope), []);
      const raced = await Promise.allSettled(["last-one", "last-two"].map(id =>
        f.concurrentStorage.roomPlugins.reservePackage(scope, artifact(id), "b".repeat(64))));
      assert.equal(raced.filter(value => value.status === "fulfilled").length, 1);
      for (const result of raced) if (result.status === "rejected") code("plugin_history_quota_exceeded")(result.reason);
      const last = raced.find(value => value.status === "fulfilled") as PromiseFulfilledResult<{ package: RoomPluginPackage }>;
      await f.storage.roomPlugins.failPackageUpload(scope, last.value.package.packageId);
      await f.storage.roomPlugins.confirmPackageDeletion(scope, last.value.package.packageId);
      const restarted = await f.restart();
      await assert.rejects(restarted.roomPlugins.reservePackage(scope, artifact("over-history"), "b".repeat(64)), code("plugin_history_quota_exceeded"));
      assert.deepEqual(await restarted.roomPlugins.listPackages(scope), []);
    });

    await t.test("initial approval and same-capability exact-version updates require no extra approval ceremony", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const first = await service.savePackage(scope, artifact("same-capabilities", "1.0.0"));
      const second = await service.savePackage(scope, artifact("same-capabilities", "2.0.0"));
      await f.storage.roomPlugins.putBinding(scope, first.pluginId, binding(first), 0);
      const changed = await f.storage.roomPlugins.putBinding(scope, second.pluginId, binding(second), 1);
      assert.equal(changed.revision, 2);
      assert.equal(changed.bindings[0].artifactSha256, second.artifactSha256);
      assert.deepEqual(changed.bindings[0].approvedCapabilities, ["status.set"]);
    });

    await t.test("binding envelope preserves independent config bytes and bounded metadata/data guards without mutating refused revisions", async st => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const schema = (minimum: number, maximum: number) => Object.fromEntries(["a", "b", "c", "d"].map(key => [key,
        { type: "string" as const, required: true, minLength: minimum, maxLength: maximum }]));
      const make = (version: string, minimum: number, maximum: number) => createRoomPluginArtifact({
        schemaVersion: 1, sdkApiVersion: 1, id: "binding-size", version, displayName: "Binding size", requestedCapabilities: ["status.set"],
        configSchema: schema(minimum, maximum)
      }, "export function init() {}").bytes;
      const strict = await service.savePackage(scope, make("1.0.0", 4080, 4080));
      const config = { a: "a".repeat(4080), b: "b".repeat(4080), c: "c".repeat(4080), d: "d".repeat(4080) };
      assert.equal(Buffer.byteLength(JSON.stringify(config)), 16349);
      assert.deepEqual({ ...validateRoomPluginConfig(strict.manifest.configSchema, config) }, config);
      const input = { ...binding(strict), config };
      assert.ok(Buffer.byteLength(JSON.stringify(input)) > ROOM_PLUGIN_LIMITS.messageBytes);
      assert.ok(Buffer.byteLength(JSON.stringify(input)) <= ROOM_PLUGIN_STORAGE_LIMITS.bindingEnvelopeBytes);
      // The public SDK/VM message limit is still 16 KiB. Only persistence supplies the larger envelope budget.
      assert.throws(() => validateRoomPluginData(input), { code: "message_too_large" });
      const first = await f.storage.roomPlugins.putBinding(scope, strict.pluginId, input, 0);
      assert.equal(first.revision, 1); assert.deepEqual(first.bindings[0].config, config);

      const loose = await service.savePackage(scope, make("2.0.0", 0, ROOM_PLUGIN_LIMITS.configStringBytes));
      const exact = { a: "a".repeat(4096), b: "b".repeat(4096), c: "c".repeat(4096), d: "d".repeat(4067) };
      assert.equal(Buffer.byteLength(JSON.stringify(exact)), ROOM_PLUGIN_LIMITS.configBytes);
      const exactInput = { ...binding(loose), config: exact };
      const accepted = await f.storage.roomPlugins.putBinding(scope, loose.pluginId, exactInput, 1);
      assert.equal(accepted.revision, 2); assert.deepEqual(accepted.bindings[0].config, exact);
      const unchanged = async () => assert.deepEqual(await f.storage.roomPlugins.readBindings(scope), accepted);

      const oversized = { ...exactInput, config: { ...exact, d: "d".repeat(4068) } };
      assert.equal(Buffer.byteLength(JSON.stringify(oversized.config)), ROOM_PLUGIN_LIMITS.configBytes + 1);
      assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= ROOM_PLUGIN_STORAGE_LIMITS.bindingEnvelopeBytes);
      // Each string fits its field limit; only the independent aggregate config-byte cap refuses it.
      assert.ok(Object.values(oversized.config).every(value => Buffer.byteLength(value) <= ROOM_PLUGIN_LIMITS.configStringBytes));
      assert.throws(() => validateRoomPluginConfig(loose.manifest.configSchema, oversized.config), { code: "message_too_large" });
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, loose.pluginId, oversized, 2), { code: "message_too_large" });
      await unchanged();

      const excessiveMetadata = "m".repeat(1024 * 1024);
      // Verify oversized caller metadata is rejected before allocating its JSON-encoded copy.
      const stringify = JSON.stringify;
      const encoder = st.mock.method(JSON, "stringify", ((value: unknown) => {
        assert.notEqual(value, excessiveMetadata, "byte preflight must reject before JSON encoding a large metadata string");
        return stringify(value);
      }) as typeof JSON.stringify);
      try {
        await assert.rejects(f.storage.roomPlugins.putBinding(scope, loose.pluginId, {
          ...exactInput, packageId: excessiveMetadata, config: { a: "", b: "", c: "", d: "" }
        }, 2), { code: "message_too_large" });
      } finally { encoder.mock.restore(); }
      await unchanged();

      await assert.rejects(f.storage.roomPlugins.putBinding(scope, loose.pluginId, {
        ...exactInput, config: JSON.parse('{"__proto__":{"polluted":true}}')
      }, 2), { code: "unsafe_key" });
      await unchanged();
      let nested: unknown = true;
      for (let depth = 0; depth <= ROOM_PLUGIN_LIMITS.dataDepth; depth++) nested = { value: nested };
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, loose.pluginId, {
        ...exactInput, config: { a: nested }
      } as unknown as Parameters<typeof f.storage.roomPlugins.putBinding>[2], 2), { code: "nesting_too_deep" });
      await unchanged();
      let getterCalls = 0;
      const accessor = Object.defineProperty({ ...exactInput }, "config", { enumerable: true, get() { getterCalls++; return exact; } });
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, loose.pluginId, accessor, 2), { code: "invalid_data" });
      assert.equal(getterCalls, 0); await unchanged();
    });

    await t.test("CAS and enabled-quota races never over-admit", async () => {
      const scope = await room(f), objects = blobs(f);
      const metadata = f.concurrentStorage.roomPlugins;
      const service = createRoomPluginPackageService(metadata, objects.adapter);
      const packages = await concurrentOperations(f, () => Promise.all(["one", "two", "three"].map(id => service.savePackage(scope, artifact(id)))));
      const firstRace = await Promise.allSettled(packages.map(value => metadata.putBinding(scope, value.pluginId, binding(value), 0)));
      assert.equal(firstRace.filter(value => value.status === "fulfilled").length, 1);
      for (const result of firstRace) if (result.status === "rejected") code("plugin_revision_conflict")(result.reason);
      const first = await f.storage.roomPlugins.readBindings(scope);
      const remaining = packages.filter(value => value.pluginId !== first.bindings[0].pluginId);
      const secondRace = await Promise.allSettled(remaining.map(value => metadata.putBinding(scope, value.pluginId, binding(value), 1)));
      assert.equal(secondRace.filter(value => value.status === "fulfilled").length, 1);
      const current = await f.storage.roomPlugins.readBindings(scope);
      assert.equal(current.revision, 2);
      assert.equal(current.bindings.filter(value => value.enabled).length, 2);
      const third = packages.find(value => !current.bindings.some(bound => bound.pluginId === value.pluginId))!;
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, third.pluginId, binding(third), 2), code("plugin_quota_exceeded"));
      await f.storage.roomPlugins.putBinding(scope, third.pluginId, binding(third, false), 2);
      assert.equal((await f.storage.roomPlugins.readBindings(scope)).revision, 3);
      const removal = await Promise.allSettled(current.bindings.map(value => metadata.removeBinding(scope, value.pluginId, 3)));
      assert.equal(removal.filter(value => value.status === "fulfilled").length, 1);
      assert.equal((await f.storage.roomPlugins.readBindings(scope)).revision, 4);
    });

    await t.test("identical in-flight uploads have one immutable writer; binding/deletion races serialize", async () => {
      const scope = await room(f), objects = blobs(f), started = deferred(), finish = deferred();
      const paused: RoomPluginBlobStorage = { ...objects.adapter, async put(s, key, bytes) {
        started.resolve(); await finish.promise; await objects.adapter.put(s, key, bytes);
      } };
      const service = createRoomPluginPackageService(f.storage.roomPlugins, paused);
      const first = service.savePackage(scope, artifact());
      await started.promise;
      await assert.rejects(service.savePackage(scope, artifact()), code("plugin_upload_pending"));
      assert.equal((await f.storage.roomPlugins.listPackages(scope)).length, 1);
      finish.resolve();
      const saved = await first;
      assert.equal((await service.savePackage(scope, artifact())).packageId, saved.packageId);
      assert.equal(objects.calls.put, 1);
      // The competing binding transaction may legitimately own the same parent during blob cleanup.
      const raced = await concurrentOperations(f, () => Promise.allSettled([
        service.deletePackage(scope, saved.packageId), f.storage.roomPlugins.putBinding(scope, saved.pluginId, binding(saved), 0)
      ]));
      assert.equal(raced.filter(value => value.status === "fulfilled").length, 1);
      const bound = (await f.storage.roomPlugins.readBindings(scope)).bindings.length > 0;
      assert.equal(objects.objects.has(saved.storageKey), bound);
      const rejected = raced.find(value => value.status === "rejected") as PromiseRejectedResult;
      code(bound ? "plugin_package_bound" : "plugin_package_not_ready")(rejected.reason);
    });

    await t.test("confirmed upload failure, failed compensation, retryable deletion and immutable tombstones", async () => {
      const scope = await room(f), objects = blobs(f);
      let rejectDelete = true;
      const failing: RoomPluginBlobStorage = { ...objects.adapter,
        async put(s, key, bytes) { await objects.adapter.put(s, key, bytes); throw new Error("confirmed_put_failed"); },
        async delete(s, key) { if (rejectDelete) throw new Error("delete_failed"); await objects.adapter.delete(s, key); }
      };
      const service = createRoomPluginPackageService(f.storage.roomPlugins, failing);
      await assert.rejects(service.savePackage(scope, artifact()), RoomPluginOperationPending);
      const saved = (await f.storage.roomPlugins.listPackages(scope))[0];
      assert.equal(saved.state, "cleanup-pending");
      assert.equal(objects.objects.has(saved.storageKey), true);
      await assert.rejects(f.storage.deleteRoom(scope.roomId), code("room_plugin_cleanup_pending"));
      const restarted = await f.restart();
      assert.deepEqual(await restarted.roomPlugins.listPackages(scope), [saved]);
      await assert.rejects(createRoomPluginPackageService(restarted.roomPlugins, failing).deletePackage(scope, saved.packageId), /delete_failed/);
      assert.equal((await restarted.roomPlugins.listPackages(scope))[0].storageKey, saved.storageKey);
      rejectDelete = false;
      await service.deletePackage(scope, saved.packageId);
      await service.deletePackage(scope, saved.packageId);
      assert.equal(objects.objects.size, 0);
      assert.equal((await restarted.roomPlugins.listPackages(scope)).length, 0);
      assert.equal((await restarted.roomPlugins.getPackage(scope, saved.packageId))?.state, "deleted");
      await assert.rejects(service.savePackage(scope, artifact("welcome-status", "1.0.0", [])), code("plugin_version_conflict"));
      await assert.rejects(service.savePackage(scope, artifact()), code("plugin_invalid_transition"));
      await createRoomPluginPackageService(restarted.roomPlugins, objects.adapter).savePackage(scope, artifact("welcome-status", "1.0.1"));
    });

    await t.test("lost publish acknowledgement recovers persisted bytes without another PUT", async () => {
      const scope = await room(f), objects = blobs(f);
      let fail = true;
      const metadata = { ...f.storage.roomPlugins, async publishPackage(s: RoomPluginScope, id: string) {
        if (fail) { fail = false; throw new Error("publish_ack_lost"); }
        return f.storage.roomPlugins.publishPackage(s, id);
      } };
      await assert.rejects(createRoomPluginPackageService(metadata, objects.adapter).savePackage(scope, artifact()), RoomPluginOperationPending);
      const value = (await f.storage.roomPlugins.listPackages(scope))[0];
      assert.equal(value.state, "reserved");
      const restarted = await f.restart();
      const recovered = await createRoomPluginPackageService(restarted.roomPlugins, objects.adapter).reconcileUpload(scope, value.packageId);
      assert.equal(recovered.state, "ready");
      assert.equal(objects.calls.put, 1);
      assert.equal(objects.calls.delete, 0);
      assert.deepEqual(await createRoomPluginPackageService(restarted.roomPlugins, objects.adapter).readPackage(scope, value.packageId), artifact());
    });

    await t.test("room deletion recovers settled orphan reservations after reinit with a durable bounded cleanup intent", async () => {
      const scope = await room(f), objects = blobs(f), history: RoomPluginPackage[] = [];
      // Deleted history must remain durable but must not consume the ten-key active cleanup intent.
      for (let index = 0; index < 100; index++) {
        const value = (await f.storage.roomPlugins.reservePackage(scope, artifact("orphan-history", `0.0.${index}`), objects.adapter.backendFingerprint)).package;
        await f.storage.roomPlugins.failPackageUpload(scope, value.packageId); // no PUT started: confirmed rejection
        await f.storage.roomPlugins.confirmPackageDeletion(scope, value.packageId);
        history.push(value);
      }
      const ready = await createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter).savePackage(scope, artifact("current-ready"));
      await f.storage.roomPlugins.putBinding(scope, ready.pluginId, binding(ready), 0);
      let publisherCalls = 0;
      const disappeared = { ...f.storage.roomPlugins, async publishPackage() {
        publisherCalls++; throw new Error("publisher_disappeared_after_settlement");
      } };
      for (let index = 1; index < ROOM_PLUGIN_LIMITS.packagesPerRoom; index++) {
        await assert.rejects(createRoomPluginPackageService(disappeared, objects.adapter).savePackage(scope, artifact(`settled-orphan-${index}`)), RoomPluginOperationPending);
      }
      const packages = await f.storage.roomPlugins.listPackages(scope);
      assert.equal(packages.length, ROOM_PLUGIN_LIMITS.packagesPerRoom);
      assert.ok(packages.every(value => value.uploadSettled));
      assert.equal(packages.filter(value => value.state === "reserved").length, ROOM_PLUGIN_LIMITS.packagesPerRoom - 1);
      await assert.rejects(f.storage.roomPlugins.reservePackage(scope, artifact("over-active-quota"), objects.adapter.backendFingerprint), code("plugin_quota_exceeded"));
      const restarted = await f.restart();
      assert.deepEqual(await restarted.roomPlugins.listPackages(scope), packages);
      await assert.rejects(restarted.roomPlugins.beginPackageDeletion(scope, packages.find(value => value.state === "reserved")!.packageId), code("plugin_upload_pending"));
      assert.equal((await restarted.roomPlugins.getPackage(scope, ready.packageId))?.state, "ready");
      assert.equal((await restarted.roomPlugins.readBindings(scope)).bindings.length, 1);
      const intent = await restarted.roomPlugins.beginRoomDeletion(scope);
      assert.equal(intent.packages.length, ROOM_PLUGIN_LIMITS.packagesPerRoom);
      assert.ok(intent.packages.every(value => value.state === "cleanup-pending" && value.uploadSettled));
      assert.deepEqual(new Set(intent.packages.map(value => value.packageId)), new Set(packages.map(value => value.packageId)));
      assert.equal(intent.packages.reduce((sum, value) => sum + value.byteLength, 0), packages.reduce((sum, value) => sum + value.byteLength, 0));
      assert.deepEqual(await restarted.roomPlugins.readBindings(scope), { revision: 2, bindings: [] });
      assert.equal((await restarted.roomPlugins.getPackage(scope, history[0].packageId))?.state, "deleted");
      assert.equal((await restarted.roomPlugins.getPackage(scope, history[99].packageId))?.state, "deleted");
      if (f.pool) {
        assert.equal((await f.pool.query("select count(*) as n from room_plugin_packages where room_id=$1", [scope.roomId])).rows[0].n,
          String(100 + ROOM_PLUGIN_LIMITS.packagesPerRoom));
        assert.equal((await f.pool.query("select jsonb_array_length(cleanup_package_ids) as n from room_plugin_state where room_id=$1", [scope.roomId])).rows[0].n,
          ROOM_PLUGIN_LIMITS.packagesPerRoom);
      }
      let deletionCalls = 0, reads = 0;
      const failing: RoomPluginBlobStorage = { ...objects.adapter,
        async read() { reads++; throw new Error("room_cleanup_must_not_guess_settlement_from_GET"); },
        async delete(s, key) {
          if (++deletionCalls === 2) throw new Error("settled_orphan_cleanup_retry");
          await objects.adapter.delete(s, key);
        }
      };
      await assert.rejects(deleteRoomWithPluginCleanup(restarted, scope, () => failing), /settled_orphan_cleanup_retry/);
      assert.ok(await restarted.getRoom(scope.roomId));
      const reinitialized = await f.restart(), retry = await reinitialized.roomPlugins.beginRoomDeletion(scope);
      assert.equal(retry.deletionId, intent.deletionId);
      assert.deepEqual(retry.packages.map(value => value.packageId), intent.packages.map(value => value.packageId));
      assert.equal(retry.packages.length, ROOM_PLUGIN_LIMITS.packagesPerRoom);
      assert.equal(retry.packages.filter(value => value.state === "deleted").length, 1);
      assert.ok(retry.packages.every(value => value.uploadSettled && ["deleted", "cleanup-pending"].includes(value.state)));
      assert.deepEqual(await reinitialized.roomPlugins.readBindings(scope), { revision: 2, bindings: [] });
      await assert.rejects(reinitialized.roomPlugins.reservePackage(scope, artifact("after-intent"), objects.adapter.backendFingerprint), code("room_plugin_cleanup_pending"));
      if (f.pool) assert.equal((await f.pool.query("select count(*) as n from room_plugin_packages where room_id=$1", [scope.roomId])).rows[0].n,
        String(100 + ROOM_PLUGIN_LIMITS.packagesPerRoom));
      assert.equal(await deleteRoomWithPluginCleanup(reinitialized, scope, () => failing), true);
      assert.equal(await reinitialized.getRoom(scope.roomId), null);
      assert.equal(objects.objects.size, 0); assert.equal(objects.calls.put, ROOM_PLUGIN_LIMITS.packagesPerRoom);
      assert.equal(objects.calls.delete, ROOM_PLUGIN_LIMITS.packagesPerRoom); assert.equal(reads, 0);
      assert.equal(publisherCalls, ROOM_PLUGIN_LIMITS.packagesPerRoom - 1, "recovery never invokes the disappeared publisher closure");
    });

    await t.test("reinitialized room cleanup retires settled siblings but never settles an unknown writer", async () => {
      const scope = await room(f), objects = blobs(f);
      const knownReservation = (await f.storage.roomPlugins.reservePackage(scope, artifact("known-orphan"), objects.adapter.backendFingerprint)).package;
      await objects.adapter.put(scope, knownReservation.storageKey, artifact("known-orphan"));
      await f.storage.roomPlugins.confirmPackageUpload(scope, knownReservation.packageId);
      const known = (await f.storage.roomPlugins.getPackage(scope, knownReservation.packageId))!;
      const unknownReservation = (await f.storage.roomPlugins.reservePackage(scope, artifact("unknown-writer"), objects.adapter.backendFingerprint)).package;
      // Matching bytes may be visible while the original remote PUT is still executing.
      await objects.adapter.put(scope, unknownReservation.storageKey, artifact("unknown-writer"));
      const unknown = (await f.storage.roomPlugins.getPackage(scope, unknownReservation.packageId))!;
      const restarted = await f.restart(), intent = await restarted.roomPlugins.beginRoomDeletion(scope);
      assert.deepEqual(intent.packages.find(value => value.packageId === known.packageId), { ...known, state: "cleanup-pending", uploadSettled: true });
      assert.deepEqual(intent.packages.find(value => value.packageId === unknown.packageId), unknown);
      let reads = 0;
      const noGuessing: RoomPluginBlobStorage = { ...objects.adapter, async read() {
        reads++; throw new Error("readable_bytes_do_not_settle_a_writer");
      } };
      await assert.rejects(deleteRoomWithPluginCleanup(restarted, scope, () => noGuessing), code("plugin_upload_pending"));
      assert.ok(await restarted.getRoom(scope.roomId));
      assert.equal((await restarted.roomPlugins.getPackage(scope, known.packageId))?.state, "deleted");
      assert.deepEqual(await restarted.roomPlugins.getPackage(scope, unknown.packageId), unknown);
      const reinitialized = await f.restart(), retry = await reinitialized.roomPlugins.beginRoomDeletion(scope);
      assert.equal(retry.deletionId, intent.deletionId);
      assert.deepEqual(retry.packages.map(value => value.packageId), intent.packages.map(value => value.packageId));
      await assert.rejects(deleteRoomWithPluginCleanup(reinitialized, scope, () => noGuessing), code("plugin_upload_pending"));
      assert.deepEqual(await reinitialized.roomPlugins.getPackage(scope, unknown.packageId), unknown);
      assert.equal(objects.objects.has(unknown.storageKey), true);
      assert.equal(objects.objects.has(known.storageKey), false);
      assert.equal(objects.calls.put, 2); assert.equal(objects.calls.delete, 1); assert.equal(reads, 0);
      assert.ok(await reinitialized.getRoom(scope.roomId));
    });

    await t.test("matching GET never settles a lost-ACK writer or permits cleanup while it may still finish", async () => {
      const scope = await room(f), objects = blobs(f);
      const unsettled: RoomPluginBlobStorage = { ...objects.adapter, async put(s, key, bytes) {
        await objects.adapter.put(s, key, bytes);
        // The storage front end exposes matching bytes before the original operation has settled.
        throw new RoomPluginBlobWriteUncertain(new Error("PUT may still complete"));
      } };
      const service = createRoomPluginPackageService(f.storage.roomPlugins, unsettled);
      await assert.rejects(service.savePackage(scope, artifact()), RoomPluginOperationPending);
      const value = (await f.storage.roomPlugins.listPackages(scope))[0];
      assert.deepEqual(await objects.adapter.read(scope, value.storageKey), artifact());
      await assert.rejects(service.reconcileUpload(scope, value.packageId), code("plugin_upload_pending"));
      await assert.rejects(service.deletePackage(scope, value.packageId), code("plugin_upload_pending"));
      await assert.rejects(deleteRoomWithPluginCleanup(f.storage, scope, () => unsettled), code("plugin_upload_pending"));
      assert.ok(await f.storage.getRoom(scope.roomId));
      assert.equal((await f.storage.roomPlugins.getPackage(scope, value.packageId))?.state, "reserved");
      assert.equal(objects.calls.put, 1);
      assert.equal(objects.calls.delete, 0);
    });

    await t.test("in-flight PUT and uncertain acknowledgement fence room deletion without metadata loss", async () => {
      const scope = await room(f), objects = blobs(f), started = deferred(), finish = deferred();
      const adapter: RoomPluginBlobStorage = { ...objects.adapter, async put(s, key, bytes) {
        await f.checkNoFence(s); started.resolve(); await finish.promise; await objects.adapter.put(s, key, bytes);
      } };
      const saving = createRoomPluginPackageService(f.storage.roomPlugins, adapter).savePackage(scope, artifact());
      await started.promise;
      const reserved = (await f.storage.roomPlugins.listPackages(scope))[0];
      assert.equal(reserved.state, "reserved");
      await assert.rejects(deleteRoomWithPluginCleanup(f.storage, scope, () => adapter), code("plugin_upload_pending"));
      assert.ok(await f.storage.getRoom(scope.roomId));
      assert.equal((await f.storage.roomPlugins.listPackages(scope))[0].storageKey, reserved.storageKey);
      finish.resolve();
      await assert.rejects(saving, code("room_plugin_cleanup_pending"));
      assert.equal(objects.objects.size, 0);
      assert.equal(await deleteRoomWithPluginCleanup(f.storage, scope, () => adapter), true);

      const uncertainScope = await room(f);
      const uncertain: RoomPluginBlobStorage = { ...objects.adapter, async put() { throw new RoomPluginBlobWriteUncertain(new Error("network_reset")); } };
      const uncertainService = createRoomPluginPackageService(f.storage.roomPlugins, uncertain);
      await assert.rejects(uncertainService.savePackage(uncertainScope, artifact()), RoomPluginOperationPending);
      const pending = (await f.storage.roomPlugins.listPackages(uncertainScope))[0];
      assert.equal(pending.state, "reserved");
      await assert.rejects(uncertainService.reconcileUpload(uncertainScope, pending.packageId), code("plugin_upload_pending"));
      await assert.rejects(deleteRoomWithPluginCleanup(f.storage, uncertainScope, () => objects.adapter), code("plugin_upload_pending"));
      assert.equal((await f.storage.roomPlugins.listPackages(uncertainScope))[0].state, "reserved");
      // The sole original writer's late completion, not a retry PUT.
      objects.objects.set(pending.storageKey, artifact());
      await f.storage.roomPlugins.confirmPackageUpload(uncertainScope, pending.packageId);
      await createRoomPluginPackageService((await f.restart()).roomPlugins, objects.adapter).reconcileUpload(uncertainScope, pending.packageId);
      assert.equal(await deleteRoomWithPluginCleanup(f.storage, uncertainScope, () => objects.adapter), true);
    });

    await t.test("partial room cleanup preserves every key and a durable intent; ordinary room needs no blob config", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const first = await service.savePackage(scope, artifact("first")), second = await service.savePackage(scope, artifact("second"));
      await f.storage.roomPlugins.putBinding(scope, first.pluginId, binding(first), 0);
      let calls = 0;
      const fail: RoomPluginBlobStorage = { ...objects.adapter, async delete(s, key) {
        await f.checkNoFence(s);
        if (++calls === 2) throw new Error("second_delete_failed");
        await objects.adapter.delete(s, key);
      } };
      await assert.rejects(deleteRoomWithPluginCleanup(f.storage, scope, () => fail), /second_delete_failed/);
      assert.ok(await f.storage.getRoom(scope.roomId));
      for (const value of [first, second]) assert.equal((await f.storage.roomPlugins.getPackage(scope, value.packageId))?.storageKey, value.storageKey);
      assert.deepEqual(await f.storage.roomPlugins.readBindings(scope), { revision: 2, bindings: [] });
      await assert.rejects(f.storage.roomPlugins.reservePackage(scope, artifact("new-package"), "b".repeat(64)), code("room_plugin_cleanup_pending"));
      await assert.rejects(f.storage.roomPlugins.putBinding(scope, first.pluginId, binding(first), 2), code("room_plugin_cleanup_pending"));
      const intent = await f.storage.roomPlugins.beginRoomDeletion(scope);
      assert.deepEqual(new Set(intent.packages.map(value => value.storageKey)), new Set([first.storageKey, second.storageKey]));
      const restarted = await f.restart();
      assert.equal((await restarted.roomPlugins.beginRoomDeletion(scope)).deletionId, intent.deletionId);
      assert.equal(await deleteRoomWithPluginCleanup(restarted, scope, () => objects.adapter), true);
      assert.equal(objects.objects.size, 0);
      assert.equal(await restarted.getRoom(scope.roomId), null);
      // A stale cleanup must never delete a newly-created room reusing the same public ID.
      await restarted.createRoom({ ...scope, templateId: "meeting-room-basic", name: "Replacement room" });
      await assert.rejects(restarted.deleteRoom(scope.roomId, { tenantId: scope.tenantId, deletionId: intent.deletionId }), code("room_plugin_cleanup_pending"));
      const ordinary = await room(f);
      assert.equal(await deleteRoomWithPluginCleanup(restarted, ordinary, () => { throw new Error("must_not_resolve_blob_config"); }), true);
    });

    await t.test("backend configuration drift blocks reads/idempotent upload/cleanup before IO or deletion confirmation", async () => {
      const scope = await room(f), objects = blobs(f);
      const service = createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter);
      const value = await service.savePackage(scope, artifact());
      assert.equal(value.backendFingerprint, objects.adapter.backendFingerprint);
      let wrongIo = 0;
      const wrong: RoomPluginBlobStorage = { backendFingerprint: "c".repeat(64), async put() { wrongIo++; }, async read() { wrongIo++; return artifact(); }, async delete() { wrongIo++; } };
      const changed = createRoomPluginPackageService(f.storage.roomPlugins, wrong);
      await assert.rejects(changed.readPackage(scope, value.packageId), RoomPluginBlobConfigurationError);
      await assert.rejects(changed.savePackage(scope, artifact()), RoomPluginBlobConfigurationError);
      await assert.rejects(deleteRoomWithPluginCleanup(f.storage, scope, () => wrong), RoomPluginBlobConfigurationError);
      assert.equal(wrongIo, 0);
      assert.equal(objects.objects.has(value.storageKey), true);
      const persisted = await f.storage.roomPlugins.getPackage(scope, value.packageId);
      assert.equal(persisted?.state, "cleanup-pending");
      assert.equal(persisted?.backendFingerprint, value.backendFingerprint);
      const restarted = await f.restart();
      assert.equal(await deleteRoomWithPluginCleanup(restarted, scope, () => objects.adapter), true);
    });

    if (f.pool) await t.test("database constraints reject cross-room exact-binding spoofing and immutable rewrites", async () => {
      const scope = await room(f), other = await room(f), objects = blobs(f);
      const value = await createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter).savePackage(scope, artifact());
      await assert.rejects(f.pool!.query("update room_plugin_packages set artifact_sha256=$4 where tenant_id=$1 and room_id=$2 and package_id=$3", [scope.tenantId, scope.roomId, value.packageId, "a".repeat(64)]), { code: "23514" });
      await assert.rejects(f.pool!.query("update room_plugin_packages set backend_fingerprint=$4 where tenant_id=$1 and room_id=$2 and package_id=$3", [scope.tenantId, scope.roomId, value.packageId, "c".repeat(64)]), { code: "23514" });
      await assert.rejects(f.pool!.query(`insert into room_plugin_bindings(tenant_id,room_id,plugin_id,package_id,version,artifact_sha256,binding_id,generation,binding_revision,enabled,approved_capabilities,config)
        values($1,$2,$3,$4,$5,$6,'spoofed',1,1,true,'[]','{}')`, [other.tenantId, other.roomId, value.pluginId, value.packageId, value.version, value.artifactSha256]), { code: "23503" });
      await assert.rejects(f.pool!.query("delete from rooms where tenant_id=$1 and room_id=$2", [scope.tenantId, scope.roomId]), { code: "23503" });
      assert.equal((await f.storage.roomPlugins.getPackage(scope, value.packageId))?.artifactSha256, value.artifactSha256);
    });
    if (f.pool) await t.test("older records without a backend identity retain their keys and cannot adopt current configuration", async () => {
      const scope = await room(f), objects = blobs(f);
      const value = await createRoomPluginPackageService(f.storage.roomPlugins, objects.adapter).savePackage(scope, artifact());
      // Reproduce a schema from before backend identity persistence, rather than forge a new fingerprint.
      await f.pool!.query("alter table room_plugin_packages drop column backend_fingerprint");
      const restarted = await f.restart();
      const legacy = await restarted.roomPlugins.getPackage(scope, value.packageId);
      assert.equal(legacy?.backendFingerprint, null);
      await assert.rejects(createRoomPluginPackageService(restarted.roomPlugins, objects.adapter).readPackage(scope, value.packageId), RoomPluginBlobConfigurationError);
      await assert.rejects(deleteRoomWithPluginCleanup(restarted, scope, () => objects.adapter), RoomPluginBlobConfigurationError);
      assert.equal((await restarted.roomPlugins.getPackage(scope, value.packageId))?.storageKey, value.storageKey);
      assert.equal(objects.objects.has(value.storageKey), true);
      assert.ok(await restarted.getRoom(scope.roomId));
    });
  });
}
