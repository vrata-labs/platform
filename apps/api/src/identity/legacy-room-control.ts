import { isRoomRole, type RoomRole } from "@vrata/shared-types";
import type { RoomSessionRoleSource } from "@vrata/shared-types/session-token";
import type { LegacyRoomEffectOptions, RoomSessionControlState } from "../storage-contracts.js";
import { validId } from "./authority.js";
import { assertLegacyDeadline, type LegacyAdmissionDeadline } from "./legacy-admission-write.js";

export const LEGACY_CONTROL_ADMIN_ID = "control-plane-admin";

/** The administrator token, or a floor-1 MAC's verified claims with its own signed expiry (kind bearer). */
export type LegacyControlActor =
  | { readonly kind: "admin"; readonly actorId: "control-plane-admin" }
  | { readonly kind: "session"; readonly tenantId: string; readonly roomId: string; readonly participantId: string; readonly role: RoomRole;
    readonly roleSource: RoomSessionRoleSource; readonly lease: LegacyAdmissionDeadline };

/** The closed family of the seven legacy session-control routes; `reason` is the route's normalized value (≤120) or null. */
export type LegacyRoomControlCommand =
  | { readonly type: "lock" | "unlock" | "end" }
  | { readonly type: "remove"; readonly targetParticipantId: string; readonly reason: string | null }
  | { readonly type: "grant-presenter" | "revoke-presenter" | "transfer-host"; readonly targetParticipantId: string };

/** Live room presence: synchronous and boolean only; never a public SDK callback. */
export type LegacyRoomPresence = (roomId: string, participantId: string) => boolean;

export interface LegacyRoomControlInput {
  readonly scope: { readonly tenantId: string; readonly roomId: string };
  readonly actor: LegacyControlActor;
  readonly command: LegacyRoomControlCommand;
  /** Required for grant-presenter and transfer-host, refused for every other command. */
  readonly presence?: LegacyRoomPresence;
  readonly hostControlsEnabled: boolean;
}

export type LegacyRoomControlOptions = Pick<LegacyRoomEffectOptions, "lockTimeoutMs" | "idleTimeoutMs">;

