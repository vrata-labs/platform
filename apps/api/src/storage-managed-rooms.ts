import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ManagedRoomActivity,
  ManagedRoomBlockReason,
  ManagedRoomEnforcementRecord,
  ManagedRoomGrantConsumeResult,
  ManagedRoomGrantInput,
  ManagedRoomGrantPurpose,
  ManagedRoomGrantRole,
  ManagedRoomGrantRecord,
  ManagedRoomKind,
  ManagedRoomStatus,
  RoomRecord
} from "./storage-contracts.js";
import { isoString } from "./storage-row-mappers.js";

const ENFORCER_LOCK_KEY = "vrata:managed-room-enforcer:v1";

/** Withdrawal of a managed room at nowMs, in the order a client must hear it. */
export function managedRoomBlock(input: { status: ManagedRoomStatus; cutoffMs: number }, nowMs: number): ManagedRoomBlockReason | null {
  if (input.status === "closed") return "room_closed";
  if (nowMs >= input.cutoffMs) return "access_expired";
  return input.status === "paused" ? "room_paused" : null;
}

function cutoffMs(room: RoomRecord): number {
  return Date.parse(room.managed!.accessUntil) + room.managed!.graceSeconds * 1000;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface MemoryEnforcement {
  enforcedBlock: ManagedRoomBlockReason | null;
  retiredEpochs: string[];
  rotateRequestedAt: string | null;
  lastActivityAt: string | null;
}

interface MemoryGrant extends ManagedRoomGrantRecord {
  codeHash: string;
  revocationCompletedAt?: string | null;
}

// Single-process grants and enforcement state over the MemoryStorage room map; no method yields mid-update.
export class MemoryManagedRooms {
  private grants = new Map<string, MemoryGrant>();
  private grantIdentities = new Map<string, Set<string>>();
  private enforcement = new Map<string, MemoryEnforcement>();
  private usage = new Map<string, { participantSeconds: number; updatedAt: string }>();
  private enforcerBusy = false;

  constructor(private readonly rooms: Map<string, RoomRecord>, private readonly now: () => number = Date.now) {}

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private state(roomId: string): MemoryEnforcement {
    let state = this.enforcement.get(roomId);
    if (!state) {
      state = { enforcedBlock: null, retiredEpochs: [], rotateRequestedAt: null, lastActivityAt: null };
      this.enforcement.set(roomId, state);
    }
    return state;
  }

  private managedRoom(roomId: string): RoomRecord | null {
    const room = this.rooms.get(roomId);
    return room?.managed ? room : null;
  }

  private publicGrant(grant: MemoryGrant): ManagedRoomGrantRecord {
    const { codeHash: _codeHash, revocationCompletedAt: _completed, ...record } = grant;
    return structuredClone(record);
  }

  async closeManagedRoom(roomId: string, expectedRevision: number, reason: string | null, operationId: string | null): Promise<RoomRecord | "revision_mismatch" | null> {
    const room = this.managedRoom(roomId);
    if (!room) return null;
    if (room.managed!.status === "closed") return structuredClone(room);
    if (room.managed!.revision !== expectedRevision) return "revision_mismatch";
    const timestamp = this.timestamp();
    this.state(roomId).rotateRequestedAt = timestamp;
    room.managed = {
      ...room.managed!,
      status: "closed",
      closedAt: timestamp,
      closeReason: reason,
      accessUntil: new Date(Math.min(Date.parse(room.managed!.accessUntil), this.now())).toISOString(),
      graceSeconds: 0,
      revision: room.managed!.revision + 1,
      lastOperationId: operationId ?? room.managed!.lastOperationId ?? null,
      updatedAt: timestamp
    };
    return structuredClone(room);
  }

  async issueManagedRoomGrant(input: ManagedRoomGrantInput): Promise<ManagedRoomGrantRecord | ManagedRoomBlockReason | null> {
    const room = this.managedRoom(input.roomId);
    if (!room) return null;
    const block = managedRoomBlock({ status: room.managed!.status, cutoffMs: cutoffMs(room) }, this.now());
    if (block) return block;
    const timestamp = this.timestamp();
    const grant: MemoryGrant = {
      grantId: input.grantId, roomId: input.roomId, tenantId: room.tenantId, role: input.role, subject: input.subject ?? null, purpose: input.purpose,
      maxUses: input.maxUses, usedCount: 0,
      expiresAt: new Date(Math.min(Date.parse(input.expiresAt), cutoffMs(room))).toISOString(),
      revokedAt: null, revokeReason: null, displayName: input.displayName ?? null, returnContext: input.returnContext ?? null,
      revision: 1, lastOperationId: input.operationId, createdAt: timestamp, updatedAt: timestamp, codeHash: input.codeHash
    };
    this.grants.set(grant.grantId, grant);
    return this.publicGrant(grant);
  }

  async getManagedRoomGrant(grantId: string): Promise<ManagedRoomGrantRecord | null> {
    const grant = this.grants.get(grantId);
    return grant ? this.publicGrant(grant) : null;
  }

  async revokeManagedRoomGrant(grantId: string, reason: string | null, operationId: string): Promise<ManagedRoomGrantRecord | null> {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    const timestamp = this.timestamp();
    for (const candidate of this.grants.values()) {
      const same = candidate === grant || (grant.subject !== null && candidate.roomId === grant.roomId && candidate.subject === grant.subject);
      if (same && !candidate.revokedAt) {
        Object.assign(candidate, { revokedAt: timestamp, revokeReason: reason, revision: candidate.revision + 1, lastOperationId: operationId, updatedAt: timestamp });
      }
    }
    return this.publicGrant(grant);
  }

  async consumeManagedRoomGrant(roomId: string, codeHash: string): Promise<ManagedRoomGrantConsumeResult> {
    const room = this.managedRoom(roomId);
    const grant = [...this.grants.values()].find(candidate => candidate.codeHash === codeHash);
    if (!room || !grant || grant.roomId !== roomId) return { ok: false, code: "grant_invalid" };
    const block = managedRoomBlock({ status: room.managed!.status, cutoffMs: cutoffMs(room) }, this.now());
    if (block) return { ok: false, code: block };
    if (grant.revokedAt) return { ok: false, code: "grant_revoked" };
    if (Date.parse(grant.expiresAt) <= this.now() || grant.usedCount >= grant.maxUses) return { ok: false, code: "grant_invalid" };
    const maxParticipants = room.managed!.maxParticipants;
    if (maxParticipants) {
      const used = [...this.grants.values()].filter(candidate => candidate.roomId === roomId).reduce((sum, candidate) => sum + candidate.usedCount, 0);
      if (used >= maxParticipants) return { ok: false, code: "capacity_full" };
    }
    Object.assign(grant, { usedCount: grant.usedCount + 1, revision: grant.revision + 1, updatedAt: this.timestamp() });
    return { ok: true, grant: this.publicGrant(grant), room: structuredClone(room) };
  }

  async releaseManagedRoomGrantUse(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant && grant.usedCount > 0) Object.assign(grant, { usedCount: grant.usedCount - 1, revision: grant.revision + 1, updatedAt: this.timestamp() });
  }

  async recordManagedRoomGrantIdentity(grantId: string, identityId: string): Promise<void> {
    const identities = this.grantIdentities.get(grantId) ?? new Set<string>();
    identities.add(identityId);
    this.grantIdentities.set(grantId, identities);
  }

  async listManagedRoomGrantIdentities(grantId: string): Promise<string[]> {
    return [...(this.grantIdentities.get(grantId) ?? [])];
  }

  async requestManagedRoomRotation(roomId: string): Promise<void> {
    if (this.managedRoom(roomId)) this.state(roomId).rotateRequestedAt = this.timestamp();
  }

  async listIncompleteManagedGrantRevocations(): Promise<ManagedRoomGrantRecord[]> {
    return [...this.grants.values()].filter(grant => grant.revokedAt && !grant.revocationCompletedAt).map(grant => this.publicGrant(grant));
  }

  async completeManagedGrantRevocation(grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.revocationCompletedAt) return;
    grant.revocationCompletedAt = this.timestamp();
    if (grant.usedCount > 0) this.state(grant.roomId).rotateRequestedAt = grant.revocationCompletedAt;
  }

  /** Memory twin of the access update rule in PostgreSQL: a pause or a lapsed window asks for a new epoch. */
  noteManagedRoomAccessChange(room: RoomRecord, nextStatus: string): void {
    if (nextStatus === "paused" || this.now() >= cutoffMs(room)) this.state(room.roomId).rotateRequestedAt = this.timestamp();
  }

  async listManagedRoomsForEnforcement(): Promise<ManagedRoomEnforcementRecord[]> {
    const nowMs = this.now();
    return [...this.rooms.values()].flatMap(room => {
      if (!room.managed) return [];
      const state = this.state(room.roomId);
      const block = managedRoomBlock({ status: room.managed.status, cutoffMs: cutoffMs(room) }, nowMs);
      const due = block !== state.enforcedBlock || state.retiredEpochs.length > 0 || state.rotateRequestedAt !== null
        || (room.managed.kind === "demo-instance" && block === null);
      if (!due) return [];
      return [{
        roomId: room.roomId, tenantId: room.tenantId, kind: room.managed.kind, status: room.managed.status,
        cutoff: new Date(cutoffMs(room)).toISOString(), accessEpoch: room.managed.accessEpoch, enforcedBlock: state.enforcedBlock,
        retiredEpochs: [...state.retiredEpochs], rotateRequestedAt: state.rotateRequestedAt,
        idleTimeoutSeconds: room.managed.idleTimeoutSeconds ?? null, lastActivityAt: state.lastActivityAt,
        createdAt: room.managed.createdAt, revision: room.managed.revision
      }];
    });
  }

  async rotateManagedRoomEpoch(roomId: string, expectedEpoch: string, enforcedBlock: ManagedRoomBlockReason | null): Promise<string | null> {
    const room = this.managedRoom(roomId);
    if (!room || room.managed!.accessEpoch !== expectedEpoch) return null;
    const state = this.state(roomId);
    state.retiredEpochs.push(expectedEpoch);
    state.enforcedBlock = enforcedBlock;
    state.rotateRequestedAt = null;
    room.managed = { ...room.managed!, accessEpoch: randomUUID(), updatedAt: this.timestamp() };
    return room.managed.accessEpoch;
  }

  async setManagedRoomEnforcedBlock(roomId: string, enforcedBlock: ManagedRoomBlockReason | null): Promise<void> {
    if (this.managedRoom(roomId)) this.state(roomId).enforcedBlock = enforcedBlock;
  }

  async completeRetiredManagedRoomEpoch(roomId: string, epoch: string): Promise<void> {
    const state = this.enforcement.get(roomId);
    if (state) state.retiredEpochs = state.retiredEpochs.filter(candidate => candidate !== epoch);
  }

  async recordManagedRoomActivity(activity: ManagedRoomActivity[]): Promise<void> {
    const timestamp = this.timestamp();
    for (const entry of activity) {
      if (!this.managedRoom(entry.roomId)) continue;
      this.state(entry.roomId).lastActivityAt = timestamp;
      if (entry.participantSeconds <= 0) continue;
      const key = `${entry.tenantId}\u0000${utcDay(this.now())}`;
      const current = this.usage.get(key)?.participantSeconds ?? 0;
      this.usage.set(key, { participantSeconds: current + entry.participantSeconds, updatedAt: timestamp });
    }
  }

  async getIntegrationUsage(tenantId: string, day: string): Promise<{ participantSeconds: number; updatedAt: string | null }> {
    const usage = this.usage.get(`${tenantId}\u0000${day}`);
    return { participantSeconds: usage?.participantSeconds ?? 0, updatedAt: usage?.updatedAt ?? null };
  }

  async withManagedRoomEnforcerLock(fn: () => Promise<void>): Promise<boolean> {
    if (this.enforcerBusy) return false;
    this.enforcerBusy = true;
    try {
      await fn();
      return true;
    } finally {
      this.enforcerBusy = false;
    }
  }
}

