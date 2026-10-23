import type { Storage } from "./storage.js";

import {
  appendXrTelemetryRecord,
  cloneXrTelemetryBuffer,
  createXrTelemetryRecord,
  mergeXrTelemetryBuffers,
  type XrTelemetryParticipantBuffer,
  type XrTelemetryRecord
} from "./xr-telemetry-buffer.js";

const xrTelemetryPairQueueLimit = 32;
const xrTelemetryRoomQueueLimit = 256;
const xrTelemetryServiceQueueLimit = 512;
const xrTelemetryCommitSlots = 2;

export class XrTelemetryQueueFull extends Error {
  readonly code = "XR_TELEMETRY_QUEUE_FULL";
  constructor() { super("XR telemetry queue is full"); this.name = "XrTelemetryQueueFull"; }
}

export interface XrTelemetryPairQueue { pending: number; tail: Promise<void> }
export interface XrTelemetryRoomQueue { pending: number; tail: Promise<void>; pairs: Map<string, XrTelemetryPairQueue> }

// Trusted backend plumbing, never guest-facing: services sharing one scheduler
// share pair/room/service limits, room turns and commit slots, keyed by the
// bare room id, while each service keeps its own live buffers.
export interface XrTelemetryScheduler {
  readonly queuesByRoom: Map<string, XrTelemetryRoomQueue>;
  pending: number;
  acquireCommitSlot(): Promise<void>;
  releaseCommitSlot(): void;
}

export function createXrTelemetryScheduler(): XrTelemetryScheduler {
  let activeCommits = 0;
  const commitSlotWaiters: Array<() => void> = [];
  return {
    queuesByRoom: new Map<string, XrTelemetryRoomQueue>(),
    pending: 0,
    acquireCommitSlot() {
      if (activeCommits < xrTelemetryCommitSlots) { activeCommits += 1; return Promise.resolve(); }
      return new Promise(resolve => { commitSlotWaiters.push(resolve); });
    },
    releaseCommitSlot() {
      const next = commitSlotWaiters.shift();
      if (next) next(); else activeCommits -= 1;
    }
  };
}

