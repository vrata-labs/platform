import type { Storage } from "./storage.js";

import {
  appendXrTelemetryRecord,
  cloneXrTelemetryBuffer,
  createXrTelemetryRecord,
  mergeXrTelemetryBuffers,
  type XrTelemetryParticipantBuffer,
  type XrTelemetryRecord
} from "./xr-telemetry-buffer.js";

export function createXrTelemetryService(storagePromise: Promise<Pick<Storage, "addXrTelemetry" | "getXrTelemetry">>) {
  const xrTelemetryByRoom = new Map<string, Map<string, XrTelemetryParticipantBuffer>>();

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

  return { upsertXrTelemetry, listXrTelemetry };
}
