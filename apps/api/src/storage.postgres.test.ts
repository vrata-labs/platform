import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { Pool } from "pg";

import { MemoryStorage, PostgresStorage } from "./storage.js";

const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;
const postgresSkipReason = "VRATA_TEST_POSTGRES_URL is not set; skipping real PostgreSQL integration test";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value_not_json_serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}

test("PostgresStorage upgrades legacy schema and preserves pinned template versions", {
  skip: postgresUrl ? false : postgresSkipReason,
  timeout: 120_000
}, async () => {
  assert.ok(postgresUrl);
  const schema = `vrata_template_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: postgresUrl });
  const createPool = () => new Pool({
    connectionString: postgresUrl,
    max: 12,
    options: `-c search_path=${schema},public`
  });
  const pools = [createPool(), createPool(), createPool(), createPool()];

  try {
    await adminPool.query(`create schema "${schema}"`);
    await pools[0].query(`
      create table tenants (
        tenant_id text primary key,
        name text not null
      );
      create table templates (
        template_id text primary key,
        label text not null,
        asset_slots jsonb not null
      );
      create table rooms (
        room_id text primary key,
        tenant_id text not null references tenants(tenant_id),
        template_id text not null references templates(template_id),
        name text not null,
        room_type text not null default 'standard',
        owner_participant_id text,
        status text not null default 'active',
        disabled_at timestamptz,
        disabled_by text,
        visibility text not null default 'public',
        scene_bundle_url text,
        features jsonb not null,
        asset_ids jsonb not null default '[]'::jsonb,
        theme jsonb not null default '{"primaryColor":"#5fc8ff","accentColor":"#163354"}'::jsonb,
        guest_allowed boolean not null default true,
        avatar_config jsonb not null default '{"avatarsEnabled":true,"avatarCatalogUrl":"/assets/avatars/catalog.v1.json","avatarQualityProfile":"desktop-standard","avatarFallbackCapsulesEnabled":true,"avatarSeatsEnabled":true}'::jsonb,
        session_control jsonb not null default '{}'::jsonb,
        personal_state jsonb not null default '{}'::jsonb
      );
      insert into tenants (tenant_id, name) values ('legacy-tenant', 'Legacy Tenant');
      insert into templates (template_id, label, asset_slots)
      values ('meeting-room-basic', 'Meeting Room Basic', '["logo","hero-screen"]'::jsonb);
      insert into rooms (room_id, tenant_id, template_id, name, visibility, features)
      values (
        'legacy-pinned-room',
        'legacy-tenant',
        'meeting-room-basic',
        'Legacy Pinned Room',
        'public',
        '{"voice":true,"spatialAudio":true,"screenShare":true}'::jsonb
      );
    `);

    const storages = pools.map((pool) => new PostgresStorage(pool));
    const concurrentResults = await Promise.allSettled(storages.map((storage) => storage.init()));
    const concurrentFailures = concurrentResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => ({ code: errorCode(result.reason), message: result.reason instanceof Error ? result.reason.message : String(result.reason) }));
    assert.deepEqual(concurrentFailures, [], `concurrent init failures: ${JSON.stringify(concurrentFailures)}`);
    await storages[0].init();

    const memoryTemplateIds = (await new MemoryStorage().listTemplates()).map((template) => template.templateId);
    const postgresTemplateIds = (await storages[0].listTemplates()).map((template) => template.templateId);
    assert.equal(memoryTemplateIds.length, 4);
    assert.deepEqual(postgresTemplateIds, memoryTemplateIds);
    assert.equal((await storages[0].getRoom("legacy-pinned-room"))?.templateVersion, "0.1.0");

    await pools[0].query(`
      insert into templates (template_id, label, asset_slots)
      values ('legacy-database-only', 'Legacy Database Only', '["logo"]'::jsonb);
      insert into rooms (room_id, tenant_id, template_id, name, features)
      values (
        'legacy-database-only-room',
        'legacy-tenant',
        'legacy-database-only',
        'Legacy Database Only Room',
        '{"voice":true,"spatialAudio":false,"screenShare":false}'::jsonb
      );
    `);
    await storages[0].init();
    const catalogWithLegacyRow = await storages[0].listTemplates();
    assert.deepEqual(catalogWithLegacyRow.map((template) => template.templateId), [...memoryTemplateIds, "legacy-database-only"]);
    assert.deepEqual(catalogWithLegacyRow.find((template) => template.templateId === "legacy-database-only"), {
      templateId: "legacy-database-only",
      label: "Legacy Database Only",
      assetSlots: ["logo"],
      currentVersion: "0.1.0",
      status: "active"
    });
    assert.equal((await storages[0].getTemplateVersion("legacy-database-only", "0.1.0"))?.version, "0.1.0");
    assert.equal((await storages[0].getRoom("legacy-database-only-room"))?.templateVersion, "0.1.0");

    await pools[0].query(`update templates set status = 'deprecated' where template_id = 'legacy-database-only'`);
    assert.equal((await storages[0].listTemplates()).find((template) => template.templateId === "legacy-database-only")?.status, "deprecated");
    const deprecatedTemplateRoom = await storages[0].createRoom({
      roomId: "deprecated-database-only-room",
      tenantId: "legacy-tenant",
      templateId: "legacy-database-only",
      name: "Deprecated Database Only Room"
    });
    assert.equal(deprecatedTemplateRoom.templateVersion, "0.1.0");
    await pools[0].query(`update templates set status = 'retired' where template_id = 'legacy-database-only'`);
    await assert.rejects(
      storages[0].listTemplates(),
      /unsupported_template_status:legacy-database-only:retired/
    );
    await assert.rejects(
      storages[0].init(),
      /unsupported_template_status:legacy-database-only:retired/
    );
    await pools[0].query(`update templates set status = 'active' where template_id = 'legacy-database-only'`);

    const definitions = await pools[0].query(
      `select c.conname, pg_get_constraintdef(c.oid, true) as definition
       from pg_constraint c
       where c.conrelid in ('templates'::regclass, 'template_versions'::regclass, 'rooms'::regclass)
         and c.conname in (
           'template_versions_template_id_fkey',
           'templates_current_version_fkey',
           'rooms_template_id_fkey',
           'rooms_template_version_fkey'
         )
       order by c.conname`
    );
    assert.deepEqual(definitions.rows.map((row: { conname: string }) => row.conname), [
      "rooms_template_id_fkey",
      "rooms_template_version_fkey",
      "template_versions_template_id_fkey",
      "templates_current_version_fkey"
    ]);
    const triggerDefinition = await pools[0].query(
      `select pg_get_triggerdef(t.oid, false) as definition, fn_ns.nspname as function_schema
       from pg_trigger t
       join pg_proc fn on fn.oid = t.tgfoid
       join pg_namespace fn_ns on fn_ns.oid = fn.pronamespace
       where t.tgrelid = 'template_versions'::regclass
         and t.tgname = 'template_versions_immutable'
         and not t.tgisinternal`
    );
    assert.equal(triggerDefinition.rows[0]?.function_schema, schema);
    assert.match(triggerDefinition.rows[0]?.definition ?? "", /vrata_reject_template_version_mutation\(\)/);

    await pools[0].query(
      `insert into rooms (room_id, tenant_id, template_id, name, features)
       values ('old-shape-switch-room', 'legacy-tenant', 'meeting-room-basic', 'Old Shape Switch Room', $1::jsonb)`,
      [JSON.stringify({ voice: true, spatialAudio: false, screenShare: true })]
    );
    await storages[0].init();
    for (const templateId of ["showroom-basic", "event-demo-basic", "personal-workspace-basic", "meeting-room-basic"]) {
      await pools[0].query(
        `update rooms set template_id = $2 where room_id = $1`,
        ["old-shape-switch-room", templateId]
      );
    }
    await pools[0].query(
      `update rooms
       set template_id = 'event-demo-basic',
           visibility = 'private',
           guest_allowed = false,
           features = '{"voice":false,"spatialAudio":true,"screenShare":false}'::jsonb,
           template_snapshot = '{}'::jsonb
       where room_id = 'old-shape-switch-room'`
    );
    await storages[0].init();
    const switchedRoom = await storages[0].getRoom("old-shape-switch-room");
    assert.equal(switchedRoom?.templateId, "event-demo-basic");
    assert.equal(switchedRoom?.templateVersion, "0.1.0");
    assert.equal(switchedRoom?.templateSnapshot.version, "0.1.0");
    assert.equal(switchedRoom?.templateSnapshot.templateId, "event-demo-basic");
    assert.deepEqual(switchedRoom?.templateSnapshot.roomConfig.features, { voice: false, spatialAudio: true, screenShare: false });

    await pools[0].query(
      `insert into rooms (room_id, tenant_id, template_id, name, features)
       values ('old-shape-during-rollout', 'legacy-tenant', 'meeting-room-basic', 'Old Shape During Rollout', $1::jsonb)`,
      [JSON.stringify({ voice: true, spatialAudio: true, screenShare: true })]
    );
    const rolloutRoom = await storages[0].getRoom("old-shape-during-rollout");
    assert.equal(rolloutRoom?.templateVersion, "0.1.0");
    const healedDuringPatch = await storages[0].updateRoom("old-shape-during-rollout", { name: "Healed During Patch" }, {
      templateId: "meeting-room-basic",
      templateVersion: "0.1.0"
    });
    assert.equal(healedDuringPatch?.name, "Healed During Patch");
    const healedColumns = await pools[0].query(
      `select template_version, template_snapshot->>'templateId' as snapshot_template_id
       from rooms where room_id = 'old-shape-during-rollout'`
    );
    assert.deepEqual(healedColumns.rows[0], {
      template_version: "0.1.0",
      snapshot_template_id: "meeting-room-basic"
    });

    const rollbackBeforeNewVersion = await pools[0].query(
      `select exists(select 1 from template_versions where version <> '0.1.0') as forbidden`
    );
    assert.equal(rollbackBeforeNewVersion.rows[0]?.forbidden, false);

    const version020 = {
      schemaVersion: 1,
      templateId: "meeting-room-basic",
      version: "0.2.0",
      label: "Meeting Room Basic 0.2",
      assetSlots: ["logo", "presentation-screen"]
    };
    const version020Hash = createHash("sha256").update(stableJson(version020)).digest("hex");
    await pools[0].query(
      `insert into template_versions (template_id, version, snapshot, content_hash)
       values ($1,$2,$3::jsonb,$4)`,
      [version020.templateId, version020.version, JSON.stringify(version020), version020Hash]
    );
    await pools[0].query(
      `update templates set current_version = '0.2.0' where template_id = 'meeting-room-basic'`
    );
    await pools[0].query(
      `update rooms
       set visibility = 'private',
           guest_allowed = false,
           scene_bundle_url = '/assets/scenes/pinned/scene.json',
           template_snapshot = '{"stale":true}'::jsonb
       where room_id = 'legacy-pinned-room'`
    );

    const pinnedInitResults = await Promise.allSettled([storages[1].init(), storages[2].init()]);
    assert.equal(pinnedInitResults.every((result) => result.status === "fulfilled"), true);
    const catalogAfterAdvance = await storages[0].listTemplates();
    assert.deepEqual(catalogAfterAdvance.find((template) => template.templateId === "meeting-room-basic"), {
      templateId: "meeting-room-basic",
      label: "Meeting Room Basic 0.2",
      assetSlots: ["logo", "presentation-screen"],
      currentVersion: "0.2.0",
      status: "active"
    });
    const legacyCatalogColumns = await pools[0].query(
      `select label, asset_slots from templates where template_id = 'meeting-room-basic'`
    );
    assert.deepEqual(legacyCatalogColumns.rows[0], {
      label: "Meeting Room Basic 0.2",
      asset_slots: ["logo", "presentation-screen"]
    });
    const pinnedAfterInit = await storages[0].getRoom("legacy-pinned-room");
    assert.equal(pinnedAfterInit?.templateVersion, "0.1.0");
    assert.equal(pinnedAfterInit?.templateSnapshot.version, "0.1.0");
    assert.equal(pinnedAfterInit?.templateSnapshot.roomConfig.visibility, "private");
    assert.equal(pinnedAfterInit?.templateSnapshot.roomConfig.guestAllowed, false);
    assert.equal(pinnedAfterInit?.templateSnapshot.roomConfig.sceneBundleUrl, "/assets/scenes/pinned/scene.json");

    const databaseOnlyVersion020 = {
      schemaVersion: 1,
      templateId: "legacy-database-only",
      version: "0.2.0",
      label: "Legacy Database Only 0.2",
      assetSlots: ["logo", "wall-graphic"]
    };
    await pools[0].query(
      `insert into template_versions (template_id, version, snapshot, content_hash)
       values ($1,$2,$3::jsonb,$4)`,
      [
        databaseOnlyVersion020.templateId,
        databaseOnlyVersion020.version,
        JSON.stringify(databaseOnlyVersion020),
        createHash("sha256").update(stableJson(databaseOnlyVersion020)).digest("hex")
      ]
    );
    await pools[0].query(`update templates set current_version = '0.2.0' where template_id = 'legacy-database-only'`);
    await storages[0].init();
    await storages[0].init();
    assert.deepEqual((await storages[0].listTemplates()).find((template) => template.templateId === "legacy-database-only"), {
      templateId: "legacy-database-only",
      label: "Legacy Database Only 0.2",
      assetSlots: ["logo", "wall-graphic"],
      currentVersion: "0.2.0",
      status: "active"
    });
    assert.equal((await storages[0].getRoom("legacy-database-only-room"))?.templateVersion, "0.1.0");

    const pinnedAfterUpdate = await storages[0].updateRoom("legacy-pinned-room", {
      templateId: "meeting-room-basic",
      visibility: "unlisted"
    });
    assert.equal(pinnedAfterUpdate?.templateVersion, "0.1.0");
    assert.equal(pinnedAfterUpdate?.templateSnapshot.version, "0.1.0");
    assert.equal(pinnedAfterUpdate?.templateSnapshot.roomConfig.visibility, "unlisted");

    const currentRoom = await storages[0].createRoom({
      roomId: "current-version-room",
      tenantId: "legacy-tenant",
      templateId: "meeting-room-basic",
      name: "Current Version Room"
    });
    assert.equal(currentRoom.templateVersion, "0.2.0");
    const bindingGuardRoom = await storages[0].createRoom({
      roomId: "binding-guard-room",
      tenantId: "legacy-tenant",
      templateId: "meeting-room-basic",
      name: "Binding Guard Room"
    });
    await storages[0].updateRoom(bindingGuardRoom.roomId, { templateId: "showroom-basic" }, {
      templateId: "meeting-room-basic",
      templateVersion: "0.2.0"
    });
    await assert.rejects(
      storages[0].updateRoom(bindingGuardRoom.roomId, { name: "Stale Update" }, {
        templateId: "meeting-room-basic",
        templateVersion: "0.2.0"
      }),
      /room_template_binding_changed/
    );
    await assert.rejects(
      pools[0].query(`update rooms set template_id = 'showroom-basic' where room_id = 'current-version-room'`),
      (error: unknown) => errorCode(error) === "23503"
    );
    const rollbackAfterNewVersion = await pools[0].query(
      `select exists(select 1 from template_versions where version <> '0.1.0') as forbidden`
    );
    assert.equal(rollbackAfterNewVersion.rows[0]?.forbidden, true);

    const invalidHashVersion = {
      schemaVersion: 1,
      templateId: "meeting-room-basic",
      version: "0.3.0",
      label: "Invalid Hash Version",
      assetSlots: ["logo"]
    };
    await pools[0].query(
      `insert into template_versions (template_id, version, snapshot, content_hash)
       values ($1,$2,$3::jsonb,$4)`,
      [invalidHashVersion.templateId, invalidHashVersion.version, JSON.stringify(invalidHashVersion), "0".repeat(64)]
    );
    await pools[0].query(`update rooms set template_version = '0.3.0' where room_id = 'current-version-room'`);
    await assert.rejects(
      storages[0].getRoom("current-version-room"),
      /template_version_content_hash_mismatch:meeting-room-basic@0\.3\.0/
    );
    await assert.rejects(
      storages[0].init(),
      /template_version_content_hash_mismatch:meeting-room-basic@0\.3\.0/
    );
    await pools[0].query(`update rooms set template_version = '0.2.0' where room_id = 'current-version-room'`);

    const mismatchedIdentityVersion = {
      schemaVersion: 1,
      templateId: "showroom-basic",
      version: "0.4.0",
      label: "Mismatched Identity Version",
      assetSlots: ["logo"]
    };
    await pools[0].query(
      `insert into template_versions (template_id, version, snapshot, content_hash)
       values ('meeting-room-basic',$1,$2::jsonb,$3)`,
      [mismatchedIdentityVersion.version, JSON.stringify(mismatchedIdentityVersion), createHash("sha256").update(stableJson(mismatchedIdentityVersion)).digest("hex")]
    );
    await assert.rejects(
      storages[0].getTemplateVersion("meeting-room-basic", "0.4.0"),
      /template_version_identity_mismatch:meeting-room-basic@0\.4\.0/
    );

    await assert.rejects(
      pools[0].query(`update template_versions set content_hash = 'mutated' where template_id = 'meeting-room-basic' and version = '0.1.0'`),
      (error: unknown) => errorCode(error) === "55000"
    );
    await assert.rejects(
      pools[0].query(`delete from template_versions where template_id = 'meeting-room-basic' and version = '0.1.0'`),
      (error: unknown) => errorCode(error) === "55000"
    );
  } finally {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await adminPool.query(`drop schema if exists "${schema}" cascade`);
    await adminPool.end();
  }
});
