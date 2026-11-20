import type { ParticipantInfo, ParticipantPermission, RoomServiceClient } from "livekit-server-sdk";
import { createHash } from "node:crypto";
import type { UserMediaBinding } from "@vrata/shared-types";
import type { RoomScreenSourceAuthority } from "./identity/contracts.js";
import { parseMediaRoomName, type ParsedMediaRoom } from "./managed-media-names.js";
import { validId } from "./identity/authority.js";
import type { MediaBoundary } from "./identity/protocol.js";
import { mustEvictExecutorMedia, mustEvictUserMedia, screenSourceLowering, screenSourcesRetired, verifiedSourcePeer } from "./media-source-permissions.js";

/** 3: eviction also checks the selected identity lineage (revocation, absence, codec-3 epoch) and the room generation.
 * 4: remote-browser executor connections are retired in missing, ended and retired-generation native rooms.
 * 5: an executor instance is retired once room-state confirms it can never be current again; the shared legacy
 *    executor address is retired outright.
 * 6: native rooms of a retired owned media namespace are deleted. */
export const MEDIA_RECONCILIATION_VERSION = 6;

/** Room-state's answer for one executor instance; null when room-state cannot be asked. */
export interface ExecutorAuthorityAnswer { readonly reason: string }

export interface MediaScreenAuthority {
  readonly tenantId: string | null;
  readonly authority: RoomScreenSourceAuthority | null;
  /** Portal-managed rooms: the current access epoch; native rooms of any other epoch are retired. */
  readonly accessEpoch?: string | null;
}
export interface MediaScreenReconciliationStatus {
  enforcementVersion: typeof MEDIA_RECONCILIATION_VERSION;
  state: "pending" | "observed" | "unavailable";
  desiredVersion: { authorityRevision: number | null; roomActive: boolean | null };
  observedAtMs: number | null;
  nativeRoom: "unknown" | "present" | "absent";
}
type NativeRooms = Pick<RoomServiceClient, "listRooms" | "listParticipants" | "removeParticipant" | "deleteRoom"> & {
  updateParticipant(room: string, identity: string, input: { permission: Partial<ParticipantPermission> }): Promise<ParticipantInfo>;
};
type Context = MediaBoundary & { prefix: string; native: NativeRooms };
type Observation = { fingerprint: string; atMs: number; nativeRoom: "present" | "absent" };
type Peer = { info: ParticipantInfo; binding: UserMediaBinding | null };
/** `retiredNamespace`: the room belongs to a namespace this database owned and retired; nothing in it is current. */
type OwnedMediaRoom = ParsedMediaRoom & { readonly name: string; readonly retiredNamespace: boolean };

const boundaryKey = (boundary: MediaBoundary) => `${boundary.codec}:${boundary.namespace}:${boundary.retired.join(",")}`;
const version = (value: MediaScreenAuthority) => ({ authorityRevision: value.authority?.revision ?? null,
  roomActive: value.authority?.roomActive ?? false });
const authorityFingerprint = (boundary: string, value: MediaScreenAuthority) => JSON.stringify([boundary, value.tenantId,
  version(value), value.authority?.publisherParticipantIds ?? [],
  createHash("sha256").update(JSON.stringify(value.authority?.removedParticipantIds ?? [])).digest("hex"),
  value.authority?.mediaIncarnation ?? null, value.accessEpoch ?? null]);
