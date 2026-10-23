import { createRoomAccessFromPermissions } from "@vrata/shared-types";
import type { Storage } from "../storage-contracts.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import type { VerifiedRoomRequestV2 } from "./http-authority.js";

export function assertParticipantViewDeadline(expiresAtSeconds: number, now: () => number = Date.now): void {
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds < 1
    || !Number.isSafeInteger(expiresAtSeconds * 1000)) {
    throw new IdentityBoundaryError(503, "identity_authority_unavailable");
  }
  if (at >= expiresAtSeconds * 1000) throw new IdentityBoundaryError(401, "identity_session_expired");
}

/** MAC-verified subject and deadline are lookup pins; current rights and all
 * displayed authority slots come from one read-only persistence snapshot. */
export async function readParticipantSessionViewV2(storage: Pick<Storage, "roomIdentities">,
  verified: VerifiedRoomRequestV2, now: () => number = Date.now) {
  const { tenantId, roomId, identityId, participantId, authEpoch } = verified.identity;
  const expiresAtSeconds = verified.expiresAtSeconds;
  assertParticipantViewDeadline(expiresAtSeconds, now);
  let view;
  try { view = await storage.roomIdentities.resolveView({ tenantId, roomId, identityId, participantId, authEpoch }); }
  catch (error) { throw new IdentityBoundaryError(503, "identity_authority_unavailable", error); }
  assertParticipantViewDeadline(expiresAtSeconds, now);
  if (!view) throw new IdentityBoundaryError(409, "identity_recovery_required");
  return {
    authorityRevision: view.authority.revision,
    // Runtime viewers need current control state, not moderation/audit details
    // about other participants or arbitrary removal reasons.
    state: { lockedAt: view.authority.lifecycle.lockedAt, endedAt: view.authority.lifecycle.endedAt,
      hostParticipantId: view.slots.host?.participantId ?? null,
      presenterParticipantId: view.slots.presenter?.participantId ?? null },
    ownerParticipantId: view.slots.owner?.participantId ?? null,
    slots: view.slots,
    participant: { participantId: view.identity.participantId, role: view.role, permissions: view.permissions,
      isOwner: view.isOwner, status: "active" as const, reason: null,
      access: createRoomAccessFromPermissions(view.role, view.permissions) }
  };
}
