import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";
import { defaultSessionControlState, getSessionControlBlockReason, resolveEffectiveRoomRole } from "../room-session-control.js";
import { roomTemplateSessionContext } from "../room-template-policy.js";
import type { RoomInviteRecord, RoomRecord } from "../storage-contracts.js";
import {
  evaluateLegacyAdmission,
  type LegacyAdmissionContext, type LegacyAdmissionDecision, type LegacyAdmissionOutcome, type LegacyAdmissionRequest,
  type LegacyAdmissionSnapshot, type LegacyBindingRef
} from "./legacy-state-admission.js";

export type LegacyDeadlineKind = "bearer" | "invite";

export interface LegacyAdmissionDeadline {
  readonly expiresAtMs: number;
  readonly kind: LegacyDeadlineKind;
}

type InviteDeadline = LegacyAdmissionDeadline & { readonly kind: "invite" };
type BearerDeadline = LegacyAdmissionDeadline & { readonly kind: "bearer" };

export interface LegacyAdmissionWriteLeases {
  readonly deadline: LegacyAdmissionDeadline | null;
  readonly presentedBearerDeadline: LegacyAdmissionDeadline | null;
}

/** The original admission's lease lapsed. Fixed message: never the proof, invite, hash or instant. */
export class LegacyAdmissionDeadlineExpired extends Error {
  constructor(readonly kind: LegacyDeadlineKind) { super("legacy_admission_deadline_expired"); this.name = "LegacyAdmissionDeadlineExpired"; }
}

/** A caller wiring fault, never a client answer; carries only its fixed code. */
export class LegacyAdmissionWriteInvariant extends Error {
  constructor(readonly code: "invalid_legacy_admission_deadline" | "invalid_legacy_admission_plan") { super(code); this.name = "LegacyAdmissionWriteInvariant"; }
}

const invalidDeadline = () => new LegacyAdmissionWriteInvariant("invalid_legacy_admission_deadline");
const invalidPlan = () => new LegacyAdmissionWriteInvariant("invalid_legacy_admission_plan");

function deadline<K extends LegacyDeadlineKind>(kind: K, expiresAtMs: number): LegacyAdmissionDeadline & { readonly kind: K } {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) throw invalidDeadline();
  return Object.freeze({ expiresAtMs, kind });
}

function checked(lease: LegacyAdmissionDeadline): LegacyAdmissionDeadline {
  if (lease.kind !== "bearer" && lease.kind !== "invite") throw invalidDeadline();
  return deadline(lease.kind, lease.expiresAtMs);
}

function inviteDeadline(snap: LegacyAdmissionSnapshot, inviteId: string): InviteDeadline {
  if (!snap.invite || snap.invite.inviteId !== inviteId) throw invalidDeadline();
  return deadline("invite", Date.parse(snap.invite.expiresAt));
}

/** The lease an admission was granted under: the MAC's signed expiry or the selected invite's.
 * None for the personal owner or a public room. */
export function legacyAdmissionDeadline(initial: LegacyAdmissionOutcome, snap: LegacyAdmissionSnapshot): LegacyAdmissionDeadline | null {
  if (initial.kind === "waiting") return inviteDeadline(snap, initial.inviteId);
  if (initial.kind !== "admit") throw invalidDeadline();
  const { source } = initial.decision;
  if (source.kind === "bearer") return deadline("bearer", source.originalExp * 1000);
  if (source.kind === "invite" || source.kind === "waiting_approved") return inviteDeadline(snap, source.inviteId);
  return null;
}

/** A fresh lease can only shorten the original; an externally extended invite never widens it. */
export function narrowLegacyDeadline(original: LegacyAdmissionDeadline | null, fresh: LegacyAdmissionDeadline | null): LegacyAdmissionDeadline | null {
  if (original === null && fresh === null) return null;
  if (original === null || fresh === null || original.kind !== fresh.kind) throw invalidDeadline();
  return deadline(original.kind, Math.min(checked(original).expiresAtMs, checked(fresh).expiresAtMs));
}

function lapsedKind(lease: LegacyAdmissionDeadline | null, nowMs: number): LegacyDeadlineKind | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw invalidDeadline();
  if (lease === null) return null;
  const { kind, expiresAtMs } = checked(lease);
  return nowMs >= expiresAtMs ? kind : null;
}

