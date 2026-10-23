import assert from "node:assert/strict";
import test from "node:test";
import type { RoomEffectDatabase } from "../storage-contracts.js";
import { createRoomEffectFacade } from "./effect-facade.js";

test("facade checks diagnostics and XR telemetry writes without a room-write fence and denies them after release or scope exit", async () => {
  const calls: string[] = [];
  let open = true;
  const database = {
    addDiagnostic: async (roomId: string) => { calls.push(`diagnostic:${roomId}`); },
    addXrTelemetry: async (roomId: string, participantId: string) => { calls.push(`telemetry:${roomId}:${participantId}`); }
  } as unknown as RoomEffectDatabase;
  const scoped = createRoomEffectFacade(database, { check: () => {
    calls.push("check");
    if (!open) throw new Error("room_effect_scope_closed");
  } });
  const diagnostic = {} as Parameters<RoomEffectDatabase["addDiagnostic"]>[1];
  await scoped.addDiagnostic("room", diagnostic);
  await scoped.addXrTelemetry("room", "participant", { fps: 72 });
  assert.deepEqual(calls, ["check", "diagnostic:room", "check", "telemetry:room:participant"]);
  scoped.releaseResponse(() => { calls.push("sent"); });
  assert.throws(() => scoped.addXrTelemetry("room", "participant", {}), /room_effect_response_released/);
  open = false;
  assert.throws(() => scoped.addDiagnostic("room", diagnostic), /room_effect_scope_closed/);
  assert.deepEqual(calls.filter(call => call !== "check"), ["diagnostic:room", "telemetry:room:participant", "sent"]);
});
