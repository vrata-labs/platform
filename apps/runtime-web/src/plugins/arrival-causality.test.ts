import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TestQuickJSWASMModule } from "quickjs-emscripten-core";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { RoomPluginResponse } from "@vrata/room-plugin-sdk";
import { createPluginQuickJS } from "./quickjs-module.js";
import { PluginVm, type VmTurn } from "./vm.js";
import { PluginKernelClient, type KernelWorker } from "./kernel-client.js";
import type { KernelCommand, KernelReply } from "./kernel-protocol.js";
import { RoomPluginController } from "./controller.js";
import { RoomPluginSeatAdapter, type RoomPluginSeatWorld } from "./seat-adapter.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, type RoomPluginRuntimeSnapshot } from "./runtime-dto.js";
import { SANDBOX_LIMITS, SandboxError } from "./limits.js";

let module: TestQuickJSWASMModule, wasm: WebAssembly.Module, source: string;
before(async () => {
  wasm = await WebAssembly.compile(Uint8Array.from(await readFile(new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")))));
  module = new TestQuickJSWASMModule(await createPluginQuickJS(wasm));
  source = await readFile(new URL("../../../../packages/room-plugin-sdk/examples/auto-seat/entry.bundle.mjs", import.meta.url), "utf8");
});
const capabilities = ["status.set", "seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim"] as const;
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await delay(1); }
  assert.fail("causal_condition_not_reached");
}

/** Only the worker boundary is controlled. Controller, broker, adapter, facade queue
 * and scaffold VM are real. Consumption is recorded at vm.event, NOT at event()
 * dispatch or lifecycle promise completion. This is not a browser elapsed proof
 * or a replacement for the trusted kernel's independent watchdog tests. */
function harness(t: TestContext, entry = source) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0, alias = 0;
  const artifact = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "external.causal-seat", version: "1.0.0",
    displayName: "Causal seat", requestedCapabilities: [...capabilities], configSchema: {} }, entry);
  const snapshot = (revision = 1, enabled = true) => parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1,
    revision, leaseExpiresAtMs: 1, bindings: enabled ? [{ bindingId: "11111111-1111-4111-8111-111111111111",
      packageId: "22222222-2222-4222-8222-222222222222", pluginId: artifact.artifact.manifest.id, version: "1.0.0",
      artifactSha256: artifact.artifactSha256, generation: revision, bindingRevision: revision, enabled: true,
      approvedCapabilities: [...capabilities], config: {}, contentUrl: roomPluginContentPath("room", "22222222-2222-4222-8222-222222222222") }] : [] }), "room");
  let current = snapshot(), pendingRead: Promise<RoomPluginRuntimeSnapshot> | undefined;
  const world: RoomPluginSeatWorld = { ready: true, correlation: true, online: true, xr: false, selfId: "self",
    seats: [{ id: "seat-a", yaw: 0 }], occupancy: {}, currentSeatId: null, pendingSeatId: null };
  const claims: Array<{ at: number; id: string }> = [], cancels: Array<{ at: number; claim: string }> = [];
  const retirements: number[] = [], consumed: Array<{ type: string; at: number }> = [], responses: RoomPluginResponse[] = [];
  const adapter = new RoomPluginSeatAdapter({ world: () => world, optedOut: () => false, clock: () => now, random: () => `alias-${++alias}`,
    claim(seat, id) { world.pendingSeatId = seat; claims.push({ at: now, id }); },
    cancel(_release, claim) { cancels.push({ at: now, claim }); world.pendingSeatId = null; return true; } });
  const workers: ControlledWorker[] = [];
  class ControlledWorker implements KernelWorker {
    onmessage: KernelWorker["onmessage"] = null; onerror: KernelWorker["onerror"] = null; onmessageerror: KernelWorker["onmessageerror"] = null;
    queue: KernelCommand[] = []; vm = new PluginVm(module, { approvedCapabilities: capabilities, clock: () => now });
    actionId = 0; batchId = 0;
    postMessage(command: KernelCommand) { this.queue.push(command); }
    terminate() { this.vm.close(); }
    reply(data: KernelReply) { this.onmessage?.({ data } as MessageEvent<KernelReply>); }
    async consume() {
      const command = this.queue.shift(); assert.ok(command, "a real queued command must exist");
      if (command.type === "terminate") { this.vm.close(); this.reply({ version: 1, type: "closed" }); return; }
      if (command.type === "prepare") {
        this.vm.prepare(); this.reply({ version: 1, type: "prepared", id: command.id, wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes,
          startupTiming: { moduleAgeMs: 0, prepareMs: 0 } });
      } else {
        let turn: VmTurn;
        try {
          if (command.type === "respond") { responses.push(...JSON.parse(command.responsesJson)); turn = this.vm.respond(command.responsesJson); }
          else {
            this.actionId = command.id; this.batchId = 0;
            if (command.type === "init") turn = this.vm.init(command.source, command.config);
            else if (command.type === "dispose") turn = this.vm.dispose();
            else { consumed.push({ type: command.event.type, at: now }); turn = this.vm.event(JSON.stringify(command.event)); }
          }
        } catch (error) {
          if (!(error instanceof SandboxError)) throw error;
          this.reply({ version: 1, type: "failed", id: this.actionId, channel: "sandbox", failure: error.code }); await flush(); return;
        }
        if (turn.lifecycle === "pending") this.reply({ version: 1, type: "requests", actionId: this.actionId, batchId: ++this.batchId,
          requestsJson: JSON.stringify(turn.requests) });
        else this.reply({ version: 1, type: "result", id: this.actionId, result: { ...turn, lifecycle: "fulfilled",
          maxTurnExecutionMs: turn.executionMs, turnCount: 1, requestCount: turn.requests.length } });
      }
      await flush();
    }
    async drain() { for (let i = 0; this.queue.length; i++) { assert.ok(i < 32); await this.consume(); } }
  }
  const clients: PluginKernelClient[] = [];
  let hostCalls = 0, hostGate: Promise<void> | undefined;
  const controller = new RoomPluginController({ apiBaseUrl: "https://app.invalid", roomId: "room", clock: () => now,
    context: () => ({ active: true, ready: true, online: true, visible: true, connection: "connected" }),
    proof: () => ({ token: "unit-only", deadlineMs: 900_000 }), render() {},
    http: { snapshot: async () => pendingRead ?? current, content: async () => artifact.bytes },
    seating: { ready: () => world.ready, supported: () => true, activate: () => adapter.activate(),
      snapshot: (owner, seating) => adapter.snapshot(owner, seating),
      port: owner => ({ claim: seat => adapter.claim(seat, owner), cancel: () => adapter.cancelOwn(owner) }),
      retire(owner) { retirements.push(now); adapter.retire(owner); } },
    async start(code, config, approved, dispatch) {
      hostCalls++; await hostGate;
      const worker = new ControlledWorker(); workers.push(worker);
      const client = new PluginKernelClient(worker, approved, undefined, { dispatch, clock: () => now }); clients.push(client);
      const boot = client.init(wasm, code, config); await worker.drain(); await boot; return client;
    } });
  t.after(async () => { controller.stop(); adapter.stop(); for (const worker of workers) { worker.vm.close(); } await flush(); module.assertNoMemoryAllocated(); });
  return { controller, adapter, world, claims, cancels, consumed, retirements, responses, workers, clients, snapshot,
    beginDiscovery() { controller.start(2); },
    async start() { adapter.observe(); controller.start(2); await until(() => controller.diagnostics().running === 1); },
    async advance(ms: number) { now += ms; t.mock.timers.tick(ms); await flush(); },
    async config(revision: number, enabled: boolean) { current = snapshot(revision, enabled); controller.kick(); await flush(); },
    hostCalls: () => hostCalls,
    holdHost() { hostGate = new Promise(resolve => { this.releaseHost = () => { hostGate = undefined; resolve(); }; }); },
    releaseHost: () => {},
    holdRead() { pendingRead = new Promise(resolve => { this.releaseRead = snapshot => { pendingRead = undefined; resolve(snapshot); }; }); },
    releaseRead: (_snapshot: RoomPluginRuntimeSnapshot) => {}
  };
}

