import type { RoomIdentityProof } from "../identity/contracts.js";
import type { RoomPluginBindingInput, RoomPluginBindings, RoomPluginPackage, RoomPluginScope, StoredRoomPluginBinding } from "./contracts.js";

/** Server-verified admission only. Body/query role, IDs or deadlines are never actors. */
export interface RoomPluginSessionActor {
  actorType: "room-session";
  proof: RoomIdentityProof;
  expiresAtSeconds: number;
}
export interface RoomPluginAdministratorActor {
  actorType: "administrator";
  scope: RoomPluginScope;
}
export type RoomPluginAuthorActor = RoomPluginSessionActor | RoomPluginAdministratorActor;

export type RoomPluginAccessErrorCode = "plugin_identity_not_active" | "plugin_author_forbidden" | "plugin_content_not_bound" | "plugin_binding_changed" | "plugin_ticket_invalid";
export class RoomPluginAccessError extends Error {
  constructor(readonly code: RoomPluginAccessErrorCode) { super(code); this.name = "RoomPluginAccessError"; }
}

declare const uploadTicket: unique symbol;
declare const cleanupTicket: unique symbol;
declare const contentTicket: unique symbol;
/** Internal tickets contain server-only metadata; never serialize them to HTTP. */
export interface RoomPluginUploadTicket {
  readonly [uploadTicket]: true;
  readonly package: Readonly<RoomPluginPackage>;
  readonly disposition: "write" | "resume" | "ready";
}
export interface RoomPluginCleanupTicket {
  readonly [cleanupTicket]: true;
  readonly package: Readonly<RoomPluginPackage>;
}
export interface RoomPluginContentTicket {
  readonly [contentTicket]: true;
  readonly package: Readonly<RoomPluginPackage>;
  readonly binding: Readonly<StoredRoomPluginBinding>;
  readonly revision: number;
}
export interface RoomPluginAuthorLibrary extends RoomPluginBindings { packages: RoomPluginPackage[] }
export interface RoomPluginRuntimeSnapshot extends RoomPluginBindings {
  /** Computed at fenced release, bounded by the original session deadline. */
  leaseExpiresAtMs: number;
}

export interface RoomPluginAuthorAccess {
  /** Admission before body buffering; mutations still revalidate independently. */
  authorize(): Promise<void>;
  reservePackage(bytes: Uint8Array, backendFingerprint: string): Promise<RoomPluginUploadTicket>;
  publishPackage(ticket: RoomPluginUploadTicket): Promise<RoomPluginPackage>;
  putBinding(pluginId: string, input: RoomPluginBindingInput, expectedRevision: number): Promise<RoomPluginBindings>;
  removeBinding(pluginId: string, expectedRevision: number): Promise<RoomPluginBindings>;
  beginPackageDeletion(packageId: string): Promise<RoomPluginCleanupTicket>;
  releaseLibrary(send: (library: RoomPluginAuthorLibrary) => undefined): Promise<void>;
}
export interface RoomPluginRuntimeAccess {
  releaseSnapshot(send: (snapshot: RoomPluginRuntimeSnapshot) => undefined): Promise<void>;
  prepareBoundContent(packageId: string): Promise<RoomPluginContentTicket>;
  /** Validates a private byte copy, then rechecks session/tuple at synchronous release. */
  releaseBoundContent(ticket: RoomPluginContentTicket, bytes: Uint8Array, send: (validatedBytes: Uint8Array) => undefined): Promise<void>;
}
/** Continuations can settle/clean an admitted operation; they cannot publish or bind. */
export interface RoomPluginContinuation {
  settleUpload(ticket: RoomPluginUploadTicket, outcome: "acked" | "rejected"): Promise<RoomPluginCleanupTicket | null>;
  abandonUnpublished(ticket: RoomPluginUploadTicket): Promise<RoomPluginCleanupTicket | null>;
  confirmDeletion(ticket: RoomPluginCleanupTicket): Promise<void>;
}
export interface RoomPluginAccessFactory {
  author(actor: RoomPluginAuthorActor): RoomPluginAuthorAccess;
  runtime(actor: RoomPluginSessionActor): RoomPluginRuntimeAccess;
  readonly continuation: RoomPluginContinuation;
}
