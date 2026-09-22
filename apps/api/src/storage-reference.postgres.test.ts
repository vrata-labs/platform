import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { referenceCatalogState } from "@vrata/templates";
import { PostgresStorage } from "./storage.js";
import { createRoomManifestBuilder } from "./room-manifest.js";

const url = process.env.VRATA_TEST_POSTGRES_URL;
const rollbackModule = process.env.VRATA_TEMPLATE_ROLLBACK_STORAGE_MODULE;
const rollbackSha = "33c7485ffa1773105c496b43542ea53bf4c5ae9a";

async function database(run: (pools: Pool[]) => Promise<void>) {
  assert(url);
  const schema = `reference_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const pools = [0, 1].map(() => new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 1 }));
  try {
    await admin.query(`create schema "${schema}"`);
    await run(pools);
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
}

test("Postgres reference catalog activation/rollback is guarded, atomic and preserves immutable room bindings", { skip: url ? false : "VRATA_TEST_POSTGRES_URL is required" }, async () => {
  await database(async pools => {
    const storage = new PostgresStorage(pools[0]!);
    const concurrent = new PostgresStorage(pools[1]!);
    await storage.init();
    const legacy = await storage.createRoom({ name: "Legacy pinned", templateId: "meeting-room-basic" });
    const activated = await Promise.all([storage.transitionReferenceTemplateCatalog("active"), concurrent.transitionReferenceTemplateCatalog("active")]);
    assert(activated.every(catalog => referenceCatalogState(catalog) === "active"));
    assert.deepEqual((await storage.listTemplates()).map(row => row.templateId), ["personal-room-basic", "meeting-room-basic", "presentation-room-basic"]);
    const personal = await storage.createRoom({ name: "Private reference", templateId: "personal-room-basic", ownerParticipantId: "owner-123" });
    assert.equal(personal.templateVersion, "2.0.0");
    assert.equal(personal.visibility, "private");
    assert.equal(personal.guestAllowed, false);
    assert(personal.sceneBundleUrl?.includes("personal-workspace-v1@"));
    const before = structuredClone(personal.templateSnapshot.assetLock);
    const updated = await storage.updateRoom(personal.roomId, { name: "Renamed" });
    assert.deepEqual(updated?.templateSnapshot.assetLock, before);
    await assert.rejects(() => storage.updateRoom(personal.roomId, { sceneBundleUrl: "https://other.example/scene.json" }), /reference_scene_override_not_allowed/);
    await assert.rejects(() => storage.updateRoom(personal.roomId, { visibility: "public" }), /personal_room_must_be_private/);
    await assert.rejects(() => storage.createRoom({ name: "Deprecated", templateId: "event-demo-basic" }), /template_deprecated/);
    await storage.init();
    assert.equal((await storage.listTemplates()).length, 3);
    assert.equal(referenceCatalogState(await storage.transitionReferenceTemplateCatalog("wave2")), "wave2");
    assert.deepEqual(await storage.getRoom(legacy.roomId), legacy);
    assert.equal((await storage.getRoom(personal.roomId))?.templateVersion, "2.0.0");
    await pools[0]!.query("update templates set current_version='1.0.0' where template_id='personal-room-basic'");
    await assert.rejects(() => storage.transitionReferenceTemplateCatalog("active"), /template_catalog_state_mismatch/);
    const unchanged = await pools[0]!.query("select status from templates where template_id='event-demo-basic'");
    assert.equal(unchanged.rows[0].status, "active");
  });
});

test("create waits for a concurrent catalog change and rejects a now-deprecated version", { skip: url ? false : "VRATA_TEST_POSTGRES_URL is required" }, async () => {
  await database(async pools => {
    const storage = new PostgresStorage(pools[1]!);
    await storage.init();
    const creatorPid = (await pools[1]!.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    await pools[0]!.query("begin");
    try {
      await pools[0]!.query("update templates set status = 'deprecated' where template_id = 'meeting-room-basic'");
      const pending = storage.createRoom({ roomId: "concurrent-create", templateId: "meeting-room-basic", name: "Concurrent create" }).then(() => null, error => error as Error);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        blocked = (await pools[0]!.query("select cardinality(pg_blocking_pids($1)) > 0 as blocked", [creatorPid])).rows[0].blocked as boolean;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "create must serialize on the catalog row");
      await pools[0]!.query("commit");
      assert.match((await pending)?.message ?? "", /template_deprecated/);
      assert.equal(await storage.getRoom("concurrent-create"), null);
    } finally { await pools[0]!.query("rollback"); }
  });
});

test("Wave 2 schema supports the exact Wave 1 rollback build with create/PATCH/manifest and return", { skip: url && rollbackModule ? false : "Postgres and the pinned rollback build are required" }, async () => {
  const root = resolve(dirname(rollbackModule!), "../../..");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), rollbackSha);
  execFileSync("git", ["diff", "--exit-code", "HEAD"], { cwd: root });
  const old = await import(pathToFileURL(rollbackModule!).href) as { PostgresStorage: typeof PostgresStorage };
  const oldManifestModule = await import(pathToFileURL(resolve(dirname(rollbackModule!), "room-manifest.js")).href) as { createRoomManifestBuilder: typeof createRoomManifestBuilder };
  await database(async pools => {
    const current = new PostgresStorage(pools[0]!);
    await current.init();
    const first = await current.createRoom({ name: "Before rollback", templateId: "meeting-room-basic", features: { voice: false, spatialAudio: true, screenShare: true } });
    const previous = new old.PostgresStorage(pools[1]!);
    await previous.init();
    assert.equal((await previous.listTemplates()).length, 4);
    await previous.updateRoom(first.roomId, { name: "Edited by rollback build" });
    const second = await previous.createRoom({ name: "Created by rollback build", templateId: "showroom-basic", sceneBundleUrl: "https://fixtures.example/legacy/scene.json" });
    const previousManifest = await oldManifestModule.createRoomManifestBuilder(Promise.resolve(previous))(second.roomId);
    assert.equal(previousManifest.templateVersion, "0.1.0");
    await current.init();
    assert.equal((await current.getRoom(first.roomId))?.name, "Edited by rollback build");
    assert.equal((await current.getRoom(first.roomId))?.features.voice, false);
    assert.deepEqual(await createRoomManifestBuilder(Promise.resolve(current))(second.roomId), previousManifest);
    const columns = await pools[0]!.query("select is_nullable from information_schema.columns where table_schema=current_schema() and table_name='rooms' and column_name in ('template_version','template_snapshot')");
    assert.deepEqual(columns.rows.map(row => row.is_nullable), ["NO", "NO"]);
    assert.equal(referenceCatalogState(await current.transitionReferenceTemplateCatalog("active")), "active");
    assert.equal(referenceCatalogState(await current.transitionReferenceTemplateCatalog("wave2")), "wave2");
  });
});
