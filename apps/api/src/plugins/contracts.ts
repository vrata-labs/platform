import type { RoomPluginBinding, RoomPluginCapability, RoomPluginConfig, RoomPluginManifest } from "@vrata/room-plugin-sdk";

/** Internal, server-resolved scope. This library does not grant author permission. */
export interface RoomPluginScope { tenantId: string; roomId: string }
export type RoomPluginPackageState = "reserved" | "ready" | "cleanup-pending" | "deleted";
export interface RoomPluginPackage extends RoomPluginScope {
  packageId: string;
  pluginId: string;
  version: string;
  artifactSha256: string;
  byteLength: number;
  manifest: RoomPluginManifest;
  storageKey: string;
  /** Server-only target identity. Never serialize this field into author/runtime HTTP responses.
   * Null means an older record has no proven target identity; IO must fail closed, not adopt today's config.
   */
  backendFingerprint: string | null;
  state: RoomPluginPackageState;
  /** Durable acknowledgement of writer completion, never inferred from GET/existence/elapsed time. */
  uploadSettled: boolean;
  createdAt: string;
}
export interface StoredRoomPluginBinding extends RoomPluginBinding, RoomPluginScope { packageId: string }
export interface RoomPluginBindings { revision: number; bindings: StoredRoomPluginBinding[] }
export interface RoomPluginBindingInput {
  packageId: string;
  version: string;
  artifactSha256: string;
  enabled: boolean;
  config: RoomPluginConfig;
  approvedCapabilities: readonly RoomPluginCapability[];
  /** Required when an existing binding gains capabilities; tied to exact bytes. */
  capabilityApproval?: { artifactSha256: string; capabilities: readonly RoomPluginCapability[] };
}
export type RoomPluginStorageErrorCode = "room_not_found" | "room_plugin_cleanup_pending" | "plugin_package_not_found"
  | "plugin_version_conflict" | "plugin_upload_pending" | "plugin_package_not_ready" | "plugin_package_bound"
  | "plugin_quota_exceeded" | "plugin_revision_conflict" | "plugin_invalid_binding" | "plugin_capability_approval_required"
  | "plugin_invalid_transition" | "plugin_revision_exhausted" | "plugin_history_quota_exceeded";
export class RoomPluginStorageError extends Error {
  constructor(readonly code: RoomPluginStorageErrorCode) { super(code); this.name = "RoomPluginStorageError"; }
}

/** Metadata-only operations. No callback, network IO, authority claim, or caller-supplied manifest. */
export interface RoomPluginStorage {
  reservePackage(scope: RoomPluginScope, originalBytes: Uint8Array, backendFingerprint: string): Promise<{ package: RoomPluginPackage; created: boolean }>;
  /** Only the trusted writer may call this after a terminal PUT acknowledgement or proven quiescence. */
  confirmPackageUpload(scope: RoomPluginScope, packageId: string): Promise<void>;
  publishPackage(scope: RoomPluginScope, packageId: string): Promise<RoomPluginPackage>;
  /** Only a confirmed, settled rejection permits compensation; never use for an unknown remote outcome. */
  failPackageUpload(scope: RoomPluginScope, packageId: string): Promise<RoomPluginPackage>;
  listPackages(scope: RoomPluginScope): Promise<RoomPluginPackage[]>;
  getPackage(scope: RoomPluginScope, packageId: string): Promise<RoomPluginPackage | null>;
  readBindings(scope: RoomPluginScope): Promise<RoomPluginBindings>;
  putBinding(scope: RoomPluginScope, pluginId: string, input: RoomPluginBindingInput, expectedRevision: number): Promise<RoomPluginBindings>;
  removeBinding(scope: RoomPluginScope, pluginId: string, expectedRevision: number): Promise<RoomPluginBindings>;
  beginPackageDeletion(scope: RoomPluginScope, packageId: string): Promise<RoomPluginPackage>;
  confirmPackageDeletion(scope: RoomPluginScope, packageId: string): Promise<void>;
  beginRoomDeletion(scope: RoomPluginScope): Promise<{ deletionId: string; packages: RoomPluginPackage[] }>;
}

export interface RoomPluginRoomState {
  revision: number;
  deleting: boolean;
  deletionId: string | null;
  /** Frozen at room-delete admission: at most ten keys, retained across partial cleanup/restart. */
  cleanupPackageIds: string[];
}
export interface RoomPluginTransaction {
  state: RoomPluginRoomState;
  saveState(): Promise<void>;
  findVersion(pluginId: string, version: string): Promise<RoomPluginPackage | null>;
  getPackage(packageId: string): Promise<RoomPluginPackage | null>;
  listPackages(includeDeleted?: boolean): Promise<RoomPluginPackage[]>;
  quota(): Promise<{ count: number; bytes: number; lifetimeCount: number }>;
  insertPackage(value: RoomPluginPackage): Promise<void>;
  setPackageState(packageId: string, state: RoomPluginPackageState): Promise<void>;
  setUploadSettled(packageId: string): Promise<void>;
  listBindings(): Promise<StoredRoomPluginBinding[]>;
  getBinding(pluginId: string): Promise<StoredRoomPluginBinding | null>;
  saveBinding(value: StoredRoomPluginBinding): Promise<void>;
  deleteBinding(pluginId?: string): Promise<void>;
}
export interface RoomPluginRepository {
  transaction<T>(scope: RoomPluginScope, operation: (transaction: RoomPluginTransaction) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
}
