import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { assertDocumentStorageKey, documentObjectMissing, documentObjectStores, type DocumentObjectStores } from "./document-storage.js";
import { roomPluginAnonymousEndpoint } from "./plugins/anonymous-probe-endpoint.js";
import { resolveSceneBundlePublicUrl } from "./scene-bundle-storage.js";
import { deleteDocumentObject, listStoredObjects, readPrivateUploadedObject, sha256Hex, trimSlashes, writeDocumentObject } from "./uploaded-object-storage.js";

/** Operator command: moves room documents that earlier releases wrote to the public object namespace into the
 * private one, deletes every public copy and checks that a document object is not served anonymously.
 *
 *   node apps/api/dist/document-storage-move.js            counts only, no writes
 *   node apps/api/dist/document-storage-move.js --verify   privacy probe with one fixture object
 *   node apps/api/dist/document-storage-move.js --confirm  move, delete public copies, list again, probe
 *   node apps/api/dist/document-storage-move.js --restore  as --confirm, but objects without a row are deleted at
 *                                                           once (no writer of an older release runs after a restore)
 *                                                           and there is no probe (the public address may not
 *                                                           answer yet; --verify checks it later)
 *
 * A live row's object is copied only after its bytes match the recorded checksum, and its public copy is deleted
 * only after a signed read of the private copy matches too. Copies of tombstoned rows and objects without a row are
 * deleted; an object without a row younger than ORPHAN_MIN_AGE_MS is left for the next run, because a writer of an
 * older release may not have committed its row yet. Output is counts only: no keys, URLs or credentials.
 */

export const ORPHAN_MIN_AGE_MS = 15 * 60_000;

export interface DocumentRowState { live: boolean; sizeBytes: number; checksum: string; contentType: string }
export interface DocumentRowSource {
  snapshot(): Promise<Map<string, DocumentRowState>>;
  current(key: string): Promise<DocumentRowState | null>;
}

export interface DocumentMoveCounts {
  legacyConfigured: boolean;
  legacyObjects: number;
  liveToMove: number;
  publicCopiesToDelete: number;
  recentOrphans: number;
  moved: number;
  alreadyPrivate: number;
  deletedTombstoned: number;
  deletedOrphans: number;
  checksumMismatch: number;
  conflicts: number;
  failed: number;
  remaining: number | null;
  /** Objects left in the public prefix that this run neither kept on purpose nor failed on (a concurrent writer). */
  unexpectedRemaining: number | null;
}

export interface DocumentPrivacyProbe {
  checked: boolean;
  signedReadExact: boolean;
  publicUrlDenied: boolean;
  privateBucketAnonymousDenied: boolean;
  publicEndpointPrivateBucketDenied: boolean;
  cleanup: boolean;
}

type Mode = "dry-run" | "verify" | "confirm" | "restore";

function mergeRows(rows: Map<string, DocumentRowState>, key: string, state: DocumentRowState): void {
  const previous = rows.get(key);
  // Keys carry a random document id; should two rows ever share one, a live row keeps the object.
  if (!previous || state.live && !previous.live) rows.set(key, state);
}

export function postgresDocumentRows(pool: Pool): DocumentRowSource {
  const select = "select storage_key, size_bytes, checksum, content_type, deleted_at is null as live from room_documents";
  const map = (rows: Array<{ storage_key: string; size_bytes: string | number; checksum: string; content_type: string; live: boolean }>) => {
    const result = new Map<string, DocumentRowState>();
    for (const row of rows) mergeRows(result, row.storage_key, { live: row.live, sizeBytes: Number(row.size_bytes), checksum: row.checksum, contentType: row.content_type });
    return result;
  };
  return {
    async snapshot() { return map((await pool.query(select)).rows); },
    async current(key) { return map((await pool.query(`${select} where storage_key = $1`, [key])).rows).get(key) ?? null; }
  };
}

function documentPrefix(env: NodeJS.ProcessEnv): string {
  const prefix = trimSlashes(env.MINIO_DOCUMENT_PREFIX ?? "documents");
  if (!prefix) throw new Error("document_prefix_required");
  return `${prefix}/`;
}

function emptyCounts(legacyConfigured: boolean): DocumentMoveCounts {
  return { legacyConfigured, legacyObjects: 0, liveToMove: 0, publicCopiesToDelete: 0, recentOrphans: 0, moved: 0, alreadyPrivate: 0,
    deletedTombstoned: 0, deletedOrphans: 0, checksumMismatch: 0, conflicts: 0, failed: 0, remaining: null, unexpectedRemaining: null };
}

const checksumOf = (bytes: Buffer) => `sha256:${sha256Hex(bytes)}`;

async function readOptional(storage: DocumentObjectStores["current"], key: string, limit: number): Promise<Buffer | null> {
  try { return await readPrivateUploadedObject(storage, key, limit); }
  catch (error) { if (documentObjectMissing(error)) return null; throw error; }
}