/** The caller supplies its own captured instant; nothing here reads a clock. */
export function assertLegacyDeadline(lease: LegacyAdmissionDeadline | null, nowMs: number): void {
  const kind = lapsedKind(lease, nowMs);
  if (kind !== null) throw new LegacyAdmissionDeadlineExpired(kind);
}

export interface LegacyPendingRef {
  /** The original API request and subject; the same invite replayed for any other is drift. */
  readonly requestId: string;
  readonly participantId: string;
  readonly inviteId: string;
  readonly inviteTokenHash: string;
  readonly protocolVersion: 1;
  readonly waitingRoomEnabled: true;
  readonly binding: LegacyBindingRef;
  readonly existingRequestId: string | null;
}

export type LegacyAdmissionWritePlan =
  | { readonly mode: "claim_host"; readonly decision: LegacyAdmissionDecision; readonly deadline: LegacyAdmissionDeadline | null;
    readonly presentedBearerDeadline: BearerDeadline | null }
  | { readonly mode: "pending"; readonly displayName: string; readonly pending: LegacyPendingRef; readonly deadline: InviteDeadline;
    readonly presentedBearerDeadline: BearerDeadline | null };

export type LegacyAdmissionWriteDecision =
  | { readonly write: "set_host" }
  | { readonly write: "none_host_current" }
  | { readonly write: "insert_pending" }
  | { readonly write: "none_pending"; readonly accessRequestId: string }
  | { readonly write: "refuse"; readonly status: 403; readonly reason: string; readonly accessRequestId?: string }
  | { readonly write: "changed"; readonly status: 409; readonly reason: "room_state_changed" };

type HostPlan = Extract<LegacyAdmissionWritePlan, { mode: "claim_host" }>;
type PendingPlan = Extract<LegacyAdmissionWritePlan, { mode: "pending" }>;
type Evaluated = Exclude<LegacyAdmissionOutcome, { kind: "session" | "upgrade_required" }>;

const CHANGED = Object.freeze({ write: "changed", status: 409, reason: "room_state_changed" } as const);
const SET_HOST = Object.freeze({ write: "set_host" } as const);
const HOST_CURRENT = Object.freeze({ write: "none_host_current" } as const);
const INSERT_PENDING = Object.freeze({ write: "insert_pending" } as const);

function refuse(reason: string, accessRequestId?: string): LegacyAdmissionWriteDecision {
  return Object.freeze(accessRequestId === undefined ? { write: "refuse", status: 403, reason } : { write: "refuse", status: 403, reason, accessRequestId });
}

function bindingRef(room: RoomRecord): LegacyBindingRef {
  return Object.freeze({ templateId: room.templateId, templateVersion: room.templateVersion,
    contentHash: roomTemplateSessionContext(room)?.contentHash ?? null, sceneBundleUrl: room.sceneBundleUrl ?? null });
}