test("actual ready consumption, dispatch and completion differ while the real scaffold claims successfully", async t => {
  const h = harness(t); await h.start();
  assert.deepEqual(h.consumed, []);
  assert.equal(h.adapter.diagnostics().grant, "open");
  assert.deepEqual(h.controller.diagnostics().readyDeliveries.map(row => [row.sentAtMs, row.completedAtMs]), [[0, null]]);
  await h.advance(400); await h.workers[0].consume(); // preceding room.connection
  assert.deepEqual(h.consumed, [{ type: "room.connection", at: 400 }]);
  assert.equal(h.claims.length, 0);
  await h.advance(400); await h.workers[0].consume(); // actual vm.event(room.ready)
  assert.deepEqual(h.consumed.at(-1), { type: "room.ready", at: 800 });
  assert.equal(h.claims[0].at, 800); assert.equal(h.controller.diagnostics().readyDeliveries[0].completedAtMs, null);
  await h.advance(1000);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id }); await flush(); await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().grant, "used");
  assert.equal(h.controller.diagnostics().readyDeliveries[0].completedAtMs, 1800);
  assert.deepEqual(h.adapter.diagnostics().settlements, [{ atMs: 1800, reason: "accepted" }]);
  assert.ok(h.responses.some(response => response.ok && response.result === "accepted"));
});