interface GrantRow {
  grant_id: string;
  room_id: string;
  tenant_id: string;
  role: ManagedRoomGrantRole;
  subject: string | null;
  purpose: ManagedRoomGrantPurpose;
  max_uses: number;
  used_count: number;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoke_reason: string | null;
  display_name: string | null;
  return_context: unknown;
  revision: number;
  last_operation_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const GRANT_COLUMNS = `grant_id, room_id, tenant_id, role, subject, purpose, max_uses, used_count, expires_at, revoked_at, revoke_reason,
  display_name, return_context, revision, last_operation_id, created_at, updated_at`;

function mapGrant(row: GrantRow): ManagedRoomGrantRecord {
  return {
    grantId: row.grant_id, roomId: row.room_id, tenantId: row.tenant_id, role: row.role, subject: row.subject ?? null, purpose: row.purpose,
    maxUses: row.max_uses, usedCount: row.used_count, expiresAt: isoString(row.expires_at)!, revokedAt: isoString(row.revoked_at),
    revokeReason: row.revoke_reason, displayName: row.display_name, returnContext: row.return_context ?? null, revision: row.revision,
    lastOperationId: row.last_operation_id, createdAt: isoString(row.created_at)!, updatedAt: isoString(row.updated_at)!
  };
}

// The block a room has now, computed by the database clock like every other access check here.
const BLOCK_SQL = `case when ir.status = 'closed' then 'room_closed'
  when ir.access_until + ir.grace_seconds * interval '1 second' <= now() then 'access_expired'
  when ir.status = 'paused' then 'room_paused' else null end`;

export class PostgresManagedRooms {
  constructor(private readonly pool: Pool, private readonly getRoom: (roomId: string) => Promise<RoomRecord | null>) {}

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async closeManagedRoom(roomId: string, expectedRevision: number, reason: string | null, operationId: string | null): Promise<RoomRecord | "revision_mismatch" | null> {
    const outcome = await this.transaction(async client => {
      const current = await client.query<{ status: string; revision: number }>(`select status, revision from integration_rooms where room_id = $1 for update`, [roomId]);
      const row = current.rows[0];
      if (!row) return "missing" as const;
      if (row.status === "closed") return "closed" as const;
      if (row.revision !== expectedRevision) return "revision_mismatch" as const;
      await client.query(
        `update integration_rooms
            set status = 'closed', closed_at = now(), close_reason = $2, access_until = least(access_until, now()), grace_seconds = 0,
                revision = revision + 1, last_operation_id = coalesce($3, last_operation_id), rotate_requested_at = now(), updated_at = now()
          where room_id = $1`,
        [roomId, reason, operationId]
      );
      return "closed" as const;
    });
    if (outcome === "missing") return null;
    if (outcome === "revision_mismatch") return outcome;
    return this.getRoom(roomId);
  }

