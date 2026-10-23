import type { LegacyAdmissionWriteInput, LegacyAdmissionWriteReceipt, LegacyRoomCredentialSnapshot, RoomInviteRecord,
  WaitingRoomRequestRecord } from "../storage-contracts.js";
import {
  assertLegacyAdmissionPlanDeadlines, LegacyAdmissionWriteInvariant, narrowLegacyDeadline,
  type LegacyAdmissionDeadline, type LegacyDeadlineKind
} from "./legacy-admission-write.js";
import { captureLegacyCredentialRelease, type LegacyCredentialReleaseGuard } from "./legacy-credential-release.js";

const invalidDeadline = () => new LegacyAdmissionWriteInvariant("invalid_legacy_admission_deadline");
const invalidPlan = () => new LegacyAdmissionWriteInvariant("invalid_legacy_admission_plan");

/** The two leases every write moment is checked against: frozen store copies, never the caller's objects. */
export interface LegacyWriteLeases {
  readonly deadline: LegacyAdmissionDeadline | null;
  readonly presentedBearerDeadline: LegacyAdmissionDeadline | null;
}

export interface LegacyAdmissionWriteGuard extends LegacyCredentialReleaseGuard {
  readonly mode: "claim_host" | "pending";
  readonly displayName: string | null;
  readonly leases: LegacyWriteLeases;
  readonly decide: LegacyAdmissionWriteInput["decide"];
}

function lease(value: unknown, kinds: readonly LegacyDeadlineKind[]): LegacyAdmissionDeadline | null {
  if (value === null) return null;
  if (typeof value !== "object") throw invalidDeadline();
  const { expiresAtMs, kind } = value as LegacyAdmissionDeadline;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 || !kinds.includes(kind)) throw invalidDeadline();
  return Object.freeze({ expiresAtMs, kind });
}

const timeout = (value: unknown) => value === undefined || Number.isSafeInteger(value);

/** Copies every primitive, both leases and the callback before the first wait; caller mutation cannot widen the write. */
export function captureLegacyAdmissionWrite(input: unknown, options: unknown): LegacyAdmissionWriteGuard {
  if (typeof input !== "object" || input === null) throw invalidPlan();
  const { selector, mode, deadline, presentedBearerDeadline, displayName, decide } = input as LegacyAdmissionWriteInput;
  if ((mode !== "claim_host" && mode !== "pending") || typeof decide !== "function"
    || !(typeof displayName === "string" || (mode === "claim_host" && displayName === null))) throw invalidPlan();
  const scope = captureLegacyCredentialRelease(selector, options, decide);
  if (!timeout(scope.lockTimeoutMs) || !timeout(scope.idleTimeoutMs)) throw invalidPlan();
  const leases: LegacyWriteLeases = Object.freeze({
    deadline: lease(deadline, mode === "pending" ? ["invite"] : ["bearer", "invite"]),
    presentedBearerDeadline: lease(presentedBearerDeadline, ["bearer"])
  });
  // A waiting request is only ever planned under its invite's lease.
  if (mode === "pending" && leases.deadline === null) throw invalidDeadline();
  return Object.freeze({ ...scope, mode, displayName, leases, decide });
}

/** The pure plan contract reads only these two leases: the earlier lapse answers and a tie is the bearer's. */
export function assertLegacyWriteLeases(leases: LegacyWriteLeases, nowMs: number): void {
  assertLegacyAdmissionPlanDeadlines(leases, nowMs);
}

export type LegacyHostSeat = "vacant" | "subject" | "occupied" | "malformed";

/** Vacancy is the store's own reading of the raw control: an absent, null or empty host. A non-object is never stomped. */
export function legacyHostSeat(controlIsObject: boolean, host: unknown, participantId: string): LegacyHostSeat {
  if (!controlIsObject) return "malformed";
  if (host === undefined || host === null || host === "") return "vacant";
  return host === participantId ? "subject" : "occupied";
}

/** The memory store's raw control: absent reads as {}, any other non-object is malformed. */
export function rawLegacyHostSeat(control: unknown, participantId: string): LegacyHostSeat {
  const raw = control ?? {};
  const isObject = typeof raw === "object" && !Array.isArray(raw);
  return legacyHostSeat(isObject, isObject ? (raw as { hostParticipantId?: unknown }).hostParticipantId : undefined, participantId);
}

/** Store-owned facts read before the callback; no identifier is ever taken from its returned value. */
export interface LegacyWritePins {
  readonly seat: LegacyHostSeat;
  readonly inviteId: string | null;
  readonly inviteExpiresAtMs: number | null;
  readonly waitingRequestId: string | null;
  readonly waitingPending: boolean;
}

export function legacyWritePins(seat: LegacyHostSeat, invite: RoomInviteRecord | null, waiting: WaitingRoomRequestRecord | null): LegacyWritePins {
  const expiresAtMs = invite ? Date.parse(invite.expiresAt) : Number.NaN;
  return Object.freeze({ seat, inviteId: invite?.inviteId ?? null,
    inviteExpiresAtMs: Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null,
    waitingRequestId: waiting?.requestId ?? null, waitingPending: waiting?.status === "pending" });
}

