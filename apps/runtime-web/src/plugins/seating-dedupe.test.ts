import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TestQuickJSWASMModule } from "quickjs-emscripten-core";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { RoomPluginRequest, RoomPluginResponse } from "@vrata/room-plugin-sdk";
import { createPluginQuickJS } from "./quickjs-module.js";
import { PluginVm, type VmTurn } from "./vm.js";
import { PluginKernelClient, type KernelWorker } from "./kernel-client.js";
import type { KernelCommand, KernelReply } from "./kernel-protocol.js";
import { RoomPluginController, type RoomPluginCoreContext } from "./controller.js";
import { RoomPluginSeatAdapter, type RoomPluginSeatWorld } from "./seat-adapter.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, type RoomPluginRuntimeSnapshot } from "./runtime-dto.js";
import { SANDBOX_LIMITS } from "./limits.js";

let module: TestQuickJSWASMModule, wasm: WebAssembly.Module, autoSeatSource: string;
before(async () => {
  wasm = await WebAssembly.compile(Uint8Array.from(await readFile(new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")))));
  module = new TestQuickJSWASMModule(await createPluginQuickJS(wasm));
  autoSeatSource = await readFile(new URL("../../../../packages/room-plugin-sdk/examples/auto-seat/entry.bundle.mjs", import.meta.url), "utf8");
});
const capabilities = ["status.set", "seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim"] as const;
const passiveSource = 'export function init(c) { return c.sdk.status.set("Ready"); } export function onEvent() {}';
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await delay(1); }
  assert.fail("dedupe_condition_not_reached");
}

/** Actual controller, broker, adapter, kernel facade and QuickJS VM.
 * Only worker task/reply delivery and time are controlled. */
function harness(t: TestContext, options: { autoSeat?: boolean; allowArrival?: boolean; ready?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0, alias = 0;
  const source = options.autoSeat ? autoSeatSource : passiveSource;
  const artifact = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "external.dedupe-seat", version: "1.0.0",
    displayName: "Dedupe seat", requestedCapabilities: [...capabilities], configSchema: {} }, source);
  const snapshot = (revision = 1, enabled = true) => parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1,
    revision, leaseExpiresAtMs: 1, bindings: enabled ? [{ bindingId: "11111111-1111-4111-8111-111111111111",
      packageId: "22222222-2222-4222-8222-222222222222", pluginId: artifact.artifact.manifest.id, version: "1.0.0",
      artifactSha256: artifact.artifactSha256, generation: revision, bindingRevision: revision, enabled: true,
      approvedCapabilities: [...capabilities], config: {}, contentUrl: roomPluginContentPath("room", "22222222-2222-4222-8222-222222222222") }] : [] }), "room");
  let current = snapshot(), pendingRead: Promise<RoomPluginRuntimeSnapshot> | undefined;
  const context: RoomPluginCoreContext = { active: true, ready: true, online: true, visible: true, connection: "connected" };
  const world: RoomPluginSeatWorld = { ready: options.ready ?? true, correlation: true, online: true, xr: false, selfId: "self",
    seats: [{ id: "seat-a", yaw: 0 }, { id: "seat-b", yaw: 1 }],
    occupancy: options.autoSeat || options.allowArrival ? {} : { "seat-a": "self" },
    currentSeatId: options.autoSeat || options.allowArrival ? null : "seat-a", pendingSeatId: null };
  const claims: Array<{ seat: string; id: string }> = [], consumed: string[] = [], responses: RoomPluginResponse[] = [], statuses: string[] = [];
  const dispatches: Array<(request: RoomPluginRequest, signal: AbortSignal) => RoomPluginResponse | Promise<RoomPluginResponse>> = [];
  const adapter = new RoomPluginSeatAdapter({ world: () => world, optedOut: () => false, clock: () => now, random: () => `alias-${++alias}`,
    claim(seat, id) { world.pendingSeatId = seat; claims.push({ seat, id }); },
    cancel() { world.pendingSeatId = null; return true; } });
  const workers: ControlledWorker[] = [], clients: PluginKernelClient[] = [];
  class ControlledWorker implements KernelWorker {
    onmessage: KernelWorker["onmessage"] = null; onerror: KernelWorker["onerror"] = null; onmessageerror: KernelWorker["onmessageerror"] = null;
    queue: KernelCommand[] = []; vm = new PluginVm(module, { approvedCapabilities: capabilities, clock: () => now });
    held: KernelReply[] = []; deferResults = false; actionId = 0; batchId = 0;
    postMessage(command: KernelCommand) { this.queue.push(command); }
    terminate() { this.vm.close(); }
    reply(data: KernelReply) { this.onmessage?.({ data } as MessageEvent<KernelReply>); }
    deliverHeld() { for (const reply of this.held.splice(0)) this.reply(reply); }
    async consume() {
      const command = this.queue.shift(); assert.ok(command, "a real queued command must exist");
      if (command.type === "terminate") { this.vm.close(); this.reply({ version: 1, type: "closed" }); return; }
      if (command.type === "prepare") {
        this.vm.prepare(); this.reply({ version: 1, type: "prepared", id: command.id, wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes,
          startupTiming: { moduleAgeMs: 0, prepareMs: 0 } });
      } else {
        let turn: VmTurn;
        if (command.type === "respond") { responses.push(...JSON.parse(command.responsesJson)); turn = this.vm.respond(command.responsesJson); }
        else {
          this.actionId = command.id; this.batchId = 0;
          if (command.type === "init") turn = this.vm.init(command.source, command.config);
          else if (command.type === "dispose") turn = this.vm.dispose();
          else { consumed.push(command.event.type); turn = this.vm.event(JSON.stringify(command.event)); }
        }
        if (turn.lifecycle === "pending") this.reply({ version: 1, type: "requests", actionId: this.actionId, batchId: ++this.batchId,
          requestsJson: JSON.stringify(turn.requests) });
        else {
          const result: KernelReply = { version: 1, type: "result", id: this.actionId, result: { ...turn, lifecycle: "fulfilled",
            maxTurnExecutionMs: turn.executionMs, turnCount: 1, requestCount: turn.requests.length } };
          if (this.deferResults) this.held.push(result); else this.reply(result);
        }
      }
      await flush();
    }
    async drain() { for (let i = 0; this.queue.length; i++) { assert.ok(i < 32); await this.consume(); } }
  }
  const controller = new RoomPluginController({ apiBaseUrl: "https://app.invalid", roomId: "room", clock: () => now,
    context: () => context, proof: () => ({ token: "unit-only", deadlineMs: 900_000 }),
    render(rows) { const text = rows[0]?.text; if (text && statuses.at(-1) !== text) statuses.push(text); },
    http: { snapshot: async () => pendingRead ?? current, content: async () => artifact.bytes },
    seating: { ready: () => world.ready, supported: () => true, activate: () => adapter.activate(),
      snapshot: (owner, seating) => adapter.snapshot(owner, seating),
      port: owner => ({ claim: seat => adapter.claim(seat, owner), cancel: () => adapter.cancelOwn(owner) }), retire: owner => adapter.retire(owner) },
    async start(code, config, approved, dispatch) {
      dispatches.push(dispatch);
      const worker = new ControlledWorker(); workers.push(worker);
      const client = new PluginKernelClient(worker, approved, undefined, { dispatch, clock: () => now }); clients.push(client);
      const boot = client.init(wasm, code, config); await worker.drain(); await boot; return client;
    } });
  t.after(async () => { controller.stop(); adapter.stop(); for (const worker of workers) worker.vm.close(); await flush(); module.assertNoMemoryAllocated(); });
  return { controller, adapter, world, context, claims, consumed, responses, workers, clients, snapshot, dispatches, statuses,
    async start() { adapter.observe(); controller.start(2); await until(() => controller.diagnostics().running === 1); await workers.at(-1)!.drain(); },
    async advance(ms: number) { now += ms; t.mock.timers.tick(ms); await flush(); },
    async config(revision: number) { const previous = clients.length; current = snapshot(revision); controller.kick();
      await until(() => clients.length > previous && controller.diagnostics().running === 1); },
    holdRead() { pendingRead = new Promise(resolve => { this.releaseRead = value => { pendingRead = undefined; resolve(value); }; }); },
    releaseRead: (_snapshot: RoomPluginRuntimeSnapshot) => {},
    status(index: number, text: string) { return dispatches[index]({ sdkApiVersion: 1, requestId: "900", operation: "status.set", payload: { text } }, new AbortController().signal); }
  };
}