  async issueManagedRoomGrant(input: ManagedRoomGrantInput): Promise<ManagedRoomGrantRecord | ManagedRoomBlockReason | null> {
    return this.transaction(async client => {
      const room = await client.query<{ tenant_id: string; block: ManagedRoomBlockReason | null; cutoff: Date }>(
        `select ir.tenant_id, ${BLOCK_SQL} as block, ir.access_until + ir.grace_seconds * interval '1 second' as cutoff
           from integration_rooms ir where ir.room_id = $1 for update`, [input.roomId]);
      const row = room.rows[0];
      if (!row) return null;
      if (row.block) return row.block;
      const inserted = await client.query<GrantRow>(
        `insert into integration_grants (grant_id, room_id, tenant_id, code_hash, role, purpose, max_uses, expires_at, display_name, return_context, last_operation_id, subject)
         values ($1, $2, $3, $4, $5, $6, $7, least($8::timestamptz, $9::timestamptz), $10, $11::jsonb, $12, $13)
         returning ${GRANT_COLUMNS}`,
        [input.grantId, input.roomId, row.tenant_id, input.codeHash, input.role, input.purpose, input.maxUses, input.expiresAt, row.cutoff,
          input.displayName ?? null, input.returnContext === undefined ? null : JSON.stringify(input.returnContext), input.operationId, input.subject ?? null]
      );
      return mapGrant(inserted.rows[0]!);
    });
  }