/** Frozen copies taken before the first wait; only the captured presence function is the caller's own reference. */
export interface LegacyRoomControlGuard {
  readonly tenantId: string;
  readonly roomId: string;
  readonly actor: LegacyControlActor;
  readonly command: LegacyRoomControlCommand;
  readonly presence: LegacyRoomPresence | null;
  readonly hostControlsEnabled: boolean;
  readonly lockTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/** The locked row as stored; `rawControl` is the raw session_control value (memory: undefined when absent). */
export interface LegacyRoomControlSnapshot {
  readonly tenantId: string;
  readonly roomId: string;
  readonly status: string | null;
  readonly disabledAt: unknown;
  readonly rawControl: unknown;
}

/** `patch` carries only the keys its command writes; the store merges it into the current raw column, keeping spare keys. */
export type LegacyRoomControlDecision =
  | { readonly kind: "apply"; readonly patch: Readonly<RoomSessionControlState> }
  | { readonly kind: "refused"; readonly status: 400 | 403 | 404; readonly error: string; readonly reason?: string }
  | { readonly kind: "changed" };

/** A caller or store wiring fault, never a client answer; carries only its fixed code. */
export class LegacyRoomControlInvariant extends Error {
  readonly code = "invalid_legacy_room_control";
  constructor() { super("invalid_legacy_room_control"); this.name = "LegacyRoomControlInvariant"; }
}

type Bag = Record<string, unknown>;
type BlockReason = "room_disabled" | "session_ended" | "participant_removed";
type Removal = NonNullable<RoomSessionControlState["removedParticipants"]>;
interface RawControl { readonly raw: Bag; readonly removed: Bag }

const invalid = () => new LegacyRoomControlInvariant();
/** The largest instant a Date can stamp. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const ROLE_SOURCES: readonly unknown[] = ["default", "dev-query", "trusted"];
const SAMPLED: readonly string[] = ["grant-presenter", "transfer-host"];
const ADMIN: LegacyControlActor = Object.freeze({ kind: "admin", actorId: LEGACY_CONTROL_ADMIN_ID } as const);
const LOCK = Object.freeze({ type: "lock" } as const);
const UNLOCK = Object.freeze({ type: "unlock" } as const);
const END = Object.freeze({ type: "end" } as const);

const isBag = (value: unknown): value is Bag => typeof value === "object" && value !== null && !Array.isArray(value);
const isRoleSource = (value: unknown): value is RoomSessionRoleSource => ROLE_SOURCES.includes(value);
const isReason = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length > 0 && value.length <= 120);
const timeout = (value: unknown) => value === undefined || Number.isSafeInteger(value);
/** Own data only: an inherited `constructor` or `toString` is never a stored fact. */
const own = (bag: Bag, key: string): unknown => Object.hasOwn(bag, key) ? bag[key] : undefined;

function record(value: unknown): Bag {
  if (!isBag(value)) throw invalid();
  return value;
}

/** Exactly the named own keys, optional ones aside: a v2 marker or any extra field is a wiring fault. */
function exact(bag: Bag, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(bag);
  if (!required.every(key => keys.includes(key)) || !keys.every(key => required.includes(key) || optional.includes(key))) throw invalid();
}

function captureLease(value: unknown): LegacyAdmissionDeadline {
  const bag = record(value);
  const { expiresAtMs, kind } = bag;
  exact(bag, ["expiresAtMs", "kind"]);
  if (kind !== "bearer" || typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) throw invalid();
  return Object.freeze({ expiresAtMs, kind: "bearer" as const });
}

function captureActor(value: unknown): LegacyControlActor {
  const bag = record(value);
  const { kind, actorId, tenantId, roomId, participantId, role, roleSource, lease } = bag;
  if (kind === "admin") {
    exact(bag, ["kind", "actorId"]);
    if (actorId !== LEGACY_CONTROL_ADMIN_ID) throw invalid();
    return ADMIN;
  }
  exact(bag, ["kind", "tenantId", "roomId", "participantId", "role", "roleSource", "lease"]);
  // The tenant is the saved catalog key, any string; exact stored equality bounds it at decision time.
  if (kind !== "session" || typeof tenantId !== "string" || !validId(roomId) || !validId(participantId) || !isRoomRole(role)
    || !isRoleSource(roleSource)) throw invalid();
  return Object.freeze({ kind: "session" as const, tenantId, roomId, participantId, role, roleSource, lease: captureLease(lease) });
}

function captureCommand(value: unknown): LegacyRoomControlCommand {
  const bag = record(value);
  const { type, targetParticipantId, reason } = bag;
  if (type === "lock" || type === "unlock" || type === "end") {
    exact(bag, ["type"]);
    return type === "lock" ? LOCK : type === "unlock" ? UNLOCK : END;
  }
  if (!validId(targetParticipantId)) throw invalid();
  if (type === "remove") {
    exact(bag, ["type", "targetParticipantId", "reason"]);
    if (!isReason(reason)) throw invalid();
    return Object.freeze({ type, targetParticipantId, reason });
  }
  exact(bag, ["type", "targetParticipantId"]);
  if (type !== "grant-presenter" && type !== "revoke-presenter" && type !== "transfer-host") throw invalid();
  return Object.freeze({ type, targetParticipantId });
}

/** Copies every primitive, the original lease, the flag, both timeouts and the presence function before the first wait;
 * each field is read once, and caller mutation afterwards cannot widen the scope, subject, command or lease. */
export function captureLegacyRoomControl(input: unknown, options: unknown): LegacyRoomControlGuard {
  const bag = record(input);
  const { scope, actor, command, presence, hostControlsEnabled } = bag;
  exact(bag, ["scope", "actor", "command", "hostControlsEnabled"], ["presence"]);
  const where = record(scope);
  const { tenantId, roomId } = where;
  exact(where, ["tenantId", "roomId"]);
  const { lockTimeoutMs, idleTimeoutMs } = record(options) as LegacyRoomControlOptions;
  if (typeof tenantId !== "string" || !validId(roomId) || typeof hostControlsEnabled !== "boolean" || !timeout(lockTimeoutMs)
    || !timeout(idleTimeoutMs)) throw invalid();
  const subject = captureActor(actor), order = captureCommand(command);
  const sampled = SAMPLED.includes(order.type);
  if (sampled ? typeof presence !== "function" : presence !== undefined) throw invalid();
  return Object.freeze({ tenantId, roomId, actor: subject, command: order, presence: sampled ? presence as LegacyRoomPresence : null,
    hostControlsEnabled, lockTimeoutMs, idleTimeoutMs });
}

function instant(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_DATE_MS) throw invalid();
}