export function createXrTelemetryService(storagePromise: Promise<Pick<Storage, "addXrTelemetry" | "getXrTelemetry">>,
  scheduler: XrTelemetryScheduler = createXrTelemetryScheduler()) {
  const xrTelemetryByRoom = new Map<string, Map<string, XrTelemetryParticipantBuffer>>();
  const xrTelemetryQueuesByRoom = scheduler.queuesByRoom;
  // Only ready pair heads compete for a room turn and then a scheduler slot,
  // before their callback can borrow a shared database pool client.

  async function upsertXrTelemetry(roomId: string, participantId: string, payload: XrTelemetryRecord): Promise<void> {
    const roomTelemetry = xrTelemetryByRoom.get(roomId) ?? new Map<string, XrTelemetryParticipantBuffer>();
    const nextRecord = createXrTelemetryRecord(roomId, participantId, payload);
    const shouldPersist = appendXrTelemetryRecord(roomTelemetry, nextRecord);
    xrTelemetryByRoom.set(roomId, roomTelemetry);
    if (shouldPersist) {
      const storage = await storagePromise;
      await storage.addXrTelemetry(roomId, participantId, structuredClone(nextRecord) as unknown as Record<string, unknown>);
    }
  }

  function upsertXrTelemetryWithFence(roomId: string, participantId: string, payload: XrTelemetryRecord,
    commit: (record: XrTelemetryRecord, persist: boolean) => Promise<void>): Promise<void> {
    const roomQueue = xrTelemetryQueuesByRoom.get(roomId)
      ?? { pending: 0, tail: Promise.resolve(), pairs: new Map<string, XrTelemetryPairQueue>() };
    const pairQueue = roomQueue.pairs.get(participantId) ?? { pending: 0, tail: Promise.resolve() };
    if (pairQueue.pending >= xrTelemetryPairQueueLimit || roomQueue.pending >= xrTelemetryRoomQueueLimit
      || scheduler.pending >= xrTelemetryServiceQueueLimit) {
      return Promise.reject(new XrTelemetryQueueFull());
    }
    let admittedPayload: XrTelemetryRecord;
    try { admittedPayload = structuredClone(payload); }
    catch (error) { return Promise.reject(error); }
    scheduler.pending += 1;
    roomQueue.pending += 1;
    pairQueue.pending += 1;
    roomQueue.pairs.set(participantId, pairQueue);
    xrTelemetryQueuesByRoom.set(roomId, roomQueue);
    const run = pairQueue.tail.then(async () => {
      // Turns only ever resolve, so a failed callback cannot poison the room tail.
      const previousTurn = roomQueue.tail;
      let releaseTurn!: () => void;
      const turn = new Promise<void>(resolve => { releaseTurn = resolve; });
      roomQueue.tail = previousTurn.then(() => turn);
      try {
        await previousTurn;
        await scheduler.acquireCommitSlot();
        try {
          const record = createXrTelemetryRecord(roomId, participantId, admittedPayload);
          const current = xrTelemetryByRoom.get(roomId)?.get(participantId);
          const preview = new Map<string, XrTelemetryParticipantBuffer>();
          if (current) preview.set(participantId, current);
          const persist = appendXrTelemetryRecord(preview, record);
          await commit(structuredClone(record), persist);
          const roomTelemetry = xrTelemetryByRoom.get(roomId) ?? new Map<string, XrTelemetryParticipantBuffer>();
          appendXrTelemetryRecord(roomTelemetry, record);
          xrTelemetryByRoom.set(roomId, roomTelemetry);
        } finally { scheduler.releaseCommitSlot(); }
      } finally { releaseTurn(); }
    });
    pairQueue.tail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      scheduler.pending -= 1;
      pairQueue.pending -= 1;
      roomQueue.pending -= 1;
      if (pairQueue.pending === 0 && roomQueue.pairs.get(participantId) === pairQueue) roomQueue.pairs.delete(participantId);
      if (roomQueue.pending === 0 && xrTelemetryQueuesByRoom.get(roomId) === roomQueue) xrTelemetryQueuesByRoom.delete(roomId);
    });
  }

  async function listXrTelemetry(roomId: string): Promise<Array<XrTelemetryRecord & { history: XrTelemetryRecord[] }>> {
    const storage = await storagePromise;
    const persistedTelemetry = new Map<string, XrTelemetryParticipantBuffer>();
    for (const entry of await storage.getXrTelemetry(roomId)) {
      appendXrTelemetryRecord(
        persistedTelemetry,
        createXrTelemetryRecord(roomId, entry.participantId, entry.payload as unknown as XrTelemetryRecord)
      );
    }

    const liveTelemetry = xrTelemetryByRoom.get(roomId) ?? new Map<string, XrTelemetryParticipantBuffer>();
    const participantIds = new Set<string>([...persistedTelemetry.keys(), ...liveTelemetry.keys()]);
    return Array.from(participantIds)
      .map((participantId) => {
        const persisted = persistedTelemetry.get(participantId);
        const live = liveTelemetry.get(participantId);
        const merged = persisted && live
          ? mergeXrTelemetryBuffers(persisted, live)
          : persisted
            ? cloneXrTelemetryBuffer(persisted)
            : live
              ? cloneXrTelemetryBuffer(live)
              : null;
        if (!merged) {
          return null;
        }
        return {
          ...merged.latest,
          history: merged.history
        };
      })
      .filter((entry): entry is XrTelemetryRecord & { history: XrTelemetryRecord[] } => entry !== null)
      .sort((left, right) => left.participantId.localeCompare(right.participantId));
  }

  return { upsertXrTelemetry, upsertXrTelemetryWithFence, listXrTelemetry };
}