  async getManagedRoomGrant(grantId: string): Promise<ManagedRoomGrantRecord | null> {
    const result = await this.pool.query<GrantRow>(`select ${GRANT_COLUMNS} from integration_grants where grant_id = $1`, [grantId]);
    return result.rows[0] ? mapGrant(result.rows[0]) : null;
  }

  // Touches only grant rows: an exchange locks the room before the grant, so this never waits in the other order.
  // An account grant ends the account's access to the room: its other open grants there go with it, each finished
  // later on its own identities, so a new grant issued after this revoke is untouched.
  async revokeManagedRoomGrant(grantId: string, reason: string | null, operationId: string): Promise<ManagedRoomGrantRecord | null> {
    const updated = await this.pool.query<GrantRow>(
      `with target as (select grant_id, room_id, subject from integration_grants where grant_id = $1)
       update integration_grants g
          set revoked_at = now(), revoke_reason = $2, revision = g.revision + 1, last_operation_id = $3, updated_at = now()
         from target
        where g.revoked_at is null
          and (g.grant_id = target.grant_id or (target.subject is not null and g.room_id = target.room_id and g.subject = target.subject))
        returning ${GRANT_COLUMNS.split(",").map(column => `g.${column.trim()}`).join(", ")}`, [grantId, reason, operationId]);
    const own = updated.rows.find(row => row.grant_id === grantId);
    if (own) return mapGrant(own);
    return this.getManagedRoomGrant(grantId);
  }

