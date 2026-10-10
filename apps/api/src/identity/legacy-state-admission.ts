import type { RoomRole, RoomTemplateSessionContext } from "@vrata/shared-types";
import {
  isRotatedDevelopmentSession, verifyRoomSessionToken,
  type RoomSessionRoleSource, type RoomSessionTokenPayload, type RoomSessionTokenVerificationResult
} from "@vrata/shared-types/session-token";
import { isPersonalRoom, isPersonalRoomOwner } from "../personal-room-rules.js";
import { sanitizeRoomVisibility } from "../room-input.js";
import { getSessionControlBlockReason, isRoomDisabled, resolveEffectiveRoomRole } from "../room-session-control.js";
import { roomTemplateSessionContext } from "../room-template-policy.js";
import type { RoomInviteRecord, RoomRecord, WaitingRoomRequestRecord } from "../storage-contracts.js";
import { validId } from "./authority.js";

type SessionFailure = Extract<RoomSessionTokenVerificationResult, { ok: false }>;

/** Captured once per request; flags and bearer never re-read across awaits. */
export interface LegacyAdmissionContext {
  readonly rawBearer: string | null;
  readonly secret: string;
  readonly nowMs: number;
  readonly accessPolicyEnabled: boolean;
  readonly hostControlsEnabled: boolean;
}

export interface LegacyAdmissionRequest {
  readonly mode: "admit" | "renew";
  readonly requestId: string;
  readonly explicitParticipantId: string | null;
  readonly participantId: string;
  readonly displayName: string;
  readonly requested: { readonly role: RoomRole; readonly roleSource: RoomSessionRoleSource };
  readonly inviteTokenHash: string | null;
}

/** Structurally matches the storage selector snapshot (fresh clones, room already scope-validated). */
export interface LegacyAdmissionSnapshot {
  readonly room: RoomRecord;
  readonly invite: RoomInviteRecord | null;
  readonly waiting: WaitingRoomRequestRecord | null;
}

export type LegacyBearerClass =
  | { kind: "absent" }
  | { kind: "valid"; payload: RoomSessionTokenPayload }
  | { kind: "expired"; result: SessionFailure }
  | { kind: "rotated_dev" }
  | { kind: "unusable"; result: SessionFailure };

export type LegacyAdmissionSource =
  | { readonly kind: "bearer"; readonly jti: string; readonly sessionId: string; readonly originalExp: number }
  | { readonly kind: "personal_owner" }
  | { readonly kind: "public" }
  | { readonly kind: "invite"; readonly inviteId: string; readonly inviteTokenHash: string }
  | { readonly kind: "waiting_approved"; readonly inviteId: string; readonly inviteTokenHash: string; readonly requestId: string };

export interface LegacyBindingRef {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly contentHash: string | null;
  readonly sceneBundleUrl: string | null;
}

export interface LegacyAdmissionDecision {
  readonly requestId: string;
  readonly tenantId: string;
  readonly roomId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly role: RoomRole;
  readonly roleSource: RoomSessionRoleSource;
  readonly source: LegacyAdmissionSource;
  readonly binding: LegacyBindingRef;
}

type LegacyDeny = { kind: "deny"; status: 403; reason: string; inviteId?: string; accessRequestId?: string };

export type LegacyAdmissionOutcome =
  | { kind: "admit"; decision: LegacyAdmissionDecision }
  | LegacyDeny
  | { kind: "session"; result: SessionFailure }
  | { kind: "upgrade_required" }
  | { kind: "waiting"; inviteId: string; requestId: string | null };

export type LegacyAdmissionConfirmation =
  | { ok: true; room: RoomRecord; role: RoomRole; roleSource: RoomSessionRoleSource; templateContext: RoomTemplateSessionContext | undefined }
  | { ok: false; kind: "deny"; status: 202 | 403; reason: string; inviteId?: string; accessRequestId?: string }
  | { ok: false; kind: "session"; result: SessionFailure }
  | { ok: false; kind: "changed"; status: 409; reason: "room_state_changed" };

const CHANGED = Object.freeze({ ok: false, kind: "changed", status: 409, reason: "room_state_changed" } as const);

function deny(reason: string, extra: { inviteId?: string; accessRequestId?: string } = {}): LegacyDeny {
  return { kind: "deny", status: 403, reason, ...extra };
}

