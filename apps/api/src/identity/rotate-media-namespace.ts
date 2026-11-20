import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { RoomServiceClient } from "livekit-server-sdk";
import { getLivekitCredentials, getMediaTokenConfigError } from "../livekit-config.js";
import { PostgresStorage } from "../storage.js";
import { createPostgresIdentityProtocol, type PreviousMediaNamespace } from "./protocol.js";

export interface MediaNamespaceRotationResult {
  previous: PreviousMediaNamespace;
  /** The current namespace before and after. Namespaces are not secret (every grant names its room); keep the new one
   * with the backup records: a restore from an older backup must retire it. A lost reply is checked with --dry-run. */
  before: string;
  after: string;
  /** How many namespaces this database has retired; the reconciler deletes their native rooms. */
  retired: number;
  rotated: boolean;
  dryRun: boolean;
  /** Dry run only: namespaces under this deployment's room prefix on the SFU that this database neither uses, retired
   * nor used before, with their room counts. After a restore they may be rotations the backup does not know. */
  unknownNamespaces?: Record<string, number> | "unavailable";
  /** Dry run only: the schema predates rotation; the real run migrates it first. */
  migrationRequired?: boolean;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Read-only: room names of every media namespace on the SFU under the deployment's prefix. */
async function sfuNamespaces(env: NodeJS.ProcessEnv): Promise<Map<string, number> | null> {
  if (getMediaTokenConfigError(env) || !env.LIVEKIT_URL) return null;
  const { apiKey, apiSecret } = getLivekitCredentials(env);
  if (!apiKey || !apiSecret) return null;
  const native = new RoomServiceClient(env.LIVEKIT_API_URL?.trim() || env.LIVEKIT_URL, apiKey, apiSecret, { requestTimeout: 5 });
  const pattern = new RegExp(`^${escape(env.LIVEKIT_ROOM_PREFIX ?? "vrata-")}v[23]:([a-f0-9]{32}):`);
  const counts = new Map<string, number>();
  for (const room of await native.listRooms()) {
    const namespace = pattern.exec(room.name)?.[1];
    if (namespace) counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return counts;
}

/** Operator action, irreversible: every media grant is issued in a fresh namespace from now on, and a grant
 * prepared for the previous one is refused. "retire" keeps the previous namespace owned, so the reconciler deletes
 * its native rooms (a database restored onto the same SFU, leaked media credentials). "disown" leaves it alone (a
 * database cloned onto an SFU the original still uses; run it before the clone's API first starts). `alsoRetire`
 * adds namespaces of this deployment the database does not know. Open tabs lose their media connection and join
 * audio again; remote browsers must be reopened. Rotation does not void room sessions or identity credentials.
 * A database restored from a backup taken before rotation support is migrated first, as the API would on start, so
 * the rotation runs without starting the API (whose reconciler must not run before it); a dry run never migrates. */
export async function rotateMediaNamespace(pool: Pool, options: { previous: PreviousMediaNamespace; alsoRetire?: readonly string[];
  dryRun: boolean; env?: NodeJS.ProcessEnv }): Promise<MediaNamespaceRotationResult> {
  const migrated = (await pool.query(`select exists(select 1 from pg_attribute where attrelid=to_regclass('room_identity_protocol_policy')
    and attname='previous_media_namespaces' and not attisdropped) as value`)).rows[0]?.value === true;
  if (!migrated && !options.dryRun) await new PostgresStorage(pool).init();
  const policy = createPostgresIdentityProtocol(pool);
  if (await policy.minimum() < 2) throw new Error("media_namespace_requires_identity_v2");
  // Before the migration the activation namespace is the only one this database has used.
  const before = migrated || !options.dryRun ? await policy.mediaBoundary() : { retired: [] as string[], namespace:
    (await pool.query("select media_namespace from room_identity_protocol_policy where singleton=true")).rows[0]?.media_namespace as string | undefined };
  if (!before?.namespace) throw new Error("media_namespace_requires_identity_v2");
  if (options.dryRun) {
    const used = migrated ? (await pool.query("select previous_media_namespaces from room_identity_protocol_policy where singleton=true")).rows[0]?.previous_media_namespaces : [];
    if (!Array.isArray(used)) throw new Error("identity_protocol_namespace_invalid");
    let unknownNamespaces: MediaNamespaceRotationResult["unknownNamespaces"];
    try {
      const counts = await sfuNamespaces(options.env ?? process.env);
      unknownNamespaces = counts ? Object.fromEntries([...counts].filter(([namespace]) =>
        namespace !== before.namespace && !before.retired.includes(namespace) && !used.includes(namespace)).sort()) : "unavailable";
    } catch { unknownNamespaces = "unavailable"; }
    return { previous: options.previous, before: before.namespace, after: before.namespace,
      retired: before.retired.length, rotated: false, dryRun: true, unknownNamespaces, ...(migrated ? {} : { migrationRequired: true }) };
  }
  const rotation = await policy.rotateMediaNamespace(options.previous, options.alsoRetire ?? []);
  const after = await policy.mediaBoundary();
  if (!after || after.namespace === before.namespace || after.retired.length !== rotation.retired
    || (options.previous === "retire") !== after.retired.includes(before.namespace)) throw new Error("media_namespace_rotation_not_confirmed");
  return { previous: options.previous, before: before.namespace, after: after.namespace,
    retired: rotation.retired, rotated: true, dryRun: false };
}

async function operatorMain(): Promise<void> {
  const args = process.argv.slice(2);
  let pool: Pool | undefined;
  try {
    const dryRun = args.includes("--dry-run");
    const value = (name: string) => args.filter(arg => arg.startsWith(`--${name}=`)).map(arg => arg.slice(name.length + 3));
    const previous = value("previous"), alsoRetire = value("retire");
    if (args.some(arg => !["--dry-run", "--confirm-irreversible"].includes(arg) && !/^--(previous|retire)=/.test(arg))
      || new Set(args).size !== args.length || previous.length !== 1 || (previous[0] !== "retire" && previous[0] !== "disown")
      || alsoRetire.some(namespace => !/^[a-f0-9]{32}$/.test(namespace))) throw new Error("media_namespace_rotation_invalid_arguments");
    if (!dryRun && !args.includes("--confirm-irreversible")) throw new Error("media_namespace_rotation_confirmation_required");
    if (!process.env.POSTGRES_URL) throw new Error("media_namespace_rotation_database_required");
    // A migration waits at most this long for a table lock rather than queueing the API behind it.
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 4, options: "-c lock_timeout=5000" });
    process.stdout.write(`${JSON.stringify({ ok: true, ...await rotateMediaNamespace(pool, { previous: previous[0], alsoRetire, dryRun }) })}\n`);
  } catch (error) {
    // Fixed codes only: no connection strings, SQL or stack traces.
    const message = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "media_namespace_rotation_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`); process.exitCode = 1;
  } finally { await pool?.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await operatorMain();
