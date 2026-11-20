import { isAbsolute, join, posix, relative, resolve, sep, dirname } from "node:path";

import type { SceneBundleProvider } from "./scene-bundle-storage.js";
import type { DocumentUploadStorage } from "./upload-storage-config.js";
import { deleteDocumentObject, readPrivateUploadedObject, trimSlashes, writeDocumentObject } from "./uploaded-object-storage.js";

/** Room document bytes are released only by the API after the room fence; the object store never serves them.
 * `current` is the private object namespace (the bucket room plugins use, under its own key prefix). `legacy` is
 * the public namespace earlier releases wrote documents to: read and deleted only until its objects are moved
 * (document-storage-move), never written.
 */
export interface DocumentObjectStores {
  current: DocumentUploadStorage;
  legacy: DocumentUploadStorage | null;
}

export class DocumentStorageConfigurationError extends Error {
  constructor(code: string) { super(code); this.name = "DocumentStorageConfigurationError"; }
}

export const LEGACY_LOCAL_DOCUMENT_ASSET_PATH = "/assets/uploaded-documents/";

function privateBucket(env: NodeJS.ProcessEnv): string {
  const bucket = env.ROOM_PLUGIN_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new DocumentStorageConfigurationError("document_private_storage_unavailable");
  }
  for (const publicBucket of [env.MINIO_BUCKET, env.SCENE_BUNDLE_S3_BUCKET]) {
    if (publicBucket !== undefined && trimSlashes(publicBucket.trim()) === bucket) {
      throw new DocumentStorageConfigurationError("document_private_storage_unavailable");
    }
  }
  return bucket;
}

function assertOutsidePublicTree(runtimePublicRoot: string, root: string, env: NodeJS.ProcessEnv): void {
  // Every directory the API serves statically: runtime public, its build output, the control-plane build output
  // and the local scene uploads.
  const served = [runtimePublicRoot, join(dirname(runtimePublicRoot), "dist"), join(dirname(dirname(runtimePublicRoot)), "control-plane", "dist"),
    ...(env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT ? [env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT] : [])];
  for (const publicRoot of served) {
    const path = relative(resolve(publicRoot), root);
    if (!path || !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) {
      throw new DocumentStorageConfigurationError("document_storage_root_is_public");
    }
  }
}

export function documentObjectStores(runtimePublicRoot: string, env: NodeJS.ProcessEnv = process.env): DocumentObjectStores {
  const provider = (env.DOCUMENT_PROVIDER ?? env.SCENE_BUNDLE_PROVIDER ?? "minio-default") as SceneBundleProvider;
  if (provider === "s3-compatible") {
    const bucket = privateBucket(env);
    const { SCENE_BUNDLE_S3_ENDPOINT: endpoint, SCENE_BUNDLE_S3_REGION: region,
      SCENE_BUNDLE_S3_ACCESS_KEY_ID: accessKeyId, SCENE_BUNDLE_S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
    if (!endpoint || !region || !accessKeyId || !secretAccessKey) throw new DocumentStorageConfigurationError("document_private_storage_unavailable");
    const legacyBucket = env.SCENE_BUNDLE_S3_BUCKET ? trimSlashes(env.SCENE_BUNDLE_S3_BUCKET) : "";
    const base = { type: "s3" as const, provider, endpoint, region, accessKeyId, secretAccessKey };
    return { current: { ...base, bucket }, legacy: legacyBucket ? { ...base, bucket: legacyBucket } : null };
  }
  if (provider === "minio-default" && (env.MINIO_ROOT_USER || env.MINIO_ROOT_PASSWORD || env.ROOM_PLUGIN_BUCKET)) {
    const bucket = privateBucket(env);
    if (!env.MINIO_ROOT_USER || !env.MINIO_ROOT_PASSWORD) throw new DocumentStorageConfigurationError("document_private_storage_unavailable");
    const base = { type: "s3" as const, provider, endpoint: env.MINIO_ENDPOINT ?? "http://minio:9000",
      region: env.SCENE_BUNDLE_S3_REGION || "us-east-1", accessKeyId: env.MINIO_ROOT_USER, secretAccessKey: env.MINIO_ROOT_PASSWORD };
    const legacyBucket = env.MINIO_BUCKET ? trimSlashes(env.MINIO_BUCKET) : "";
    return { current: { ...base, bucket }, legacy: legacyBucket ? { ...base, bucket: legacyBucket } : null };
  }
  if (env.NODE_ENV === "production") throw new DocumentStorageConfigurationError(`misconfigured_document_upload_storage:${provider}`);
  // Local development keeps documents outside the runtime's statically served tree. The previous default
  // directory under public/assets stays a read/delete-only legacy location; the static route refuses it.
  const root = resolve(env.DOCUMENT_LOCAL_UPLOAD_ROOT ?? join(runtimePublicRoot, "..", "..", ".room-document-objects"));
  assertOutsidePublicTree(runtimePublicRoot, root, env);
  const legacyRoot = resolve(join(runtimePublicRoot, "assets", "uploaded-documents"));
  const local = { type: "local" as const, provider: "minio-default" as const, publicBaseUrl: "https://private-storage.invalid/" };
  return { current: { ...local, root }, legacy: legacyRoot === root ? null : { ...local, root: legacyRoot } };
}

/** The static route must not serve the legacy local document directory, whatever the request spelling. */
export function isLegacyLocalDocumentAssetPath(pathname: string): boolean {
  const normalized = posix.normalize(pathname);
  return normalized === LEGACY_LOCAL_DOCUMENT_ASSET_PATH.slice(0, -1) || normalized.startsWith(LEGACY_LOCAL_DOCUMENT_ASSET_PATH);
}

/** Keys are built from validated room, tenant and file names; refuse anything a URL or path could reinterpret,
 * because the private namespace is shared with room plugin artifacts.
 */
export function assertDocumentStorageKey(key: string): void {
  const segments = key.split("/");
  if (!key || key.length > 1024 || /[\\\0]/.test(key) || segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("unsafe_document_storage_key");
  }
}

export function documentObjectMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT" || error instanceof Error && error.message === "private_object_download_failed:404";
}

export async function writeDocumentBytes(stores: DocumentObjectStores, key: string, bytes: Buffer, contentType: string): Promise<void> {
  assertDocumentStorageKey(key);
  await writeDocumentObject(stores.current, key, bytes, contentType);
}

/** Signed read of the private object; only a missing private object falls back to a signed read of the legacy copy.
 * Other failures (denied, unavailable, too large) never fall back. The recorded size bounds the read.
 */
export async function readDocumentBytes(stores: DocumentObjectStores, key: string, sizeBytes: number): Promise<{ bytes: Buffer; legacy: boolean }> {
  assertDocumentStorageKey(key);
  const limit = Math.max(1, sizeBytes);
  try { return { bytes: await readPrivateUploadedObject(stores.current, key, limit), legacy: false }; }
  catch (error) { if (!stores.legacy || !documentObjectMissing(error)) throw error; }
  return { bytes: await readPrivateUploadedObject(stores.legacy, key, limit), legacy: true };
}

/** Deletes the private object and any legacy copy; a missing object is success in both namespaces. */
export async function deleteDocumentBytes(stores: DocumentObjectStores, key: string): Promise<void> {
  assertDocumentStorageKey(key);
  await deleteDocumentObject(stores.current, key);
  if (stores.legacy) await deleteDocumentObject(stores.legacy, key);
}
