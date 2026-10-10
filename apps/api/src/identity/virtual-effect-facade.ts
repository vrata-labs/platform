import type { RoomEffectDatabase, VirtualRoomEffectOptions, VirtualRoomEffectStorage } from "../storage-contracts.js";
import { validId } from "./authority.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";

/** Capture original primitives before any wait; caller mutation cannot widen the fence. */
export interface VirtualRoomEffectGuard {
  readonly roomId: string;
  readonly roomWrite: boolean;
  readonly pinAbsence: boolean;
  readonly expiresAtMs: number | null;
  readonly lockTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/** A room id the virtual namespace can never hold. Parameterless: it carries no request value. */
export class InvalidVirtualRoomId extends Error {
  constructor() { super("room_not_found"); this.name = "InvalidVirtualRoomId"; }
}

export function assertVirtualRoomId(roomId: unknown): asserts roomId is string {
  if (!validId(roomId)) throw new InvalidVirtualRoomId();
}

export function captureVirtualRoomGuard(roomId: unknown, options: unknown): VirtualRoomEffectGuard {
  assertVirtualRoomId(roomId);
  if (typeof options !== "object" || options === null) throw new Error("invalid_virtual_room_effect");
  const { roomWrite, pinAbsence, expiresAtSeconds, lockTimeoutMs, idleTimeoutMs } = options as VirtualRoomEffectOptions;
  const write = roomWrite === true;
  const pin = pinAbsence === true;
  if (write && pin) throw new Error("invalid_virtual_room_effect");
  if (expiresAtSeconds !== undefined && (typeof expiresAtSeconds !== "number" || !Number.isSafeInteger(expiresAtSeconds)
    || expiresAtSeconds < 1 || !Number.isSafeInteger(expiresAtSeconds * 1000))) {
    throw new IdentityBoundaryError(401, "identity_session_expired");
  }
  return Object.freeze({ roomId, roomWrite: write, pinAbsence: pin, lockTimeoutMs, idleTimeoutMs,
    expiresAtMs: expiresAtSeconds === undefined ? null : expiresAtSeconds * 1000 });
}

export function assertVirtualRoomDeadline(guard: VirtualRoomEffectGuard, nowMs: number): void {
  if (guard.expiresAtMs !== null && (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= guard.expiresAtMs)) {
    throw new IdentityBoundaryError(401, "identity_session_expired");
  }
}

/** Writes require a final check before commit and cannot release a response.
 * Read mode has at most one release; pin mode must release exactly once and
 * admits no telemetry. Unawaited SQL is drained and rejects the call so it
 * cannot run after the transaction has ended. */
export async function runVirtualRoomEffect<T>(telemetry: Pick<RoomEffectDatabase, "addDiagnostic" | "addXrTelemetry">,
  guard: VirtualRoomEffectGuard, check: () => void, effect: (scoped: VirtualRoomEffectStorage) => Promise<T>): Promise<T> {
  let released = false;
  let closed = false;
  const pending = new Set<Promise<void>>();
  const invoke = <R>(target: string, write: boolean, operation: () => R): R => {
    if (closed) throw new Error("room_effect_scope_closed");
    check();
    if (released) throw new Error("room_effect_response_released");
    if (write && !guard.roomWrite) throw new Error("room_write_fence_required");
    if (!write && guard.roomWrite) throw new Error("virtual_room_release_requires_read_fence");
    if (target !== guard.roomId) throw new Error("room_effect_room_mismatch");
    return operation();
  };
  const write = (target: string, operation: () => Promise<void>): Promise<void> => invoke(target, true, () => {
    const running = operation();
    const settle = () => { pending.delete(running); };
    pending.add(running);
    running.then(settle, settle);
    return running;
  });
  const scoped: VirtualRoomEffectStorage = Object.freeze({
    addDiagnostic: (roomId, payload) => write(roomId, () => telemetry.addDiagnostic(guard.roomId, payload)),
    addXrTelemetry: (roomId, participantId, payload) => write(roomId, () => telemetry.addXrTelemetry(guard.roomId, participantId, payload)),
    releaseResponse: send => invoke(guard.roomId, false, () => { released = true; send(); })
  });
  let leaked = false;
  let result: T;
  try { result = await effect(scoped); }
  finally {
    closed = true;
    leaked = pending.size > 0;
    if (leaked) await Promise.allSettled([...pending]);
  }
  if (leaked) throw new Error("room_effect_write_pending");
  if (guard.pinAbsence && !released) throw new Error("virtual_room_release_required");
  if (!released) check();
  return result;
}