/** The session's original signed expiry against the store's captured instant, at the decision and every write moment
 * (before SQL, after SQL, before COMMIT). A lapse is LegacyAdmissionDeadlineExpired("bearer"); the admin token has none. */
export function assertLegacyControlLease(guard: LegacyRoomControlGuard, nowMs: number): void {
  instant(nowMs);
  assertLegacyDeadline(guard.actor.kind === "session" ? guard.actor.lease : null, nowMs);
}

function refusal(status: 400 | 403 | 404, error: string, reason?: string): LegacyRoomControlDecision {
  return Object.freeze(reason === undefined ? { kind: "refused" as const, status, error } : { kind: "refused" as const, status, error, reason });
}

const FORBIDDEN = refusal(403, "forbidden", "permission_denied");
const SELF = refusal(400, "cannot_remove_self");
const CURRENT_HOST = refusal(403, "cannot_remove_current_host");
const NOT_FOUND = refusal(404, "participant_not_found");
const NO_PRESENTER = refusal(404, "presenter_not_found");
const CHANGED: LegacyRoomControlDecision = Object.freeze({ kind: "changed" } as const);
const BLOCKED: Readonly<Record<BlockReason, LegacyRoomControlDecision>> = Object.freeze({
  room_disabled: refusal(403, "room_access_denied", "room_disabled"),
  session_ended: refusal(403, "room_access_denied", "session_ended"),
  participant_removed: refusal(403, "room_access_denied", "participant_removed")
});

/** The column the store will merge into, as stored: memory's absent control is empty; anything else must be an object
 * whose removal map is absent, null or an object. Otherwise drift, never overwritten with defaults. */
function rawControl(value: unknown): RawControl | null {
  const raw = value === undefined ? {} : value;
  if (!isBag(raw)) return null;
  const removed = own(raw, "removedParticipants") ?? {};
  return isBag(removed) ? { raw, removed } : null;
}

const isRemoved = (control: RawControl, participantId: string) => Boolean(own(control.removed, participantId));

/** getSessionControlBlockReason for an existing host session over the raw row: a lock never blocks it. */
function blockReason(snap: LegacyRoomControlSnapshot, control: RawControl, participantId: string, hostControlsEnabled: boolean): BlockReason | null {
  if (snap.status === "disabled" || Boolean(snap.disabledAt)) return "room_disabled";
  if (!hostControlsEnabled) return null;
  if (own(control.raw, "endedAt")) return "session_ended";
  return isRemoved(control, participantId) ? "participant_removed" : null;
}

const revocation = (at: string, by: string) => ({ presenterParticipantId: null, presenterRevokedAt: at, presenterRevokedBy: by });
/** The presenter trio only when the target is the current presenter. */
const revokedIf = (control: RawControl, target: string, at: string, by: string): RoomSessionControlState =>
  own(control.raw, "presenterParticipantId") === target ? revocation(at, by) : {};

