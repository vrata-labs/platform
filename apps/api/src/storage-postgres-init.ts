import type { Pool, PoolClient } from "pg";

import { ensureNamedForeignKey, installTemplateVersionImmutabilityTrigger } from "./storage-postgres-guards.js";
import { ensurePostgresStorageSchema } from "./storage-postgres-schema.js";

const POSTGRES_INIT_ADVISORY_LOCK_SQL = "select pg_advisory_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))";
const POSTGRES_INIT_ADVISORY_UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended('vrata:postgres-storage-init:v1', 0)) as unlocked";

export interface PostgresStorageInitHooks {
seed(client: PoolClient): Promise<void>;
validateStoredTemplateVersions(client: PoolClient): Promise<void>;
synchronizeTemplateCatalog(client: PoolClient): Promise<void>;
}

// Schema creation and catalog work share the same locked transaction and client.
export async function initializePostgresStorage(pool: Pool, hooks: PostgresStorageInitHooks): Promise<void> {
  const client = await pool.connect();
  let lockAcquired = false;
  let transactionStarted = false;
  try {
    await client.query(POSTGRES_INIT_ADVISORY_LOCK_SQL);
    lockAcquired = true;
    await client.query("begin");
    transactionStarted = true;
    await initWithClient(client, hooks);
    await client.query("commit");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query("rollback");
    }
    throw error;
  } finally {
    try {
      if (lockAcquired) {
        const result = await client.query(POSTGRES_INIT_ADVISORY_UNLOCK_SQL);
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("postgres_init_advisory_unlock_failed");
        }
      }
    } finally {
      client.release();
    }
  }
}

async function initWithClient(client: PoolClient, hooks: PostgresStorageInitHooks): Promise<void> {
  await ensurePostgresStorageSchema(client);
  await ensureTemplateVersionBaseConstraints(client);
  await hooks.seed(client);
  await hooks.validateStoredTemplateVersions(client);
  await hooks.synchronizeTemplateCatalog(client);
  await repairRoomTemplateMetadata(client);
  await addTemplateVersionConstraints(client);
  const incomplete = await client.query("select 1 from rooms where template_version is null or template_snapshot is null limit 1");
  if (incomplete.rows.length > 0) throw new Error("incomplete_room_template_backfill");
  await client.query("alter table rooms alter column template_version set not null, alter column template_snapshot set not null");
  await installTemplateVersionImmutabilityTrigger(client);
}

async function repairRoomTemplateMetadata(client: PoolClient): Promise<void> {
  await client.query(`
      with desired as (
        select
          r.room_id,
          coalesce(r.template_version, t.current_version) as template_version,
          tv.snapshot || jsonb_build_object(
            'roomConfig', jsonb_build_object(
              'roomType', r.room_type,
              'visibility', r.visibility,
              'guestAllowed', r.guest_allowed,
              'sceneBundleUrl', r.scene_bundle_url,
              'features', r.features,
              'theme', r.theme,
              'avatarConfig', r.avatar_config
            )
          ) as template_snapshot
        from rooms r
        join templates t on t.template_id = r.template_id
        join template_versions tv
          on tv.template_id = r.template_id
         and tv.version = coalesce(r.template_version, t.current_version)
        where coalesce(r.template_version, t.current_version) is not null
      )
      update rooms r
      set template_version = coalesce(r.template_version, desired.template_version),
          template_snapshot = desired.template_snapshot
      from desired
      where r.room_id = desired.room_id
        and (
          r.template_version is distinct from desired.template_version
          or r.template_snapshot is distinct from desired.template_snapshot
        )
    `);
}

async function ensureTemplateVersionBaseConstraints(client: PoolClient): Promise<void> {
  await ensureNamedForeignKey(client, {
    tableRegclass: "template_versions",
    tableSql: "template_versions",
    constraintName: "template_versions_template_id_fkey",
    columns: ["template_id"],
    referencedTableRegclass: "templates",
    referencedColumns: ["template_id"],
    expectedDefinition: "foreign key (template_id) references templates(template_id)",
    createSql: `alter table template_versions
        add constraint template_versions_template_id_fkey
        foreign key (template_id) references templates(template_id) not valid`
  });
  await ensureNamedForeignKey(client, {
    tableRegclass: "rooms",
    tableSql: "rooms",
    constraintName: "rooms_template_id_fkey",
    columns: ["template_id"],
    referencedTableRegclass: "templates",
    referencedColumns: ["template_id"],
    expectedDefinition: "foreign key (template_id) references templates(template_id)",
    createSql: `alter table rooms
        add constraint rooms_template_id_fkey
        foreign key (template_id) references templates(template_id) not valid`
  });
}

async function addTemplateVersionConstraints(client: PoolClient): Promise<void> {
  await ensureNamedForeignKey(client, {
    tableRegclass: "templates",
    tableSql: "templates",
    constraintName: "templates_current_version_fkey",
    columns: ["template_id", "current_version"],
    referencedTableRegclass: "template_versions",
    referencedColumns: ["template_id", "version"],
    expectedDefinition: "foreign key (template_id, current_version) references template_versions(template_id, version)",
    createSql: `alter table templates
        add constraint templates_current_version_fkey
        foreign key (template_id, current_version)
        references template_versions(template_id, version) not valid`
  });
  await ensureNamedForeignKey(client, {
    tableRegclass: "rooms",
    tableSql: "rooms",
    constraintName: "rooms_template_version_fkey",
    columns: ["template_id", "template_version"],
    referencedTableRegclass: "template_versions",
    referencedColumns: ["template_id", "version"],
    expectedDefinition: "foreign key (template_id, template_version) references template_versions(template_id, version)",
    createSql: `alter table rooms
        add constraint rooms_template_version_fkey
        foreign key (template_id, template_version)
        references template_versions(template_id, version) not valid`
  });
}
