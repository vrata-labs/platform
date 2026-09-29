import type { RoomIdentityProof, RoomIdentityScope } from "@vrata/shared-types/identity-credential";
import type { RoomPermission, RoomRole } from "@vrata/shared-types";
import type { RoomRecord, RoomSessionControlState } from "../storage-contracts.js";

export type { RoomIdentityScope, RoomIdentityProof };

export type IdentityProvenance =
  | { kind: "guest" }
  | { kind: "invite"; inviteId: string; role: "guest" | "member" | "presenter" | "host" }
  | { kind: "waiting-room"; inviteId: string; requestId: string; role: "guest" | "member" | "presenter" | "host" }
  | { kind: "personal-owner" }
  | { kind: "administrator-recovery"; recoveryId: string };

export interface RoomIdentityRecord extends RoomIdentityProof {
  displayName: string;
  baseRole: "guest" | "member";
  provenance: IdentityProvenance;
  createdAt: string;
  revokedAt: string | null;
}

export interface RoomIdentityAuthority extends RoomIdentityScope {
  hostIdentityId: string | null;
  ownerIdentityId: string | null;
  presenterIdentityId: string | null;
  revision: number;
  lifecycle: RoomIdentityLifecycle;
}

export type RoomIdentityLifecycle = Required<Omit<RoomSessionControlState, "hostParticipantId" | "presenterParticipantId">>;

export type RoomIdentityActor =
  | { actorType: "room-session"; proof: RoomIdentityProof }
  | { actorType: "admin-token"; actorId: string; role: "admin" };

export type RoomIdentityCommand =
  | { type: "lock" | "unlock" | "end" }
  | { type: "grant-presenter" | "revoke-presenter" | "transfer-host" | "transfer-owner"; targetParticipantId: string }
  | { type: "remove"; targetParticipantId: string; reason?: string };

export interface RoomIdentityRecovery extends RoomIdentityScope {
  recoveryId: string;
  targetParticipantId: string;
  targetIdentityId: string | null;
  targetRole: "host" | "owner";
  expectedAuthEpoch: number | null;
  expectedAuthorityRevision: number;
  secretHash: string;
  issuedBy: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type IdentityRoomBinding = Pick<RoomRecord, "tenantId" | "roomId" | "roomType" | "ownerParticipantId" | "status" | "disabledAt" | "sessionControl">;
export type IdentityStorageErrorCode = "room_not_found" | "room_blocked" | "invalid_identity_input" | "identity_conflict" | "identity_not_active" | "authority_conflict" | "identity_forbidden" | "recovery_invalid";
export class IdentityStorageError extends Error {
  constructor(readonly code: IdentityStorageErrorCode) { super(code); this.name = "IdentityStorageError"; }
}

// Internal server commands. Admission provenance and administrator identity must
// come from validated server context, never a request body or legacy JWT claims.
export interface RoomIdentityStorage {
  create(input: RoomIdentityScope & { displayName: string; baseRole: "guest" | "member"; provenance: IdentityProvenance }): Promise<RoomIdentityRecord>;
  get(scope: RoomIdentityScope, identityId: string): Promise<RoomIdentityRecord | null>;
  authority(scope: RoomIdentityScope): Promise<RoomIdentityAuthority | null>;
  resolve(proof: RoomIdentityProof): Promise<{ identity: RoomIdentityRecord; authority: RoomIdentityAuthority; role: RoomRole; permissions: RoomPermission[]; isOwner: boolean } | null>;
  claimHost(proof: RoomIdentityProof, expectedRevision: number): Promise<RoomIdentityAuthority>;
  transferHost(proof: RoomIdentityProof, toIdentityId: string, expectedRevision: number): Promise<RoomIdentityAuthority>;
  revoke(scope: RoomIdentityScope, identityId: string, expectedAuthEpoch: number): Promise<RoomIdentityRecord>;
  transition(scope: RoomIdentityScope, actor: RoomIdentityActor, expectedRevision: number, command: RoomIdentityCommand): Promise<RoomIdentityAuthority>;
  issueRecovery(input: RoomIdentityScope & {
    recoveryId: string; secretHash: string; targetParticipantId: string; targetRole: "host" | "owner";
    expiresAt: string; issuer: { actorType: string; actorId: string; role: string };
  }): Promise<RoomIdentityRecovery>;
  redeemRecovery(scope: RoomIdentityScope, recoveryId: string, secretHash: string): Promise<RoomIdentityRecord>;
}

export interface IdentitySelection { identityIds?: string[]; participantId?: string; recoveryId?: string }
export interface IdentityTransaction {
  room: IdentityRoomBinding;
  authority: RoomIdentityAuthority;
  identities: Map<string, RoomIdentityRecord>;
  recovery: RoomIdentityRecovery | null;
}

export interface IdentityPersistence {
  read(scope: RoomIdentityScope, selection: IdentitySelection): Promise<IdentityTransaction | null>;
  transact<T>(scope: RoomIdentityScope, selection: IdentitySelection, apply: (state: IdentityTransaction) => T): Promise<T>;
}