/** Copies one live object; resolves "moved", "already" or a refusal. The public copy is not touched here. */
async function copyToPrivate(stores: DocumentObjectStores & { legacy: NonNullable<DocumentObjectStores["legacy"]> }, key: string,
  row: DocumentRowState): Promise<"moved" | "already" | "missing" | "mismatch" | "conflict"> {
  const limit = Math.max(1, row.sizeBytes);
  const existing = await readOptional(stores.current, key, limit);
  if (existing) return checksumOf(existing) === row.checksum ? "already" : "conflict";
  const bytes = await readOptional(stores.legacy, key, limit);
  if (!bytes) return "missing";
  if (checksumOf(bytes) !== row.checksum) return "mismatch";
  try { await writeDocumentObject(stores.current, key, bytes, row.contentType, { ifAbsent: true }); }
  catch (error) {
    // Another run wrote it first: accept only identical bytes.
    if ((error as { code?: string }).code !== "EEXIST" && !(error instanceof Error && /^document_object_upload_failed:(409|412)$/.test(error.message))) throw error;
  }
  const written = await readOptional(stores.current, key, limit);
  if (!written) throw new Error("document_move_private_copy_missing");
  return checksumOf(written) === row.checksum ? "moved" : "conflict";
}

export async function moveLegacyDocuments(stores: DocumentObjectStores, rows: DocumentRowSource,
  options: { prefix: string; confirm: boolean; now?: () => number; orphanMinAgeMs?: number }): Promise<DocumentMoveCounts> {
  const counts = emptyCounts(!!stores.legacy);
  if (!stores.legacy) return counts;
  const legacyStores = stores as DocumentObjectStores & { legacy: NonNullable<DocumentObjectStores["legacy"]> };
  const now = options.now ?? Date.now;
  const orphanMinAgeMs = options.orphanMinAgeMs ?? ORPHAN_MIN_AGE_MS;
  // List first, then read rows: an older writer commits its row after its object, so a listed object whose row is
  // not visible yet is at most as old as that writer's request.
  const listed = await listStoredObjects(stores.legacy, options.prefix);
  const snapshot = await rows.snapshot();
  const candidates = new Map<string, Date | null>(listed.map(entry => [entry.key, entry.lastModified]));
  // Rows whose key is outside the listed prefix (an earlier prefix setting) are still checked by key, tombstones too.
  for (const key of snapshot.keys()) if (!candidates.has(key) && !key.startsWith(options.prefix)) candidates.set(key, null);
  counts.legacyObjects = listed.length;
  for (const [key, lastModified] of candidates) {
    const row = snapshot.get(key);
    if (row?.live) counts.liveToMove += 1;
    else if (!row && lastModified && now() - lastModified.getTime() < orphanMinAgeMs) counts.recentOrphans += 1;
    else counts.publicCopiesToDelete += 1;
  }
  if (!options.confirm) return counts;

  // Keys this run leaves in place on purpose (recent orphans) or because an operation refused or failed.
  const kept = new Set<string>();
  for (const [key, lastModified] of candidates) {
    try {
      assertDocumentStorageKey(key);
      const row = await rows.current(key);
      if (row?.live) {
        const result = await copyToPrivate(legacyStores, key, row);
        if (result === "missing") continue;
        if (result === "mismatch") { counts.checksumMismatch += 1; kept.add(key); continue; }
        if (result === "conflict") { counts.conflicts += 1; kept.add(key); continue; }
        // A deletion that tombstoned the row while the copy was written may already have removed the private
        // object; the copy must not outlive it. A later tombstone is followed by that deletion's own cleanup.
        const after = await rows.current(key);
        if (!after?.live) await deleteDocumentObject(stores.current, key);
        await deleteDocumentObject(stores.legacy, key);
        if (!after?.live) counts.deletedTombstoned += 1;
        else if (result === "moved") counts.moved += 1;
        else counts.alreadyPrivate += 1;
        continue;
      }
      if (!row && lastModified && now() - lastModified.getTime() < orphanMinAgeMs) { kept.add(key); continue; }
      await deleteDocumentObject(stores.legacy, key);
      if (row) counts.deletedTombstoned += 1; else counts.deletedOrphans += 1;
    } catch { counts.failed += 1; kept.add(key); }
  }
  const remaining = await listStoredObjects(stores.legacy, options.prefix);
  counts.remaining = remaining.length;
  counts.unexpectedRemaining = remaining.filter(entry => !kept.has(entry.key)).length;
  return counts;
}