async function lapse(h: ReturnType<typeof harness>, changed: boolean) {
  const worker = h.workers.at(-1)!, client = h.clients.at(-1)!, oldIndex = h.clients.length - 1;
  h.holdRead();
  await h.advance(h.controller.diagnostics().remainingLeaseMs - 200);
  if (changed) h.world.seats = h.world.seats.map((seat, index) => index === 0 ? { ...seat, yaw: seat.yaw + 0.1 } : seat);
  h.controller.seatingChanged(); await h.advance(100);
  worker.deferResults = true; await worker.drain();
  const busy = client.busy, heldResults = worker.held.length;
  await h.advance(100); assert.equal(h.controller.diagnostics().state, "suspended");
  assert.equal((await h.status(oldIndex, "expired MUST NOT COMMIT")).ok, false, "expired leases still fence effects on idle and busy VMs");
  const killed = client.state === "failed";
  h.releaseRead(h.snapshot()); await until(() => !h.controller.diagnostics().fetchPending);
  if (!h.controller.diagnostics().failed) {
    await until(() => h.controller.diagnostics().running === 1);
    if (killed) await h.workers.at(-1)!.drain();
  }
  if (killed) {
    assert.equal((await h.status(oldIndex, "retired MUST NOT COMMIT")).ok, false, "renewal cannot revive the retired generation's SDK broker");
    worker.reply({ version: 1, type: "requests", actionId: worker.actionId, batchId: 1,
      requestsJson: JSON.stringify([{ sdkApiVersion: 1, requestId: "999", operation: "status.set", payload: { text: "late MUST NOT COMMIT" } }]) });
    worker.deliverHeld(); await worker.drain();
  }
  assert.equal(h.statuses.some(text => text.includes("MUST NOT COMMIT")), false);
  return { busy, killed, heldResults };
}