const fingerprint = (boundary: string, value: MediaScreenAuthority) => JSON.stringify([
  authorityFingerprint(boundary, value), value.authority?.observationVersion ?? null
]);
/** Lineage of exactly the given participants; an unselected ID is not "absent". */
const lineage = (value: MediaScreenAuthority, participantIds: readonly string[]) => JSON.stringify(participantIds.map(id => {
  const state = value.authority?.participants && Object.hasOwn(value.authority.participants, id) ? value.authority.participants[id] : null;
  return [id, state ? [state.epoch, state.active] : null];
}));
const userPeer = (peer: Pick<ParticipantInfo, "identity">) => !peer.identity.startsWith("remote-browser:");
/** The one classifier for executor connections: the shared legacy object address, or one instance's own address. */
type ExecutorAddress = { kind: "legacy"; objectId: string } | { kind: "instance"; objectId: string; instanceId: string };
function executorAddress(identity: string): ExecutorAddress | null {
  const legacy = /^remote-browser:([^:]+)$/.exec(identity);
  if (legacy) return { kind: "legacy", objectId: legacy[1]! };
  const instance = /^remote-browser:([^:]+):instance:[^:]+$/.exec(identity);
  return instance ? { kind: "instance", objectId: instance[1]!, instanceId: identity } : null;
}
const executorPeer = (peer: Pick<ParticipantInfo, "identity">) => executorAddress(peer.identity) !== null;
/** These reasons never become authorized again for the same instance: room-state restores no room or object. */
const TERMINAL_EXECUTOR_REASONS = new Set(["superseded", "stopped", "object_missing", "room_missing"]);
/** The object's current instance, even off its surface or failed: it can become active again. */
const CURRENT_EXECUTOR_REASONS = new Set(["authorized", "inactive", "failed"]);

/** Reconstruct desired state from durable authority, not a process-local transition queue.
 * Permission writes use the fixed class lowering; public removal, inactive rooms, retired
 * identity lineages and retired room generations disconnect verified user connections instead.
 * Delayed operations may over-restrict a renewed/re-enabled connection, never expand its signed
 * source ceiling. Codec-3 addresses differ per epoch, so evicting an old lineage cannot target
 * a recovered connection; a codec-2 recovery remains indistinguishable until the boundary is raised. */
