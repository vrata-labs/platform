import { createHash } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type SceneBundleProvider = "minio-default" | "s3-compatible";

export interface SceneBundleRecord {
  bundleId: string;
  storageKey: string;
  publicUrl: string;
  checksum?: string;
  sizeBytes?: number;
  contentType: string;
  provider: SceneBundleProvider;
  version: string;
  status?: "active" | "obsolete" | "cleanup-ready";
  isCurrent?: boolean;
  createdAt: string;
}

export interface SceneBundleCreateInput {
  bundleId?: string;
  storageKey: string;
  publicUrl?: string;
  checksum?: string;
  sizeBytes?: number;
  contentType?: string;
  provider?: SceneBundleProvider;
  version?: string;
}

interface ProviderConfig {
  provider: SceneBundleProvider;
  publicBaseUrl: string;
}

interface UploadConfig extends ProviderConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface SceneBundleUploadResult {
  storageKey: string;
  publicUrl: string;
  checksum: string;
  sizeBytes: number;
  contentType: string;
  provider: SceneBundleProvider;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

export function getSceneBundleProviderConfig(env: NodeJS.ProcessEnv = process.env, provider?: SceneBundleProvider): ProviderConfig {
  const resolvedProvider = provider ?? ((env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined) ?? "minio-default");

  if (resolvedProvider === "minio-default") {
    const publicBaseUrl = env.MINIO_PUBLIC_BASE_URL;
    const bucket = env.MINIO_BUCKET;
    if (!publicBaseUrl || !bucket) {
      throw new Error("misconfigured_storage_provider:minio-default");
    }
    return {
      provider: resolvedProvider,
      publicBaseUrl: `${trimTrailingSlash(publicBaseUrl)}/${trimLeadingSlash(bucket)}`
    };
  }

  const publicBaseUrl = env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error("misconfigured_storage_provider:s3-compatible");
  }

  if (!env.SCENE_BUNDLE_S3_BUCKET || !env.SCENE_BUNDLE_S3_ENDPOINT || !env.SCENE_BUNDLE_S3_REGION) {
    throw new Error("misconfigured_storage_provider:s3-compatible");
  }

  return {
    provider: resolvedProvider,
    publicBaseUrl: trimTrailingSlash(publicBaseUrl)
  };
}

export function resolveSceneBundlePublicUrl(storageKey: string, env: NodeJS.ProcessEnv = process.env, provider?: SceneBundleProvider): string {
  if (!storageKey || storageKey.trim().length === 0) {
    throw new Error("invalid_scene_bundle_storage_key");
  }

  const config = getSceneBundleProviderConfig(env, provider);
  return `${trimTrailingSlash(config.publicBaseUrl)}/${trimLeadingSlash(storageKey)}`;
}

function assertStorageSegment(value: string, errorCode: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(trimmed)) {
    throw new Error(errorCode);
  }
  return trimmed;
}

export function normalizeSceneBundleRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.length > 512 || !/^[a-zA-Z0-9._/-]+$/.test(trimmed)) {
    throw new Error("invalid_scene_bundle_file_path");
  }

  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid_scene_bundle_file_path");
  }

  return parts.join("/");
}

export function resolveSceneBundleStorageKey(bundleId: string, version: string, relativePath: string): string {
  const safeBundleId = assertStorageSegment(bundleId, "invalid_scene_bundle_id");
  const safeVersion = assertStorageSegment(version, "invalid_scene_bundle_version");
  const safePath = normalizeSceneBundleRelativePath(relativePath);
  return `scenes/${safeBundleId}/${safeVersion}/${safePath}`;
}

export function getSceneBundleUploadConfig(env: NodeJS.ProcessEnv = process.env, provider?: SceneBundleProvider): UploadConfig {
  const resolvedProvider = provider ?? ((env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined) ?? "minio-default");
  const publicConfig = getSceneBundleProviderConfig(env, resolvedProvider);

  if (resolvedProvider === "minio-default") {
    const bucket = env.MINIO_BUCKET;
    const accessKeyId = env.MINIO_ROOT_USER;
    const secretAccessKey = env.MINIO_ROOT_PASSWORD;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("misconfigured_scene_bundle_upload:minio-default");
    }

    return {
      ...publicConfig,
      bucket,
      endpoint: env.MINIO_INTERNAL_ENDPOINT ?? env.SCENE_BUNDLE_S3_ENDPOINT ?? "http://minio:9000",
      region: env.SCENE_BUNDLE_S3_REGION ?? "us-east-1",
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true
    };
  }

  const bucket = env.SCENE_BUNDLE_S3_BUCKET;
  const endpoint = env.SCENE_BUNDLE_S3_ENDPOINT;
  const region = env.SCENE_BUNDLE_S3_REGION;
  const accessKeyId = env.SCENE_BUNDLE_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("misconfigured_scene_bundle_upload:s3-compatible");
  }

  return {
    ...publicConfig,
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.SCENE_BUNDLE_S3_FORCE_PATH_STYLE !== "false"
  };
}

export async function uploadSceneBundleObject(input: {
  storageKey: string;
  body: Buffer;
  contentType: string;
  provider?: SceneBundleProvider;
  env?: NodeJS.ProcessEnv;
}): Promise<SceneBundleUploadResult> {
  if (!input.body.length) {
    throw new Error("empty_scene_bundle_file");
  }

  const env = input.env ?? process.env;
  const config = getSceneBundleUploadConfig(env, input.provider);
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: input.storageKey,
    Body: input.body,
    ContentType: input.contentType
  }));

  return {
    storageKey: input.storageKey,
    publicUrl: resolveSceneBundlePublicUrl(input.storageKey, env, config.provider),
    checksum: `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
    sizeBytes: input.body.byteLength,
    contentType: input.contentType,
    provider: config.provider
  };
}