  async consumeManagedRoomGrant(roomId: string, codeHash: string): Promise<ManagedRoomGrantConsumeResult> {
    const outcome = await this.transaction(async (client): Promise<ManagedRoomGrantConsumeResult | { ok: true; grant: ManagedRoomGrantRecord }> => {
      // The room row lock serializes every entry into this room, so the participant limit holds under concurrency.
      const room = await client.query<{ block: ManagedRoomBlockReason | null; max_participants: number | null }>(
        `select ${BLOCK_SQL} as block, ir.max_participants from integration_rooms ir where ir.room_id = $1 for update`, [roomId]);
      const grant = await client.query<GrantRow & { expired: boolean }>(
        `select ${GRANT_COLUMNS}, expires_at <= now() as expired from integration_grants where code_hash = $1 for update`, [codeHash]);
      const roomRow = room.rows[0], grantRow = grant.rows[0];
      if (!roomRow || !grantRow || grantRow.room_id !== roomId) return { ok: false, code: "grant_invalid" };
      if (roomRow.block) return { ok: false, code: roomRow.block };
      if (grantRow.revoked_at) return { ok: false, code: "grant_revoked" };
      if (grantRow.expired || grantRow.used_count >= grantRow.max_uses) return { ok: false, code: "grant_invalid" };
      if (roomRow.max_participants) {
        const used = await client.query<{ used: number }>(`select coalesce(sum(used_count), 0)::int as used from integration_grants where room_id = $1`, [roomId]);
        if (used.rows[0]!.used >= roomRow.max_participants) return { ok: false, code: "capacity_full" };
      }
      const updated = await client.query<GrantRow>(
        `update integration_grants set used_count = used_count + 1, revision = revision + 1, updated_at = now()
          where grant_id = $1 returning ${GRANT_COLUMNS}`, [grantRow.grant_id]);
      return { ok: true, grant: mapGrant(updated.rows[0]!) };
    });
    if (!outcome.ok) return outcome;
    const room = await this.getRoom(roomId);
    return room ? { ...outcome, room } : { ok: false, code: "grant_invalid" };
  }

