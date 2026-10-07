import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "../storage.js";
import type { RoomIdentityEffectStorage, RuntimeDiagnosticRecord } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import { createRoomIdentityService } from "./service.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const SECRET = "memory-telemetry-stage-test-secret-32-bytes";
const ADMIN = { actorType: "admin-token" as const, actorId: "test-admin", role: "admin" as const };
type Effect<T> = (scoped: RoomIdentityEffectStorage) => Promise<T>;
interface Fixture { storage: MemoryStorage; roomId: string; run<T>(effect: Effect<T>): Promise<T> }

const code = (value: string) => (error: unknown) => error instanceof IdentityStorageError && error.code === value;
const upgrade = (error: unknown) => error instanceof IdentityBoundaryError && error.reason === "identity_upgrade_required";
const diagnostic = (label: string) => ({ participantId: label, localPosition: { x: 1, z: 2 } }) as unknown as RuntimeDiagnosticRecord;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function telemetry(storage: MemoryStorage, roomId: string) {
  return { diagnostics: (await storage.getDiagnostics(roomId)).map(entry => entry.participantId),
    xr: (await storage.getXrTelemetry(roomId)).map(entry => entry.payload.label) };
}

async function identityFixture() {
  const clock = { now: NOW };
  const storage = new MemoryStorage(() => clock.now);
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Telemetry stage",
    sessionControl: { hostParticipantId: "stage-host" } });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, SECRET, () => clock.now);
  const recovery = await service.issueRecovery({ ...scope, targetParticipantId: "stage-host", targetRole: "host",
    expiresAt: new Date(NOW + 120_000).toISOString(), issuer: ADMIN });
  const host = await service.redeemRecovery(recovery.credential, scope);
  const guard = { ...host.identity, permission: "room.join" as const, expiresAtSeconds: NOW / 1000 + 60 };
  const run = <T>(effect: Effect<T>) => storage.withRoomIdentityEffect(guard, effect);
  return { clock, storage, scope, guard, roomId: room.roomId, run };
}

async function legacyFixture() {
  const storage = new MemoryStorage(() => NOW);
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Legacy telemetry stage" });
  const run = <T>(effect: Effect<T>) => storage.withLegacyRoomEffect({ tenantId: room.tenantId, roomId: room.roomId }, {}, effect);
  return { storage, roomId: room.roomId, run };
}

const fixtures: Array<[string, () => Promise<Fixture>]> = [["identity", identityFixture], ["legacy", legacyFixture]];
for (const [name, setup] of fixtures) test(`${name}: a throwing callback discards its staged diagnostic and XR telemetry`, async () => {
  const f = await setup();
  const failure = new Error("callback failed");
  await assert.rejects(f.run(async scoped => {
    await scoped.addDiagnostic(f.roomId, diagnostic("staged"));
    await scoped.addXrTelemetry(f.roomId, "p", { label: "staged" });
    throw failure;
  }), (error: unknown) => error === failure);
  assert.deepEqual(await telemetry(f.storage, f.roomId), { diagnostics: [], xr: [] });
  await f.run(async scoped => {
    await scoped.addDiagnostic(f.roomId, diagnostic("next"));
    await scoped.addXrTelemetry(f.roomId, "p", { label: "next" });
  });
  assert.deepEqual(await telemetry(f.storage, f.roomId), { diagnostics: ["next"], xr: ["next"] });
});

const changes: Array<[string, () => Promise<Fixture & { change(): Promise<void> }>, (error: unknown) => boolean]> = [
  ["identity deadline", async () => { const f = await identityFixture();
    return { ...f, change: async () => { f.clock.now = f.guard.expiresAtSeconds * 1000; } }; }, code("identity_session_expired")],
  ["identity epoch revoke", async () => { const f = await identityFixture();
    return { ...f, change: () => f.storage.roomIdentities.revoke(f.scope, f.guard.identityId, f.guard.authEpoch).then(() => undefined) }; },
  code("identity_not_active")],
  ["legacy floor raise", async () => { const f = await legacyFixture();
    return { ...f, change: () => f.storage.identityProtocol.raise(2).then(() => undefined) }; }, upgrade]
];
for (const [name, setup, denied] of changes) test(`${name} after an awaited barrier discards both staged writes`, async () => {
  const f = await setup();
  const reached = deferred();
  const gate = deferred();
  const pending = f.run(async scoped => {
    await scoped.addDiagnostic(f.roomId, diagnostic("stale"));
    await scoped.addXrTelemetry(f.roomId, "p", { label: "stale" });
    reached.resolve();
    await gate.promise;
    return "returned";
  });
  await reached.promise;
  await f.change();
  gate.resolve();
  await assert.rejects(pending, denied);
  assert.deepEqual(await telemetry(f.storage, f.roomId), { diagnostics: [], xr: [] });
});

