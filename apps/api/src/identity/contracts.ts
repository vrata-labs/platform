import type { RoomIdentityProof, RoomIdentityScope } from "@vrata/shared-types/identity-credential";
import type { RoomPermission, RoomRole } from "@vrata/shared-types";
import type { RoomInviteRecord, RoomRecord, RoomSessionControlState, WaitingRoomRequestRecord } from "../storage-contracts.js";

export type { RoomIdentityScope, RoomIdentityProof };

/** Original MAC-verified RI2 deadline, checked after loading under the mutation lock. */
export type RoomIdentityMutationProof = RoomIdentityProof & { readonly expiresAtSeconds: number };

export type IdentityProvenance =
  | { kind: "guest" }
  | { kind: "invite"; inviteId: string; role: "guest" | "member" | "presenter" | "host" }
  | { kind: "waiting-room"; inviteId: string; requestId: string; role: "guest" | "member" | "presenter" | "host" }
  | { kind: "personal-owner" }
  | { kind: "administrator-recovery"; recoveryId: string }
  | { kind: "grant"; grantId: string; role: "guest" };

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

export interface RoomAuthorityParticipant {
  participantId: string;
  displayName: string;
}

/** Actor and authority slots read from one immutable authority snapshot. */
export interface RoomIdentityView {
  identity: RoomIdentityRecord;
  authority: RoomIdentityAuthority;
  role: RoomRole;
  permissions: RoomPermission[];
  isOwner: boolean;
  slots: { host: RoomAuthorityParticipant | null; presenter: RoomAuthorityParticipant | null; owner: RoomAuthorityParticipant | null };
}

export class IdentityAuthorityViewUnavailable extends Error {
  constructor() { super("room_identity_authority_unavailable"); this.name = "IdentityAuthorityViewUnavailable"; }
}

/** One consistent read of room lifecycle and the identities that can publish a screen. */
/** One selected participant's identity lineage from the same snapshot as its room authority. */
export interface RoomMediaParticipantState {
  /** Current authEpoch; a codec-3 connection of any other epoch is a retired lineage. */
  readonly epoch: number;
  /** False after revocation or public removal. */
  readonly active: boolean;
}

export interface RoomScreenSourceAuthority {
  readonly revision: number;
  readonly roomActive: boolean;
  readonly publisherParticipantIds: readonly string[];
  readonly removedParticipantIds?: readonly string[];
  /** Volatile row/object token for observation-cache freshness only, never admission or identity. */
  readonly observationVersion?: string;
  /** Durable generation of this room record; absent only from adapters predating media lineage. */
  readonly mediaIncarnation?: string;
  /** Present when participant IDs were selected: a missing key is a confirmed absent identity. */
  readonly participants?: Readonly<Record<string, RoomMediaParticipantState>>;
}

export type RoomIdentityLifecycle = Required<Omit<RoomSessionControlState, "hostParticipantId" | "presenterParticipantId">>;

export type RoomIdentityActor =
  | { actorType: "room-session"; proof: RoomIdentityProof; expiresAtSeconds: number }
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

export interface RoomIdentityPending extends RoomIdentityScope {
  pendingId: string;
  inviteId: string;
  requestId: string;
  participantId: string;
  displayName: string;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  activatedAt: string | null;
}

export type IdentityRoomBinding = Pick<RoomRecord, "tenantId" | "roomId" | "roomType" | "ownerParticipantId" | "visibility" | "guestAllowed" | "status" | "disabledAt" | "sessionControl">;
export type IdentityStorageErrorCode = "room_not_found" | "room_blocked" | "invalid_identity_input" | "identity_conflict" | "identity_not_active" | "identity_session_expired" | "authority_conflict" | "identity_forbidden" | "identity_role_changed" | "identity_capacity_reached" | "waiting_room_pending" | "waiting_room_capacity_reached" | "waiting_room_rejected" | "waiting_proof_invalid" | "recovery_invalid";
export class IdentityStorageError extends Error {
  constructor(readonly code: IdentityStorageErrorCode) { super(code); this.name = "IdentityStorageError"; }
}

