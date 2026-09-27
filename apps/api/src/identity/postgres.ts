import type { Pool, PoolClient } from "pg";
import { IdentityStorageError, type IdentityPersistence, type IdentitySelection, type IdentityTransaction, type RoomIdentityRecord, type RoomIdentityRecovery, type RoomIdentityScope } from "./contracts.js";
import { createRoomIdentityStorage, emptyIdentityAuthority } from "./store.js";
import { defaultSessionControl } from "../storage-room-records.js";

const iso = (date: Date | string) => new Date(date).toISOString();
const nullableIso = (date: Date | string | null) => date === null ? null : iso(date);

async function load(client: PoolClient, scope: RoomIdentityScope, selection: IdentitySelection, lock: boolean): Promise<IdentityTransaction | null> {
  const binding = await client.query(`select tenant_id, room_id, room_type, owner_participant_id, status, disabled_at, session_control
    from rooms where tenant_id = $1 and room_id = $2 ${lock ? "for update" : ""}`, [scope.tenantId, scope.roomId]);
  const room = binding.rows[0];
  if (!room) return null;
  const authority = (await client.query(`select * from room_identity_authority_v2 where tenant_id=$1 and room_id=$2`, [scope.tenantId, scope.roomId])).rows[0];
  const raw = selection.recoveryId ? (await client.query(`select * from room_identity_recoveries_v2 where tenant_id=$1 and room_id=$2 and recovery_id=$3`, [scope.tenantId, scope.roomId, selection.recoveryId])).rows[0] : null;
  const recovery: RoomIdentityRecovery | null = raw ? {
    tenantId: raw.tenant_id, roomId: raw.room_id, recoveryId: raw.recovery_id,
    targetParticipantId: raw.target_participant_id, targetIdentityId: raw.target_identity_id, targetRole: raw.target_role,
    expectedAuthEpoch: raw.expected_auth_epoch, expectedAuthorityRevision: raw.expected_authority_revision,
    secretHash: raw.secret_hash, issuedBy: raw.issued_by, createdAt: iso(raw.created_at), expiresAt: iso(raw.expires_at), consumedAt: nullableIso(raw.consumed_at)
  } : null;
  const ids = [...(selection.identityIds ?? []), ...(recovery?.targetIdentityId ? [recovery.targetIdentityId] : [])];
  const participantId = selection.participantId ?? recovery?.targetParticipantId ?? null;
  const rows = ids.length || participantId !== null ? (await client.query(`select * from room_identities_v2
    where tenant_id=$1 and room_id=$2 and (identity_id=any($3::text[]) or participant_id=$4)`, [scope.tenantId, scope.roomId, ids, participantId])).rows : [];
  const identities = new Map<string, RoomIdentityRecord>(rows.map(row => [row.identity_id, {
    tenantId: row.tenant_id, roomId: row.room_id, identityId: row.identity_id, participantId: row.participant_id,
    authEpoch: row.auth_epoch, baseRole: row.base_role, provenance: row.provenance, displayName: row.display_name,
    createdAt: iso(row.created_at), revokedAt: nullableIso(row.revoked_at)
  }]));
  return {
    room: { tenantId: room.tenant_id, roomId: room.room_id, roomType: room.room_type, ownerParticipantId: room.owner_participant_id,
      status: room.status, disabledAt: nullableIso(room.disabled_at), sessionControl: room.session_control },
    authority: authority ? { tenantId: authority.tenant_id, roomId: authority.room_id, revision: authority.revision,
      hostIdentityId: authority.host_identity_id, ownerIdentityId: authority.owner_identity_id, presenterIdentityId: authority.presenter_identity_id } : emptyIdentityAuthority(scope),
    identities, recovery
  };
}

async function save(client: PoolClient, state: IdentityTransaction): Promise<void> {
  // Canonicalise legacy defaults before installing the v2 authority boundary.
  // Later name/theme edits must not appear to mutate lifecycle merely because
  // the pre-migration JSON omitted nullable keys.
  await client.query(`update rooms set session_control=$3::jsonb where tenant_id=$1 and room_id=$2
    and not exists (select 1 from room_identity_authority_v2 where tenant_id=$1 and room_id=$2)`,
  [state.room.tenantId, state.room.roomId, JSON.stringify(defaultSessionControl(state.room.sessionControl))]);
  for (const identity of state.identities.values()) {
    await client.query(`insert into room_identities_v2 (tenant_id,room_id,identity_id,participant_id,display_name,base_role,provenance,auth_epoch,created_at,revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id,room_id,identity_id)
      do update set auth_epoch=excluded.auth_epoch, revoked_at=excluded.revoked_at`, [identity.tenantId, identity.roomId, identity.identityId,
      identity.participantId, identity.displayName, identity.baseRole, JSON.stringify(identity.provenance), identity.authEpoch, identity.createdAt, identity.revokedAt]);
  }
  const a = state.authority;
  await client.query(`insert into room_identity_authority_v2 (tenant_id,room_id,revision,host_identity_id,owner_identity_id,presenter_identity_id)
    values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id,room_id) do update set revision=excluded.revision,
    host_identity_id=excluded.host_identity_id,owner_identity_id=excluded.owner_identity_id,presenter_identity_id=excluded.presenter_identity_id`,
  [a.tenantId, a.roomId, a.revision, a.hostIdentityId, a.ownerIdentityId, a.presenterIdentityId]);
  const r = state.recovery;
  if (r) await client.query(`insert into room_identity_recoveries_v2 (tenant_id,room_id,recovery_id,target_participant_id,target_identity_id,target_role,
    expected_auth_epoch,expected_authority_revision,secret_hash,issued_by,created_at,expires_at,consumed_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (tenant_id,room_id,recovery_id) do update set consumed_at=excluded.consumed_at`,
  [r.tenantId, r.roomId, r.recoveryId, r.targetParticipantId, r.targetIdentityId, r.targetRole, r.expectedAuthEpoch,
    r.expectedAuthorityRevision, r.secretHash, r.issuedBy, r.createdAt, r.expiresAt, r.consumedAt]);
}

export function createPostgresRoomIdentities(pool: Pool, now = Date.now) {
  async function transaction(scope: RoomIdentityScope, selection: IdentitySelection): Promise<IdentityTransaction | null>;
  async function transaction<T>(scope: RoomIdentityScope, selection: IdentitySelection, apply: (state: IdentityTransaction) => T): Promise<T>;
  async function transaction<T>(scope: RoomIdentityScope, selection: IdentitySelection, apply?: (state: IdentityTransaction) => T): Promise<T | IdentityTransaction | null> {
    const client = await pool.connect();
    try {
      await client.query(apply ? "begin" : "begin isolation level repeatable read read only");
      // Every writer locks the parent room first. Role transfer, recovery,
      // revocation and room deletion therefore have one serialisation point.
      const state = await load(client, scope, selection, Boolean(apply));
      if (!state && apply) throw new IdentityStorageError("room_not_found");
      const result = apply && state ? apply(state) : state;
      if (apply && state) await save(client, state);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string })?.code === "23505") throw new IdentityStorageError("identity_conflict");
      throw error;
    } finally { client.release(); }
  }
  const persistence: IdentityPersistence = {
    read: (scope, selection) => transaction(scope, selection),
    transact: (scope, selection, apply) => transaction(scope, selection, apply)
  };
  return createRoomIdentityStorage(persistence, now);
}
