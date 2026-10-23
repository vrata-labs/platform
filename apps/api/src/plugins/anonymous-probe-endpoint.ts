import type { DocumentUploadStorage } from "../upload-storage-config.js";

/** Additional anonymous route only; the probe always verifies its actual signed-storage target first. */
export function roomPluginAnonymousEndpoint(config: Pick<DocumentUploadStorage, "provider">, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.ROOM_PLUGIN_ANONYMOUS_ENDPOINT?.trim();
  if (explicit) return explicit;
  if (config.provider === "minio-default") return env.MINIO_PUBLIC_BASE_URL?.trim() || undefined;
  // Custom S3 has no implicit public-route mapping. Empty override means the mandatory direct check only.
  return undefined;
}
