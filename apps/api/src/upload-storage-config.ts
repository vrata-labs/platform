import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";

import type { SceneBundleProvider } from "./scene-bundle-storage.js";

export type SceneBundleUploadStorage = {
  type: "local";
  provider: SceneBundleProvider;
  root: string;
  publicBaseUrl: string;
} | {
  type: "s3";
  provider: SceneBundleProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type DocumentUploadStorage = SceneBundleUploadStorage;

export function createUploadStorageConfig(
  runtimePublicRoot: string,
  publicBaseUrlFromRequest: (request: IncomingMessage) => string
) {
  function getSceneBundleUploadStorage(request: IncomingMessage): SceneBundleUploadStorage {
    const provider = (process.env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined) ?? "minio-default";
    if (provider === "minio-default") {
      if (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD && process.env.MINIO_BUCKET && process.env.MINIO_PUBLIC_BASE_URL) {
        return {
          type: "s3",
          provider,
          endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
          region: process.env.SCENE_BUNDLE_S3_REGION || "us-east-1",
          bucket: process.env.MINIO_BUCKET,
          accessKeyId: process.env.MINIO_ROOT_USER,
          secretAccessKey: process.env.MINIO_ROOT_PASSWORD
        };
      }
    } else if (provider === "s3-compatible") {
      if (process.env.SCENE_BUNDLE_S3_ENDPOINT && process.env.SCENE_BUNDLE_S3_REGION && process.env.SCENE_BUNDLE_S3_BUCKET && process.env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL && process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID && process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY) {
        return {
          type: "s3",
          provider,
          endpoint: process.env.SCENE_BUNDLE_S3_ENDPOINT,
          region: process.env.SCENE_BUNDLE_S3_REGION,
          bucket: process.env.SCENE_BUNDLE_S3_BUCKET,
          accessKeyId: process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY
        };
      }
    }

    if (process.env.NODE_ENV === "production") {
      throw new Error(`misconfigured_scene_bundle_upload_storage:${provider}`);
    }

    const root = resolve(process.env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT ?? join(runtimePublicRoot, "assets", "uploaded-scene-bundles"));
    return {
      type: "local",
      provider: "minio-default",
      root,
      publicBaseUrl: new URL("/assets/uploaded-scene-bundles/", publicBaseUrlFromRequest(request)).toString()
    };
  }

  function getDocumentUploadStorage(request: IncomingMessage): DocumentUploadStorage {
    const provider = ((process.env.DOCUMENT_PROVIDER as SceneBundleProvider | undefined) ?? (process.env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined)) ?? "minio-default";
    if (provider === "minio-default") {
      if (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD && process.env.MINIO_BUCKET && process.env.MINIO_PUBLIC_BASE_URL) {
        return {
          type: "s3",
          provider,
          endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
          region: process.env.SCENE_BUNDLE_S3_REGION || "us-east-1",
          bucket: process.env.MINIO_BUCKET,
          accessKeyId: process.env.MINIO_ROOT_USER,
          secretAccessKey: process.env.MINIO_ROOT_PASSWORD
        };
      }
    } else if (provider === "s3-compatible") {
      if (process.env.SCENE_BUNDLE_S3_ENDPOINT && process.env.SCENE_BUNDLE_S3_REGION && process.env.SCENE_BUNDLE_S3_BUCKET && process.env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL && process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID && process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY) {
        return {
          type: "s3",
          provider,
          endpoint: process.env.SCENE_BUNDLE_S3_ENDPOINT,
          region: process.env.SCENE_BUNDLE_S3_REGION,
          bucket: process.env.SCENE_BUNDLE_S3_BUCKET,
          accessKeyId: process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY
        };
      }
    }

    if (process.env.NODE_ENV === "production") {
      throw new Error(`misconfigured_document_upload_storage:${provider}`);
    }

    const root = resolve(process.env.DOCUMENT_LOCAL_UPLOAD_ROOT ?? join(runtimePublicRoot, "assets", "uploaded-documents"));
    return {
      type: "local",
      provider: "minio-default",
      root,
      publicBaseUrl: new URL("/assets/uploaded-documents/", publicBaseUrlFromRequest(request)).toString()
    };
  }

  return { getSceneBundleUploadStorage, getDocumentUploadStorage };
}