test("unchanged presence snapshots preserve the same idle VM across three lease lapses", async t => {
  const h = harness(t); await h.start(); const first = h.clients[0], rows = [];
  assert.equal(first.busy, false);
  for (let i = 0; i < 3; i++) rows.push(await lapse(h, false));
  assert.deepEqual({ starts: h.clients.length, kills: rows.filter(row => row.killed).length,
    busy: rows.filter(row => row.busy).length, held: rows.reduce((sum, row) => sum + row.heldResults, 0),
    snapshots: h.consumed.filter(type => type === "seating.snapshot").length,
    running: h.controller.diagnostics().running, failed: h.controller.diagnostics().failed, failure: h.controller.diagnostics().lastFailure },
  { starts: 1, kills: 0, busy: 0, held: 0, snapshots: 0, running: 1, failed: 0, failure: null });
  assert.equal(h.clients[0], first); assert.equal(first.busy, false);
  assert.equal((await h.status(0, "same idle VM resumed")).ok, true);
});

test("real changed snapshots in flight still terminate at expiry, fence old SDK effects and deny the fourth start", async t => {
  const h = harness(t); await h.start(); const rows = [];
  for (let i = 0; i < 3; i++) rows.push(await lapse(h, true));
  assert.deepEqual(rows, Array.from({ length: 3 }, () => ({ busy: true, killed: true, heldResults: 1 })));
  assert.equal(h.clients.length, 3); assert.equal(h.controller.diagnostics().failed, 1);
  assert.equal(h.controller.diagnostics().lastFailure, "host-unavailable");
  h.controller.kick(); await flush(); assert.equal(h.clients.length, 3, "the 3 / 600000 start budget remains sticky");
});

