import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { activatedIdentityRoomGuard, legacyIdentityRoomGuard } from "./protocol-guard.js";

export type MediaCodec = 2 | 3;
/** The floor-two media address space: one namespace plus the monotonic codec that new grants use. */
export interface MediaBoundary { namespace: string; codec: MediaCodec }

export interface IdentityProtocolPolicy {
  minimum(): Promise<number>;
  mediaNamespace(): Promise<string | null>;
  /** Null below floor two. Codec 3 retires every codec-2 grant; it is never lowered. */
  mediaBoundary(): Promise<MediaBoundary | null>;
  raise(minimum: 1 | 2): Promise<number>;
  raiseMediaCodec(codec: MediaCodec): Promise<MediaCodec>;
}

function assertMediaCodec(value: number): asserts value is MediaCodec {
  if (value !== 2 && value !== 3) throw new Error("invalid_media_codec");
}

function assertMinimum(value: number): void {
  if (value !== 1 && value !== 2) throw new Error("invalid_identity_protocol");
}

export function createMemoryIdentityProtocol(): IdentityProtocolPolicy & { current(): number; currentMediaCodec(): MediaCodec; currentMediaNamespace(): string | null } {
  let minimum = 1;
  let namespace: string | null = null;
  let mediaCodec: MediaCodec = 2;
  return {
    current() { return minimum; },
    currentMediaCodec() { return mediaCodec; },
    currentMediaNamespace() { return namespace; },
    async minimum() { return minimum; },
    async mediaNamespace() { return namespace; },
    async mediaBoundary() { return namespace === null ? null : { namespace, codec: mediaCodec }; },
    async raiseMediaCodec(value) {
      assertMediaCodec(value);
      if (minimum < 2) throw new Error("media_codec_requires_identity_v2");
      if (value < mediaCodec) throw new Error("media_codec_downgrade_forbidden");
      mediaCodec = value;
      return mediaCodec;
    },
    async raise(value) {
      assertMinimum(value);
      if (value < minimum) throw new Error("identity_protocol_downgrade_forbidden");
      if (value >= 2) namespace ??= randomBytes(16).toString("hex");
      minimum = value;
      return minimum;
    }
  };
}

export function createPostgresIdentityProtocol(pool: Pool): IdentityProtocolPolicy {
  return {
    async minimum() {
      const row = (await pool.query("select minimum_protocol from room_identity_protocol_policy where singleton=true")).rows[0];
      if (!row || !Number.isInteger(row.minimum_protocol) || row.minimum_protocol < 1) throw new Error("identity_protocol_policy_missing");
      return row.minimum_protocol;
    },
    async mediaNamespace() {
      const row = (await pool.query("select minimum_protocol, media_namespace from room_identity_protocol_policy where singleton=true")).rows[0];
      if (!row) throw new Error("identity_protocol_policy_missing");
      if (row.minimum_protocol === 1 && row.media_namespace === null) return null;
      if (row.minimum_protocol >= 2 && typeof row.media_namespace === "string" && /^[a-f0-9]{32}$/.test(row.media_namespace)) return row.media_namespace;
      throw new Error("identity_protocol_namespace_invalid");
    },
    async mediaBoundary() {
      const row = (await pool.query("select minimum_protocol, media_namespace, media_codec from room_identity_protocol_policy where singleton=true")).rows[0];
      if (!row) throw new Error("identity_protocol_policy_missing");
      if (row.minimum_protocol === 1 && row.media_namespace === null && row.media_codec === 2) return null;
      if (row.minimum_protocol >= 2 && typeof row.media_namespace === "string" && /^[a-f0-9]{32}$/.test(row.media_namespace)
        && (row.media_codec === 2 || row.media_codec === 3)) return { namespace: row.media_namespace, codec: row.media_codec };
      throw new Error("identity_protocol_namespace_invalid");
    },
    async raiseMediaCodec(value) {
      assertMediaCodec(value);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))");
        await client.query("set local lock_timeout='2s'");
        // EXCLUSIVE waits for every issuance fence holding the policy FOR SHARE:
        // a codec-2 grant is either released before this commit or refused after it.
        await client.query("lock table room_identity_protocol_policy in exclusive mode");
        const row = (await client.query("select minimum_protocol,media_codec from room_identity_protocol_policy where singleton=true for update")).rows[0];
        if (!row) throw new Error("identity_protocol_policy_missing");
        if (row.minimum_protocol < 2) throw new Error("media_codec_requires_identity_v2");
        if (value < row.media_codec) throw new Error("media_codec_downgrade_forbidden");
        await client.query("update room_identity_protocol_policy set media_codec=$1 where singleton=true", [value]);
        await client.query("commit");
        return value;
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    },
    async raise(value) {
      assertMinimum(value);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))");
        await client.query("set local lock_timeout='2s'");
        // Queue new FOR SHARE readers behind activation, rather than letting a
        // continuous stream of tuple-share lockers starve the floor update.
        await client.query("lock table room_identity_protocol_policy in exclusive mode");
        const row = (await client.query("select minimum_protocol,media_namespace from room_identity_protocol_policy where singleton=true for update")).rows[0];
        if (!row) throw new Error("identity_protocol_policy_missing");
        if (value < row.minimum_protocol) throw new Error("identity_protocol_downgrade_forbidden");
        if (value >= 2) {
          const guard = await client.query(`select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
            where n.nspname=current_schema() and p.proname='vrata_identity_v2_room_boundary' and p.pronargs=0
            and p.prosrc=any($1::text[]) and p.prorettype='trigger'::regtype and l.lanname='plpgsql'
            and not p.prosecdef and not p.proleakproof and not p.proisstrict and p.provolatile='v' and p.proparallel='u' and p.proconfig is null`, [[legacyIdentityRoomGuard, activatedIdentityRoomGuard]]);
          if (guard.rowCount !== 1) throw new Error("room_identity_guard_mismatch");
          // The floor and guard replacement commit together. Released S2a
          // binaries do not recognise this body and must not restart on v2 data.
          await client.query(`do $activate$ begin
            execute format('create or replace function %I.vrata_identity_v2_room_boundary() returns trigger language plpgsql as %L', current_schema(), $body$${activatedIdentityRoomGuard}$body$);
          end; $activate$;`);
        }
        const namespace = value >= 2 ? row.media_namespace ?? randomBytes(16).toString("hex") : null;
        if (value >= 2 && !/^[a-f0-9]{32}$/.test(namespace)) throw new Error("identity_protocol_namespace_invalid");
        await client.query("update room_identity_protocol_policy set minimum_protocol=$1,media_namespace=$2 where singleton=true", [value, namespace]);
        await client.query("commit");
        return value;
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
  };
}
