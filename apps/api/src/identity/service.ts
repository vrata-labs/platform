import { createRoomIdentityCodec, type RoomIdentityScope } from "@vrata/shared-types/identity-credential";
import { IdentityStorageError, type RoomIdentityStorage } from "./contracts.js";

// Deliberately not installed in the legacy HTTP/WS routes. Activation must pair
// this service with server-authority checks and runtime server-ID adoption.
export function createRoomIdentityService(storage: RoomIdentityStorage, secret: string, now = Date.now) {
  const codec = createRoomIdentityCodec(secret);
  const seconds = () => Math.floor(now() / 1000);
  const proof = (credential: unknown, scope: RoomIdentityScope) => {
    const verified = codec.verify(credential, scope, seconds());
    if (!verified) throw new IdentityStorageError("identity_not_active");
    return verified;
  };
  const issue = (identity: Awaited<ReturnType<RoomIdentityStorage["create"]>>) => ({
    identity, credential: codec.sign(identity, { nowSeconds: seconds() })
  });
  return {
    async admitFromVerifiedAccess(input: Parameters<RoomIdentityStorage["create"]>[0]) {
      return issue(await storage.create(input));
    },
    async resolveCredential(credential: unknown, scope: RoomIdentityScope) {
      const verified = codec.verify(credential, scope, seconds());
      return verified ? storage.resolve(verified) : null;
    },
    async renewCredential(credential: unknown, scope: RoomIdentityScope) {
      const current = await storage.resolve(proof(credential, scope));
      if (!current) throw new IdentityStorageError("identity_not_active");
      return issue(current.identity);
    },
    async claimHost(credential: unknown, scope: RoomIdentityScope, expectedRevision: number) {
      return storage.claimHost(proof(credential, scope), expectedRevision);
    },
    async transferHost(credential: unknown, scope: RoomIdentityScope, targetIdentityId: string, expectedRevision: number) {
      return storage.transferHost(proof(credential, scope), targetIdentityId, expectedRevision);
    },
    async issueRecovery(input: Omit<Parameters<RoomIdentityStorage["issueRecovery"]>[0], "recoveryId" | "secretHash">) {
      const credential = codec.createRecovery(input);
      const record = await storage.issueRecovery({ ...input, recoveryId: credential.recoveryId, secretHash: credential.secretHash });
      return { credential: credential.credential, expiresAt: record.expiresAt };
    },
    async redeemRecovery(credential: unknown, scope: RoomIdentityScope) {
      const parsed = codec.parseRecovery(credential, scope);
      if (!parsed) throw new IdentityStorageError("recovery_invalid");
      return issue(await storage.redeemRecovery(scope, parsed.recoveryId, parsed.secretHash));
    }
  };
}