async function anonymousStatus(url: string): Promise<number> {
  const response = await fetch(url, { credentials: "omit", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  try { return response.status; } finally { if (response.body) await response.body.cancel().catch(() => undefined); }
}

function objectUrl(base: string, bucket: string, key: string): string {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  if (root.username || root.password || root.search || root.hash || !["http:", "https:"].includes(root.protocol)) throw new Error("invalid_anonymous_endpoint");
  return new URL(`${trimSlashes(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, root).toString();
}

/** One fixture object under the document prefix of the private namespace: a signed read returns it; neither the
 * URL earlier releases published documents at, nor the private bucket directly or through the public endpoint,
 * serves it anonymously. The fixture is deleted afterwards.
 */
export async function probeDocumentPrivacy(stores: DocumentObjectStores, env: NodeJS.ProcessEnv, prefix: string): Promise<DocumentPrivacyProbe> {
  const probe: DocumentPrivacyProbe = { checked: false, signedReadExact: false, publicUrlDenied: false, privateBucketAnonymousDenied: false,
    publicEndpointPrivateBucketDenied: false, cleanup: false };
  const current = stores.current;
  if (current.type !== "s3") return probe;
  probe.checked = true;
  const key = `${prefix}privacy-probe/${randomUUID()}/probe.txt`;
  const bytes = Buffer.from("vrata document privacy probe\n");
  // The bucket-addressing public endpoint, as for the plugin probe: bundled storage behind Caddy, or an explicit override.
  const publicBase = roomPluginAnonymousEndpoint(current, env);
  let written = false;
  try {
    await writeDocumentObject(current, key, bytes, "text/plain");
    written = true;
    probe.signedReadExact = (await readPrivateUploadedObject(current, key, bytes.length)).equals(bytes);
    // Earlier releases published documents at the public asset URL of the same key; an anonymous endpoint
    // reachable from this container replaces that address, as it does for the private bucket check below.
    const legacyUrl = publicBase && stores.legacy?.type === "s3" ? objectUrl(publicBase, stores.legacy.bucket, key)
      : resolveSceneBundlePublicUrl(key, env, current.provider);
    probe.publicUrlDenied = [403, 404].includes(await anonymousStatus(legacyUrl));
    probe.privateBucketAnonymousDenied = await anonymousStatus(objectUrl(current.endpoint, current.bucket, key)) === 403;
    probe.publicEndpointPrivateBucketDenied = !publicBase || await anonymousStatus(objectUrl(publicBase, current.bucket, key)) === 403;
  } catch { /* the failed check stays false */ }
  finally {
    if (written) {
      try { await deleteDocumentObject(current, key); probe.cleanup = !await readOptional(current, key, bytes.length); }
      catch { probe.cleanup = false; }
    }
  }
  return probe;
}

export function probePassed(probe: DocumentPrivacyProbe): boolean {
  return !probe.checked || probe.signedReadExact && probe.publicUrlDenied && probe.privateBucketAnonymousDenied
    && probe.publicEndpointPrivateBucketDenied && probe.cleanup;
}

export function movePassed(counts: DocumentMoveCounts): boolean {
  return counts.checksumMismatch === 0 && counts.conflicts === 0 && counts.failed === 0 && !counts.unexpectedRemaining;
}

export function parseMoveMode(argv: readonly string[]): Mode {
  if (argv.length === 0) return "dry-run";
  if (argv.length === 1 && ["--verify", "--confirm", "--restore"].includes(argv[0])) return argv[0].slice(2) as Mode;
  throw new Error("usage: document-storage-move.js [--verify | --confirm | --restore]");
}

async function operatorMain(): Promise<void> {
  let pool: Pool | undefined;
  let mode: Mode = "dry-run";
  try {
    mode = parseMoveMode(process.argv.slice(2));
    const stores = documentObjectStores(resolve("apps/runtime-web/public"));
    const prefix = documentPrefix(process.env);
    if (mode === "verify") {
      const probe = await probeDocumentPrivacy(stores, process.env, prefix);
      process.stdout.write(`${JSON.stringify({ ok: probePassed(probe), mode, probe })}\n`);
      if (!probePassed(probe)) process.exitCode = 1;
      return;
    }
    // The deployed API has installed its schema; this process reads room_documents and does not migrate.
    if (!process.env.POSTGRES_URL) throw new Error("document_move_database_required");
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
    const counts = await moveLegacyDocuments(stores, postgresDocumentRows(pool), { prefix, confirm: mode !== "dry-run",
      orphanMinAgeMs: mode === "restore" ? 0 : ORPHAN_MIN_AGE_MS });
    const probe = mode === "confirm" ? await probeDocumentPrivacy(stores, process.env, prefix) : undefined;
    const ok = movePassed(counts) && (!probe || probePassed(probe));
    process.stdout.write(`${JSON.stringify({ ok, mode, ...counts, ...(probe ? { probe } : {}) })}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:]+$/.test(error.message) ? error.message : "document_move_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, mode, error: code })}\n`);
    process.exitCode = 1;
  } finally { await pool?.end().catch(() => undefined); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await operatorMain();
