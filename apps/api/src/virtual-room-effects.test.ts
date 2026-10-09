import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "./storage.js";
import type { RuntimeDiagnosticRecord, VirtualRoomEffectOptions, VirtualRoomEffectStorage } from "./storage-contracts.js";
import { IdentityBoundaryError } from "./identity/legacy-boundary.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const EXPIRES = NOW / 1000 + 60;
const ROOM = "virtual-meeting";
const KNOWN = new Set(["callback_failed", "room_effect_room_mismatch", "room_effect_scope_closed", "room_effect_response_released",
  "room_write_fence_required", "virtual_room_release_requires_read_fence"]);
const write = (): VirtualRoomEffectOptions => ({ roomWrite: true, expiresAtSeconds: EXPIRES });
const read = (): VirtualRoomEffectOptions => ({ expiresAtSeconds: EXPIRES });
const diagnostic = (value: string) => ({ participantId: value }) as unknown as RuntimeDiagnosticRecord;

// Assertion output carries only allow-listed reasons; unexpected errors are never printed.
function label(error: unknown): string {
  if (error instanceof assert.AssertionError) throw error;
  if (error instanceof IdentityBoundaryError) return `${error.status}:${error.reason}`;
  return error instanceof Error && KNOWN.has(error.message) ? error.message : "unexpected_error";
}
const outcome = (pending: Promise<unknown>) => pending.then(() => "ok", label);
function attempt(operation: () => unknown): string {
  try { operation(); return "ok"; } catch (error) { return label(error); }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const clock = { now: NOW };
  const storage = new MemoryStorage(() => clock.now);
  let entered = 0;
  const run = <T>(options: VirtualRoomEffectOptions, effect: (scoped: VirtualRoomEffectStorage) => Promise<T>) =>
    storage.withLegacyVirtualRoomEffect(ROOM, options, scoped => { entered += 1; return effect(scoped); });
  const stored = async () => ({ diagnostics: (await storage.getDiagnostics(ROOM)).map(entry => entry.participantId),
    xr: (await storage.getXrTelemetry(ROOM)).map(entry => entry.payload.label) });
  return { clock, storage, run, stored, entered: () => entered };
}
type Fixture = ReturnType<typeof fixture>;
const both = async (scoped: VirtualRoomEffectStorage, value: string) => {
  await scoped.addDiagnostic(ROOM, diagnostic(value));
  await scoped.addXrTelemetry(ROOM, "virtual-participant", { label: value });
};

test("floor 1 with no actual room commits one diagnostic and one XR event exactly once", async () => {
  const f = fixture();
  const result = await f.run(write(), async scoped => {
    await both(scoped, "once");
    assert.deepEqual(await f.stored(), { diagnostics: [], xr: [] }, "staged writes stay invisible before commit");
    return "committed";
  }).catch(label);
  assert.equal(result, "committed");
  assert.deepEqual(await f.stored(), { diagnostics: ["once"], xr: ["once"] });
  assert.equal(await f.storage.getRoom(ROOM), null, "a virtual effect never materializes an actual room");
});

const discards: Array<[string, ((f: Fixture) => unknown) | null, string]> = [
  ["a callback failure", null, "callback_failed"],
  ["expiry inside the callback", f => { f.clock.now = EXPIRES * 1000; }, "401:identity_session_expired"],
  ["an actual room appearing", f => f.storage.createRoom({ roomId: ROOM, tenantId: "demo-tenant", templateId: "meeting-room-basic",
    name: "Actual" }), "409:room_state_changed"],
  ["the floor rising", f => f.storage.identityProtocol.raise(2), "409:identity_upgrade_required"]
];
for (const [name, change, expected] of discards) test(`${name} during an awaited barrier discards staged diagnostic and XR writes`, async () => {
  const f = fixture();
  const reached = deferred(), gate = deferred();
  const pending = outcome(f.run(write(), async scoped => {
    await both(scoped, "stale");
    reached.resolve();
    await gate.promise;
    if (!change) throw new Error("callback_failed");
  }));
  await reached.promise;
  await change?.(f);
  gate.resolve();
  assert.equal(await pending, expected);
  assert.deepEqual(await f.stored(), { diagnostics: [], xr: [] });
});

