import { randomUUID } from "node:crypto";
import { ROOM_PLUGIN_LIMITS, validateRoomPluginCapabilities, validateRoomPluginConfig, validateRoomPluginData } from "@vrata/room-plugin-sdk";
import { validateRoomPluginArtifact, validateRoomPluginSha256 } from "@vrata/room-plugin-sdk/artifact";
import { RoomPluginStorageError, type RoomPluginBindingInput, type RoomPluginRepository, type RoomPluginScope,
  type RoomPluginStorage, type RoomPluginTransaction, type RoomPluginPackage } from "./contracts.js";
import { ROOM_PLUGIN_STORAGE_LIMITS } from "./policy.js";

export function roomPluginPrefix(scope: RoomPluginScope): string {
  // Encode all UTF-8 bytes, not URI dots/slashes: legacy room identifiers need not be path-safe.
  const segment = (value: string) => {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512) throw new RoomPluginStorageError("room_not_found");
    return Buffer.from(value).toString("hex");
  };
  return `room-plugins/${segment(scope.tenantId)}/${segment(scope.roomId)}/`;
}

function writable(tx: RoomPluginTransaction): void {
  if (tx.state.deleting) throw new RoomPluginStorageError("room_plugin_cleanup_pending");
}
function revision(tx: RoomPluginTransaction, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || tx.state.revision !== expected) throw new RoomPluginStorageError("plugin_revision_conflict");
}
function advance(tx: RoomPluginTransaction): number {
  if (tx.state.revision >= Number.MAX_SAFE_INTEGER) throw new RoomPluginStorageError("plugin_revision_exhausted");
  return ++tx.state.revision;
}
async function requirePackage(tx: RoomPluginTransaction, id: string): Promise<RoomPluginPackage> {
  const value = await tx.getPackage(id);
  if (!value) throw new RoomPluginStorageError("plugin_package_not_found");
  return value;
}
async function snapshot(tx: RoomPluginTransaction) { return { revision: tx.state.revision, bindings: await tx.listBindings() }; }

