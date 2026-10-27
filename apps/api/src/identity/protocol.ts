import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { activatedIdentityRoomGuard, legacyIdentityRoomGuard } from "./protocol-guard.js";

export type MediaCodec = 2 | 3;
/** The floor-two media address space: the current namespace, the monotonic codec that new grants use and the
 * namespaces this database owned and retired; every native room of a retired namespace is deleted. */
export interface MediaBoundary { namespace: string; codec: MediaCodec; retired: readonly string[] }
/** What happens to the namespace being replaced: "retire" keeps it owned and its rooms are deleted (a restored
 * database, leaked media credentials); "disown" leaves it to whoever else uses it (a database cloned onto the same SFU). */
export type PreviousMediaNamespace = "retire" | "disown";
export interface MediaNamespaceRotation { previous: PreviousMediaNamespace; retired: number }

export interface IdentityProtocolPolicy {
  minimum(): Promise<number>;
  mediaNamespace(): Promise<string | null>;
  /** Null below floor two. Codec 3 retires every codec-2 grant; it is never lowered. */
  mediaBoundary(): Promise<MediaBoundary | null>;
  raise(minimum: 1 | 2): Promise<number>;
  raiseMediaCodec(codec: MediaCodec): Promise<MediaCodec>;
  /** Replaces the current media namespace with a fresh one that was never used; irreversible. Grants prepared for the
   * old one are refused. `alsoRetire` names further namespaces of this deployment the database no longer knows, e.g.
   * of a rotation made after the backup it was restored from. */
  rotateMediaNamespace(previous: PreviousMediaNamespace, alsoRetire?: readonly string[]): Promise<MediaNamespaceRotation>;
}

function assertMediaCodec(value: number): asserts value is MediaCodec {
  if (value !== 2 && value !== 3) throw new Error("invalid_media_codec");
}

function assertMinimum(value: number): void {
  if (value !== 1 && value !== 2) throw new Error("invalid_identity_protocol");
}

function assertPrevious(value: string): asserts value is PreviousMediaNamespace {
  if (value !== "retire" && value !== "disown") throw new Error("invalid_media_namespace_rotation");
}

/** The retired list after one rotation: append-only, without duplicates and never the namespace being disowned. */
function retiredAfter(current: { namespace: string; retired: readonly string[] }, previous: PreviousMediaNamespace,
  alsoRetire: readonly string[]): string[] {
  if (!Array.isArray(alsoRetire) || alsoRetire.some(value => typeof value !== "string" || !hex32.test(value))
    || previous === "disown" && alsoRetire.includes(current.namespace)) throw new Error("invalid_media_namespace_rotation");
  const retired = [...current.retired];
  for (const value of previous === "retire" ? [current.namespace, ...alsoRetire] : alsoRetire) if (!retired.includes(value)) retired.push(value);
  return retired;
}

/** A fresh namespace, never one this database used or retired. */
function freshNamespace(used: readonly string[]): string {
  const value = randomBytes(16).toString("hex");
  if (used.includes(value)) throw new Error("media_namespace_rotation_collision");
  return value;
}

const hex32 = /^[a-f0-9]{32}$/;
/** The effective namespace and the retired list, validated together; null below floor two. */
function boundaryRow(row: { minimum_protocol: number; media_namespace: unknown; rotated_media_namespace: unknown;
  retired_media_namespaces: unknown; media_codec?: unknown }): { namespace: string; retired: string[] } | null {
  if (row.minimum_protocol === 1 && row.media_namespace === null && row.rotated_media_namespace === null) return null;
  const namespace = row.rotated_media_namespace ?? row.media_namespace;
  const retired = row.retired_media_namespaces;
  if (row.minimum_protocol >= 2 && typeof row.media_namespace === "string" && hex32.test(row.media_namespace)
    && typeof namespace === "string" && hex32.test(namespace) && Array.isArray(retired)
    && retired.every(value => typeof value === "string" && hex32.test(value) && value !== namespace)) return { namespace, retired };
  throw new Error("identity_protocol_namespace_invalid");
}

export function createMemoryIdentityProtocol(): IdentityProtocolPolicy & { current(): number; currentMediaCodec(): MediaCodec; currentMediaNamespace(): string | null } {
  let minimum = 1;
  let namespace: string | null = null;
  let mediaCodec: MediaCodec = 2;
  let retired: string[] = [];
  const previousNamespaces: string[] = [];
  return {
    current() { return minimum; },
    currentMediaCodec() { return mediaCodec; },
    currentMediaNamespace() { return namespace; },
    async minimum() { return minimum; },
    async mediaNamespace() { return namespace; },
    async mediaBoundary() { return namespace === null ? null : { namespace, codec: mediaCodec, retired: [...retired] }; },
    async rotateMediaNamespace(previous, alsoRetire = []) {
      assertPrevious(previous);
      if (minimum < 2 || namespace === null) throw new Error("media_namespace_requires_identity_v2");
      const next = retiredAfter({ namespace, retired }, previous, alsoRetire);
      const fresh = freshNamespace([...previousNamespaces, namespace, ...next]);
      previousNamespaces.push(namespace); retired = next; namespace = fresh;
      return { previous, retired: retired.length };
    },
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
      const row = (await pool.query(`select minimum_protocol, media_namespace, rotated_media_namespace, retired_media_namespaces
        from room_identity_protocol_policy where singleton=true`)).rows[0];
      if (!row) throw new Error("identity_protocol_policy_missing");
      return boundaryRow(row)?.namespace ?? null;
    },
    async mediaBoundary() {
      const row = (await pool.query(`select minimum_protocol, media_namespace, rotated_media_namespace, retired_media_namespaces, media_codec
        from room_identity_protocol_policy where singleton=true`)).rows[0];
      if (!row) throw new Error("identity_protocol_policy_missing");
      const boundary = boundaryRow(row);
      if (!boundary) {
        if (row.media_codec === 2) return null;
        throw new Error("identity_protocol_namespace_invalid");
      }
      if (row.media_codec !== 2 && row.media_codec !== 3) throw new Error("identity_protocol_namespace_invalid");
      return { namespace: boundary.namespace, codec: row.media_codec, retired: boundary.retired };
    },
    async rotateMediaNamespace(previous, alsoRetire = []) {
      assertPrevious(previous);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended('vrata:postgres-storage-init:v1', 0))");
        await client.query("set local lock_timeout='2s'");
        // EXCLUSIVE waits for every issuance fence holding the policy FOR SHARE: a grant prepared for the
        // previous namespace is either released before this commit or refused after it.
        await client.query("lock table room_identity_protocol_policy in exclusive mode");
        const row = (await client.query(`select minimum_protocol, media_namespace, rotated_media_namespace, retired_media_namespaces,
          previous_media_namespaces from room_identity_protocol_policy where singleton=true for update`)).rows[0];
        if (!row) throw new Error("identity_protocol_policy_missing");
        const current = row.minimum_protocol >= 2 ? boundaryRow(row) : null;
        if (!current || !Array.isArray(row.previous_media_namespaces)) throw new Error("media_namespace_requires_identity_v2");
        const retired = retiredAfter(current, previous, alsoRetire);
        // The trigger also enforces the whole transition; this is the same rule stated in code.
        await client.query(`update room_identity_protocol_policy set rotated_media_namespace=$1, retired_media_namespaces=$2::text[],
          previous_media_namespaces=array_append(previous_media_namespaces, $3) where singleton=true`,
        [freshNamespace([...row.previous_media_namespaces, current.namespace, ...retired]), retired, current.namespace]);
        await client.query("commit");
        return { previous, retired: retired.length };
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
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