/** The current map's own entries verbatim, then the target's; every key, `__proto__` included, stays an own data key. */
function withRemoval(current: Bag, target: string, entry: Removal[string]): Removal {
  const merged: Bag = {};
  const put = (key: string, value: unknown) => Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
  for (const key of Object.keys(current)) put(key, current[key]);
  put(target, Object.freeze(entry));
  return Object.freeze(merged) as Removal;
}

/** Sampled exactly once, after authority and every stored fact; a thenable or any non-boolean is a wiring fault. */
function present(guard: LegacyRoomControlGuard, participantId: string): boolean {
  const { presence, roomId } = guard;
  if (presence === null) throw invalid();
  const answer: unknown = presence(roomId, participantId);
  if (typeof answer !== "boolean") throw invalid();
  return answer;
}

function apply(patch: RoomSessionControlState): LegacyRoomControlDecision {
  return Object.freeze({ kind: "apply" as const, patch: Object.freeze(patch) });
}

/** Pure decision on the fresh locked row at the store's instant. Order: the original lease, static authority, raw shape,
 * the current seat, the actor's own lifecycle, target facts, and presence last. */
export function reduceLegacyRoomControl(guard: LegacyRoomControlGuard, snap: LegacyRoomControlSnapshot, atMs: number): LegacyRoomControlDecision {
  assertLegacyControlLease(guard, atMs);
  const { tenantId, roomId, status } = snap;
  // The store reads by the guard's own scope; any other row is a store fault, never an answer.
  if (tenantId !== guard.tenantId || roomId !== guard.roomId || (status !== null && typeof status !== "string")) throw invalid();
  const { actor, command } = guard;
  const session = actor.kind === "session" ? actor : null;
  if (session && (session.tenantId !== tenantId || session.roomId !== roomId || session.role !== "host" || session.roleSource !== "trusted")) {
    return FORBIDDEN;
  }
  const control = rawControl(snap.rawControl);
  if (!control) return CHANGED;
  if (session) {
    const host = own(control.raw, "hostParticipantId");
    if (host && host !== session.participantId) return FORBIDDEN;
    const blocked = blockReason(snap, control, session.participantId, guard.hostControlsEnabled);
    if (blocked) return BLOCKED[blocked];
  }
  const at = new Date(atMs).toISOString(), by = session ? session.participantId : LEGACY_CONTROL_ADMIN_ID;
  switch (command.type) {
    case "lock": return apply({ lockedAt: at, lockedBy: by });
    case "unlock": return apply({ lockedAt: null, lockedBy: null });
    case "end": return apply({ endedAt: at, endedBy: by, ...revocation(at, by) });
    case "remove": {
      const target = command.targetParticipantId;
      if (session?.participantId === target) return SELF;
      // Unreachable for an authorized session (the seat is its own), kept as the legacy answer.
      if (session && own(control.raw, "hostParticipantId") === target) return CURRENT_HOST;
      return apply({ ...revokedIf(control, target, at, by),
        removedParticipants: withRemoval(control.removed, target, { removedAt: at, removedBy: by, reason: command.reason }) });
    }
    case "grant-presenter": {
      const target = command.targetParticipantId;
      if (isRemoved(control, target) || !present(guard, target)) return NOT_FOUND;
      return apply({ presenterParticipantId: target, presenterGrantedAt: at, presenterGrantedBy: by, presenterRevokedAt: null, presenterRevokedBy: null });
    }
    case "revoke-presenter": {
      const target = command.targetParticipantId;
      if (isRemoved(control, target)) return NOT_FOUND;
      return own(control.raw, "presenterParticipantId") === target ? apply(revocation(at, by)) : NO_PRESENTER;
    }
    case "transfer-host": {
      const target = command.targetParticipantId;
      if (isRemoved(control, target) || !present(guard, target)) return NOT_FOUND;
      return apply({ ...revokedIf(control, target, at, by), hostParticipantId: target });
    }
  }
}