test("an existing room in any tenant, floor 2 and malformed or elapsed original deadlines deny before the callback", async () => {
  const taken = fixture();
  await taken.storage.createTenant({ tenantId: "other-tenant", name: "Other" });
  await taken.storage.createRoom({ roomId: ROOM, tenantId: "other-tenant", templateId: "meeting-room-basic", name: "Other tenant room" });
  for (const options of [write(), read()]) assert.equal(await outcome(taken.run(options, async () => undefined)), "409:room_state_changed");
  const raised = fixture();
  await raised.storage.identityProtocol.raise(2);
  for (const options of [write(), read()]) assert.equal(await outcome(raised.run(options, async () => undefined)), "409:identity_upgrade_required");
  const malformed = fixture();
  for (const expiresAtSeconds of [null, String(EXPIRES), EXPIRES + 0.5, Number.MAX_SAFE_INTEGER, NOW / 1000]) {
    const options = { roomWrite: true, expiresAtSeconds } as unknown as VirtualRoomEffectOptions;
    assert.equal(await outcome(malformed.run(options, async () => undefined)), "401:identity_session_expired");
  }
  assert.deepEqual([taken.entered(), raised.entered(), malformed.entered()], [0, 0, 0]);
});

test("mutating the original options after the call cannot widen the mode or the deadline", async () => {
  const f = fixture();
  const options = read();
  const mutated = deferred(), reached = deferred(), gate = deferred();
  let widened = "";
  const pending = outcome(f.run(options, async scoped => {
    await mutated.promise;
    widened = attempt(() => scoped.addDiagnostic(ROOM, diagnostic("widened")));
    reached.resolve();
    await gate.promise;
  }));
  Object.assign(options, { roomWrite: true, expiresAtSeconds: EXPIRES + 3600 });
  mutated.resolve();
  await reached.promise;
  f.clock.now = EXPIRES * 1000;
  gate.resolve();
  assert.equal(widened, "room_write_fence_required");
  assert.equal(await pending, "401:identity_session_expired");
  assert.deepEqual(await f.stored(), { diagnostics: [], xr: [] });
});

test("the facade is exactly three frozen room-bound methods, mode-exclusive and closed after the callback", async () => {
  const f = fixture();
  let escaped!: VirtualRoomEffectStorage;
  let sent = 0;
  const shape = await f.run(write(), async scoped => {
    escaped = scoped;
    const observed = [Object.keys(scoped).sort().join(), Object.isFrozen(scoped), "getRoom" in scoped,
      attempt(() => scoped.addDiagnostic("other-room", diagnostic("crossed"))),
      attempt(() => scoped.releaseResponse(() => { sent += 1; }))];
    await scoped.addDiagnostic(ROOM, diagnostic("bound"));
    return observed;
  }).catch(label);
  assert.deepEqual(shape, ["addDiagnostic,addXrTelemetry,releaseResponse", true, false,
    "room_effect_room_mismatch", "virtual_room_release_requires_read_fence"]);
  assert.equal(attempt(() => escaped.addXrTelemetry(ROOM, "virtual-participant", { label: "escaped" })), "room_effect_scope_closed");
  const reads = await f.run(read(), async scoped => {
    escaped = scoped;
    return [attempt(() => scoped.addXrTelemetry(ROOM, "virtual-participant", { label: "read" })),
      attempt(() => scoped.releaseResponse(() => { sent += 1; })), attempt(() => scoped.releaseResponse(() => { sent += 1; }))];
  }).catch(label);
  assert.deepEqual(reads, ["room_write_fence_required", "ok", "room_effect_response_released"]);
  assert.equal(attempt(() => escaped.releaseResponse(() => { sent += 1; })), "room_effect_scope_closed");
  assert.equal(sent, 1);
  assert.deepEqual(await f.stored(), { diagnostics: ["bound"], xr: [] });
});

test("a read release is terminal across later awaits and clock advance; an unreleased read rechecks its deadline", async () => {
  const f = fixture();
  let sent = 0;
  const gate = deferred();
  const released = outcome(f.run(read(), async scoped => {
    scoped.releaseResponse(() => { sent += 1; });
    await gate.promise;
  }));
  f.clock.now = EXPIRES * 1000 + 1;
  gate.resolve();
  assert.equal(await released, "ok");
  assert.equal(sent, 1);
  f.clock.now = NOW;
  assert.equal(await outcome(f.run(read(), async () => { await gate.promise; f.clock.now = EXPIRES * 1000; })),
    "401:identity_session_expired");
});
