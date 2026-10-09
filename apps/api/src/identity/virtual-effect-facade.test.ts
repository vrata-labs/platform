import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { RoomEffectDatabase, RuntimeDiagnosticRecord, VirtualRoomEffectStorage } from "../storage-contracts.js";
import { assertVirtualRoomId, captureVirtualRoomGuard, InvalidVirtualRoomId, runVirtualRoomEffect } from "./virtual-effect-facade.js";

const ROOM = "virtual-meeting";
const message = (error: unknown) => error instanceof Error ? error.message : "non_error";

/** Fake transaction client: each statement starts at once and settles only when the test releases it. */
function slowClient() {
  const events: string[] = [];
  const release: Array<() => void> = [];
  const statement = (label: string) => new Promise<void>(resolve => {
    events.push(`start:${label}`);
    release.push(() => { events.push(`settled:${label}`); resolve(); });
  });
  const database: Pick<RoomEffectDatabase, "addDiagnostic" | "addXrTelemetry"> = {
    addDiagnostic: () => statement("diagnostic"),
    addXrTelemetry: () => statement("xr")
  };
  return { events, release, database };
}

for (const ending of ["returns", "throws"] as const) {
  test(`a callback that ${ending} with an unawaited write waits for its SQL and closes the captured facade`, async () => {
    const client = slowClient();
    let escaped!: VirtualRoomEffectStorage;
    const outcome = runVirtualRoomEffect(client.database, captureVirtualRoomGuard(ROOM, { roomWrite: true }), () => undefined, async scoped => {
      escaped = scoped;
      void scoped.addDiagnostic(ROOM, { participantId: "unawaited" } as unknown as RuntimeDiagnosticRecord);
      if (ending === "throws") throw new Error("callback_failed");
    }).then(() => "ok", message).then(result => { client.events.push(`effect:${result}`); return result; });
    await turn();
    assert.deepEqual(client.events, ["start:diagnostic"], "the effect, and so its transaction, cannot end while SQL is in flight");
    assert.throws(() => escaped.addXrTelemetry(ROOM, "virtual-participant", {}), { message: "room_effect_scope_closed" });
    client.release.shift()!();
    const expected = ending === "throws" ? "callback_failed" : "room_effect_write_pending";
    assert.equal(await outcome, expected, ending === "throws" ? "the original error is retained" : "a leaked write rejects the effect");
    assert.deepEqual(client.events, ["start:diagnostic", "settled:diagnostic", `effect:${expected}`]);
    assert.equal(client.release.length, 0, "no statement starts after the scope closes");
  });
}

test("an id the virtual namespace cannot hold is a typed room_not_found that carries no request value", () => {
  const typed = (error: unknown) => error instanceof InvalidVirtualRoomId && error.message === "room_not_found" && error.cause === undefined;
  const invalid: unknown[] = [undefined, null, 7, {}, "", "v".repeat(201), "virtual\u0000room", "virtual\nroom", "virtual\u001froom"];
  invalid.forEach((roomId, index) => {
    assert.throws(() => assertVirtualRoomId(roomId), typed, `assert case ${index}`);
    assert.throws(() => captureVirtualRoomGuard(roomId, { roomWrite: true }), typed, `guard case ${index}`);
  });
  assert.equal(captureVirtualRoomGuard("v".repeat(200), {}).roomId.length, 200, "an exact-limit id is still captured");
  assert.throws(() => captureVirtualRoomGuard(ROOM, null),
    (error: unknown) => error instanceof Error && !(error instanceof InvalidVirtualRoomId) && error.message === "invalid_virtual_room_effect",
    "malformed trusted options remain an internal error");
});
