import type { Pool, PoolClient } from "pg";
import { roomFenceTransaction } from "../identity/fence-transaction.js";
import { RoomPluginStorageError, type RoomPluginPackage, type RoomPluginPackageState, type RoomPluginScope,
  type RoomPluginTransaction, type StoredRoomPluginBinding } from "./contracts.js";
import { createRoomPluginStorage } from "./storage.js";

function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid_plugin_counter");
  return parsed;
}
function mapPackage(row: Record<string, unknown>): RoomPluginPackage {
  return { tenantId: String(row.tenant_id), roomId: String(row.room_id), packageId: String(row.package_id),
    pluginId: String(row.plugin_id), version: String(row.version), artifactSha256: String(row.artifact_sha256),
    byteLength: number(row.byte_length), manifest: row.manifest as RoomPluginPackage["manifest"], storageKey: String(row.storage_key),
    backendFingerprint: row.backend_fingerprint as string | null,
    state: row.state as RoomPluginPackageState, uploadSettled: row.upload_settled as boolean, createdAt: new Date(row.created_at as string).toISOString() };
}
function mapBinding(row: Record<string, unknown>): StoredRoomPluginBinding {
  return { tenantId: String(row.tenant_id), roomId: String(row.room_id), pluginId: String(row.plugin_id),
    packageId: String(row.package_id), version: String(row.version), artifactSha256: String(row.artifact_sha256),
    bindingId: String(row.binding_id), generation: number(row.generation), bindingRevision: number(row.binding_revision),
    enabled: row.enabled as boolean, approvedCapabilities: row.approved_capabilities as StoredRoomPluginBinding["approvedCapabilities"],
    config: row.config as StoredRoomPluginBinding["config"] };
}

