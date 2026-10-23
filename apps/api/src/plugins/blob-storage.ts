import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";
import type { DocumentUploadStorage } from "../upload-storage-config.js";
import { deleteDocumentObject, readPrivateUploadedObject, writeDocumentObject } from "../uploaded-object-storage.js";
import { roomPluginPrefix } from "./storage.js";
import type { RoomPluginScope } from "./contracts.js";
import { RoomPluginBlobIoError, RoomPluginBlobConfigurationError } from "./blob-errors.js";
import { ROOM_PLUGIN_STORAGE_LIMITS } from "./policy.js";
import { roomPluginUploadStorage } from "./blob-config.js";

/** A lost PUT acknowledgement is not proof that the object was never written. */
export class RoomPluginBlobWriteUncertain extends Error {
  constructor(cause: unknown) { super("plugin_blob_write_unconfirmed", { cause }); this.name = "RoomPluginBlobWriteUncertain"; }
}
export interface RoomPluginBlobStorage {
  /** Hash of the immutable, credential-free target locator; server-only, not an author-supplied claim. */
  readonly backendFingerprint: string;
  /** Resolves once the immutable write has settled. Unknown remote outcomes use the error above. */
  put(scope: RoomPluginScope, key: string, bytes: Uint8Array): Promise<void>;
  read(scope: RoomPluginScope, key: string): Promise<Uint8Array>;
  delete(scope: RoomPluginScope, key: string): Promise<void>;
}
function assertKey(scope: RoomPluginScope, key: string): void {
  const prefix = roomPluginPrefix(scope);
  if (!key.startsWith(prefix) || !/^[a-f0-9-]{36}\/[a-f0-9]{64}\.vrata-plugin\.json$/.test(key.slice(prefix.length))) {
    throw new Error("unsafe_plugin_storage_key");
  }
}

/** Reuse configured local/MinIO/S3 credentials; do not expose a public artifact URL. */
function ownBackend(config: DocumentUploadStorage): { config: DocumentUploadStorage; fingerprint: string } {
  try {
    const owned = config.type === "local" ? Object.freeze({ ...config, root: resolve(config.root) }) : Object.freeze({ ...config });
    let locator: string[];
    if (owned.type === "local") locator = ["local-v1", owned.root];
    else {
      const endpoint = new URL(owned.endpoint.endsWith("/") ? owned.endpoint : `${owned.endpoint}/`);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error("invalid_object_endpoint");
      }
      locator = ["s3-v1", endpoint.href, owned.region, owned.bucket.replace(/^\/+|\/+$/g, "")];
    }
    // Credentials and public URLs intentionally do not identify the target. Credential rotation is allowed.
    // This detects configuration drift, not a bucket recreation or mount replacement behind the same
    // locator; proving physical namespace continuity requires a separately defined backend-ID policy.
    return { config: owned, fingerprint: createHash("sha256").update(JSON.stringify(locator)).digest("hex") };
  } catch (error) { throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable", error); }
}

async function requestDeadline<T>(milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("plugin_blob_request_timeout");
      controller.abort(error); reject(error);
    }, milliseconds);
    timer.unref();
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally {
    clearTimeout(timer!);
    // Close native HTTP transport on every completed operation, including early status errors.
    // Aborting a transport is never evidence that an unacknowledged PUT has stopped server-side.
    controller.abort(new Error("plugin_blob_request_closed"));
  }
}

export function createRoomPluginBlobStorage(input: DocumentUploadStorage, options?: { requestTimeoutMs?: number }): RoomPluginBlobStorage {
  const { config, fingerprint } = ownBackend(input);
  const timeout = options?.requestTimeoutMs ?? ROOM_PLUGIN_STORAGE_LIMITS.blobRequestTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable");
  const remote = <T>(operation: (signal?: AbortSignal) => Promise<T>) => config.type === "s3" ? requestDeadline(timeout, operation) : operation();
  return {
    backendFingerprint: fingerprint,
    async put(scope, key, bytes) {
      assertKey(scope, key);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > ROOM_PLUGIN_LIMITS.artifactBytes) throw new Error("plugin_object_too_large");
      try { await remote(signal => writeDocumentObject(config, key, Buffer.from(bytes), "application/octet-stream", { ifAbsent: true, signal })); }
      catch (error) {
        if ((error as { code?: string }).code === "EEXIST" || error instanceof Error && /^document_object_upload_failed:(409|412)$/.test(error.message)) {
          throw new RoomPluginBlobWriteUncertain(error);
        }
        // Gateway/server failures may return a response while the upstream PUT continues.
        if (config.type === "s3" && error instanceof Error && /^document_object_upload_failed:(408|429|5\d\d)$/.test(error.message)) {
          throw new RoomPluginBlobWriteUncertain(error);
        }
        if (config.type === "s3" && !(error instanceof Error && /^document_object_upload_failed:\d+$/.test(error.message))) {
          throw new RoomPluginBlobWriteUncertain(error);
        }
        throw new RoomPluginBlobIoError("put", error);
      }
    },
    async read(scope, key) {
      assertKey(scope, key);
      try { return await remote(signal => readPrivateUploadedObject(config, key, ROOM_PLUGIN_LIMITS.artifactBytes, signal)); }
      catch (error) { throw new RoomPluginBlobIoError("read", error); }
    },
    async delete(scope, key) {
      assertKey(scope, key);
      try { await remote(signal => deleteDocumentObject(config, key, { signal, immutableTemp: true })); }
      catch (error) { throw new RoomPluginBlobIoError("delete", error); }
    }
  };
}

export function configuredRoomPluginBlobStorage(runtimePublicRoot: string, _request: IncomingMessage,
  _publicBaseUrlFromRequest: (request: IncomingMessage) => string): RoomPluginBlobStorage {
  try {
    const privateConfig = roomPluginUploadStorage(runtimePublicRoot);
    // Local code artifacts live outside runtime's publicly served tree. The S3 adapter uses signed GET.
    if (privateConfig.type === "local") {
      for (const publicRoot of [runtimePublicRoot, join(dirname(runtimePublicRoot), "dist")]) {
        const path = relative(resolve(publicRoot), privateConfig.root);
        if (!path || !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)) {
          throw new Error("plugin_storage_root_is_public");
        }
      }
    }
    return createRoomPluginBlobStorage(privateConfig);
  } catch (error) {
    if (error instanceof RoomPluginBlobConfigurationError) throw error;
    throw new RoomPluginBlobConfigurationError("plugin_blob_configuration_unavailable", error);
  }
}
