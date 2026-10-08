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
  // Capture one post-read clock sample while every original verified deadline
  // holds; callers sign synchronously with that same sample.
  const liveSampleMs = (...deadlinesSeconds: number[]) => {
    const nowMs = now();
    const live = Number.isSafeInteger(nowMs) && nowMs >= 0 && deadlinesSeconds.every(deadline =>
      Number.isSafeInteger(deadline) && deadline > 0 && Number.isSafeInteger(deadline * 1000) && nowMs < deadline * 1000);
    return live ? nowMs : null;
  };
  const issue = (identity: Awaited<ReturnType<RoomIdentityStorage["create"]>>, signAtSeconds = seconds()) => ({
    identity, credential: codec.sign(identity, { nowSeconds: signAtSeconds, lifetimeSeconds: options.identityLifetimeSeconds ?? 900 })
  });
  const activeSession = async (sessionToken: unknown, identityCredential: unknown, scope: RoomIdentityScope) => {
    const verified = sessionCodec.verify(sessionToken, scope, seconds());
    const possession = codec.verify(identityCredential, scope, seconds());
    if (!verified || !possession || verified.identityId !== possession.identityId
      || verified.participantId !== possession.participantId || verified.authEpoch !== possession.authEpoch) {
      throw new IdentityStorageError("identity_not_active");
    }
    const sessionId = verified.sessionId;
    const sessionExpiresAtSeconds = verified.expiresAtSeconds;
    const possessionExpiresAtSeconds = possession.expiresAtSeconds;
    const current = await storage.resolve(possession);
    if (!current) throw new IdentityStorageError("identity_not_active");
    return { sessionId, sessionExpiresAtSeconds, possessionExpiresAtSeconds, current };
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
      if (!verified) return null;
      const expiresAtSeconds = verified.expiresAtSeconds;
      const current = await storage.resolve(verified);
      return current && liveSampleMs(expiresAtSeconds) !== null ? current : null;
    },
    async renewCredential(credential: unknown, scope: RoomIdentityScope) {
      const verified = proof(credential, scope);
      const expiresAtSeconds = verified.expiresAtSeconds;
      const current = await storage.resolve(verified);
      const nowMs = liveSampleMs(expiresAtSeconds);
      if (!current || nowMs === null) throw new IdentityStorageError("identity_not_active");
      return issue(current.identity, Math.floor(nowMs / 1000));
    },
    async issueSession(credential: unknown, scope: RoomIdentityScope) {
      const verified = proof(credential, scope);
      const expiresAtSeconds = verified.expiresAtSeconds;
      const current = await storage.resolve(verified);
      const nowMs = liveSampleMs(expiresAtSeconds);
      if (!current || nowMs === null) throw new IdentityStorageError("identity_not_active");
      const sessionId = randomUUID();
      return { identity: current.identity, authority: current.authority, role: current.role, permissions: current.permissions,
        isOwner: current.isOwner,
        sessionId, sessionToken: sessionCodec.sign(current.identity, { nowSeconds: Math.floor(nowMs / 1000), lifetimeSeconds: options.sessionLifetimeSeconds ?? 900, sessionId }) };
    },
    async resolveSession(sessionToken: unknown, scope: RoomIdentityScope) {
      const verified = sessionCodec.verify(sessionToken, scope, seconds());
      if (!verified) return null;
      const { sessionId, expiresAtSeconds } = verified;
      const current = await storage.resolve(verified);
      return current && liveSampleMs(expiresAtSeconds) !== null ? { ...current, sessionId, expiresAtSeconds } : null;
    },
    async renewSession(sessionToken: unknown, identityCredential: unknown, scope: RoomIdentityScope) {
      const { sessionId, sessionExpiresAtSeconds, possessionExpiresAtSeconds, current } =
        await activeSession(sessionToken, identityCredential, scope);
      const nowMs = liveSampleMs(sessionExpiresAtSeconds, possessionExpiresAtSeconds);
      if (nowMs === null) throw new IdentityStorageError("identity_not_active");
      return {
        identity: current.identity, authority: current.authority, role: current.role, permissions: current.permissions,
        sessionId,
        sessionToken: sessionCodec.sign(current.identity, {
          nowSeconds: Math.floor(nowMs / 1000), lifetimeSeconds: options.sessionLifetimeSeconds ?? 900, sessionId
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