export function createPostgresRoomPlugins(pool: Pool) {
  return createRoomPluginStorage({
    transaction: (scope, operation, options) => roomFenceTransaction(pool, {}, async client => {
      // Admission, quotas, CAS, room deletion and authority transitions share the authoritative parent lock.
      const parent = await client.query(options?.readOnly
        ? "select 1 from rooms where tenant_id=$1 and room_id=$2 for share"
        : "select 1 from rooms where tenant_id=$1 and room_id=$2 for update", [scope.tenantId, scope.roomId]);
      if (!parent.rowCount) throw new RoomPluginStorageError("room_not_found");
      if (!options?.readOnly) await client.query("insert into room_plugin_state(tenant_id,room_id) values($1,$2) on conflict do nothing", [scope.tenantId, scope.roomId]);
      const stored = (await client.query("select revision,deleting,deletion_id,cleanup_package_ids from room_plugin_state where tenant_id=$1 and room_id=$2", [scope.tenantId, scope.roomId])).rows[0];
      const state = stored ? { revision: number(stored.revision), deleting: stored.deleting as boolean, deletionId: stored.deletion_id as string | null,
        cleanupPackageIds: stored.cleanup_package_ids as string[] } : { revision: 0, deleting: false, deletionId: null, cleanupPackageIds: [] };
      const query = (sql: string, values: unknown[] = []) => client.query(sql, [scope.tenantId, scope.roomId, ...values]);
      const write = (sql: string, values: unknown[] = []) => {
        if (options?.readOnly) throw new Error("plugin_read_only_transaction");
        return query(sql, values);
      };
      const tx: RoomPluginTransaction = {
        state,
        async saveState() { await write("update room_plugin_state set revision=$3,deleting=$4,deletion_id=$5,cleanup_package_ids=$6::jsonb where tenant_id=$1 and room_id=$2",
          [state.revision, state.deleting, state.deletionId, JSON.stringify(state.cleanupPackageIds)]); },
        async findVersion(pluginId, version) { const row = (await query("select * from room_plugin_packages where tenant_id=$1 and room_id=$2 and plugin_id=$3 and version=$4", [pluginId, version])).rows[0]; return row ? mapPackage(row) : null; },
        async getPackage(id) { const row = (await query("select * from room_plugin_packages where tenant_id=$1 and room_id=$2 and package_id=$3", [id])).rows[0]; return row ? mapPackage(row) : null; },
        async listPackages(includeDeleted = false) { return (await query("select * from room_plugin_packages where tenant_id=$1 and room_id=$2 and ($3 or state<>'deleted') order by package_id", [includeDeleted])).rows.map(mapPackage); },
        async quota() { const row = (await query(`select count(*) as lifetime_count,count(*) filter(where state<>'deleted') as count,
          coalesce(sum(byte_length) filter(where state<>'deleted'),0) as bytes from room_plugin_packages where tenant_id=$1 and room_id=$2`)).rows[0];
          return { count: number(row.count), bytes: number(row.bytes), lifetimeCount: number(row.lifetime_count) }; },
        async insertPackage(value) { await write(`insert into room_plugin_packages(tenant_id,room_id,package_id,plugin_id,version,artifact_sha256,byte_length,manifest,storage_key,state,created_at,backend_fingerprint)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`, [value.packageId, value.pluginId, value.version, value.artifactSha256, value.byteLength, JSON.stringify(value.manifest), value.storageKey, value.state, value.createdAt, value.backendFingerprint]); },
        async setPackageState(id, next) { await write("update room_plugin_packages set state=$4 where tenant_id=$1 and room_id=$2 and package_id=$3", [id, next]); },
        async setUploadSettled(id) { await write("update room_plugin_packages set upload_settled=true where tenant_id=$1 and room_id=$2 and package_id=$3", [id]); },
        async listBindings() { return (await query('select * from room_plugin_bindings where tenant_id=$1 and room_id=$2 order by plugin_id collate "C"')).rows.map(mapBinding); },
        async getBinding(id) { const row = (await query("select * from room_plugin_bindings where tenant_id=$1 and room_id=$2 and plugin_id=$3", [id])).rows[0]; return row ? mapBinding(row) : null; },
        async saveBinding(value) { await write(`insert into room_plugin_bindings(tenant_id,room_id,plugin_id,package_id,version,artifact_sha256,binding_id,generation,binding_revision,enabled,approved_capabilities,config)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
          on conflict(tenant_id,room_id,plugin_id) do update set package_id=excluded.package_id,version=excluded.version,
            artifact_sha256=excluded.artifact_sha256,binding_id=excluded.binding_id,generation=excluded.generation,
            binding_revision=excluded.binding_revision,enabled=excluded.enabled,approved_capabilities=excluded.approved_capabilities,config=excluded.config`,
          [value.pluginId, value.packageId, value.version, value.artifactSha256, value.bindingId, value.generation, value.bindingRevision, value.enabled, JSON.stringify(value.approvedCapabilities), JSON.stringify(value.config)]); },
        async deleteBinding(id) { await write("delete from room_plugin_bindings where tenant_id=$1 and room_id=$2 and ($3::text is null or plugin_id=$3)", [id ?? null]); }
      };
      return operation(tx);
    })
  });
}

/** Called inside the ordinary room-delete transaction, after locking that same parent row. */
export async function preparePostgresRoomPluginRemoval(client: PoolClient, scope: RoomPluginScope, deletionId?: string): Promise<void> {
  const values = [scope.tenantId, scope.roomId];
  if (deletionId !== undefined) {
    const state = (await client.query("select deletion_id from room_plugin_state where tenant_id=$1 and room_id=$2", values)).rows[0];
    if (state?.deletion_id !== deletionId) throw new RoomPluginStorageError("room_plugin_cleanup_pending");
  }
  const pending = await client.query(`select 1 from room_plugin_packages where tenant_id=$1 and room_id=$2 and state<>'deleted'
    union all select 1 from room_plugin_bindings where tenant_id=$1 and room_id=$2 limit 1`, values);
  if (pending.rowCount) throw new RoomPluginStorageError("room_plugin_cleanup_pending");
  await client.query("delete from room_plugin_packages where tenant_id=$1 and room_id=$2", values);
}
