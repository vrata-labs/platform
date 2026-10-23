import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { RoomEffectDatabase, RuntimeDiagnosticRecord, VirtualRoomEffectStorage } from "../storage-contracts.js";
import { assertVirtualRoomId, captureVirtualRoomGuard, InvalidVirtualRoomId, runVirtualRoomEffect } from "./virtual-effect-facade.js";

const ROOM = "virtual-meeting";
const message = (error: unknown) => error instanceof Error ? error.message : "non_error";
function attempt(operation: () => unknown): string {
  try { operation(); return "ok"; } catch (error) { return message(error); }
}

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

test("only a boolean true selects write or pin; both together are internal and the captured mode is frozen", () => {
  const mode = (options: object) => { const guard = captureVirtualRoomGuard(ROOM, options); return [guard.roomWrite, guard.pinAbsence]; };
  assert.deepEqual([mode({}), mode({ roomWrite: true }), mode({ pinAbsence: true }), mode({ roomWrite: false, pinAbsence: true })],
    [[false, false], [true, false], [false, true], [false, true]]);
  for (const loose of [1, "true", {}, [true]]) {
    assert.deepEqual(mode({ roomWrite: loose, pinAbsence: loose }), [false, false], "a truthy non-boolean flag is the read default");
    assert.deepEqual(mode({ roomWrite: true, pinAbsence: loose }), [true, false]);
  }
  assert.throws(() => captureVirtualRoomGuard(ROOM, { roomWrite: true, pinAbsence: true }),
    (error: unknown) => error instanceof Error && !(error instanceof InvalidVirtualRoomId) && error.message === "invalid_virtual_room_effect",
    "a pinned write is an internal error, never a public room reason");
  const options = { roomWrite: false, pinAbsence: true };
  const guard = captureVirtualRoomGuard(ROOM, options);
  Object.assign(options, { roomWrite: true, pinAbsence: false });
  assert.throws(() => { (guard as { pinAbsence: boolean }).pinAbsence = false; }, TypeError);
  assert.deepEqual([Object.isFrozen(guard), guard.roomWrite, guard.pinAbsence], [true, false, true]);
});

test("pin mode releases exactly once and admits no telemetry; a refused release or callback rejection is kept unchanged", async () => {
  const client = slowClient();
  const guard = captureVirtualRoomGuard(ROOM, { pinAbsence: true });
  let refuse = false, sent = 0;
  const send = () => { sent += 1; };
  const run = (effect: (scoped: VirtualRoomEffectStorage) => Promise<unknown>) => runVirtualRoomEffect(client.database, guard,
    () => { if (refuse) throw new Error("fence_lost"); }, effect).then(() => "ok", message);
  let observed: string[] = [];
  assert.equal(await run(async scoped => {
    observed = [attempt(() => scoped.addDiagnostic(ROOM, { participantId: "pinned" } as unknown as RuntimeDiagnosticRecord)),
      attempt(() => scoped.addXrTelemetry(ROOM, "virtual-participant", {})),
      attempt(() => scoped.releaseResponse(send)), attempt(() => scoped.releaseResponse(send))];
    refuse = true;
    await turn();
  }), "ok", "the timely release is terminal; no later check withdraws it");
  assert.deepEqual([observed, sent, client.events],
    [["room_write_fence_required", "room_write_fence_required", "ok", "room_effect_response_released"], 1, []]);
  refuse = false;
  assert.equal(await run(async () => undefined), "virtual_room_release_required");
  assert.equal(await run(async () => { throw new Error("callback_failed"); }), "callback_failed");
  assert.equal(await run(async scoped => { scoped.releaseResponse(send); throw new Error("callback_failed"); }), "callback_failed");
  refuse = true;
  assert.equal(await run(async scoped => { scoped.releaseResponse(send); }), "fence_lost", "a refused release propagates and sends nothing");
  assert.equal(sent, 2);
});