test("fresh authority renewal does not wait for the actual pending room.ready broker claim", async t => {
  const h = harness(t); await h.start(); await h.workers[0].drain();
  assert.equal(h.claims.length, 1); assert.equal(h.clients[0].busy, true);
  assert.equal(h.controller.diagnostics().readyDeliveries[0].completedAtMs, null);
  await h.advance(2000);
  assert.equal(h.controller.diagnostics().remainingLeaseMs, 5000, "fresh discovery renewed while the broker promise is pending");
  assert.equal(h.controller.diagnostics().fetchPending, false); assert.equal(h.clients.length, 1);
  assert.deepEqual(h.controller.diagnostics().retirements, []);
  await h.advance(500); h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id });
  await flush(); await h.workers[0].drain();
  assert.equal(h.controller.diagnostics().readyDeliveries[0].completedAtMs, 2500);
  assert.equal(h.adapter.diagnostics().grant, "used"); assert.deepEqual(h.cancels, []);
});

test("entry expiry is measured from actual platform ready, not setup or a delayed VM start", async t => {
  const h = harness(t); h.adapter.observe(); await h.advance(20_001); await h.start(); await h.workers[0].drain();
  assert.equal(h.claims.length, 0);
  assert.equal(h.adapter.diagnostics().transitions.at(-1)?.reason, "entry-expired");
  assert.equal(h.controller.diagnostics().readyDeliveries[0].arrivalAllowed, false);
});

test("post-ready discovery hold consumes the real entry budget before any claim timer starts", async t => {
  const h = harness(t); h.adapter.observe(); h.holdRead(); h.beginDiscovery(); await flush();
  assert.equal(h.adapter.diagnostics().firstReadyAtMs, 0);
  assert.equal(h.controller.diagnostics().fetchPending, true);
  await h.advance(20_001);
  h.releaseRead(h.snapshot()); await flush();
  // The stale response cannot renew its expired lease ticket. A normal fresh
  // discovery can start the VM, but cannot restore the spent arrival budget.
  h.controller.kick(); await until(() => h.controller.diagnostics().running === 1); await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().transitions.at(-1)?.reason, "entry-expired");
  assert.equal(h.controller.diagnostics().readyDeliveries[0].arrivalAllowed, false);
  assert.equal(h.claims.length, 0); assert.deepEqual(h.adapter.diagnostics().claimPhases, []);
  assert.deepEqual(h.adapter.diagnostics().settlements, [], "there was no claim-response timer to expire");
});

test("waiting at the normal admission form cannot spend entry budget before platform readiness", async t => {
  const h = harness(t); h.world.ready = false; h.adapter.observe();
  await h.advance(25_000);
  assert.equal(h.adapter.diagnostics().firstReadyAtMs, null);
  assert.equal(h.controller.diagnostics().fetchPending, false);
  h.world.ready = true; await h.start(); await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().firstReadyAtMs, 25_000);
  assert.equal(h.controller.diagnostics().readyDeliveries[0].arrivalAllowed, true);
  assert.equal(h.claims[0].at, 25_000);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id }); await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().grant, "used");
});

test("the real adapter closes an unused window at 5000, but pending completion is not a second window", async t => {
  const h = harness(t); await h.start(); await h.workers[0].drain();
  assert.equal(h.claims.length, 1);
  await h.advance(2999); assert.equal(h.cancels.length, 0);
  await h.advance(1); assert.equal(h.cancels[0].at, 3000);
  assert.deepEqual(h.adapter.diagnostics().settlements, [{ atMs: 3000, reason: "lost-answer" }]);
  assert.deepEqual(h.retirements, [], "lost-answer cancellation is not retirement");
  await h.workers[0].drain();
  assert.ok(h.responses.some(response => response.ok && response.result === "offline"));
  await h.advance(2000); assert.equal(h.adapter.diagnostics().transitions.at(-1)?.reason, "window-expired");
});