  async releaseManagedRoomGrantUse(grantId: string): Promise<void> {
    await this.pool.query(
      `update integration_grants set used_count = used_count - 1, revision = revision + 1, updated_at = now() where grant_id = $1 and used_count > 0`, [grantId]);
  }

  async recordManagedRoomGrantIdentity(grantId: string, identityId: string): Promise<void> {
    await this.pool.query(`insert into integration_grant_identities (grant_id, identity_id) values ($1, $2) on conflict do nothing`, [grantId, identityId]);
  }

  async listManagedRoomGrantIdentities(grantId: string): Promise<string[]> {
    const result = await this.pool.query<{ identity_id: string }>(`select identity_id from integration_grant_identities where grant_id = $1 order by created_at`, [grantId]);
    return result.rows.map(row => row.identity_id);
  }

  async requestManagedRoomRotation(roomId: string): Promise<void> {
    await this.pool.query(`update integration_rooms set rotate_requested_at = now() where room_id = $1`, [roomId]);
  }

  async listIncompleteManagedGrantRevocations(): Promise<ManagedRoomGrantRecord[]> {
    const result = await this.pool.query<GrantRow>(
      `select ${GRANT_COLUMNS} from integration_grants where revoked_at is not null and revocation_completed_at is null order by revoked_at limit 100`);
    return result.rows.map(mapGrant);
  }

  // Room row first, then the grant: the same order as an exchange.
  async completeManagedGrantRevocation(grantId: string): Promise<void> {
    await this.transaction(async client => {
      const room = await client.query<{ room_id: string }>(
        `select ir.room_id from integration_rooms ir join integration_grants g on g.room_id = ir.room_id where g.grant_id = $1 for update of ir`, [grantId]);
      if (!room.rows[0]) return;
      const done = await client.query<{ used_count: number }>(
        `update integration_grants set revocation_completed_at = now() where grant_id = $1 and revocation_completed_at is null returning used_count`, [grantId]);
      if ((done.rows[0]?.used_count ?? 0) > 0) {
        await client.query(`update integration_rooms set rotate_requested_at = now() where room_id = $1`, [room.rows[0].room_id]);
      }
    });
  }

  async listManagedRoomsForEnforcement(): Promise<ManagedRoomEnforcementRecord[]> {
    const result = await this.pool.query<{
      room_id: string; tenant_id: string; kind: ManagedRoomKind; status: ManagedRoomStatus; cutoff: Date; access_epoch: string;
      enforced_block: ManagedRoomBlockReason | null; retired_epochs: string[]; rotate_requested_at: Date | null;
      idle_timeout_seconds: number | null; last_activity_at: Date | null; created_at: Date; revision: number;
    }>(
      `select * from (
         select ir.room_id, ir.tenant_id, ir.kind, ir.status, ir.access_until + ir.grace_seconds * interval '1 second' as cutoff,
                ir.access_epoch::text as access_epoch, ir.enforced_block, ir.retired_epochs::text[] as retired_epochs, ir.rotate_requested_at,
                ir.idle_timeout_seconds, ir.last_activity_at, ir.created_at, ir.revision, ${BLOCK_SQL} as block
           from integration_rooms ir
          where ir.enforced_block is distinct from 'room_closed' or ir.retired_epochs <> '{}' or ir.rotate_requested_at is not null
       ) candidate
       where block is distinct from enforced_block or retired_epochs <> '{}' or rotate_requested_at is not null
          or (kind = 'demo-instance' and block is null)
       order by room_id`
    );
    return result.rows.map(row => ({
      roomId: row.room_id, tenantId: row.tenant_id, kind: row.kind, status: row.status, cutoff: isoString(row.cutoff)!,
      accessEpoch: row.access_epoch, enforcedBlock: row.enforced_block, retiredEpochs: row.retired_epochs,
      rotateRequestedAt: isoString(row.rotate_requested_at), idleTimeoutSeconds: row.idle_timeout_seconds,
      lastActivityAt: isoString(row.last_activity_at), createdAt: isoString(row.created_at)!, revision: row.revision
    }));
  }

