import { randomUUID, timingSafeEqual } from "node:crypto";
import { getRoomPermissions } from "@vrata/shared-types";
import {
  IdentityStorageError, type IdentityPersistence, type IdentityProvenance, type IdentityTransaction,
  type RoomIdentityAuthority, type RoomIdentityProof, type RoomIdentityRecord, type RoomIdentityScope, type RoomIdentityStorage
} from "./contracts.js";

function fail(code: ConstructorParameters<typeof IdentityStorageError>[0]): never { throw new IdentityStorageError(code); }
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const validCounter = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function assertIdentityScope(scope: RoomIdentityScope): void {
  if (!validId(scope.tenantId) || !validId(scope.roomId)) fail("invalid_identity_input");
}

export function emptyIdentityAuthority(scope: RoomIdentityScope): RoomIdentityAuthority {
  return { tenantId: scope.tenantId, roomId: scope.roomId, hostIdentityId: null, ownerIdentityId: null, presenterIdentityId: null, revision: 0 };
}

function assertRoomActive(state: IdentityTransaction): void {
  if (state.room.status === "disabled" || state.room.disabledAt || state.room.sessionControl?.endedAt) fail("room_blocked");
}

function activeIdentity(state: IdentityTransaction, proof: RoomIdentityProof): RoomIdentityRecord {
  const identity = state.identities.get(proof.identityId);
  if (!identity || identity.tenantId !== proof.tenantId || identity.roomId !== proof.roomId
    || identity.participantId !== proof.participantId || identity.authEpoch !== proof.authEpoch || identity.revokedAt
    || state.room.sessionControl?.removedParticipants?.[identity.participantId]) fail("identity_not_active");
  return identity;
}

function checkRevision(state: IdentityTransaction, expected: number): void {
  if (!validCounter(expected) || state.authority.revision !== expected) fail("authority_conflict");
}

function bumpAuthority(state: IdentityTransaction): void {
  if (!validCounter(state.authority.revision) || state.authority.revision === 2_147_483_647) fail("authority_conflict");
  state.authority.revision++;
}

function validateAdmission(provenance: IdentityProvenance, baseRole: "guest" | "member"): IdentityProvenance {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) fail("invalid_identity_input");
  if (provenance.kind === "guest" && baseRole === "guest") return { kind: "guest" };
  if ((provenance.kind === "invite" || provenance.kind === "waiting-room") && validId(provenance.inviteId)
    && ["guest", "member", "presenter", "host"].includes(provenance.role)
    && baseRole === (provenance.role === "guest" ? "guest" : "member")) {
    if (provenance.kind === "waiting-room") {
      if (!validId(provenance.requestId)) fail("invalid_identity_input");
      return { kind: "waiting-room", inviteId: provenance.inviteId, requestId: provenance.requestId, role: provenance.role };
    }
    return { kind: "invite", inviteId: provenance.inviteId, role: provenance.role };
  }
  // Owner bootstrap must be coupled to creating its room. Legacy ownership is
  // recovered only by the explicit single-use administrator recovery operation.
  fail("identity_forbidden");
}

function recoveryTargetIsCurrent(state: IdentityTransaction, target: { targetParticipantId: string; targetIdentityId: string | null; targetRole: "host" | "owner" }): boolean {
  const slot = target.targetRole === "owner" ? state.authority.ownerIdentityId : state.authority.hostIdentityId;
  if (target.targetIdentityId) {
    const identity = state.identities.get(target.targetIdentityId);
    return Boolean(identity && !identity.revokedAt && identity.participantId === target.targetParticipantId && slot === identity.identityId);
  }
  if (slot !== null) return false;
  return target.targetRole === "owner"
    ? state.room.roomType === "personal" && state.room.ownerParticipantId === target.targetParticipantId
    : state.authority.revision === 0 && state.room.sessionControl?.hostParticipantId === target.targetParticipantId;
}

