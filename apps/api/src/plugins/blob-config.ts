import { join, resolve } from "node:path";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { RoomPluginBlobConfigurationError } from "./blob-errors.js";

export function requireRoomPluginBucket(env: NodeJS.ProcessEnv): string {
  const bucket = env.ROOM_PLUGIN_BUCKET;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
  }
  // Reuse endpoints/credentials, never an anonymous assets namespace, even through a legacy alias.
  for (const publicBucket of [env.MINIO_BUCKET, env.SCENE_BUNDLE_S3_BUCKET]) {
    if (publicBucket?.trim().replace(/^\/+|\/+$/g, "") === bucket) {
      throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
    }
  }
  return bucket;
}

/** Private namespace config. Public document/scene URLs and buckets are not private-storage inputs. */
export function roomPluginUploadStorage(runtimePublicRoot: string, env: NodeJS.ProcessEnv = process.env): DocumentUploadStorage {
  const provider = env.DOCUMENT_PROVIDER ?? env.SCENE_BUNDLE_PROVIDER ?? "minio-default";
  if (provider === "s3-compatible") {
    const bucket = requireRoomPluginBucket(env);
    if (!env.SCENE_BUNDLE_S3_ENDPOINT || !env.SCENE_BUNDLE_S3_REGION || !env.SCENE_BUNDLE_S3_ACCESS_KEY_ID || !env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY) {
      throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
    }
    return { type: "s3", provider, bucket, endpoint: env.SCENE_BUNDLE_S3_ENDPOINT, region: env.SCENE_BUNDLE_S3_REGION,
      accessKeyId: env.SCENE_BUNDLE_S3_ACCESS_KEY_ID, secretAccessKey: env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY };
  }
  if (provider !== "minio-default") throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
  if (env.MINIO_ROOT_USER || env.MINIO_ROOT_PASSWORD || env.ROOM_PLUGIN_BUCKET) {
    const bucket = requireRoomPluginBucket(env);
    if (!env.MINIO_ROOT_USER || !env.MINIO_ROOT_PASSWORD) throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
    return { type: "s3", provider, bucket, endpoint: env.MINIO_ENDPOINT ?? "http://minio:9000",
      region: env.SCENE_BUNDLE_S3_REGION || "us-east-1", accessKeyId: env.MINIO_ROOT_USER, secretAccessKey: env.MINIO_ROOT_PASSWORD };
  }
  if (env.NODE_ENV === "production") throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
  return { type: "local", provider, root: resolve(env.ROOM_PLUGIN_LOCAL_UPLOAD_ROOT ?? join(runtimePublicRoot, "..", "..", ".room-plugin-objects")),
    publicBaseUrl: "https://private-storage.invalid/" };
}
