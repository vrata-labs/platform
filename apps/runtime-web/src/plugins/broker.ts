import { ROOM_PLUGIN_LIMITS, validateRoomPluginRequest, type RoomPluginRequest, type RoomPluginResponse } from "@vrata/room-plugin-sdk";
import type { RoomPluginRuntimeBinding } from "./runtime-dto.js";
import type { RoomPluginTokenProof } from "./token-bound.js";
import type { RoomPluginBindingLease } from "./lease.js";
import { RoomPluginRuntimeError } from "./runtime-errors.js";

/** Inputs stay in the main-thread realm. Only serialized SDK requests/responses
 * cross the Worker boundary; no token, binding identity or permission is supplied by a guest. */
export function createRoomPluginBroker(input: {
  binding: RoomPluginRuntimeBinding;
  currentBinding(): RoomPluginRuntimeBinding | null;
  available(): boolean;
  proof(): RoomPluginTokenProof | null;
  lease: RoomPluginBindingLease;
  status(text: string): void;
  clock?: () => number;
}) {
  const clock = input.clock ?? (() => performance.now());
  let requestTimes: number[] = [], statusTimes: number[] = [], lastNow = -Infinity;
  return (raw: RoomPluginRequest, signal: AbortSignal, canCommit: () => boolean = () => true): RoomPluginResponse => {
    let request: RoomPluginRequest;
    try { request = validateRoomPluginRequest(raw); } catch { throw new RoomPluginRuntimeError("host-unavailable"); }
    const denied = (error: Extract<RoomPluginResponse, { ok: false }>["error"]): RoomPluginResponse =>
      ({ sdkApiVersion: 1, requestId: request.requestId, ok: false, error });
    if (signal.aborted || !canCommit()) return denied("cancelled");
    const binding = input.currentBinding(), expected = input.binding;
    if (!binding || binding.bindingId !== expected.bindingId || binding.generation !== expected.generation
      || binding.bindingRevision !== expected.bindingRevision || binding.artifactSha256 !== expected.artifactSha256) return denied("stale-generation");
    if (!input.available()) return denied("offline");
    const now = clock();
    if (!Number.isFinite(now) || now < 0 || now < lastNow) throw new RoomPluginRuntimeError("host-unavailable");
    lastNow = now;
    const proof = input.proof();
    if (!proof || now >= proof.deadlineMs) return denied("lease-expired");
    if (!binding.approvedCapabilities.includes(request.operation) || !expected.approvedCapabilities.includes(request.operation)) return denied("capability-denied");
    if (!input.lease.authorize(binding, request.operation)) return denied("lease-expired");
    const permit = input.lease.authorize(expected, request.operation);
    if (!permit || !input.lease.isCurrent(permit)) return denied("lease-expired");
    requestTimes = requestTimes.filter(time => now - time < 1000); statusTimes = statusTimes.filter(time => now - time < 1000);
    if (requestTimes.length >= ROOM_PLUGIN_LIMITS.requestsPerSecond
      || request.operation === "status.set" && statusTimes.length >= ROOM_PLUGIN_LIMITS.statusUpdatesPerSecond) return denied("quota-exceeded");
    requestTimes.push(now);
    // The actual correlated self-seat adapter arrives in T09. Never simulate an
    // accepted claim/cancel merely because an artifact requested the capability.
    if (request.operation !== "status.set") return denied("capability-denied");
    statusTimes.push(now);
    if (signal.aborted || !canCommit() || !input.available() || !input.lease.isCurrent(permit) || !input.proof()) return denied("lease-expired");
    try { input.status(request.payload.text); } catch { throw new RoomPluginRuntimeError("host-unavailable"); }
    return { sdkApiVersion: 1, requestId: request.requestId, ok: true, result: null };
  };
}