export function createRoomIdentityStorage(persistence: IdentityPersistence, now = Date.now): RoomIdentityStorage {
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_identity_input");
    return new Date(value).toISOString();
  };
  return {
    async create(input) {
      assertIdentityScope(input);
      if (typeof input.displayName !== "string" || input.displayName.length > 80) fail("invalid_identity_input");
      const provenance = validateAdmission(input.provenance, input.baseRole);
      return persistence.transact(input, {}, state => {
        assertRoomActive(state);
        const record: RoomIdentityRecord = {
          tenantId: input.tenantId, roomId: input.roomId, identityId: randomUUID(), participantId: randomUUID(),
          authEpoch: 1, displayName: input.displayName, baseRole: input.baseRole, provenance,
          createdAt: timestamp(), revokedAt: null
        };
        state.identities.set(record.identityId, record);
        return structuredClone(record);
      });
    },
    async get(scope, identityId) {
      assertIdentityScope(scope);
      if (!validId(identityId)) return null;
      return (await persistence.read(scope, { identityIds: [identityId] }))?.identities.get(identityId) ?? null;
    },
    async authority(scope) {
      assertIdentityScope(scope);
      return (await persistence.read(scope, {}))?.authority ?? null;
    },
    async resolve(proof) {
      assertIdentityScope(proof);
      if (!validId(proof.identityId) || !validId(proof.participantId) || !validCounter(proof.authEpoch) || proof.authEpoch < 1) return null;
      const state = await persistence.read(proof, { identityIds: [proof.identityId] });
      if (!state) return null;
      try {
        assertRoomActive(state);
        const identity = activeIdentity(state, proof);
        const role = state.authority.hostIdentityId === identity.identityId ? "host"
          : state.authority.presenterIdentityId === identity.identityId ? "presenter" : identity.baseRole;
        return { identity, authority: state.authority, role, permissions: getRoomPermissions(role), isOwner: state.authority.ownerIdentityId === identity.identityId };
      } catch (error) {
        if (error instanceof IdentityStorageError) return null;
        throw error;
      }
    },
    async claimHost(proof, expectedRevision) {
      assertIdentityScope(proof);
      return persistence.transact(proof, { identityIds: [proof.identityId] }, state => {
        assertRoomActive(state);
        checkRevision(state, expectedRevision);
        const identity = activeIdentity(state, proof);
        const source = identity.provenance;
        const eligible = (source.kind === "invite" || source.kind === "waiting-room") && source.role === "host";
        if (!eligible) fail("identity_forbidden");
        // Admission can initialise the first host, not reclaim a vacancy using
        // a historical invite after transfer/revocation. Later assignment is an
        // explicit administrator/authority transition, never a refresh side effect.
        if (state.authority.hostIdentityId !== null || state.authority.revision !== 0) fail("authority_conflict");
        state.authority.hostIdentityId = identity.identityId;
        bumpAuthority(state);
        return structuredClone(state.authority);
      });
    },
    async transferHost(proof, toIdentityId, expectedRevision) {
      assertIdentityScope(proof);
      if (!validId(toIdentityId) || toIdentityId === proof.identityId) fail("invalid_identity_input");
      return persistence.transact(proof, { identityIds: [proof.identityId, toIdentityId] }, state => {
        assertRoomActive(state);
        checkRevision(state, expectedRevision);
        activeIdentity(state, proof);
        if (state.authority.hostIdentityId !== proof.identityId) fail("identity_forbidden");
        const target = state.identities.get(toIdentityId);
        if (!target || target.revokedAt || state.room.sessionControl?.removedParticipants?.[target.participantId]) fail("identity_not_active");
        state.authority.hostIdentityId = toIdentityId;
        if (state.authority.presenterIdentityId === toIdentityId) state.authority.presenterIdentityId = null;
        bumpAuthority(state);
        return structuredClone(state.authority);
      });
    },
    async revoke(scope, identityId, expectedAuthEpoch) {
      assertIdentityScope(scope);
      return persistence.transact(scope, { identityIds: [identityId] }, state => {
        const target = state.identities.get(identityId);
        if (!target || target.revokedAt || target.authEpoch !== expectedAuthEpoch || !validCounter(expectedAuthEpoch) || expectedAuthEpoch === 2_147_483_647) fail("identity_not_active");
        target.authEpoch++;
        target.revokedAt = timestamp();
        let changed = false;
        for (const key of ["hostIdentityId", "presenterIdentityId", "ownerIdentityId"] as const) {
          if (state.authority[key] === identityId) { state.authority[key] = null; changed = true; }
        }
        if (changed) bumpAuthority(state);
        return structuredClone(target);
      });
    },
    async issueRecovery(input) {
      assertIdentityScope(input);
      if (input.issuer?.actorType !== "admin-token" || input.issuer.role !== "admin" || !validId(input.issuer.actorId)) fail("identity_forbidden");
      if (!validId(input.recoveryId) || !validHash(input.secretHash) || !validId(input.targetParticipantId)
        || !["owner", "host"].includes(input.targetRole)) fail("invalid_identity_input");
      return persistence.transact(input, { participantId: input.targetParticipantId, recoveryId: input.recoveryId }, state => {
        assertRoomActive(state);
        const createdAt = timestamp();
        const lifetimeMs = Date.parse(input.expiresAt) - Date.parse(createdAt);
        if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 900_000) fail("invalid_identity_input");
        if (state.recovery) fail("identity_conflict");
        const target = [...state.identities.values()].find(identity => identity.participantId === input.targetParticipantId);
        const binding = { targetParticipantId: input.targetParticipantId, targetIdentityId: target?.identityId ?? null, targetRole: input.targetRole };
        if (!recoveryTargetIsCurrent(state, binding) || state.room.sessionControl?.removedParticipants?.[input.targetParticipantId]) fail("identity_forbidden");
        state.recovery = {
          tenantId: input.tenantId, roomId: input.roomId, recoveryId: input.recoveryId, ...binding,
          expectedAuthEpoch: target?.authEpoch ?? null, expectedAuthorityRevision: state.authority.revision,
          secretHash: input.secretHash, issuedBy: input.issuer.actorId, createdAt,
          expiresAt: new Date(input.expiresAt).toISOString(), consumedAt: null
        };
        return structuredClone(state.recovery);
      });
    },
    async redeemRecovery(scope, recoveryId, secretHash) {
      assertIdentityScope(scope);
      if (!validId(recoveryId) || !validHash(secretHash)) fail("recovery_invalid");
      return persistence.transact(scope, { recoveryId }, state => {
        assertRoomActive(state);
        const recovery = state.recovery;
        const consumedAt = timestamp();
        if (!recovery || recovery.consumedAt || Date.parse(recovery.expiresAt) <= Date.parse(consumedAt)
          || !validHash(recovery.secretHash) || !timingSafeEqual(Buffer.from(secretHash, "hex"), Buffer.from(recovery.secretHash, "hex"))
          || state.authority.revision !== recovery.expectedAuthorityRevision || !recoveryTargetIsCurrent(state, recovery)
          || state.room.sessionControl?.removedParticipants?.[recovery.targetParticipantId]) fail("recovery_invalid");
        let target = recovery.targetIdentityId ? state.identities.get(recovery.targetIdentityId) : null;
        if (recovery.targetIdentityId) {
          if (!target || target.authEpoch !== recovery.expectedAuthEpoch || !validCounter(target.authEpoch) || target.authEpoch === 2_147_483_647) fail("recovery_invalid");
          target.authEpoch++;
        } else {
          if (state.identities.size !== 0) fail("recovery_invalid");
          target = {
            tenantId: scope.tenantId, roomId: scope.roomId, identityId: randomUUID(), participantId: recovery.targetParticipantId,
            authEpoch: 1, baseRole: "member", displayName: "", provenance: { kind: "administrator-recovery", recoveryId },
            createdAt: consumedAt, revokedAt: null
          };
          state.identities.set(target.identityId, target);
        }
        if (!target) fail("recovery_invalid");
        if (recovery.targetRole === "owner") {
          state.authority.ownerIdentityId = target.identityId;
          if (state.authority.hostIdentityId === null) state.authority.hostIdentityId = target.identityId;
        } else state.authority.hostIdentityId = target.identityId;
        bumpAuthority(state);
        recovery.consumedAt = consumedAt;
        return structuredClone(target);
      });
    }
  };
}