test("staged writes are private deep clones that preserve creation time and stay invisible until commit", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const f = await identityFixture();
  const report = diagnostic("original");
  const payload = { label: "original", pose: { axes: [1] } };
  await f.run(async scoped => {
    await scoped.addDiagnostic(f.roomId, report);
    await scoped.addXrTelemetry(f.roomId, "p", payload);
    report.participantId = "mutated";
    report.localPosition.x = 99;
    payload.label = "mutated";
    payload.pose.axes[0] = 99;
    t.mock.timers.tick(10_000);
    assert.deepEqual(await telemetry(f.storage, f.roomId), { diagnostics: [], xr: [] });
  });
  const [stored] = await f.storage.getDiagnostics(f.roomId);
  const [event] = await f.storage.getXrTelemetry(f.roomId);
  assert.deepEqual([stored.participantId, stored.localPosition.x], ["original", 1]);
  assert.deepEqual([event.participantId, event.payload], ["p", { label: "original", pose: { axes: [1] } }]);
  assert.equal(event.createdAt, new Date(NOW).toISOString());
});

test("concurrent callbacks append onto the current arrays without losing another successful call", async () => {
  const f = await identityFixture();
  await f.storage.addDiagnostic(f.roomId, diagnostic("seed"));
  await f.storage.addXrTelemetry(f.roomId, "p", { label: "seed" });
  const write = (label: string): Effect<void> => async scoped => {
    await scoped.addDiagnostic(f.roomId, diagnostic(label));
    await scoped.addXrTelemetry(f.roomId, "p", { label });
  };
  const reached = deferred();
  const gate = deferred();
  const slow = f.run(async scoped => { await write("slow")(scoped); reached.resolve(); await gate.promise; });
  await reached.promise;
  await f.run(write("fast"));
  await assert.rejects(f.run(async scoped => { await write("failed")(scoped); throw new Error("failed"); }), /failed/);
  await f.storage.addXrTelemetry(f.roomId, "p", { label: "direct" });
  assert.deepEqual(await telemetry(f.storage, f.roomId), { diagnostics: ["seed", "fast"], xr: ["seed", "fast", "direct"] });
  gate.resolve();
  await slow;
  assert.deepEqual(await telemetry(f.storage, f.roomId),
    { diagnostics: ["seed", "fast", "slow"], xr: ["seed", "fast", "direct", "slow"] });
});

test("commit applies the 200 diagnostic and 1000 XR retention to the current arrays", async () => {
  const f = await identityFixture();
  for (let index = 0; index < 199; index += 1) await f.storage.addDiagnostic(f.roomId, diagnostic(`seed-${index}`));
  for (let index = 0; index < 999; index += 1) await f.storage.addXrTelemetry(f.roomId, "p", { label: `seed-${index}` });
  await f.run(async scoped => {
    for (const label of ["a", "b", "c"]) {
      await scoped.addDiagnostic(f.roomId, diagnostic(label));
      await scoped.addXrTelemetry(f.roomId, "p", { label });
    }
  });
  const { diagnostics, xr } = await telemetry(f.storage, f.roomId);
  assert.deepEqual([diagnostics.length, diagnostics[0], ...diagnostics.slice(-3)], [200, "seed-2", "a", "b", "c"]);
  assert.deepEqual([xr.length, xr[0], ...xr.slice(-3)], [1000, "seed-2", "a", "b", "c"]);
});

test("room mismatch is rejected, release stops later writes, and an escaped facade is closed", async () => {
  const f = await identityFixture();
  const other = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Other room" });
  let escaped!: RoomIdentityEffectStorage;
  let sent = 0;
  await f.run(async scoped => {
    escaped = scoped;
    await assert.rejects(scoped.addDiagnostic(other.roomId, diagnostic("crossed")), /room_effect_room_mismatch/);
    await assert.rejects(scoped.addXrTelemetry(other.roomId, "p", { label: "crossed" }), /room_effect_room_mismatch/);
    await scoped.addDiagnostic(f.roomId, diagnostic("before-release"));
    scoped.releaseResponse(() => { sent += 1; });
    assert.throws(() => scoped.addXrTelemetry(f.roomId, "p", { label: "after-release" }), /room_effect_response_released/);
  });
  assert.equal(sent, 1);
  assert.throws(() => escaped.addDiagnostic(f.roomId, diagnostic("escaped")), /room_effect_scope_closed/);
  assert.deepEqual(await telemetry(f.storage, f.roomId), { diagnostics: ["before-release"], xr: [] });
  assert.deepEqual(await telemetry(f.storage, other.roomId), { diagnostics: [], xr: [] });
});
