import type { VerifiedRoomRequestV2 } from "./http-authority.js";
import type { RoomRole } from "@vrata/shared-types";

export type ProofBoundEffectActor = {
  tenantId: string; roomId: string; identityId: string; participantId: string;
  authEpoch: number; role: RoomRole; isOwner: boolean;
};

/** An effect prepared before a revoke must not be released afterwards. The
 * fresh read is deliberately after async token signing, not the cached HTTP
 * entry snapshot. An already-issued self-hosted LiveKit token is a separate
 * lifecycle problem and is not invalidated by this check. */
export async function finalizeProofBoundToken<T>(input: {
  before: ProofBoundEffectActor;
  prepare: () => Promise<T>;
  readCurrent: () => Promise<VerifiedRoomRequestV2 | null>;
}): Promise<T | null> {
  const token = await input.prepare();
  const current = await input.readCurrent();
  if (!current || current.room.roomId !== input.before.roomId
    || current.room.tenantId !== input.before.tenantId
    || current.identity.identityId !== input.before.identityId
    || current.identity.participantId !== input.before.participantId
    || current.identity.authEpoch !== input.before.authEpoch
    || current.role !== input.before.role || current.isOwner !== input.before.isOwner) return null;
  return token;
}
