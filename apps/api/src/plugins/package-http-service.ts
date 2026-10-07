import { validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { setTimeout as delay } from "node:timers/promises";
import { IdentityStorageError } from "../identity/contracts.js";
import { IdentityBoundaryError } from "../identity/legacy-boundary.js";
import { identityFenceUnavailable, uncertainRoomCommit } from "../identity/fence-transaction.js";
import { RoomPluginAccessError, type RoomPluginAccessFactory, type RoomPluginAuthorAccess,
  type RoomPluginCleanupTicket, type RoomPluginRuntimeAccess, type RoomPluginUploadTicket } from "./access-contracts.js";
import { RoomPluginBlobConfigurationError, RoomPluginBlobIoError } from "./blob-errors.js";
import { RoomPluginBlobWriteUncertain, type RoomPluginBlobStorage } from "./blob-storage.js";
import { RoomPluginStorageError, type RoomPluginPackage } from "./contracts.js";

/** Causes are for local diagnostics only. The HTTP projection never includes tickets or causes. */
export class RoomPluginHttpOperationPending extends Error {
  constructor(cause: unknown, readonly cleanupCause?: unknown) {
    super("plugin_operation_pending", { cause }); this.name = "RoomPluginHttpOperationPending";
  }
}

function confirmedAuthorDenial(error: unknown): boolean {
  if (uncertainRoomCommit(error)) return false;
  return error instanceof RoomPluginAccessError && ["plugin_author_forbidden", "plugin_identity_not_active"].includes(error.code)
    || error instanceof IdentityBoundaryError && error.status === 401
    || error instanceof IdentityStorageError && ["identity_forbidden", "identity_not_active", "identity_session_expired", "room_blocked"].includes(error.code);
}

export function createRoomPluginHttpPackageService(access: RoomPluginAccessFactory, getBlobs: () => RoomPluginBlobStorage) {
  async function settleUpload(ticket: RoomPluginUploadTicket, outcome: "acked" | "rejected"): Promise<RoomPluginCleanupTicket | null> {
    const backoffMs = [100, 250] as const;
    for (let attempt = 0; ; attempt++) {
      try { return await access.continuation.settleUpload(ticket, outcome); }
      catch (error) {
        if (attempt >= backoffMs.length || !identityFenceUnavailable(error)) throw error;
        // Only a known terminal writer result is replayed, with the exact original opaque ticket.
        // Lost settlement COMMIT acknowledgements are safe to retry; PUT and publication are not.
        await delay(backoffMs[attempt]);
      }
    }
  }
  const sameBackend = (value: Readonly<RoomPluginPackage>, blobs: RoomPluginBlobStorage) => {
    if (!value.backendFingerprint || value.backendFingerprint !== blobs.backendFingerprint) {
      throw new RoomPluginBlobConfigurationError("plugin_blob_backend_mismatch");
    }
  };
  const scope = (value: Readonly<RoomPluginPackage>) => ({ tenantId: value.tenantId, roomId: value.roomId });
  async function cleanup(ticket: RoomPluginCleanupTicket, blobs?: RoomPluginBlobStorage): Promise<void> {
    const value = ticket.package;
    if (value.state === "deleted") return;
    if (value.state !== "cleanup-pending" || !value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
    blobs ??= getBlobs(); sameBackend(value, blobs);
    await blobs.delete(scope(value), value.storageKey);
    await access.continuation.confirmDeletion(ticket);
  }
  async function compensate(original: unknown, blobs: RoomPluginBlobStorage,
    intent: () => Promise<RoomPluginCleanupTicket | null>): Promise<never> {
    try {
      const deletion = await intent();
      // A concurrent confirmed publisher may have made the package ready. Null never permits DELETE.
      if (deletion) await cleanup(deletion, blobs);
    } catch (error) { throw new RoomPluginHttpOperationPending(original, error); }
    throw original;
  }
  async function publish(author: RoomPluginAuthorAccess, ticket: RoomPluginUploadTicket, blobs: RoomPluginBlobStorage): Promise<RoomPluginPackage> {
    try {
      const value = await author.publishPackage(ticket);
      if (value.state !== "ready" || !value.uploadSettled) throw new RoomPluginStorageError("room_plugin_cleanup_pending");
      return value;
    } catch (error) {
      if (confirmedAuthorDenial(error) || error instanceof RoomPluginStorageError
        && error.code === "room_plugin_cleanup_pending" && !uncertainRoomCommit(error)) {
        return compensate(error, blobs, () => access.continuation.abandonUnpublished(ticket));
      }
      // Never compensate a lost COMMIT acknowledgement or an unclassified publication failure.
      throw new RoomPluginHttpOperationPending(error);
    }
  }
  return {
    async savePackage(author: RoomPluginAuthorAccess, input: Uint8Array): Promise<RoomPluginPackage> {
      await author.authorize();
      const validated = validateRoomPluginArtifact(input);
      const blobs = getBlobs();
      const ticket = await author.reservePackage(validated.bytes, blobs.backendFingerprint);
      const value = ticket.package;
      sameBackend(value, blobs);
      if (ticket.disposition === "ready") {
        if (value.state !== "ready" || !value.uploadSettled) throw new RoomPluginStorageError("plugin_package_not_ready");
        return structuredClone(value);
      }
      if (ticket.disposition === "resume") {
        if (value.state !== "reserved" || !value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
        // A matching GET proves bytes, never the termination of an unknown original PUT.
        const stored = validateRoomPluginArtifact(await blobs.read(scope(value), value.storageKey), value.artifactSha256);
        if (stored.byteLength !== value.byteLength) throw new RoomPluginStorageError("plugin_package_not_ready");
        return publish(author, ticket, blobs);
      }
      if (ticket.disposition !== "write" || value.state !== "reserved" || value.uploadSettled) {
        throw new RoomPluginStorageError("plugin_upload_pending");
      }
      try { await blobs.put(scope(value), value.storageKey, validated.bytes); }
      catch (error) {
        if (error instanceof RoomPluginBlobWriteUncertain || !(error instanceof RoomPluginBlobIoError) || error.operation !== "put") {
          throw new RoomPluginHttpOperationPending(error);
        }
        return compensate(error, blobs, () => settleUpload(ticket, "rejected"));
      }
      try {
        const deletion = await settleUpload(ticket, "acked");
        if (deletion) {
          await cleanup(deletion, blobs);
          throw new RoomPluginStorageError("room_plugin_cleanup_pending");
        }
      } catch (error) { throw new RoomPluginHttpOperationPending(error); }
      return publish(author, ticket, blobs);
    },
    async deletePackage(author: RoomPluginAuthorAccess, packageId: string): Promise<void> {
      await author.authorize();
      const ticket = await author.beginPackageDeletion(packageId);
      try { await cleanup(ticket); }
      catch (error) { throw new RoomPluginHttpOperationPending(error); }
    },
    async releaseContent(runtime: RoomPluginRuntimeAccess, packageId: string,
      send: (bytes: Uint8Array, value: Readonly<RoomPluginPackage>) => undefined): Promise<void> {
      const ticket = await runtime.prepareBoundContent(packageId);
      const blobs = getBlobs(); sameBackend(ticket.package, blobs);
      const bytes = await blobs.read(scope(ticket.package), ticket.package.storageKey);
      // The backend validates a private copy and the exact captured binding tuple at final release.
      await runtime.releaseBoundContent(ticket, bytes, validated => send(validated, ticket.package));
    }
  };
}
