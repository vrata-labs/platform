import type { RoomEffectDatabase, RuntimeDiagnosticRecord, XrTelemetryEventRecord } from "../storage-contracts.js";

type StagedTelemetryWrite = { roomId: string; diagnostic: RuntimeDiagnosticRecord }
  | { roomId: string; telemetry: XrTelemetryEventRecord };

export interface MemoryTelemetrySink {
  appendDiagnostic(roomId: string, payload: RuntimeDiagnosticRecord): void;
  appendXrTelemetry(roomId: string, entry: XrTelemetryEventRecord): void;
}

/** Per-call Memory telemetry stage. Writes keep call order/createdAt as private
 * clones; only a successful callback whose original authority still holds applies
 * them, synchronously, onto the current arrays. Throw/expiry/revoke discards. */
export function createMemoryTelemetryStage(roomId: string) {
  const writes: StagedTelemetryWrite[] = [];
  const bound = (target: string) => { if (target !== roomId) throw new Error("room_effect_room_mismatch"); };
  const database: Pick<RoomEffectDatabase, "addDiagnostic" | "addXrTelemetry"> = {
    addDiagnostic: async (target, payload) => {
      bound(target);
      writes.push({ roomId: target, diagnostic: structuredClone(payload) });
    },
    addXrTelemetry: async (target, participantId, payload) => {
      bound(target);
      writes.push({ roomId: target, telemetry: { participantId, payload: structuredClone(payload), createdAt: new Date().toISOString() } });
    }
  };
  return {
    database,
    commit(check: () => void, sink: MemoryTelemetrySink): void {
      if (!writes.length) return;
      check();
      for (const write of writes.splice(0)) {
        if ("diagnostic" in write) sink.appendDiagnostic(write.roomId, write.diagnostic);
        else sink.appendXrTelemetry(write.roomId, write.telemetry);
      }
    }
  };
}