test("a correlated busy answer needs one forced unchanged snapshot for the real auto-seat scaffold to try the next candidate", async t => {
  const h = harness(t, { autoSeat: true }); await h.start();
  assert.deepEqual(h.claims.map(claim => claim.seat), ["seat-a"]);
  h.adapter.settleClaim({ seatId: "seat-a", accepted: false, commandId: h.claims[0].id }); h.world.pendingSeatId = null;
  h.controller.seatingChanged(); await flush(); await h.workers[0].drain(); await h.advance(100);
  assert.equal(h.workers[0].queue.length, 0); assert.equal(h.claims.length, 1, "unchanged ordinary presence is not a claim result");
  h.controller.seatingChanged(true); await h.advance(100); await h.workers[0].drain();
  assert.deepEqual(h.claims.map(claim => claim.seat), ["seat-a", "seat-b"]);
  h.adapter.settleClaim({ seatId: "seat-b", accepted: true, commandId: h.claims[1].id });
  h.world.pendingSeatId = null; h.world.currentSeatId = "seat-b"; h.world.occupancy = { "seat-b": "self" };
  h.controller.seatingChanged(); await flush(); await h.workers[0].drain(); await h.advance(100); await h.workers[0].drain();
  assert.equal(h.adapter.diagnostics().grant, "used"); assert.equal(h.claims.length, 2);
  assert.ok(h.responses.some(response => response.ok && response.result === "accepted"));
});

test("readiness and arrival expiry remain observable and a new generation receives room.ready", async t => {
  const h = harness(t, { allowArrival: true, ready: false }); await h.start();
  assert.equal(h.consumed.includes("room.ready"), false); assert.equal(h.adapter.diagnostics().grant, "waiting");
  h.world.ready = true; h.controller.seatingChanged(); await h.advance(100); await h.workers[0].drain();
  assert.equal(h.controller.diagnostics().readyDeliveries[0].arrivalAllowed, true);
  h.controller.seatingChanged(); await h.advance(100); assert.equal(h.workers[0].queue.length, 0);
  await h.advance(4800); h.controller.seatingChanged(); await h.advance(100);
  assert.equal(h.adapter.diagnostics().transitions.at(-1)?.reason, "window-expired");
  assert.equal(h.workers[0].queue[0].type, "event");
  const command = h.workers[0].queue[0]; assert.ok(command.type === "event" && command.event.type === "seating.snapshot");
  assert.equal(command.event.snapshot.arrivalAllowed, false); await h.workers[0].drain();
  await h.config(2); await h.workers[1].drain();
  assert.equal(h.controller.diagnostics().readyDeliveries[1].arrivalAllowed, false);
  assert.equal(h.consumed.filter(type => type === "room.ready").length, 2);
  assert.equal((await h.status(0, "retired MUST NOT COMMIT")).ok, false);
});

test("hidden idle instances stay fenced and an undelivered seating change is not lost on resume", async t => {
  const h = harness(t); await h.start();
  h.context.visible = false; h.controller.availabilityChanged();
  assert.equal((await h.status(0, "hidden MUST NOT COMMIT")).ok, false);
  h.world.seats = [{ id: "seat-a", yaw: 2 }]; h.controller.seatingChanged(); await h.advance(100);
  assert.equal(h.workers[0].queue.length, 0); assert.equal(h.clients[0].busy, false);
  h.context.visible = true; h.controller.availabilityChanged(); await until(() => h.controller.diagnostics().running === 1);
  h.controller.seatingChanged(); await h.advance(100);
  assert.equal(h.workers[0].queue.length, 1); await h.workers[0].drain();
  assert.equal(h.clients.length, 1); assert.equal((await h.status(0, "visible resumed")).ok, true);
  assert.equal(h.statuses.some(text => text.includes("MUST NOT COMMIT")), false);
});