for (const appliedAt of [1200, 3100]) test(`disable manifest applied at ${appliedAt} distinguishes retire from lost-answer timer`, async t => {
  const h = harness(t); await h.start(); await h.workers[0].drain();
  assert.equal(h.claims.length, 1); h.holdRead();
  await h.advance(1000); h.controller.kick(); await flush();
  // Host mutation is not yet the runtime's accepted manifest revision.
  h.controller.observeRevisionHint(2);
  assert.equal(h.controller.diagnostics().revision, 1); assert.deepEqual(h.retirements, []);
  await h.advance(Math.min(appliedAt, 3000) - 1000);
  if (appliedAt > 3000) {
    assert.equal(h.cancels[0].at, 3000); assert.deepEqual(h.retirements, []);
    await h.advance(appliedAt - 3000);
  } else assert.deepEqual(h.cancels, []);
  h.releaseRead(h.snapshot(2, false)); await flush();
  assert.equal(h.controller.diagnostics().revision, 2);
  assert.deepEqual(h.retirements, [appliedAt]);
  assert.equal(h.cancels.length, 1); assert.equal(h.cancels[0].at, Math.min(appliedAt, 3000));
  assert.equal(h.cancels[0].claim, h.claims[0].id);
  assert.deepEqual(h.adapter.diagnostics().settlements, [{ atMs: Math.min(appliedAt, 3000), reason: appliedAt < 3000 ? "retired" : "lost-answer" }]);
  assert.equal(h.adapter.diagnostics().grant, "open", "retirement cancels a pending claim, not the page grant");
});

test("new manifest generation fences queued OLD handlers without consuming the arrival grant", async t => {
  const h = harness(t); await h.start();
  await h.advance(500); await h.config(2, true); await until(() => h.clients.length === 2 && h.controller.diagnostics().running === 1);
  await h.workers[0].drain();
  assert.equal(h.claims.length, 0, "retired queue must not consume room.ready");
  assert.deepEqual(h.retirements, [500]);
  assert.equal(h.controller.diagnostics().retirements[0].reason, "binding-replaced");
  await h.workers[1].drain(); assert.equal(h.claims.length, 1);
  assert.equal(h.consumed.filter(row => row.type === "room.ready").length, 1);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id }); await flush(); await h.workers[1].drain();
  assert.equal(h.adapter.diagnostics().grant, "used");
});

test("lease expiry during an actual pending scaffold claim retires before its native answer, unlike claim timeout", async t => {
  const h = harness(t); await h.start();
  await h.workers[0].consume(); // room.connection completed, room.ready is queued
  h.holdRead(); await h.advance(4000); await h.workers[0].drain();
  assert.equal(h.claims[0].at, 4000); assert.equal(h.clients[0].busy, true);
  await h.advance(1000);
  const [row] = h.controller.diagnostics().retirements;
  assert.equal(row.reason, "lease-expired"); assert.equal(row.atMs, 5000); assert.equal(row.busy, true);
  assert.equal(row.leaseValid, false); assert.equal(row.remainingLeaseMs, 0); assert.equal(row.fetchPending, true);
  assert.deepEqual(h.adapter.diagnostics().settlements, [{ atMs: 5000, reason: "retired" }]);
  assert.equal(h.cancels.length, 1); assert.equal(h.cancels[0].at - h.claims[0].at, 1000);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id });
  assert.equal(h.adapter.diagnostics().grant, "closed", "a late ACK cannot reopen the expired arrival window");
  h.releaseRead(h.snapshot()); await flush(); await until(() => h.controller.diagnostics().running === 1);
  assert.deepEqual(h.controller.diagnostics().retirements[0], row, "fresh authority cannot erase the producer fact");
});

test("a renewal in flight at expiry keeps the host start: one VM, one activation and a real accepted claim", async t => {
  const h = harness(t); h.adapter.observe(); h.holdHost(); h.beginDiscovery(); await until(() => h.hostCalls() === 1);
  h.holdRead(); await h.advance(4000); // A late refresh, as under a busy main thread.
  await h.advance(1000);
  assert.equal(h.controller.diagnostics().remainingLeaseMs, 0); assert.equal(h.controller.diagnostics().fetchPending, true);
  assert.deepEqual(h.controller.diagnostics().retirements, []);
  assert.deepEqual(h.retirements, [5000], "the seat port drops any pending claim; the preparation itself stays");
  assert.deepEqual(h.adapter.diagnostics().activations, [], "no room.ready without authority");
  h.releaseRead(h.snapshot()); await flush();
  assert.equal(h.controller.diagnostics().remainingLeaseMs, 4000);
  h.releaseHost(); await until(() => h.controller.diagnostics().running === 1); await h.workers[0].drain();
  assert.equal(h.hostCalls(), 1); assert.equal(h.workers.length, 1);
  assert.equal(h.adapter.diagnostics().activations.length, 1); assert.equal(h.claims.length, 1);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id }); await flush(); await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().grant, "used");
});

