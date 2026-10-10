import type { LegacyRoomCredentialSelector, LegacyRoomCredentialSnapshot, LegacyRoomEffectOptions, RoomInviteRecord, RoomRecord, WaitingRoomRequestRecord } from "../storage-contracts.js";
import { validId } from "./authority.js";
import { IdentityStorageError } from "./contracts.js";

/** Primitives copied before any wait; caller mutation cannot widen role, room, or hash. */
export interface LegacyCredentialReleaseGuard {
  readonly tenantId: string;
  readonly roomId: string;
  readonly participantId: string;
  readonly inviteTokenHash: string | null;
  readonly lockTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/** Errors are parameterless: they never echo a request value. The tenant is the saved catalog key, any
 * string the tenant API accepted, so only its type is checked; exact stored equality bounds the scope. */
export function captureLegacyCredentialRelease(selector: unknown, options: unknown, send: unknown): LegacyCredentialReleaseGuard {
  if (typeof selector !== "object" || selector === null || typeof options !== "object" || options === null || typeof send !== "function") {
    throw new Error("invalid_legacy_credential_release");
  }
  const { tenantId, roomId, participantId, inviteTokenHash } = selector as LegacyRoomCredentialSelector;
  const { lockTimeoutMs, idleTimeoutMs } = options as Pick<LegacyRoomEffectOptions, "lockTimeoutMs" | "idleTimeoutMs">;
  if (typeof tenantId !== "string" || !validId(roomId)) throw new IdentityStorageError("room_not_found");
  if (!validId(participantId) || (inviteTokenHash !== null && !validId(inviteTokenHash))) throw new IdentityStorageError("invalid_identity_input");
  return Object.freeze({ tenantId, roomId, participantId, inviteTokenHash, lockTimeoutMs, idleTimeoutMs });
}

export function legacyCredentialSnapshot(room: RoomRecord, invite: RoomInviteRecord | null,
  waiting: WaitingRoomRequestRecord | null): LegacyRoomCredentialSnapshot {
  return Object.freeze({ room, invite, waiting });
}
