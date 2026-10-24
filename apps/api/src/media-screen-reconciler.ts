import type { ParticipantInfo, ParticipantPermission, RoomServiceClient } from "livekit-server-sdk";
import { createHash } from "node:crypto";
import type { RoomScreenSourceAuthority } from "./identity/contracts.js";
import { roomMediaGrantName } from "./identity/media-room.js";
import { validId } from "./identity/authority.js";
import { parseMediaRoomName } from "./managed-media-names.js";
import { mustEvictUserMedia, screenSourceLowering, screenSourcesRetired, verifiedSourcePeer } from "./media-source-permissions.js";

export const MEDIA_RECONCILIATION_VERSION = 2;

export interface MediaScreenAuthority {
  readonly tenantId: string | null;
  readonly authority: RoomScreenSourceAuthority | null;
}
export interface MediaScreenReconciliationStatus {
  enforcementVersion: typeof MEDIA_RECONCILIATION_VERSION;
  state: "pending" | "observed" | "unavailable";
  desiredVersion: { authorityRevision: number | null; roomActive: boolean | null };
  observedAtMs: number | null;
  nativeRoom: "unknown" | "present" | "absent";
}
type NativeRooms = Pick<RoomServiceClient, "listRooms" | "listParticipants" | "removeParticipant"> & {
  updateParticipant(room: string, identity: string, input: { permission: Partial<ParticipantPermission> }): Promise<ParticipantInfo>;
};
type Context = { namespace: string; prefix: string; native: NativeRooms };
type Observation = { fingerprint: string; atMs: number; nativeRoom: "present" | "absent" };

const version = (value: MediaScreenAuthority) => ({ authorityRevision: value.authority?.revision ?? null,
  roomActive: value.authority?.roomActive ?? false });
const authorityFingerprint = (namespace: string, value: MediaScreenAuthority) => JSON.stringify([namespace, value.tenantId,
  version(value), value.authority?.publisherParticipantIds ?? [],
  createHash("sha256").update(JSON.stringify(value.authority?.removedParticipantIds ?? [])).digest("hex")]);
const fingerprint = (namespace: string, value: MediaScreenAuthority) => JSON.stringify([
  authorityFingerprint(namespace, value), value.authority?.observationVersion ?? null
]);

/** Reconstruct desired state from durable authority, not a process-local transition queue.
 * Permission writes use the fixed class lowering; public removal and inactive rooms
 * disconnect verified user connections instead. Delayed operations may over-restrict
 * a renewed/re-enabled connection, never expand its signed source ceiling. */