/** MAC, expiry and current scope via the codec; no unchecked payload is ever read. A signed
 * subject outside the selector namespace is invalid_payload: never a subject, never a role. */
export function classifyLegacyBearer(ctx: Pick<LegacyAdmissionContext, "rawBearer" | "secret" | "nowMs">,
  scope: { tenantId: string; roomId: string }, explicitParticipantId: string | null): LegacyBearerClass {
  const result = verifyRoomSessionToken(ctx.rawBearer, ctx.secret,
    { nowSeconds: Math.floor(ctx.nowMs / 1000), tenantId: scope.tenantId, roomId: scope.roomId });
  if (result.ok) {
    // An older issuer signed any non-empty ID; the codec still accepts what no selector can hold.
    if (!validId(result.payload.participantId)) return { kind: "unusable", result: { ok: false, code: "invalid_payload" } };
    if (explicitParticipantId !== null && result.payload.participantId !== explicitParticipantId) {
      return { kind: "unusable", result: { ok: false, code: "participant_mismatch" } };
    }
    return { kind: "valid", payload: result.payload };
  }
  // The codec checks expiry after the MAC and before scope, so an authentic
  // stale proof for any room is expired and never falls back to fresh admission.
  if (result.code === "expired_token") return { kind: "expired", result };
  if (isRotatedDevelopmentSession(ctx.rawBearer, ctx.secret)) return { kind: "rotated_dev" };
  if (result.code === "missing_token") return { kind: "absent" };
  return { kind: "unusable", result };
}

/** Explicit ID, else the valid scoped proof's ID, else exactly one minted UUID. */
export function normalizeLegacyParticipant(explicitParticipantId: string | null, bearer: LegacyBearerClass, mint: () => string): string {
  if (explicitParticipantId !== null) return explicitParticipantId;
  return bearer.kind === "valid" ? bearer.payload.participantId : mint();
}

function bindingRef(room: RoomRecord): LegacyBindingRef {
  return Object.freeze({
    templateId: room.templateId,
    templateVersion: room.templateVersion,
    contentHash: roomTemplateSessionContext(room)?.contentHash ?? null,
    sceneBundleUrl: room.sceneBundleUrl ?? null
  });
}

function admitUnlessBlocked(req: LegacyAdmissionRequest, room: RoomRecord, ctx: LegacyAdmissionContext, role: RoomRole,
  roleSource: RoomSessionRoleSource, source: LegacyAdmissionSource, hasExistingSession: boolean, inviteId?: string): LegacyAdmissionOutcome {
  const reason = getSessionControlBlockReason(room, req.participantId, role, hasExistingSession, ctx.hostControlsEnabled);
  if (reason) return deny(reason, inviteId === undefined ? {} : { inviteId });
  return { kind: "admit", decision: Object.freeze({
    requestId: req.requestId, tenantId: room.tenantId, roomId: room.roomId,
    participantId: req.participantId, displayName: req.displayName,
    role, roleSource, source: Object.freeze(source), binding: bindingRef(room)
  }) };
}

function evaluateInvite(req: LegacyAdmissionRequest, snap: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext, inviteTokenHash: string): LegacyAdmissionOutcome {
  const { room, invite, waiting } = snap;
  if (!invite || invite.tokenHash !== inviteTokenHash || invite.roomId !== room.roomId || !invite.inviteId) return deny("invite_required");
  // A v2 invite is never a legacy grant.
  if (invite.protocolVersion === 2) return { kind: "upgrade_required" };
  const { inviteId } = invite;
  if (invite.revokedAt) return deny("invite_revoked", { inviteId });
  const expiresAtMs = Date.parse(invite.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= ctx.nowMs) return deny("invite_expired", { inviteId });
  const role = resolveEffectiveRoomRole(room, req.participantId, invite.role);
  if (!invite.waitingRoomEnabled) {
    return admitUnlessBlocked(req, room, ctx, role, "trusted", { kind: "invite", inviteId, inviteTokenHash: invite.tokenHash }, false, inviteId);
  }
  const request = waiting && waiting.roomId === room.roomId && waiting.inviteId === inviteId
    && waiting.participantId === req.participantId ? waiting : null;
  if (request?.status === "approved") {
    return admitUnlessBlocked(req, room, ctx, role, "trusted",
      { kind: "waiting_approved", inviteId, inviteTokenHash: invite.tokenHash, requestId: request.requestId }, false, inviteId);
  }
  if (request?.status === "rejected") return deny("waiting_room_rejected", { inviteId, accessRequestId: request.requestId });
  return { kind: "waiting", inviteId, requestId: request?.requestId ?? null };
}

