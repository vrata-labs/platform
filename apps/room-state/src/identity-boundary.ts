import { IDENTITY_UPGRADE_CLOSE_CODE } from "@vrata/shared-types";
import type { RawData, WebSocket } from "ws";

export interface IdentityProtocolPolicy { minimumProtocolVersion: number; roomRequiresV2: boolean }
export type ReadIdentityProtocolPolicy = (roomId: string) => Promise<IdentityProtocolPolicy>;
export interface IdentityBoundaryDenial { code: number; reason: string; queuedMessages: number; queuedBytes: number; errorKind?: string }

export function createIdentityProtocolReader(input: { baseUrl: string; internalToken?: string | null; fetch?: typeof fetch }): ReadIdentityProtocolPolicy {
  let minimum = 1;
  return async roomId => {
    if (minimum >= 2) return { minimumProtocolVersion: minimum, roomRequiresV2: false };
    const url = new URL("/api/internal/identity-policy", input.baseUrl);
    url.searchParams.set("roomId", roomId);
    const response = await (input.fetch ?? fetch)(url, {
      headers: input.internalToken ? { "x-vrata-internal-token": input.internalToken } : {},
      signal: AbortSignal.timeout(5000), cache: "no-store"
    });
    if (!response.ok) throw new Error("identity_authority_unavailable");
    const policy = await response.json() as IdentityProtocolPolicy;
    if (!policy || !Number.isSafeInteger(policy.minimumProtocolVersion) || policy.minimumProtocolVersion < 1 || typeof policy.roomRequiresV2 !== "boolean") {
      throw new Error("identity_authority_unavailable");
    }
    // A late response from before activation cannot lower the observed floor.
    minimum = Math.max(minimum, policy.minimumProtocolVersion);
    return { minimumProtocolVersion: minimum, roomRequiresV2: policy.roomRequiresV2 };
  };
}

const maxQueuedBytes = 256 * 1024;
const maxQueuedMessages = 128;
const bytes = (raw: RawData) => Array.isArray(raw) ? raw.reduce((sum, buffer) => sum + buffer.byteLength, 0) : raw.byteLength;
function isPoseMessage(raw: RawData): boolean {
  try { return ["participant_update", "avatar_reliable_state", "avatar_pose_preview"].includes(JSON.parse(String(raw))?.type); }
  catch { return false; }
}

/** Keeps a rollback server from accepting legacy writes after activation. */
export function guardLegacySocket(input: {
  socket: WebSocket; roomId: string; readPolicy: ReadIdentityProtocolPolicy;
  admit(): void; dispatch(raw: RawData): void; pollIntervalMs?: number; onDenied?(event: IdentityBoundaryDenial): void;
}): void {
  const { socket } = input;
  const queue: RawData[] = [];
  let queuedBytes = 0, admitted = false, disposed = false, draining = false, polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const open = () => !disposed && socket.readyState === socket.OPEN;
  const dispose = () => {
    disposed = true; queue.length = 0; queuedBytes = 0;
    if (timer) clearInterval(timer);
  };
  const close = (code: number, reason: string, errorKind?: string) => {
    const event = { code, reason, queuedMessages: queue.length, queuedBytes, ...(errorKind ? { errorKind } : {}) };
    dispose();
    try { input.onDenied?.(event); } catch { /* Logging must not prevent denial. */ }
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  };
  const check = async () => {
    try {
      const policy = await input.readPolicy(input.roomId);
      if (!open()) return false;
      if (policy.minimumProtocolVersion >= 2 || policy.roomRequiresV2) {
        close(IDENTITY_UPGRADE_CLOSE_CODE, "identity_upgrade_required"); return false;
      }
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      if (open()) close(1013, "identity_authority_unavailable", ["AbortError", "TimeoutError", "TypeError", "Error"].includes(name) ? name : "unknown");
      return false;
    }
  };
  const drain = async () => {
    if (draining || !admitted) return;
    draining = true;
    try {
      while (queue.length && open()) {
        const raw = queue.shift()!;
        queuedBytes -= bytes(raw);
        // Pose traffic has a bounded session lease. Every effect-bearing command
        // performs a fresh policy read; it never reuses a cached protocol-1 result.
        if (!isPoseMessage(raw) && !await check()) break;
        if (open()) input.dispatch(raw);
      }
    } catch {
      if (open()) close(1011, "room_state_command_failed");
    } finally { draining = false; }
  };
  socket.on("message", raw => {
    if (!open()) return;
    const size = bytes(raw);
    if (size > maxQueuedBytes || queue.length >= maxQueuedMessages || queuedBytes + size > maxQueuedBytes) {
      close(1009, "room_state_queue_limit"); return;
    }
    queue.push(raw); queuedBytes += size;
    void drain();
  });
  socket.once("close", dispose);
  void (async () => {
    if (!await check() || !open()) return;
    try { input.admit(); } catch { close(1008, "room_template_context_mismatch"); return; }
    if (!open()) return;
    admitted = true;
    timer = setInterval(() => {
      if (polling || !open()) return;
      polling = true;
      void check().finally(() => { polling = false; });
    }, input.pollIntervalMs ?? 1000);
    timer.unref();
    await drain();
  })();
}