export type LegacyWriteIntent =
  | { readonly kind: "set_host" }
  | { readonly kind: "host_current" }
  | { readonly kind: "insert_pending"; readonly inviteId: string }
  | { readonly kind: "pending_current"; readonly accessRequestId: string }
  | { readonly kind: "refused"; readonly reason: string; readonly accessRequestId: string | null }
  | { readonly kind: "changed" };

const FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  set_host: ["write"], none_host_current: ["write"], insert_pending: ["write"], none_pending: ["write", "accessRequestId"],
  refuse: ["write", "status", "reason", "accessRequestId"], changed: ["write", "status", "reason"]
});
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const SET_HOST = Object.freeze({ kind: "set_host" } as const);
const HOST_CURRENT = Object.freeze({ kind: "host_current" } as const);
const CHANGED = Object.freeze({ kind: "changed" } as const);

/** Runs the trusted pure callback once on fresh clones and closes its answer over the store's pins. A shape outside
 * the mode's closed family is a wiring fault; drift the store itself observes is room_state_changed. After a lost
 * natural-key race the redecision never inserts again. */
export function decideLegacyWrite(guard: LegacyAdmissionWriteGuard, fresh: LegacyRoomCredentialSnapshot, atMs: number,
  pins: LegacyWritePins, redecided: boolean): LegacyWriteIntent {
  const { decide } = guard;
  const value: unknown = decide(fresh, atMs);
  if (typeof value !== "object" || value === null || typeof (value as { then?: unknown }).then === "function") throw invalidPlan();
  const { write, status, reason, accessRequestId } = value as Record<string, unknown>;
  const fields = typeof write === "string" && Object.hasOwn(FIELDS, write) ? FIELDS[write] : undefined;
  if (!fields || !Object.keys(value).every(key => fields.includes(key))) throw invalidPlan();
  const host = guard.mode === "claim_host";
  switch (write) {
    case "set_host":
      if (!host) throw invalidPlan();
      return pins.seat === "vacant" ? SET_HOST : CHANGED;
    case "none_host_current":
      if (!host) throw invalidPlan();
      return pins.seat === "subject" ? HOST_CURRENT : CHANGED;
    case "insert_pending":
      if (host || pins.inviteId === null || pins.waitingRequestId !== null) throw invalidPlan();
      return redecided ? CHANGED : Object.freeze({ kind: "insert_pending", inviteId: pins.inviteId } as const);
    case "none_pending":
      // Only the row this transaction pinned, and only while it is still pending.
      if (host || pins.waitingRequestId === null || !pins.waitingPending || accessRequestId !== pins.waitingRequestId) throw invalidPlan();
      return Object.freeze({ kind: "pending_current", accessRequestId: pins.waitingRequestId } as const);
    case "refuse":
      if (status !== 403 || typeof reason !== "string" || !REASON.test(reason)
        || (accessRequestId !== undefined && (pins.waitingRequestId === null || accessRequestId !== pins.waitingRequestId))) throw invalidPlan();
      return Object.freeze({ kind: "refused", reason, accessRequestId: accessRequestId === undefined ? null : pins.waitingRequestId } as const);
    default:
      if (status !== 409 || reason !== "room_state_changed") throw invalidPlan();
      return CHANGED;
  }
}

/** Narrows an invite lease to the pinned invite's expiry, never past the original. A refusal or drift beside an absent
 * or unparsable invite keeps the original lease, still checked; an allowed intent without one is a fault. */
export function effectiveLegacyLeases(guard: LegacyAdmissionWriteGuard, intent: LegacyWriteIntent, pins: LegacyWritePins): LegacyWriteLeases {
  const { deadline, presentedBearerDeadline } = guard.leases;
  if (deadline?.kind !== "invite") return guard.leases;
  if (pins.inviteExpiresAtMs === null) {
    if (intent.kind === "refused" || intent.kind === "changed") return guard.leases;
    throw invalidDeadline();
  }
  return Object.freeze({ deadline: narrowLegacyDeadline(deadline, { kind: "invite", expiresAtMs: pins.inviteExpiresAtMs }), presentedBearerDeadline });
}

export const LEGACY_HOST_READY: LegacyAdmissionWriteReceipt = Object.freeze({ kind: "host_ready" } as const);
export const LEGACY_WRITE_CHANGED: LegacyAdmissionWriteReceipt = Object.freeze({ kind: "changed" } as const);

export function legacyPendingReceipt(accessRequestId: string, created: boolean): LegacyAdmissionWriteReceipt {
  return Object.freeze({ kind: "pending", accessRequestId, created } as const);
}

/** The receipt for an intent that writes nothing. A refusal carries its own fresh clones, never the callback's. */
export function unwrittenLegacyReceipt(intent: LegacyWriteIntent, fresh: () => LegacyRoomCredentialSnapshot): LegacyAdmissionWriteReceipt {
  switch (intent.kind) {
    case "host_current": return LEGACY_HOST_READY;
    case "pending_current": return legacyPendingReceipt(intent.accessRequestId, false);
    case "refused": {
      const refused = { kind: "refused", status: 403, reason: intent.reason, fresh: fresh() } as const;
      return Object.freeze(intent.accessRequestId === null ? refused : { ...refused, accessRequestId: intent.accessRequestId });
    }
    case "changed": return LEGACY_WRITE_CHANGED;
    default: throw invalidPlan();
  }
}