/** Pure legacy (floor-1) admission over one storage snapshot. No metrics, audit or I/O. */
export function evaluateLegacyAdmission(req: LegacyAdmissionRequest, snap: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext): LegacyAdmissionOutcome {
  const { room } = snap;
  if (isRoomDisabled(room)) return deny("room_disabled");
  const bearer = classifyLegacyBearer(ctx, room, req.explicitParticipantId);
  if (bearer.kind === "expired") return { kind: "session", result: bearer.result };
  if (bearer.kind === "rotated_dev") return { kind: "upgrade_required" };
  const restricted = isPersonalRoom(room) || (ctx.accessPolicyEnabled && sanitizeRoomVisibility(room.visibility) === "private");
  // The MAC-bound role is copied only for the proof's own participant.
  const proof = bearer.kind === "valid" && bearer.payload.participantId === req.participantId ? bearer.payload : null;
  const proofRoleSource = proof?.roleSource ?? "trusted";
  if (proof && (!restricted || proofRoleSource === "trusted")) {
    return admitUnlessBlocked(req, room, ctx, resolveEffectiveRoomRole(room, proof.participantId, proof.role), proofRoleSource,
      { kind: "bearer", jti: proof.jti, sessionId: proof.sessionId, originalExp: proof.exp }, true);
  }
  if (req.mode === "renew") {
    if (proof) return deny("invite_required");
    return { kind: "session", result: bearer.kind === "unusable" ? bearer.result
      : { ok: false, code: bearer.kind === "absent" ? "missing_token" : "participant_mismatch" } };
  }
  if (req.inviteTokenHash !== null) return evaluateInvite(req, snap, ctx, req.inviteTokenHash);
  if (proof) return deny("invite_required");
  if (isPersonalRoom(room)) {
    if (!isPersonalRoomOwner(room, req.participantId)) return deny("invite_required");
    return admitUnlessBlocked(req, room, ctx, resolveEffectiveRoomRole(room, req.participantId, "host"), "trusted", { kind: "personal_owner" }, false);
  }
  if (restricted) return deny("invite_required");
  return admitUnlessBlocked(req, room, ctx, resolveEffectiveRoomRole(room, req.participantId, req.requested.role),
    req.requested.roleSource, { kind: "public" }, false);
}

function sameFields(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/** Re-evaluates on a fresh snapshot; any drift from the frozen decision is room_state_changed. */
export function confirmLegacyAdmission(decision: LegacyAdmissionDecision, req: LegacyAdmissionRequest,
  fresh: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext): LegacyAdmissionConfirmation {
  if (decision.requestId !== req.requestId || decision.participantId !== req.participantId || decision.displayName !== req.displayName
    || decision.tenantId !== fresh.room.tenantId || decision.roomId !== fresh.room.roomId) return CHANGED;
  const outcome = evaluateLegacyAdmission(req, fresh, ctx);
  switch (outcome.kind) {
    case "deny": {
      const { kind: _kind, ...rest } = outcome;
      return { ok: false, kind: "deny", ...rest };
    }
    case "session":
      return { ok: false, kind: "session", result: outcome.result };
    case "waiting":
      return outcome.requestId === null ? CHANGED
        : { ok: false, kind: "deny", status: 202, reason: "waiting_room_pending", inviteId: outcome.inviteId, accessRequestId: outcome.requestId };
    case "upgrade_required":
      return CHANGED;
  }
  const next = outcome.decision;
  if (next.role !== decision.role || next.roleSource !== decision.roleSource
    || !sameFields(next.source, decision.source) || !sameFields(next.binding, decision.binding)) return CHANGED;
  return { ok: true, room: fresh.room, role: decision.role, roleSource: decision.roleSource, templateContext: roomTemplateSessionContext(fresh.room) };
}