export function createMediaScreenReconciler(input: {
  context: () => Promise<Context | null>;
  authority: (roomId: string) => Promise<MediaScreenAuthority>;
  /** The current LiveKit room of a platform room; portal-managed rooms add their access epoch. */
  mediaRoomName?: (roomId: string, prefix: string, namespace: string) => Promise<string>;
  event?: (event: "observed" | "pending" | "unavailable" | "lowered" | "evicted") => void;
  now?: () => number;
  intervalMs?: number;
  maxRooms?: number;
  maxPeers?: number;
  maxObservations?: number;
  passBudgetMs?: number;
}) {
  const now = input.now ?? Date.now;
  const intervalMs = input.intervalMs ?? 1000, maxRooms = input.maxRooms ?? 32, maxPeers = input.maxPeers ?? 128;
  const maxObservations = input.maxObservations ?? 4096;
  const passBudgetMs = input.passBudgetMs ?? 10_000;
  for (const value of [intervalMs, maxRooms, maxPeers, maxObservations, passBudgetMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_media_screen_reconciler_limits");
  }
  const observations = new Map<string, Observation>();
  const peerCursors = new Map<string, number>();
  const interests = new Map<string, number>();
  let interestSequence = 0;
  let namespace: string | null = null, unavailable = false, roomCursor = 0;
  let generation = 0, stopped = false, started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingPass: Promise<void> | null = null;
  const trackInterest = (roomId: string) => {
    // Updating a value preserves FIFO order; a frequent reader must not move itself
    // behind the next scan forever. Versions retain requests received during an await.
    interests.set(roomId, ++interestSequence);
    while (interests.size > maxObservations) interests.delete(interests.keys().next().value!);
  };
  const record = (roomId: string, observation: Observation) => {
    observations.delete(roomId); observations.set(roomId, observation);
    while (observations.size > maxObservations) observations.delete(observations.keys().next().value!);
  };
  const invalidate = (roomId: string) => { observations.delete(roomId); };
  const alive = (captured: number) => !stopped && generation === captured;
  const emit = (event: Parameters<NonNullable<typeof input.event>>[0]) => {
    try { input.event?.(event); } catch { /* Diagnostics cannot interrupt enforcement or escape raw errors. */ }
  };

  async function reconcileRoom(context: Context, roomId: string, nativeRoom: string, captured: number, deadline: number): Promise<void> {
    invalidate(roomId);
    try {
      const desired = await input.authority(roomId);
      if (!alive(captured)) return;
      const key = fingerprint(context.namespace, desired);
      const authorityKey = authorityFingerprint(context.namespace, desired);
      const peers = await context.native.listParticipants(nativeRoom);
      if (!alive(captured)) return;
      peers.sort((a, b) => a.identity.localeCompare(b.identity));
      const start = (peerCursors.get(roomId) ?? 0) % Math.max(peers.length, 1);
      const selected = Array.from({ length: Math.min(peers.length, maxPeers) }, (_, index) => peers[(start + index) % peers.length]);
      peerCursors.delete(roomId); peerCursors.set(roomId, start);
      while (peerCursors.size > maxObservations) peerCursors.delete(peerCursors.keys().next().value!);
      let complete = peers.length <= maxPeers;
      let visited = 0;
      for (const peer of selected) {
        if (!alive(captured)) return;
        if (now() >= deadline) { complete = false; break; }
        peerCursors.set(roomId, start + ++visited);
        if (peer.identity.startsWith("remote-browser:")) continue;
        const binding = await verifiedSourcePeer(nativeRoom, peer);
        if (!binding) { complete = false; continue; }
        if (mustEvictUserMedia(desired.authority, binding.participantId)) {
          if (authorityFingerprint(context.namespace, await input.authority(roomId)) !== authorityKey) { complete = false; break; }
          if (!alive(captured)) return;
          await context.native.removeParticipant(nativeRoom, peer.identity);
          if (!alive(captured)) return;
          emit("evicted");
          continue;
        }
        if (binding.scope === "m") continue;
        if (desired.authority?.roomActive && desired.authority.publisherParticipantIds.includes(binding.participantId)) continue;
        // Check immediately before writing as an availability optimization, not a SID/revision CAS.
        if (!screenSourcesRetired(peer, binding.scope)) {
          if (authorityFingerprint(context.namespace, await input.authority(roomId)) !== authorityKey) { complete = false; break; }
          if (!alive(captured)) return;
          await context.native.updateParticipant(nativeRoom, peer.identity, { permission: screenSourceLowering(binding.scope)! });
          if (!alive(captured)) return;
          emit("lowered");
        }
      }
      if (!alive(captured)) return;
      if (!complete || now() >= deadline) { emit("pending"); return; }
      // A full post-read also sees peers that joined while earlier updates were in flight.
      const observedAtMs = now();
      const currentPeers = await context.native.listParticipants(nativeRoom);
      if (!alive(captured)) return;
      const originalSids = new Map(peers.map(peer => [peer.identity, peer.sid]));
      if (currentPeers.length > maxPeers) complete = false;
      for (const current of currentPeers.slice(0, maxPeers)) {
        if (!alive(captured)) return;
        if (current.identity.startsWith("remote-browser:")) continue;
        const binding = await verifiedSourcePeer(nativeRoom, current);
        if (!binding) { complete = false; continue; }
        if (mustEvictUserMedia(desired.authority, binding.participantId)) { complete = false; continue; }
        if (binding.scope === "m" || desired.authority?.roomActive && desired.authority.publisherParticipantIds.includes(binding.participantId)) continue;
        if (current.sid !== originalSids.get(current.identity) || !screenSourcesRetired(current, binding.scope)) complete = false;
      }
      const after = await input.authority(roomId);
      if (!alive(captured)) return;
      if (complete && fingerprint(context.namespace, after) === key) {
        record(roomId, { fingerprint: key, atMs: observedAtMs, nativeRoom: "present" }); interests.delete(roomId); emit("observed");
      } else emit("pending");
    } catch {
      // A missing participant, lost response or authority outage is not an acknowledgement.
      // The next pass rediscovers the live connection even if no HTTP/WS client remains.
      if (alive(captured)) { invalidate(roomId); emit("pending"); }
    }
  }

  async function pass(captured: number): Promise<void> {
    const deadline = now() + passBudgetMs;
    try {
      const context = await input.context();
      if (!alive(captured)) return;
      if (!context) { unavailable = true; observations.clear(); namespace = null; return; }
      if (!/^[a-f0-9]{32}$/.test(context.namespace)) throw new Error("media_screen_namespace_invalid");
      if (namespace !== context.namespace) observations.clear();
      namespace = context.namespace;
      unavailable = false;
      const rooms = await context.native.listRooms();
      if (!alive(captured)) return;
      const owned = rooms.flatMap(room => {
        const parsed = parseMediaRoomName(room.name, context.prefix, context.namespace);
        if (!parsed || !validId(parsed.roomId)) return [];
        const base = roomMediaGrantName(parsed.roomId, context.prefix, context.namespace);
        return (parsed.epoch ? `${base}:${parsed.epoch}` : base) === room.name ? [{ roomId: parsed.roomId, name: room.name }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name));
      const present = new Set(owned.map(room => room.roomId));
      const count = Math.min(maxRooms, owned.length);
      let processed = 0;
      for (let index = 0; index < count && now() < deadline; index++) {
        const room = owned[(roomCursor + index) % owned.length];
        await reconcileRoom(context, room.roomId, room.name, captured, deadline);
        processed++;
        if (!alive(captured)) return;
      }
      roomCursor = owned.length ? (roomCursor + processed) % owned.length : 0;
      // Authenticated HTTP readers may request an observation of an idle room.
      // Round-robin interests are bounded separately from active native-room discovery.
      const absent = [...interests].filter(([roomId]) => !present.has(roomId)).slice(0, maxRooms);
      for (const [roomId, requested] of absent) {
        if (now() >= deadline || !alive(captured)) break;
        interests.delete(roomId); interests.set(roomId, requested); invalidate(roomId);
        try {
          const desired = await input.authority(roomId), key = fingerprint(context.namespace, desired);
          if (!alive(captured)) return;
          const atMs = now();
          const mediaRoom = input.mediaRoomName ? await input.mediaRoomName(roomId, context.prefix, context.namespace)
            : roomMediaGrantName(roomId, context.prefix, context.namespace);
          const native = await context.native.listRooms([mediaRoom]);
          if (!alive(captured)) return;
          const after = await input.authority(roomId);
          if (!alive(captured)) return;
          if (!native.length && fingerprint(context.namespace, after) === key) {
            record(roomId, { fingerprint: key, atMs, nativeRoom: "absent" }); emit("observed");
            if (interests.get(roomId) === requested) interests.delete(roomId);
          }
        } catch { if (alive(captured)) emit("pending"); }
      }
    } catch {
      if (alive(captured)) { unavailable = true; observations.clear(); emit("unavailable"); }
    }
  }

  function runOnce(): Promise<void> {
    if (pendingPass) return pendingPass;
    if (stopped) return Promise.resolve();
    const operation = pass(generation);
    pendingPass = operation;
    void operation.finally(() => { if (pendingPass === operation) pendingPass = null; });
    return operation;
  }
  const schedule = (captured: number) => {
    if (!started || !alive(captured)) return;
    timer = setTimeout(() => {
      if (!started || !alive(captured)) return;
      void runOnce().finally(() => schedule(captured));
    }, intervalMs);
    timer.unref();
  };
  return {
    runOnce,
    invalidate,
    status(roomId: string, desired: MediaScreenAuthority, currentNamespace: string | null): MediaScreenReconciliationStatus {
      const observed = observations.get(roomId);
      const fresh = observed && namespace && currentNamespace === namespace && observed.fingerprint === fingerprint(namespace, desired)
        && now() >= observed.atMs && now() - observed.atMs <= Math.max(intervalMs * 3, 5000);
      if (!fresh && validId(roomId)) trackInterest(roomId);
      return { enforcementVersion: MEDIA_RECONCILIATION_VERSION,
        state: unavailable ? "unavailable" : fresh ? "observed" : "pending", desiredVersion: version(desired),
        observedAtMs: fresh ? observed.atMs : null, nativeRoom: fresh ? observed.nativeRoom : "unknown" };
    },
    start() {
      if (started) return;
      stopped = false; started = true;
      const captured = generation;
      void runOnce().finally(() => schedule(captured));
    },
    stop() {
      started = false; stopped = true; generation++;
      clearTimeout(timer); observations.clear(); peerCursors.clear(); interests.clear(); namespace = null;
    }
  };
}
