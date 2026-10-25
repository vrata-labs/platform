import { IdentityStorageError, type RoomIdentityRecord } from "./identity/contracts.js";
import type { ManagedRoomGrantRecord, Storage } from "./storage-contracts.js";

/**
 * Finishes a revoked grant: every identity that entered with it is revoked, then a used grant asks for a new
 * media epoch (not before: an identity still active at the rotation could get a token for the new epoch).
 * Idempotent; the route runs it at once and the enforcer again for any revoke that was interrupted.
 *
 * An account grant ends the account's access as it was at the revoke. The first revoke takes every grant the account
 * had in the room, so a generation is from before the revoke exactly when the grant that created it is revoked; a
 * generation created by a grant issued later is a later entry and stays, however late this runs.
 */
export async function completeGrantRevocation(storage: Storage, grant: ManagedRoomGrantRecord): Promise<void> {
  const scope = { tenantId: grant.tenantId, roomId: grant.roomId };
  const candidates = new Set(await storage.listManagedRoomGrantIdentities(grant.grantId));
  if (grant.subject) {
    const current = await storage.roomIdentities.accountIdentity(scope, grant.subject);
    if (current) candidates.add(current.identityId);
  }
  for (const identityId of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const identity = await storage.roomIdentities.get(scope, identityId);
      if (!identity || identity.revokedAt) break;
      if (grant.subject && !(await createdByRevokedGrant(storage, identity, grant.subject))) break;
      try {
        await storage.roomIdentities.revoke(scope, identityId, identity.authEpoch);
        break;
      } catch (error) {
        // Revoked meanwhile (an exchange withdrawing its own identity, a second revoke): read it again.
        if (!(error instanceof IdentityStorageError && error.code === "identity_not_active") || attempt === 2) throw error;
      }
    }
  }
  // One step for the completion mark and the rotation request: a concurrent finisher rotates nothing twice.
  await storage.completeManagedGrantRevocation(grant.grantId);
}

async function createdByRevokedGrant(storage: Storage, identity: RoomIdentityRecord, subject: string): Promise<boolean> {
  const provenance = identity.provenance;
  if (provenance.kind !== "grant" || !("subject" in provenance) || provenance.subject !== subject) return false;
  const creator = await storage.getManagedRoomGrant(provenance.grantId);
  // An identity whose grant is gone cannot be placed: revoking it is the safe side.
  return !creator || creator.revokedAt !== null;
}