export function createMediaScreenReconciler(input: {
  context: () => Promise<Context | null>;
  /** Selected participants are read in one snapshot with the room authority; read errors throw. */
  authority: (roomId: string, participantIds?: readonly string[]) => Promise<MediaScreenAuthority>;
  /** Whether one executor instance is still its object's current one; absent means instances are never retired. */
  executorAuthority?: (roomId: string, executor: { objectId: string; instanceId: string }) => Promise<ExecutorAuthorityAnswer | null>;
  event?: (event: "observed" | "pending" | "unavailable" | "lowered" | "evicted" | "retired") => void;
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
  // Cursors belong to one native room name: generations of one room ID never share a position.
  const peerCursors = new Map<string, number>();
  const interests = new Map<string, number>();
  let interestSequence = 0;
  let boundary: string | null = null, unavailable = false, roomCursor = 0, retiredCursor = 0, retiredTurn = true;
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
  /** A selected lineage that an adapter did not return is a read failure, never permission. */
  const read = async (roomId: string, participantIds: readonly string[]) => {
    const value = await input.authority(roomId, participantIds);
    if (value.authority && participantIds.length && !value.authority.participants) throw new Error("media_lineage_unavailable");
    return value;
  };
  /** A codec-2 room is retired by the codec-3 boundary, a codec-3 room by any other room generation,
   * and a portal-managed room by any other access epoch (an unmanaged room has none). */
  const retired = (context: Context, room: OwnedMediaRoom, desired: MediaScreenAuthority) => (room.codec === 2
    ? context.codec >= 3 : desired.authority?.mediaIncarnation !== room.incarnation) || room.epoch !== (desired.accessEpoch ?? null);
  /** "evict" only for a confirmed permanent loss of authority; anything uncertain keeps the executor. */
  async function executorDecision(roomId: string, peer: ParticipantInfo): Promise<"keep" | "evict" | "unknown"> {
    const address = executorAddress(peer.identity);
    if (!address) return "unknown";
    // The shared object address is no longer issued; such a connection predates per-instance media identities.
    if (address.kind === "legacy") return "evict";
    if (!input.executorAuthority) return "keep";
    const answer = await input.executorAuthority(roomId, { objectId: address.objectId, instanceId: address.instanceId });
    if (!answer) return "unknown";
    if (CURRENT_EXECUTOR_REASONS.has(answer.reason)) return "keep";
    return TERMINAL_EXECUTOR_REASONS.has(answer.reason) ? "evict" : "unknown";
  }
  async function verify(room: OwnedMediaRoom, peer: ParticipantInfo): Promise<UserMediaBinding | null> {
    const binding = await verifiedSourcePeer(room.name, peer);
    // A room name fixes its codec; a binding of the other codec is unverified here.
    return binding && (binding.epoch !== undefined) === (room.codec === 3) ? binding : null;
  }

  /** Every owned native room, both codecs, of the current namespace and of the retired ones, in name order.
   * A name of any other namespace is foreign: another deployment may share the SFU and prefix. */
  const listing = async (context: Context) => (await context.native.listRooms()).flatMap((room): OwnedMediaRoom[] => {
    const owned = parseMediaRoomName(room.name, context.prefix, context.namespace);
    if (owned) return [{ ...owned, name: room.name, retiredNamespace: false }];
    for (const namespace of context.retired) {
      const retired = parseMediaRoomName(room.name, context.prefix, namespace);
      if (retired) return [{ ...retired, name: room.name, retiredNamespace: true }];
    }
    return [];
  }).sort((a, b) => a.name.localeCompare(b.name));

  async function reconcileRoom(context: Context, room: OwnedMediaRoom, captured: number, deadline: number): Promise<void> {
    const { roomId } = room;
    try {
      const peers = await context.native.listParticipants(room.name);
      if (!alive(captured)) return;
      peers.sort((a, b) => a.identity.localeCompare(b.identity));
      const start = (peerCursors.get(room.name) ?? 0) % Math.max(peers.length, 1);
      const selected = Array.from({ length: Math.min(peers.length, maxPeers) }, (_, index) => peers[(start + index) % peers.length]);
      peerCursors.delete(room.name); peerCursors.set(room.name, start);
      while (peerCursors.size > maxObservations) peerCursors.delete(peerCursors.keys().next().value!);
      const verified: Peer[] = [];
      for (const info of selected) {
        if (!alive(captured)) return;
        verified.push({ info, binding: userPeer(info) ? await verify(room, info) : null });
      }
      const ids = [...new Set(verified.flatMap(peer => peer.binding ? [peer.binding.participantId] : []))].sort();
      const desired = await read(roomId, ids);
      if (!alive(captured)) return;
      const bk = boundaryKey(context), key = fingerprint(bk, desired);
      // Decision-relevant authority: lifecycle, slots, removals, generation and the selected lineage.
      const decisionKey = JSON.stringify([authorityFingerprint(bk, desired), lineage(desired, ids)]);
      const stale = retired(context, room, desired);
      // An empty retired generation leaves the current room's observation alone; one with connections does not.
      if (!stale || peers.some(peer => userPeer(peer) || executorPeer(peer))) invalidate(roomId);
      const recheck = async () => {
        const current = await read(roomId, ids);
        return JSON.stringify([authorityFingerprint(bk, current), lineage(current, ids)]) === decisionKey;
      };
      let complete = peers.length <= maxPeers;
      let visited = 0;
      /** Executors confirmed current in this pass; the post-read acknowledges no other executor connection. */
      const keptExecutors = new Set<string>();
      for (const { info: peer, binding } of verified) {
        if (!alive(captured)) return;
        if (now() >= deadline) { complete = false; break; }
        peerCursors.set(room.name, start + ++visited);
        if (executorPeer(peer)) {
          if (!mustEvictExecutorMedia(desired.authority, stale)) {
            const decision = await executorDecision(roomId, peer);
            if (!alive(captured)) return;
            if (decision === "keep") keptExecutors.add(peer.identity);
            if (decision === "unknown") complete = false;
            // A fresh answer immediately before the RPC; the address is this instance's own, so it cannot hit another.
            if (decision !== "evict" || await executorDecision(roomId, peer) !== "evict") continue;
            if (!alive(captured)) return;
            await context.native.removeParticipant(room.name, peer.identity);
            if (!alive(captured)) return;
            emit("evicted");
            continue;
          }
          if (!await recheck()) { complete = false; break; }
          if (!alive(captured)) return;
          await context.native.removeParticipant(room.name, peer.identity);
          if (!alive(captured)) return;
          emit("evicted");
          continue;
        }
        if (!userPeer(peer)) continue;
        if (!binding) { complete = false; continue; }
        if (mustEvictUserMedia(desired.authority, binding, stale)) {
          if (!await recheck()) { complete = false; break; }
          if (!alive(captured)) return;
          await context.native.removeParticipant(room.name, peer.identity);
          if (!alive(captured)) return;
          emit("evicted");
          continue;
        }
        if (binding.scope === "m") continue;
        if (desired.authority?.roomActive && desired.authority.publisherParticipantIds.includes(binding.participantId)) continue;
        // Check immediately before writing as an availability optimization, not a SID/revision CAS.
        if (!screenSourcesRetired(peer, binding.scope)) {
          if (!await recheck()) { complete = false; break; }
          if (!alive(captured)) return;
          await context.native.updateParticipant(room.name, peer.identity, { permission: screenSourceLowering(binding.scope)! });
          if (!alive(captured)) return;
          emit("lowered");
        }
      }
      if (!alive(captured)) return;
      if (!complete || now() >= deadline) { emit("pending"); return; }
      // A retired generation is only swept; it never acknowledges the room. The current one does
      // so only while no sibling generation still holds a user connection.
      if (stale) return;
      // A full post-read also sees peers that joined while earlier updates were in flight.
      const observedAtMs = now();
      const currentPeers = await context.native.listParticipants(room.name);
      if (!alive(captured)) return;
      const originalSids = new Map(peers.map(peer => [peer.identity, peer.sid]));
      if (currentPeers.length > maxPeers) complete = false;
      const after: Peer[] = [];
      let executorsPresent = false;
      for (const info of currentPeers.slice(0, maxPeers)) {
        if (!alive(captured)) return;
        if (executorPeer(info)) {
          executorsPresent = true;
          // A legacy address, an instance not asked in this pass or one that outlived its removal is not acknowledged.
          // A kept one is asked again: a final state is never left, so a keep after observedAtMs held at that time.
          if (!keptExecutors.has(info.identity) || await executorDecision(roomId, info) !== "keep") complete = false;
          if (!alive(captured)) return;
          continue;
        }
        if (!userPeer(info)) continue;
        const binding = await verify(room, info);
        if (!binding) complete = false;
        after.push({ info, binding });
      }
      // Generations are re-listed after the post-read: a retired room created during this pass is seen too. In a
      // retired namespace any connection blocks the observation, an unrecognised identity included.
      for (const sibling of (await listing(context)).filter(other => other.roomId === roomId && other.name !== room.name)) {
        if (!alive(captured)) return;
        const peers = await context.native.listParticipants(sibling.name);
        if (sibling.retiredNamespace ? peers.length > 0 : peers.some(peer => userPeer(peer) || executorPeer(peer))) complete = false;
      }
      if (!alive(captured)) return;
      const afterIds = [...new Set([...ids, ...after.flatMap(peer => peer.binding ? [peer.binding.participantId] : [])])].sort();
      const fresh = await read(roomId, afterIds);
      if (!alive(captured)) return;
      if (retired(context, room, fresh) || lineage(fresh, ids) !== lineage(desired, ids)) complete = false;
      if (executorsPresent && mustEvictExecutorMedia(fresh.authority, false)) complete = false;
      for (const { info: current, binding } of after) {
        if (!binding) continue;
        if (mustEvictUserMedia(fresh.authority, binding)) { complete = false; continue; }
        if (binding.scope === "m" || fresh.authority?.roomActive && fresh.authority.publisherParticipantIds.includes(binding.participantId)) continue;
        if (current.sid !== originalSids.get(current.identity) || !screenSourcesRetired(current, binding.scope)) complete = false;
      }
      if (complete && fingerprint(bk, fresh) === key) {
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
      if (!context) { unavailable = true; observations.clear(); boundary = null; return; }
      if (![context.namespace, ...context.retired].every(namespace => /^[a-f0-9]{32}$/.test(namespace))
        || context.retired.includes(context.namespace) || (context.codec !== 2 && context.codec !== 3)) throw new Error("media_screen_namespace_invalid");
      const bk = boundaryKey(context);
      if (boundary !== bk) observations.clear();
      boundary = bk;
      unavailable = false;
      const listed = await listing(context);
      if (!alive(captured)) return;
      const owned = listed.filter(room => !room.retiredNamespace), retiredRooms = listed.filter(room => room.retiredNamespace);
      // A room ID with a native room in a retired namespace is not idle, and an earlier observation of it is void.
      const present = new Set(listed.map(room => room.roomId));
      for (const room of retiredRooms) invalidate(room.roomId);
      // Both kinds share one room budget. While both wait, they split it and take turns going first, so neither
      // failing deletions nor slow current rooms can starve the other; each has its own cursor.
      const half = Math.ceil(maxRooms / 2);
      const retiredQuota = Math.min(retiredRooms.length, owned.length ? (retiredTurn ? half : maxRooms - half) : maxRooms);
      const currentQuota = Math.min(owned.length, maxRooms - retiredQuota);
      /** A retired namespace has no authority to consult: its rooms are deleted whole, executors and unknown
       * identities included. A JWT that rejoins recreates its room, which a later pass deletes again. */
      const retire = async () => {
        let processed = 0;
        for (; processed < retiredQuota && now() < deadline; processed++) {
          const room = retiredRooms[(retiredCursor + processed) % retiredRooms.length];
          try {
            await context.native.deleteRoom(room.name);
            if (alive(captured)) emit("retired");
          } catch { if (alive(captured)) emit("pending"); }
          if (!alive(captured)) return;
        }
        retiredCursor = retiredRooms.length ? (retiredCursor + processed) % retiredRooms.length : 0;
      };
      const reconcileCurrent = async () => {
        let processed = 0;
        for (; processed < currentQuota && now() < deadline; processed++) {
          await reconcileRoom(context, owned[(roomCursor + processed) % owned.length], captured, deadline);
          if (!alive(captured)) return;
        }
        roomCursor = owned.length ? (roomCursor + processed) % owned.length : 0;
      };
      if (retiredTurn) { await retire(); if (alive(captured)) await reconcileCurrent(); }
      else { await reconcileCurrent(); if (alive(captured)) await retire(); }
      if (retiredRooms.length && owned.length) retiredTurn = !retiredTurn;
      if (!alive(captured)) return;
      // Authenticated HTTP readers may request an observation of an idle room.
      // Round-robin interests are bounded separately from active native-room discovery.
      const absent = [...interests].filter(([roomId]) => !present.has(roomId)).slice(0, maxRooms);
      const candidates: Array<{ roomId: string; requested: number; key: string }> = [];
      for (const [roomId, requested] of absent) {
        if (now() >= deadline || !alive(captured)) break;
        interests.delete(roomId); interests.set(roomId, requested); invalidate(roomId);
        try { candidates.push({ roomId, requested, key: fingerprint(bk, await read(roomId, [])) }); }
        catch { if (alive(captured)) emit("pending"); }
        if (!alive(captured)) return;
      }
      if (!candidates.length || now() >= deadline) return;
      // One fresh native read after every desired read: absence covers each generation of the room.
      const atMs = now();
      const fresh = new Set((await listing(context)).map(room => room.roomId));
      if (!alive(captured)) return;
      for (const candidate of candidates) {
        if (now() >= deadline || !alive(captured)) break;
        if (fresh.has(candidate.roomId)) continue;
        try {
          const after = await read(candidate.roomId, []);
          if (!alive(captured)) return;
          if (fingerprint(bk, after) === candidate.key) {
            record(candidate.roomId, { fingerprint: candidate.key, atMs, nativeRoom: "absent" }); emit("observed");
            if (interests.get(candidate.roomId) === candidate.requested) interests.delete(candidate.roomId);
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
    status(roomId: string, desired: MediaScreenAuthority, current: MediaBoundary | null): MediaScreenReconciliationStatus {
      const observed = observations.get(roomId);
      const fresh = observed && boundary && current && boundaryKey(current) === boundary && observed.fingerprint === fingerprint(boundary, desired)
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
      clearTimeout(timer); observations.clear(); peerCursors.clear(); interests.clear(); boundary = null;
    }
  };
}