test("a real guest denied in the lease gap gets a clean new start instead of a sticky failure", async t => {
  const h = harness(t, 'export function init(context) { return context.sdk.status.set("ready"); }');
  h.adapter.observe(); h.holdHost(); h.beginDiscovery(); await until(() => h.hostCalls() === 1);
  h.holdRead(); await h.advance(4000); await h.advance(1000);
  h.releaseHost(); await until(() => h.controller.diagnostics().retirements.length === 1);
  assert.ok(h.responses.some(response => !response.ok && response.error === "lease-expired"));
  const [fact] = h.controller.diagnostics().retirements;
  assert.equal(fact.reason, "lease-expired"); assert.equal(fact.failure, "guest_exception");
  assert.equal(h.controller.diagnostics().failed, 0); assert.equal(h.controller.diagnostics().lastInstanceFailure, null);
  h.releaseRead(h.snapshot()); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.hostCalls(), 2); assert.ok(h.responses.some(response => response.ok));
});

test("negative control: suppressing actual retirement cannot masquerade as cancellation before 3000", async t => {
  const h = harness(t); await h.start(); await h.workers[0].drain();
  const retire = h.adapter.retire.bind(h.adapter);
  h.adapter.retire = () => {}; // Fault injection at the actual component boundary, not a copied reducer.
  await h.advance(1200); await h.config(2, false);
  assert.deepEqual(h.retirements, [1200]);
  const earlyCancellation = () => { assert.equal(h.cancels.length, 1); assert.ok(h.cancels[0].at < 3000); };
  assert.throws(earlyCancellation, assert.AssertionError);
  await h.advance(1800); assert.equal(h.cancels[0].at, 3000);
  assert.throws(earlyCancellation, assert.AssertionError, "a final empty/cancel is not proof of the early retire branch");
  h.adapter.retire = retire;
});

test("negative control: removing activation produces no claim despite running VM and consumed room.ready", async t => {
  const h = harness(t); h.adapter.activate = () => {};
  await h.start(); await h.workers[0].drain();
  assert.equal(h.controller.diagnostics().running, 1);
  assert.ok(h.consumed.some(row => row.type === "room.ready"));
  assert.equal(h.controller.diagnostics().readyDeliveries[0].arrivalAllowed, false);
  assert.equal(h.adapter.diagnostics().grant, "armed"); assert.equal(h.claims.length, 0);
});

test("a stale manifest cannot restore a disabled generation or consume its queued ready", async t => {
  const h = harness(t); await h.start();
  await h.advance(500); await h.config(2, false);
  await h.config(1, true); await h.workers[0].drain();
  assert.equal(h.controller.diagnostics().revision, 2);
  assert.equal(h.controller.diagnostics().instances, 0);
  assert.equal(h.clients.length, 1); assert.equal(h.claims.length, 0);
  assert.equal(h.consumed.some(row => row.type === "room.ready"), false);
});

test("late accepted answer after lost-answer cannot use the grant or reopen it for a later instance", async t => {
  const h = harness(t); await h.start(); await h.workers[0].drain();
  await h.advance(3000);
  assert.deepEqual(h.adapter.diagnostics().settlements, [{ atMs: 3000, reason: "lost-answer" }]);
  await h.advance(1); h.adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: h.claims[0].id });
  await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().grant, "open", "late ACK is not an accepted active claim");
  await h.advance(1999);
  assert.equal(h.adapter.diagnostics().transitions.at(-1)?.reason, "window-expired");
  await h.config(2, true); await until(() => h.clients.length === 2 && h.controller.diagnostics().running === 1);
  await h.workers[1].drain();
  assert.equal(h.controller.diagnostics().readyDeliveries[1].arrivalAllowed, false);
  assert.equal(h.adapter.diagnostics().grant, "closed");
  assert.equal(h.claims.length, 1); assert.equal(h.cancels.length, 1);
});