// Internal server commands. Admission provenance and administrator identity must
// come from validated server context, never a request body or legacy JWT claims.
export interface RoomIdentityStorage {
  create(input: RoomIdentityScope & { displayName: string; baseRole: "guest" | "member"; provenance: IdentityProvenance }): Promise<RoomIdentityRecord>;
  admit(input: RoomIdentityScope & { displayName: string; inviteTokenHash?: string }): Promise<RoomIdentityRecord>;
  beginWaiting(input: RoomIdentityScope & { inviteTokenHash: string; displayName: string; pendingId: string; secretHash: string; expiresAt: string }): Promise<RoomIdentityPending>;
  redeemWaiting(scope: RoomIdentityScope, pendingId: string, secretHash: string): Promise<RoomIdentityRecord>;
  get(scope: RoomIdentityScope, identityId: string): Promise<RoomIdentityRecord | null>;
  authority(scope: RoomIdentityScope): Promise<RoomIdentityAuthority | null>;
  /** Selected participants are read in the same snapshot as the room authority (at most 4096). */
  screenSourceAuthority(scope: RoomIdentityScope, participantIds?: readonly string[]): Promise<RoomScreenSourceAuthority | null>;
  mediaIncarnation(scope: RoomIdentityScope): Promise<string | null>;
  resolve(proof: RoomIdentityProof): Promise<{ identity: RoomIdentityRecord; authority: RoomIdentityAuthority; role: RoomRole; permissions: RoomPermission[]; isOwner: boolean } | null>;
  resolveView(proof: RoomIdentityProof): Promise<RoomIdentityView | null>;
  claimHost(proof: RoomIdentityMutationProof, expectedRevision: number): Promise<RoomIdentityAuthority>;
  transferHost(proof: RoomIdentityMutationProof, toIdentityId: string, expectedRevision: number): Promise<RoomIdentityAuthority>;
  revoke(scope: RoomIdentityScope, identityId: string, expectedAuthEpoch: number): Promise<RoomIdentityRecord>;
  transition(scope: RoomIdentityScope, actor: RoomIdentityActor, expectedRevision: number, command: RoomIdentityCommand): Promise<RoomIdentityAuthority>;
  issueRecovery(input: RoomIdentityScope & {
    recoveryId: string; secretHash: string; targetParticipantId: string; targetRole: "host" | "owner";
    expiresAt: string; issuer: { actorType: string; actorId: string; role: string };
  }): Promise<RoomIdentityRecovery>;
  redeemRecovery(scope: RoomIdentityScope, recoveryId: string, secretHash: string): Promise<RoomIdentityRecord>;
}

export interface IdentitySelection { identityIds?: string[]; participantId?: string; participantIds?: readonly string[]; recoveryId?: string; inviteTokenHash?: string; pendingId?: string; admissionCount?: boolean; screenPublishers?: boolean; authoritySlots?: boolean }
export interface IdentityTransaction {
  room: IdentityRoomBinding;
  /** Volatile row/object observation token, not a credential or durable room incarnation. */
  roomObservationVersion?: string;
  /** Durable room generation: new on every insert of the room record, unchanged by updates. */
  mediaIncarnation?: string;
  minimumProtocol: number;
  authority: RoomIdentityAuthority;
  identities: Map<string, RoomIdentityRecord>;
  identityCount: number | null;
  recovery: RoomIdentityRecovery | null;
  invite: RoomInviteRecord | null;
  pending: RoomIdentityPending | null;
  waitingRequest: WaitingRoomRequestRecord | null;
  waitingRequestNew: boolean;
  pendingCapacity: { room: number; invite: number; lifetimeRoom: number } | null;
}

export interface IdentityPersistence {
  read(scope: RoomIdentityScope, selection: IdentitySelection): Promise<IdentityTransaction | null>;
  transact<T>(scope: RoomIdentityScope, selection: IdentitySelection, apply: (state: IdentityTransaction) => T): Promise<T>;
}
