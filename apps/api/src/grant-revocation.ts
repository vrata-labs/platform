import { IdentityStorageError } from "./identity/contracts.js";
import type { ManagedRoomGrantRecord, Storage } from "./storage-contracts.js";

/**
 * Finishes a revoked grant: every identity that entered with it is revoked, then a used grant asks for a new
 * media epoch (not before: an identity still active at the rotation could get a token for the new epoch).
 * Idempotent; the route runs it at once and the enforcer again for any revoke that was interrupted.
 */
export async function completeGrantRevocation(storage: Storage, grant: ManagedRoomGrantRecord): Promise<void> {
  const scope = { tenantId: grant.tenantId, roomId: grant.roomId };
  for (const identityId of await storage.listManagedRoomGrantIdentities(grant.grantId)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const identity = await storage.roomIdentities.get(scope, identityId);
      if (!identity || identity.revokedAt) break;
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
