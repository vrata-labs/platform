import { createRoomIdentityCodec, type RoomIdentityScope } from "@vrata/shared-types/identity-credential";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { randomUUID } from "node:crypto";
import { IdentityStorageError, type RoomIdentityStorage } from "./contracts.js";

// Deliberately not installed in the legacy HTTP/WS routes. Activation must pair
// this service with server-authority checks and runtime server-ID adoption.
export function createRoomIdentityService(storage: RoomIdentityStorage, secret: string, now = Date.now,
  options: { identityLifetimeSeconds?: number; sessionLifetimeSeconds?: number } = {}) {
  const codec = createRoomIdentityCodec(secret);
  const sessionCodec = createRoomSessionV2Codec(secret);
  const seconds = () => Math.floor(now() / 1000);
  const proof = (credential: unknown, scope: RoomIdentityScope) => {
    const verified = codec.verify(credential, scope, seconds());
    if (!verified) throw new IdentityStorageError("identity_not_active");
    return verified;
  };
  const issue = (identity: Awaited<ReturnType<RoomIdentityStorage["create"]>>) => ({
    identity, credential: codec.sign(identity, { nowSeconds: seconds(), lifetimeSeconds: options.identityLifetimeSeconds ?? 900 })
  });
  const activeSession = async (sessionToken: unknown, identityCredential: unknown, scope: RoomIdentityScope) => {
    const verified = sessionCodec.verify(sessionToken, scope, seconds());
    const possession = codec.verify(identityCredential, scope, seconds());
    if (!verified || !possession || verified.identityId !== possession.identityId
      || verified.participantId !== possession.participantId || verified.authEpoch !== possession.authEpoch) {
      throw new IdentityStorageError("identity_not_active");
    }
    const current = await storage.resolve(possession);
    if (!current) throw new IdentityStorageError("identity_not_active");
    return { verified, current };
  };
  return {
    async admit(input: Parameters<RoomIdentityStorage["admit"]>[0]) {
      return issue(await storage.admit(input));
    },
    async beginWaiting(input: RoomIdentityScope & { inviteTokenHash: string; displayName: string; expiresAt: string }) {
      const waiting = codec.createWaiting(input);
      const pending = await storage.beginWaiting({ ...input, pendingId: waiting.pendingId, secretHash: waiting.secretHash });
      return { requestId: pending.requestId, credential: waiting.credential, expiresAt: pending.expiresAt };
    },
    async redeemWaiting(credential: unknown, scope: RoomIdentityScope) {
      const waiting = codec.parseWaiting(credential, scope);
      if (!waiting) throw new IdentityStorageError("waiting_proof_invalid");
      return issue(await storage.redeemWaiting(scope, waiting.pendingId, waiting.secretHash));
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
    async issueSession(credential: unknown, scope: RoomIdentityScope) {
      const current = await storage.resolve(proof(credential, scope));
      if (!current) throw new IdentityStorageError("identity_not_active");
      const sessionId = randomUUID();
      return { identity: current.identity, authority: current.authority, role: current.role, permissions: current.permissions,
        isOwner: current.isOwner,
        sessionId, sessionToken: sessionCodec.sign(current.identity, { nowSeconds: seconds(), lifetimeSeconds: options.sessionLifetimeSeconds ?? 900, sessionId }) };
    },
    async resolveSession(sessionToken: unknown, scope: RoomIdentityScope) {
      const verified = sessionCodec.verify(sessionToken, scope, seconds());
      if (!verified) return null;
      const current = await storage.resolve(verified);
      return current ? { ...current, sessionId: verified.sessionId, expiresAtSeconds: verified.expiresAtSeconds } : null;
    },
    async renewSession(sessionToken: unknown, identityCredential: unknown, scope: RoomIdentityScope) {
      const { verified, current } = await activeSession(sessionToken, identityCredential, scope);
      return {
        identity: current.identity, authority: current.authority, role: current.role, permissions: current.permissions,
        sessionId: verified.sessionId,
        sessionToken: sessionCodec.sign(current.identity, {
          nowSeconds: seconds(), lifetimeSeconds: options.sessionLifetimeSeconds ?? 900, sessionId: verified.sessionId
        })
      };
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
