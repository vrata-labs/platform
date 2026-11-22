import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unpackPersonalScene, validateSceneBundlePath } from "@vrata/asset-pipeline";
import type { DocumentUploadStorage } from "./upload-storage-config.js";
import { readPrivateUploadedObject, writeDocumentObject } from "./uploaded-object-storage.js";

export const privateSceneHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type PrivateSceneFile = {
  path: "scene.json" | "scene.glb";
  sha256: string;
  sizeBytes: number;
  contentType: "application/json" | "model/gltf-binary";
};
export interface PrivateSceneVersion {
  archiveSha256: string;
  tenantId: string;
  bundleId: string;
  version: string;
  bundleVersionId: string;
  contentHash: string;
  sizeBytes: number;
  files: PrivateSceneFile[];
  state: "candidate";
  createdAt: string;
  validation: { issues: Array<{ severity: "warning"; code: string; path: string }> };
}
export interface PrivateSceneApproval {
  tenantId: string;
  ownerSubject: string;
  bundleId: string;
  version: string;
  archiveSha256: string;
}
export function privateSceneApproval(env: NodeJS.ProcessEnv = process.env): PrivateSceneApproval | null {
  if (!env.VRATA_PRIVATE_SCENE_APPROVAL) return null;
  const value: PrivateSceneApproval = JSON.parse(env.VRATA_PRIVATE_SCENE_APPROVAL);
  if (
    !value ||
    !/^pt_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.tenantId) ||
    !/^acct_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.ownerSubject) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.bundleId) ||
    value.bundleId.length > 64 ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(value.version) ||
    !/^[a-f0-9]{64}$/.test(value.archiveSha256)
  )
    throw new Error("invalid_private_scene_approval");
  return value;
}

// The private scene bucket has no public base URL and is never resolved through the public bundle provider.
export function privateSceneStore(env: NodeJS.ProcessEnv = process.env): DocumentUploadStorage {
  const endpoint = env.VRATA_PRIVATE_SCENE_S3_ENDPOINT,
    bucket = env.VRATA_PRIVATE_SCENE_S3_BUCKET;
  if (
    !endpoint ||
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !env.VRATA_PRIVATE_SCENE_S3_ACCESS_KEY ||
    !env.VRATA_PRIVATE_SCENE_S3_SECRET
  )
    throw new Error("private_scene_store_unavailable");
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol))
    throw new Error("invalid_private_scene_endpoint");
  if (env.NODE_ENV === "production" && url.protocol !== "https:" && url.hostname !== "storage")
    throw new Error("invalid_private_scene_endpoint");
  return {
    type: "s3",
    provider: "s3-compatible",
    endpoint,
    bucket,
    region: env.VRATA_PRIVATE_SCENE_S3_REGION || "us-east-1",
    accessKeyId: env.VRATA_PRIVATE_SCENE_S3_ACCESS_KEY,
    secretAccessKey: env.VRATA_PRIVATE_SCENE_S3_SECRET
  };
}
const objectKey = (tenantId: string, sha: string) => `private-scenes/${tenantId}/${sha}`;

export async function preparePrivateScene(
  approval: PrivateSceneApproval,
  archive: Buffer,
  versionId: string,
  store: DocumentUploadStorage
): Promise<PrivateSceneVersion> {
  if (privateSceneHash(archive) !== approval.archiveSha256) throw new Error("private_scene_release_not_approved");
  const { manifest, model } = unpackPersonalScene(archive);
  const dir = await mkdtemp(join(tmpdir(), "vrata-private-scene-"));
  let validation;
  try {
    await Promise.all([writeFile(join(dir, "scene.json"), manifest), writeFile(join(dir, "scene.glb"), model)]);
    validation = await validateSceneBundlePath(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (!validation.ok) throw new Error("private_scene_validation_failed");
  const files: PrivateSceneFile[] = [];
  for (const [path, bytes, contentType] of [
    ["scene.json", manifest, "application/json"],
    ["scene.glb", model, "model/gltf-binary"]
  ] as const) {
    const sha256 = privateSceneHash(bytes),
      key = objectKey(approval.tenantId, sha256);
    try {
      await writeDocumentObject(store, key, bytes, contentType, { ifAbsent: true, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" &&
        !(error instanceof Error && /^document_object_upload_failed:(409|412)$/.test(error.message))
      )
        throw error;
      const existing = await readPrivateUploadedObject(store, key, bytes.length, AbortSignal.timeout(60_000));
      if (privateSceneHash(existing) !== sha256) throw new Error("private_scene_object_conflict");
    }
    files.push({ path, sha256, sizeBytes: bytes.length, contentType });
  }
  return {
    tenantId: approval.tenantId,
    bundleId: approval.bundleId,
    version: approval.version,
    bundleVersionId: versionId,
    archiveSha256: approval.archiveSha256,
    contentHash: `sha256:${privateSceneHash(JSON.stringify(files))}`,
    sizeBytes: manifest.length + model.length,
    files,
    state: "candidate",
    createdAt: new Date().toISOString(),
    validation: {
      issues: validation.issues
        .filter((i) => i.severity === "warning")
        .map(({ code, path }) => ({ severity: "warning" as const, code, path }))
    }
  };
}
export async function readPrivateSceneFile(
  version: PrivateSceneVersion,
  file: PrivateSceneFile,
  store: DocumentUploadStorage
): Promise<Buffer> {
  const bytes = await readPrivateUploadedObject(
    store,
    objectKey(version.tenantId, file.sha256),
    file.sizeBytes,
    AbortSignal.timeout(30_000)
  );
  if (bytes.length !== file.sizeBytes || privateSceneHash(bytes) !== file.sha256) throw new Error("private_scene_hash_mismatch");
  return bytes;
}
