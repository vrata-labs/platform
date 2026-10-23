import type { ManagedMediaControl } from "./managed-media.js";
import { managedMediaRoomName } from "./managed-media-names.js";
import { managedRoomBlock } from "./storage-managed-rooms.js";
import type { ManagedRoomEnforcementRecord, RoomRecord, Storage } from "./storage-contracts.js";

const DEFAULT_INTERVAL_MS = 10_000;
const KICK_DELAY_MS = 50;

export interface ManagedRoomEnforcerInput {
  storage: Promise<Storage>;
  media(): ManagedMediaControl | null;
  mediaPrefix(): string;
  logEvent(event: Record<string, unknown>): void;
  intervalMs?: number;
  now?: () => number;
}

/**
 * Access enforcement of portal-managed rooms that does not depend on the portal (contract section 8).
 * Room-state sockets close on their own within a second, because every socket re-verifies its session
 * and the verify endpoint refuses withdrawn rooms. This loop ends media and demo instances:
 * - a newly withdrawn room (cutoff, pause, close) or a revoked grant moves to a new access epoch, and the
 *   LiveKit room of the old epoch is deleted, retried every tick while LiveKit is unavailable;
 * - a demo instance without anybody connected for its idle timeout is closed;
 * - room-state verifications are counted as presence: the last activity of a room and participant-seconds.
 * Enforcement runs in one API process at a time (advisory lock); every process flushes its own observations.
 */
export function createManagedRoomEnforcer(input: ManagedRoomEnforcerInput) {
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
  const observed = new Map<string, { tenantId: string; identities: Set<string> }>();
  // Fractions of a participant-second carried to the next flush, per room.
  const carried = new Map<string, number>();
  let flushedAtMs = now();
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = true;
  let mediaUnavailableLogged = false;

  function observe(room: RoomRecord, identityId: string): void {
    if (!room.managed) return;
    let entry = observed.get(room.roomId);
    if (!entry) {
      entry = { tenantId: room.tenantId, identities: new Set() };
      observed.set(room.roomId, entry);
    }
    entry.identities.add(identityId);
  }

  async function flushActivity(storage: Storage): Promise<void> {
    const atMs = now();
    // A gap longer than two intervals (a stalled process) is not billed as presence.
    const seconds = Math.min(atMs - flushedAtMs, intervalMs * 2) / 1000;
    flushedAtMs = atMs;
    const activity = [...observed.entries()].map(([roomId, entry]) => {
      const total = (carried.get(roomId) ?? 0) + entry.identities.size * seconds;
      const whole = Math.floor(total);
      carried.set(roomId, total - whole);
      return { roomId, tenantId: entry.tenantId, participantSeconds: whole };
    });
    for (const roomId of carried.keys()) if (!observed.has(roomId)) carried.delete(roomId);
    observed.clear();
    await storage.recordManagedRoomActivity(activity);
  }

  async function deleteRetired(storage: Storage, room: ManagedRoomEnforcementRecord, namespace: string | null): Promise<void> {
    if (room.retiredEpochs.length === 0) return;
    // Before identity v2 is active no managed media room was ever created.
    if (!namespace) {
      for (const epoch of room.retiredEpochs) await storage.completeRetiredManagedRoomEpoch(room.roomId, epoch);
      return;
    }
    const media = input.media();
    if (!media) {
      if (!mediaUnavailableLogged) input.logEvent({ service: "api", event: "managed_media_control_unavailable", roomId: room.roomId });
      mediaUnavailableLogged = true;
      return;
    }
    for (const epoch of room.retiredEpochs) {
      const name = managedMediaRoomName(room.roomId, epoch, input.mediaPrefix(), namespace);
      try {
        await media.deleteRoom(name);
        await storage.completeRetiredManagedRoomEpoch(room.roomId, epoch);
        input.logEvent({ service: "api", event: "managed_media_epoch_deleted", roomId: room.roomId });
      } catch (error) {
        input.logEvent({ service: "api", event: "managed_media_delete_failed", alert: true, roomId: room.roomId, message: error instanceof Error ? error.message : "unknown" });
      }
    }
  }

  async function enforce(storage: Storage): Promise<void> {
    const namespace = await storage.identityProtocol.mediaNamespace();
    for (const room of await storage.listManagedRoomsForEnforcement()) {
      const atMs = now();
      const block = managedRoomBlock({ status: room.status, cutoffMs: Date.parse(room.cutoff) }, atMs);
      if (room.rotateRequestedAt !== null || (block !== null && room.enforcedBlock === null)) {
        const epoch = await storage.rotateManagedRoomEpoch(room.roomId, room.accessEpoch, block);
        if (epoch) {
          room.retiredEpochs.push(room.accessEpoch);
          input.logEvent({ service: "api", event: "managed_room_epoch_rotated", roomId: room.roomId, block, revoked: room.rotateRequestedAt !== null });
        }
      } else if (block !== room.enforcedBlock) {
        await storage.setManagedRoomEnforcedBlock(room.roomId, block);
      }
      await deleteRetired(storage, room, namespace);
      if (room.kind === "demo-instance" && block === null && room.idleTimeoutSeconds) {
        const lastActivityMs = Math.max(Date.parse(room.lastActivityAt ?? room.createdAt), Date.parse(room.createdAt));
        if (atMs - lastActivityMs >= room.idleTimeoutSeconds * 1000) {
          const closed = await storage.closeManagedRoom(room.roomId, room.revision, "idle", null);
          if (closed && closed !== "revision_mismatch") {
            input.logEvent({ service: "api", event: "managed_room_idle_closed", roomId: room.roomId });
            again = true;
          }
        }
      }
    }
  }

  async function tick(): Promise<void> {
    const storage = await input.storage;
    try {
      await flushActivity(storage);
    } catch (error) {
      input.logEvent({ service: "api", event: "managed_room_activity_failed", message: error instanceof Error ? error.message : "unknown" });
    }
    try {
      await storage.withManagedRoomEnforcerLock(() => enforce(storage));
    } catch (error) {
      input.logEvent({ service: "api", event: "managed_room_enforcement_failed", alert: true, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
    timer.unref();
  }

  function run(): void {
    timer = null;
    if (running) {
      again = true;
      return;
    }
    again = false;
    running = tick().finally(() => {
      running = null;
      schedule(again ? KICK_DELAY_MS : intervalMs);
    });
  }

  return {
    observe,
    /** Enforce soon, after a change that withdraws access. */
    kick(): void {
      if (running) again = true;
      else schedule(KICK_DELAY_MS);
    },
    start(): void {
      if (!stopped) return;
      stopped = false;
      flushedAtMs = now();
      schedule(intervalMs);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
    /** One pass now; for tests and operator tooling. */
    async runOnce(): Promise<void> {
      await tick();
    }
  };
}
