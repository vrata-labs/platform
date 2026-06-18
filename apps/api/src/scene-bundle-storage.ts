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