export function createRoomPluginStorage(repository: RoomPluginRepository): RoomPluginStorage {
  const transact = <T>(scope: RoomPluginScope, operation: (tx: RoomPluginTransaction, owned: RoomPluginScope) => Promise<T>, readOnly = false) => {
    const owned = { tenantId: scope.tenantId, roomId: scope.roomId };
    roomPluginPrefix(owned);
    return repository.transaction(owned, tx => operation(tx, owned), { readOnly });
  };
  return {
    async reservePackage(scope, bytes, backendFingerprint) {
      const validated = validateRoomPluginArtifact(bytes);
      validateRoomPluginSha256(backendFingerprint);
      const manifest = validated.artifact.manifest;
      return transact(scope, async (tx, owned) => {
        writable(tx);
        const existing = await tx.findVersion(manifest.id, manifest.version);
        if (existing) {
          if (existing.artifactSha256 !== validated.artifactSha256) throw new RoomPluginStorageError("plugin_version_conflict");
          if (existing.state === "ready") return { package: existing, created: false };
          if (existing.state === "reserved") throw new RoomPluginStorageError("plugin_upload_pending");
          // A deleted version remains an immutable tombstone; reinstall through a new release version.
          throw new RoomPluginStorageError("plugin_invalid_transition");
        }
        const quota = await tx.quota();
        if (quota.lifetimeCount >= ROOM_PLUGIN_STORAGE_LIMITS.lifetimePackagesPerRoom) throw new RoomPluginStorageError("plugin_history_quota_exceeded");
        if (quota.count >= ROOM_PLUGIN_LIMITS.packagesPerRoom || quota.bytes + validated.byteLength > ROOM_PLUGIN_LIMITS.roomArtifactBytes) {
          throw new RoomPluginStorageError("plugin_quota_exceeded");
        }
        const packageId = randomUUID();
        const value: RoomPluginPackage = { ...owned, packageId, pluginId: manifest.id, version: manifest.version,
          artifactSha256: validated.artifactSha256, byteLength: validated.byteLength, manifest,
          storageKey: `${roomPluginPrefix(owned)}${packageId}/${validated.artifactSha256}.vrata-plugin.json`,
          state: "reserved", uploadSettled: false, backendFingerprint, createdAt: new Date().toISOString() };
        await tx.insertPackage(value);
        return { package: value, created: true };
      });
    },
    confirmPackageUpload: (scope, id) => transact(scope, async tx => {
      const value = await requirePackage(tx, id);
      if (value.uploadSettled) return;
      if (value.state !== "reserved") throw new RoomPluginStorageError("plugin_invalid_transition");
      await tx.setUploadSettled(id);
    }),
    publishPackage: (scope, id) => transact(scope, async tx => {
      const value = await requirePackage(tx, id);
      if (!value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
      if (value.state === "ready" || value.state === "cleanup-pending") return value;
      if (value.state !== "reserved") throw new RoomPluginStorageError("plugin_invalid_transition");
      const state = tx.state.deleting ? "cleanup-pending" : "ready";
      await tx.setPackageState(id, state);
      return { ...value, state };
    }),
    failPackageUpload: (scope, id) => transact(scope, async tx => {
      const value = await requirePackage(tx, id);
      // A writer-confirmed recovery may have already published the successful PUT.
      if (value.state !== "reserved") return value;
      await tx.setUploadSettled(id);
      await tx.setPackageState(id, "cleanup-pending");
      return { ...value, state: "cleanup-pending", uploadSettled: true };
    }),
    listPackages: scope => transact(scope, tx => tx.listPackages(), true),
    getPackage: (scope, id) => transact(scope, tx => tx.getPackage(id), true),
    readBindings: scope => transact(scope, snapshot, true),
    async putBinding(scope, pluginId, raw, expected) {
      const data = validateRoomPluginData(raw, { maxBytes: ROOM_PLUGIN_STORAGE_LIMITS.bindingEnvelopeBytes });
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new RoomPluginStorageError("plugin_invalid_binding");
      const input = data as unknown as RoomPluginBindingInput;
      const keys = Object.keys(input);
      if (keys.some(key => !["packageId", "version", "artifactSha256", "enabled", "config", "approvedCapabilities", "capabilityApproval"].includes(key)) ||
        typeof input.packageId !== "string" || typeof input.version !== "string" || typeof input.enabled !== "boolean") {
        throw new RoomPluginStorageError("plugin_invalid_binding");
      }
      validateRoomPluginSha256(input.artifactSha256);
      const capabilities = validateRoomPluginCapabilities(input.approvedCapabilities);
      return transact(scope, async (tx, owned) => {
        writable(tx); revision(tx, expected);
        const value = await requirePackage(tx, input.packageId);
        if (value.state !== "ready" || !value.uploadSettled) throw new RoomPluginStorageError("plugin_package_not_ready");
        if (value.pluginId !== pluginId || value.version !== input.version || value.artifactSha256 !== input.artifactSha256 ||
          capabilities.some(capability => !value.manifest.requestedCapabilities.includes(capability))) throw new RoomPluginStorageError("plugin_invalid_binding");
        const config = validateRoomPluginConfig(value.manifest.configSchema, input.config);
        const previous = await tx.getBinding(pluginId);
        const gained = previous && capabilities.some(capability => !previous.approvedCapabilities.includes(capability));
        if (gained || input.capabilityApproval !== undefined) {
          const approval = input.capabilityApproval;
          if (!approval || Object.keys(approval).some(key => !["artifactSha256", "capabilities"].includes(key)) || approval.artifactSha256 !== value.artifactSha256) {
            throw new RoomPluginStorageError("plugin_capability_approval_required");
          }
          const explicitlyApproved = validateRoomPluginCapabilities(approval.capabilities);
          if (explicitlyApproved.length !== capabilities.length || capabilities.some(capability => !explicitlyApproved.includes(capability))) {
            throw new RoomPluginStorageError("plugin_capability_approval_required");
          }
        }
        const bindings = await tx.listBindings();
        if (input.enabled && bindings.filter(binding => binding.enabled && binding.pluginId !== pluginId).length >= ROOM_PLUGIN_LIMITS.enabledPluginsPerRoom) {
          throw new RoomPluginStorageError("plugin_quota_exceeded");
        }
        const nextRevision = advance(tx);
        await tx.saveBinding({ ...owned, packageId: value.packageId, pluginId, version: value.version, artifactSha256: value.artifactSha256,
          bindingId: previous?.bindingId ?? randomUUID(), generation: nextRevision, bindingRevision: nextRevision,
          enabled: input.enabled, approvedCapabilities: capabilities, config });
        await tx.saveState();
        return snapshot(tx);
      });
    },
    removeBinding: (scope, pluginId, expected) => transact(scope, async tx => {
      writable(tx); revision(tx, expected);
      if (await tx.getBinding(pluginId)) {
        await tx.deleteBinding(pluginId); advance(tx); await tx.saveState();
      }
      return snapshot(tx);
    }),
    beginPackageDeletion: (scope, id) => transact(scope, async tx => {
      const value = await requirePackage(tx, id);
      if ((await tx.listBindings()).some(binding => binding.packageId === id)) throw new RoomPluginStorageError("plugin_package_bound");
      if (value.state === "reserved" || !value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
      if (value.state === "deleted" || value.state === "cleanup-pending") return value;
      await tx.setPackageState(id, "cleanup-pending");
      return { ...value, state: "cleanup-pending" };
    }),
    confirmPackageDeletion: (scope, id) => transact(scope, async tx => {
      const value = await requirePackage(tx, id);
      if (value.state === "deleted") return;
      if (value.state !== "cleanup-pending") throw new RoomPluginStorageError("plugin_invalid_transition");
      if (!value.uploadSettled) throw new RoomPluginStorageError("plugin_upload_pending");
      await tx.setPackageState(id, "deleted");
    }),
    beginRoomDeletion: scope => transact(scope, async tx => {
      if (!tx.state.deleting) {
        tx.state.cleanupPackageIds = (await tx.listPackages()).map(value => value.packageId);
        const bindings = await tx.listBindings();
        if (bindings.length) { await tx.deleteBinding(); advance(tx); }
        tx.state.deleting = true;
        tx.state.deletionId = randomUUID();
        await tx.saveState();
      }
      const packages: RoomPluginPackage[] = [];
      for (const id of tx.state.cleanupPackageIds) packages.push(await requirePackage(tx, id));
      for (const value of packages) {
        if (value.state === "ready") { await tx.setPackageState(value.packageId, "cleanup-pending"); value.state = "cleanup-pending"; }
      }
      return { deletionId: tx.state.deletionId!, packages };
    })
  };
}