function sameFields(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function legacyWaitingInvite(invite: RoomInviteRecord): boolean {
  return (invite.protocolVersion ?? 1) === 1 && invite.waitingRoomEnabled === true;
}

/** The raw bearer's own signed expiry, whatever its scope or subject: the evaluator rejects an authentic
 * expired MAC before it reads any invite, so no plan made beside one may outlive it. Read only through
 * the codec's MAC check, and only as a lease: never a role, subject or scope. */
function presentedBearerDeadline(ctx: LegacyAdmissionContext): BearerDeadline | null {
  const result = verifyRoomSessionToken(ctx.rawBearer, ctx.secret, { nowSeconds: Math.floor(ctx.nowMs / 1000) });
  if (result.ok) return deadline("bearer", result.payload.exp * 1000);
  // Absent, malformed, forged or rotated: no lease. An authentic expired one is never planned.
  if (result.code === "expired_token") throw new LegacyAdmissionDeadlineExpired("bearer");
  return null;
}

/** Plans the floor-1 deferred write from the initial pool admission: a trusted first host claims a
 * vacant seat, or a waiting invitee gets a pending request. Everything is copied and frozen here,
 * before any pool wait, so the snapshot is never referenced again. Null: nothing to write. */
export function planLegacyAdmissionWrite(initial: LegacyAdmissionOutcome, req: LegacyAdmissionRequest,
  snap: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext): LegacyAdmissionWritePlan | null {
  const { room, invite, waiting } = snap;
  if (initial.kind === "admit") {
    const { decision } = initial;
    if (decision.role !== "host" || decision.roleSource !== "trusted" || defaultSessionControlState(room.sessionControl).hostParticipantId) return null;
    if (decision.requestId !== req.requestId || decision.participantId !== req.participantId || decision.displayName !== req.displayName
      || decision.tenantId !== room.tenantId || decision.roomId !== room.roomId) throw invalidPlan();
    const lease = legacyAdmissionDeadline(initial, snap);
    const presented = presentedBearerDeadline(ctx);
    assertLegacyDeadline(lease, ctx.nowMs);
    return Object.freeze({ mode: "claim_host", deadline: lease, presentedBearerDeadline: presented,
      decision: Object.freeze({ ...decision, source: Object.freeze({ ...decision.source }), binding: Object.freeze({ ...decision.binding }) }) });
  }
  if (initial.kind !== "waiting") return null;
  // The evaluator selected this invite; anything but a legacy waiting invite bound to this room is a wiring fault.
  const hash = req.inviteTokenHash;
  if (req.mode !== "admit" || hash === null || !invite || invite.inviteId !== initial.inviteId || invite.tokenHash !== hash
    || invite.roomId !== room.roomId || !legacyWaitingInvite(invite)) throw invalidPlan();
  const existing = initial.requestId;
  if (existing !== null && (!waiting || waiting.requestId !== existing || waiting.status !== "pending" || waiting.roomId !== room.roomId
    || waiting.inviteId !== invite.inviteId || waiting.participantId !== req.participantId)) throw invalidPlan();
  const lease = inviteDeadline(snap, invite.inviteId);
  const presented = presentedBearerDeadline(ctx);
  assertLegacyDeadline(lease, ctx.nowMs);
  const pending: LegacyPendingRef = Object.freeze({ requestId: req.requestId, participantId: req.participantId, inviteId: invite.inviteId,
    inviteTokenHash: hash, protocolVersion: 1, waitingRoomEnabled: true, binding: bindingRef(room), existingRequestId: existing });
  return Object.freeze({ mode: "pending", displayName: req.displayName, pending, deadline: lease, presentedBearerDeadline: presented });
}

function lapseRefusal(kind: LegacyDeadlineKind | null): LegacyAdmissionWriteDecision | null {
  if (kind === "bearer") throw new LegacyAdmissionDeadlineExpired("bearer");
  return kind === "invite" ? refuse("invite_expired") : null;
}

function leaseRefusal(lease: LegacyAdmissionDeadline | null, nowMs: number): LegacyAdmissionWriteDecision | null {
  return lapseRefusal(lapsedKind(lease, nowMs));
}

/** At most two leases, the plan's own and the presented MAC's. When both lapsed the earlier answers;
 * a tie is the bearer's, as the evaluator rejects an expired MAC before it reads any invite. */
function lapsedPlanKind(plan: LegacyAdmissionWriteLeases, nowMs: number): LegacyDeadlineKind | null {
  const { deadline: own, presentedBearerDeadline: presented } = plan;
  if (presented !== null && presented.kind !== "bearer") throw invalidDeadline();
  const ownKind = lapsedKind(own, nowMs);
  if (presented === null || lapsedKind(presented, nowMs) === null) return ownKind;
  return own !== null && ownKind !== null && own.expiresAtMs < presented.expiresAtMs ? ownKind : "bearer";
}

/** The one lease check for every write moment (decision, before SQL, after SQL, before commit),
 * against the caller's captured instant. */
export function assertLegacyAdmissionPlanDeadlines(plan: LegacyAdmissionWriteLeases, nowMs: number): void {
  const kind = lapsedPlanKind(plan, nowMs);
  if (kind !== null) throw new LegacyAdmissionDeadlineExpired(kind);
}

function decideHostClaim(plan: HostPlan, fresh: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext, outcome: Evaluated): LegacyAdmissionWriteDecision {
  if (outcome.kind === "deny") return refuse(outcome.reason, outcome.accessRequestId);
  if (outcome.kind !== "admit") return CHANGED;
  const { decision } = plan;
  const next = outcome.decision;
  // Only a trusted source ever seats the first host; a dev, default or public role never does.
  if (next.role !== "host" || next.roleSource !== "trusted" || !sameFields(next.source, decision.source)
    || !sameFields(next.binding, decision.binding)) return CHANGED;
  const lapsed = leaseRefusal(narrowLegacyDeadline(plan.deadline, legacyAdmissionDeadline(outcome, fresh)), ctx.nowMs);
  if (lapsed) return lapsed;
  // The seat is only ever the frozen subject; no caller supplies the new host.
  const host = defaultSessionControlState(fresh.room.sessionControl).hostParticipantId;
  if (!host) return SET_HOST;
  return host === decision.participantId ? HOST_CURRENT : CHANGED;
}

function decidePending(plan: PendingPlan, req: LegacyAdmissionRequest, fresh: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext,
  outcome: Evaluated): LegacyAdmissionWriteDecision {
  const { pending } = plan;
  const sameRow = (id: string) => pending.existingRequestId === null || pending.existingRequestId === id;
  // An approval or any other grant is never written or released from here.
  if (outcome.kind === "admit") return CHANGED;
  if (outcome.kind === "deny") {
    if (outcome.inviteId !== undefined && outcome.inviteId !== pending.inviteId) return CHANGED;
    if (outcome.accessRequestId !== undefined && !sameRow(outcome.accessRequestId)) return CHANGED;
    return refuse(outcome.reason, outcome.accessRequestId);
  }
  const { invite } = fresh;
  if (outcome.inviteId !== pending.inviteId || !invite || invite.inviteId !== pending.inviteId || invite.tokenHash !== pending.inviteTokenHash
    || invite.roomId !== fresh.room.roomId || !legacyWaitingInvite(invite) || !sameFields(bindingRef(fresh.room), pending.binding)) return CHANGED;
  const lapsed = leaseRefusal(narrowLegacyDeadline(plan.deadline, legacyAdmissionDeadline(outcome, fresh)), ctx.nowMs);
  if (lapsed) return lapsed;
  // The legacy waiting branch never consulted lifecycle state: no row and no 202 for an ended, removed or locked subject.
  const blocked = getSessionControlBlockReason(fresh.room, req.participantId,
    resolveEffectiveRoomRole(fresh.room, req.participantId, invite.role), false, ctx.hostControlsEnabled);
  if (blocked) return refuse(blocked);
  // A deleted request is never revived; a replaced one is drift.
  if (outcome.requestId === null) return pending.existingRequestId === null ? INSERT_PENDING : CHANGED;
  return sameRow(outcome.requestId) ? Object.freeze({ write: "none_pending", accessRequestId: outcome.requestId }) : CHANGED;
}

/** Pure re-evaluation on the fresh locked snapshot. The plan's leases are checked before any state; the store
 * and API check them again with assertLegacyAdmissionPlanDeadlines before SQL, after SQL and before commit. */
export function decideLegacyAdmissionWrite(plan: LegacyAdmissionWritePlan, req: LegacyAdmissionRequest,
  fresh: LegacyAdmissionSnapshot, ctx: LegacyAdmissionContext): LegacyAdmissionWriteDecision {
  const lapsed = lapseRefusal(lapsedPlanKind(plan, ctx.nowMs));
  if (lapsed) return lapsed;
  if (plan.mode === "claim_host") {
    const { decision } = plan;
    if (decision.requestId !== req.requestId || decision.participantId !== req.participantId || decision.displayName !== req.displayName
      || decision.tenantId !== fresh.room.tenantId || decision.roomId !== fresh.room.roomId) return CHANGED;
  } else if (req.mode !== "admit" || req.requestId !== plan.pending.requestId || req.participantId !== plan.pending.participantId
    || req.displayName !== plan.displayName || req.inviteTokenHash !== plan.pending.inviteTokenHash) return CHANGED;
  const outcome = evaluateLegacyAdmission(req, fresh, ctx);
  if (outcome.kind === "session") {
    if (outcome.result.code === "expired_token") throw new LegacyAdmissionDeadlineExpired("bearer");
    return CHANGED;
  }
  if (outcome.kind === "upgrade_required") return CHANGED;
  return plan.mode === "claim_host" ? decideHostClaim(plan, fresh, ctx, outcome) : decidePending(plan, req, fresh, ctx, outcome);
}