  async rotateManagedRoomEpoch(roomId: string, expectedEpoch: string, enforcedBlock: ManagedRoomBlockReason | null): Promise<string | null> {
    const result = await this.pool.query<{ access_epoch: string }>(
      `update integration_rooms
          set retired_epochs = array_append(retired_epochs, access_epoch), access_epoch = gen_random_uuid(),
              enforced_block = $3, rotate_requested_at = null, updated_at = now()
        where room_id = $1 and access_epoch = $2::uuid
        returning access_epoch::text as access_epoch`, [roomId, expectedEpoch, enforcedBlock]);
    return result.rows[0]?.access_epoch ?? null;
  }

  async setManagedRoomEnforcedBlock(roomId: string, enforcedBlock: ManagedRoomBlockReason | null): Promise<void> {
    await this.pool.query(`update integration_rooms set enforced_block = $2 where room_id = $1`, [roomId, enforcedBlock]);
  }

  async completeRetiredManagedRoomEpoch(roomId: string, epoch: string): Promise<void> {
    await this.pool.query(`update integration_rooms set retired_epochs = array_remove(retired_epochs, $2::uuid) where room_id = $1`, [roomId, epoch]);
  }

  async recordManagedRoomActivity(activity: ManagedRoomActivity[]): Promise<void> {
    if (activity.length === 0) return;
    await this.transaction(async client => {
      await client.query(`update integration_rooms set last_activity_at = now() where room_id = any($1::text[])`, [activity.map(entry => entry.roomId)]);
      const totals = new Map<string, number>();
      for (const entry of activity) if (entry.participantSeconds > 0) totals.set(entry.tenantId, (totals.get(entry.tenantId) ?? 0) + entry.participantSeconds);
      if (totals.size === 0) return;
      await client.query(
        `insert into integration_usage (tenant_id, day, participant_seconds)
         select usage.tenant_id, (now() at time zone 'utc')::date, usage.seconds
           from unnest($1::text[], $2::bigint[]) as usage(tenant_id, seconds)
           join tenants on tenants.tenant_id = usage.tenant_id
         on conflict (tenant_id, day) do update
           set participant_seconds = integration_usage.participant_seconds + excluded.participant_seconds, updated_at = now()`,
        [[...totals.keys()], [...totals.values()].map(value => Math.round(value))]
      );
    });
  }

  async getIntegrationUsage(tenantId: string, day: string): Promise<{ participantSeconds: number; updatedAt: string | null }> {
    const result = await this.pool.query<{ participant_seconds: string; updated_at: Date }>(
      `select participant_seconds, updated_at from integration_usage where tenant_id = $1 and day = $2::date`, [tenantId, day]);
    const row = result.rows[0];
    return { participantSeconds: row ? Number(row.participant_seconds) : 0, updatedAt: row ? isoString(row.updated_at) : null };
  }

  async withManagedRoomEnforcerLock(fn: () => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const locked = await client.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtextextended($1, 0)) as locked`, [ENFORCER_LOCK_KEY]);
      if (!locked.rows[0]?.locked) return false;
      try {
        await fn();
      } finally {
        await client.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [ENFORCER_LOCK_KEY]);
      }
      return true;
    } finally {
      client.release();
    }
  }
}
