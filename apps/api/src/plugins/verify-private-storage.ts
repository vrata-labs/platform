import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { PostgresStorage } from "../storage.js";
import type { Storage } from "../storage-contracts.js";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { createRoomPluginBlobStorage, RoomPluginBlobWriteUncertain } from "./blob-storage.js";
import { roomPluginUploadStorage } from "./blob-config.js";
import { createRoomPluginPackageService, deleteRoomWithPluginCleanup } from "./package-service.js";
import { ROOM_PLUGIN_STORAGE_LIMITS } from "./policy.js";
import type { RoomPluginPackage } from "./contracts.js";
import { roomPluginAnonymousEndpoint } from "./anonymous-probe-endpoint.js";

export interface PluginPrivateStorageChecks {
  signedPut: boolean;
  signedReadExact: boolean;
  anonymousDenied: boolean;
  publicEndpointChecked: boolean;
  publicEndpointDenied: boolean;
  noPackagePublication: boolean;
  blobMetadataCleanup: boolean;
  roomCleanup: boolean;
  unknownWriterRetained: boolean;
}
export class PluginPrivateStorageVerificationFailed extends Error {
  constructor(readonly checks: Readonly<PluginPrivateStorageChecks>) { super("plugin_private_storage_verification_failed"); }
}

async function deniedAnonymousGet(config: Extract<DocumentUploadStorage, { type: "s3" }>, key: string, endpoint = config.endpoint): Promise<boolean> {
  const base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  if (base.username || base.password || base.search || base.hash || !["http:", "https:"].includes(base.protocol)) throw new Error("invalid_anonymous_endpoint");
  const url = new URL(`${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROOM_PLUGIN_STORAGE_LIMITS.blobRequestTimeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
    try { return response.status === 403; }
    finally { if (response.body) await response.body.cancel().catch(() => undefined); }
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Privileged operator fixture only: no HTTP endpoint, author permission, binding or package publication.
 * Writes only a fixed benign SDK artifact in a freshly generated server-owned private UUID room.
 */
export async function verifyPluginPrivateStorage(storage: Storage, config: DocumentUploadStorage,
  options: { publicEndpoint?: string; requestTimeoutMs?: number } = {}): Promise<Readonly<PluginPrivateStorageChecks>> {
  const checks: PluginPrivateStorageChecks = { signedPut: false, signedReadExact: false, anonymousDenied: false,
    publicEndpointChecked: !!options.publicEndpoint, publicEndpointDenied: false, noPackagePublication: true,
    blobMetadataCleanup: false, roomCleanup: false, unknownWriterRetained: false };
  if (config.type !== "s3") throw new PluginPrivateStorageVerificationFailed(Object.freeze({ ...checks }));
  const blobs = createRoomPluginBlobStorage(config, { requestTimeoutMs: options.requestTimeoutMs });
  const service = createRoomPluginPackageService(storage.roomPlugins, blobs);
  const scope = { tenantId: "demo-tenant", roomId: `plugin-privacy-${randomUUID()}` };
  const artifact = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "storage-privacy-probe", version: "1.0.0",
    displayName: "Storage privacy verification", requestedCapabilities: [], configSchema: {} }, "export function init() {}");
  let reservation: RoomPluginPackage | undefined;
  let putAttempted = false, putSettled = false, roomAttempted = false, failed = false;
  try {
    if (await storage.getRoom(scope.roomId)) throw new Error("probe_room_collision");
    roomAttempted = true;
    await storage.createRoom({ ...scope, templateId: "meeting-room-basic", name: "Storage privacy verification", visibility: "private", guestAllowed: false });
    reservation = (await storage.roomPlugins.reservePackage(scope, artifact.bytes, blobs.backendFingerprint)).package;
    putAttempted = true;
    try { await blobs.put(scope, reservation.storageKey, artifact.bytes); putSettled = true; }
    catch (error) { if (!(error instanceof RoomPluginBlobWriteUncertain)) putSettled = true; throw error; }
    checks.signedPut = true;
    await storage.roomPlugins.confirmPackageUpload(scope, reservation.packageId);
    checks.signedReadExact = Buffer.from(await blobs.read(scope, reservation.storageKey)).equals(Buffer.from(artifact.bytes));
    if (!checks.signedReadExact) throw new Error("probe_signed_bytes_mismatch");
    // Signed byte-exact GET establishes object existence; 404/5xx/redirect is not accepted as privacy.
    checks.anonymousDenied = await deniedAnonymousGet(config, reservation.storageKey);
    if (options.publicEndpoint) checks.publicEndpointDenied = await deniedAnonymousGet(config, reservation.storageKey, options.publicEndpoint);
    if (!checks.anonymousDenied || checks.publicEndpointChecked && !checks.publicEndpointDenied) failed = true;
    const current = await storage.roomPlugins.getPackage(scope, reservation.packageId);
    checks.noPackagePublication = current?.state === "reserved" && (await storage.roomPlugins.readBindings(scope)).bindings.length === 0;
    if (!checks.noPackagePublication) failed = true;
  } catch { failed = true; }
  finally {
    if (roomAttempted) {
      try {
        if (putAttempted && !putSettled) {
          // Timeout/abort/unknown ACK must retain the index and room. Do not invent a stopped writer.
          const pending = reservation && await storage.roomPlugins.getPackage(scope, reservation.packageId);
          checks.unknownWriterRetained = pending?.state === "reserved" && !pending.uploadSettled && !!await storage.getRoom(scope.roomId);
        } else {
          // If reservation ACK was lost before PUT, no writer was ever started; only this UUID fixture's
          // bounded records may be abandoned. If PUT acknowledged, local owner knows it has settled.
          for (const value of await storage.roomPlugins.listPackages(scope)) {
            await storage.roomPlugins.failPackageUpload(scope, value.packageId);
            await service.deletePackage(scope, value.packageId);
          }
          checks.blobMetadataCleanup = (await storage.roomPlugins.listPackages(scope)).length === 0;
          checks.roomCleanup = await deleteRoomWithPluginCleanup(storage, scope, () => blobs) && !await storage.getRoom(scope.roomId);
        }
      } catch { failed = true; }
    }
  }
  const result = Object.freeze({ ...checks });
  if (failed || !checks.signedPut || !checks.signedReadExact || !checks.anonymousDenied || checks.publicEndpointChecked && !checks.publicEndpointDenied ||
    !checks.noPackagePublication || !checks.blobMetadataCleanup || !checks.roomCleanup) throw new PluginPrivateStorageVerificationFailed(result);
  return result;
}

async function operatorMain(): Promise<void> {
  // The deployed API has already installed its schema. This process does not hot-migrate or fall back
  // to MemoryStorage; it uses the container's configured database and storage credentials directly.
  let pool: Pool | undefined;
  try {
    if (!process.env.POSTGRES_URL) throw new Error("probe_database_required");
    const config = roomPluginUploadStorage(resolve("apps/runtime-web/public"));
    pool = new Pool({ connectionString: process.env.POSTGRES_URL, max: 1 });
    const checks = await verifyPluginPrivateStorage(new PostgresStorage(pool), config, {
      publicEndpoint: roomPluginAnonymousEndpoint(config)
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...checks })}\n`);
  } catch (error) {
    const checks = error instanceof PluginPrivateStorageVerificationFailed ? error.checks : {};
    // Only booleans: no stack/cause, URLs, credentials, room IDs, object keys, fingerprints or bytes.
    process.stdout.write(`${JSON.stringify({ ok: false, ...checks })}\n`); process.exitCode = 1;
  } finally { await pool?.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await operatorMain();
