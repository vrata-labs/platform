import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginSupervisor, type SandboxWorker } from "./supervisor.js";
import type { WorkerCommand, WorkerReply } from "./protocol.js";
import { SANDBOX_LIMITS } from "./limits.js";

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const approved = ["status.set"] as const;
const event = { sdkApiVersion: 1, type: "room.connection", state: "connected" } as const;
const request = (id: string, text = "plain") => ({ sdkApiVersion: 1, requestId: id, operation: "status.set", payload: { text } });
const turn = (requests: unknown[] = [], wasmMemoryBytes = SANDBOX_LIMITS.wasmInitialMemoryBytes) => JSON.stringify({ requests, executionMs: 1, jobs: 0, wasmMemoryBytes });

class WorkerDouble implements SandboxWorker {
  onmessage: SandboxWorker["onmessage"] = null;
  onerror: SandboxWorker["onerror"] = null;
  onmessageerror: SandboxWorker["onmessageerror"] = null;
  commands: WorkerCommand[] = [];
  transfers: Transferable[][] = [];
  terminated = 0;
  postMessage(command: WorkerCommand, transfer: Transferable[]) { this.transfers.push([...transfer]); this.commands.push(command); }
  terminate() { this.terminated++; }
  reply(reply: WorkerReply) { this.onmessage?.({ data: reply } as MessageEvent<WorkerReply>); }
  hello() { this.reply({ version: 1, type: "hello" }); }
  prepared() { this.reply({ version: 1, type: "prepared", id: this.commands.at(-1)!.id, wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes }); }
  success(turnJson = turn()) { this.reply({ version: 1, type: "result", id: this.commands.at(-1)!.id, ok: true, turnJson }); }
}
function prepare(worker: WorkerDouble) { worker.hello(); worker.prepared(); }

test("hello/module boot has a 3000ms budget before any 500ms guest-execution watchdog", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const boot = instance.init(wasm, "export function init() {}");
  t.mock.timers.tick(600);
  assert.equal(worker.commands.length, 0, "no guest source before hello");
  worker.hello();
  assert.equal(worker.commands[0].type, "prepare");
  assert.ok(!("source" in worker.commands[0]), "prepare cannot execute guest code");
  t.mock.timers.tick(1000);
  assert.equal(instance.state, "booting");
  worker.prepared();
  assert.equal(worker.commands[1].type, "init");
  assert.deepEqual(worker.transfers, [[], []]);
  const rejected = assert.rejects(boot, { code: "worker_timeout" });
  t.mock.timers.tick(500); await rejected;
  assert.equal(worker.terminated, 1);
  worker.success();
  await assert.rejects(instance.init(wasm, ""), { code: "instance_closed" });
});

test("stalled hello or module prepare terminates on the single finite boot deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const hello of [false, true]) {
    const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
    const rejected = assert.rejects(instance.init(wasm, ""), { code: "worker_boot_timeout" });
    if (hello) worker.hello();
    t.mock.timers.tick(3000); await rejected;
    assert.equal(worker.terminated, 1);
  }
});

test("missing approvals reject closed; empty approvals deny a forged Worker status", async () => {
  const missing = new WorkerDouble();
  assert.throws(() => new PluginSupervisor(missing, undefined as never), { code: "invalid_input" });
  assert.equal(missing.terminated, 1);
  const worker = new WorkerDouble();
  const effects: string[] = [];
  const instance = new PluginSupervisor(worker, [], (item) => effects.push(item.payload.text));
  const rejected = assert.rejects(instance.init(wasm, ""), { code: "capability_denied" });
  prepare(worker); worker.success(turn([request("1")])); await rejected;
  assert.deepEqual(effects, []);
});

test("entire turn is checked before any effect, including later invalid/unapproved/rate-limited requests", async () => {
  for (const [requests, code] of [
    [[request("1"), { ...request("2"), payload: { text: 1 } }], "worker_protocol"],
    [[request("1"), { sdkApiVersion: 1, requestId: "2", operation: "seating.claimSelfOnEntry", payload: { seatId: "seat-1" } }], "capability_denied"],
    [[request("1"), request("2"), request("3")], "status_rate_limit"],
    [Array.from({ length: 11 }, (_, i) => request(String(i))), "bridge_rate_limit"]
  ] as const) {
    const worker = new WorkerDouble();
    const statuses: string[] = [];
    const instance = new PluginSupervisor(worker, approved, (item) => statuses.push(item.payload.text));
    const rejected = assert.rejects(instance.init(wasm, ""), { code });
    prepare(worker); worker.success(turn([...requests])); await rejected;
    assert.deepEqual(statuses, []);
  }
});

test("native rolling status quotas use host time, survive turns, and expire at 1000ms", async () => {
  let now = 0;
  const worker = new WorkerDouble(), statuses: string[] = [];
  const instance = new PluginSupervisor(worker, approved, (item) => statuses.push(item.payload.text), { clock: () => now });
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(turn([request("1")])); await boot;
  now = 999;
  const event1 = instance.event(event); worker.success(turn([request("2")])); await event1;
  now = 1000;
  const event2 = instance.event(event); worker.success(turn([request("3")])); await event2;
  assert.equal(statuses.length, 3);
  now = 1001;
  const rejected = assert.rejects(instance.event(event), { code: "status_rate_limit" });
  worker.success(turn([request("4")])); await rejected;
  assert.equal(statuses.length, 3);
});

test("events serialize; backlog >32 fails all pending work", async () => {
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(); await boot;
  const results = await Promise.all(Array.from({ length: 34 }, () => instance.event(event).catch((error: unknown) => error)));
  assert.ok(results.every((error) => error && typeof error === "object" && "code" in error && error.code === "host_queue_limit"));
  assert.equal(worker.commands.length, 3); assert.equal(worker.terminated, 1);
});

test("invalid event is a rejected Promise, not a synchronous throw or instance failure", async () => {
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(); await boot;
  let result: Promise<unknown> | undefined;
  assert.doesNotThrow(() => { result = instance.event({ invalid: true } as never); });
  await assert.rejects(result!, { code: "invalid_input" });
  assert.equal(instance.state, "ready"); assert.equal(worker.commands.length, 2); instance.terminate();
});

test("successful DTO applies plain text and dispose terminates; reentrant sink cannot resurrect boot", async () => {
  const worker = new WorkerDouble(), statuses: string[] = [];
  const instance = new PluginSupervisor(worker, approved, (item) => statuses.push(item.payload.text));
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(turn([request("1", "<b>plain</b>")])); await boot;
  assert.deepEqual(statuses, ["<b>plain</b>"]);
  const disposed = instance.dispose(); worker.success(); await disposed;
  assert.equal(instance.state, "disposed"); assert.equal(worker.terminated, 1);
  const reentrant = new WorkerDouble();
  let other: PluginSupervisor;
  other = new PluginSupervisor(reentrant, approved, () => other.terminate());
  const rejected = assert.rejects(other.init(wasm, ""), { code: "instance_closed" });
  prepare(reentrant); reentrant.success(turn([request("1")])); await rejected;
  assert.equal(other.state, "failed");
});

test("oversized DTO, >48MiB WASM report and mismatched ready fail before effects", async () => {
  for (const json of ["x".repeat(SANDBOX_LIMITS.messageBytes + 1), turn([request("1")], SANDBOX_LIMITS.wasmMaxMemoryBytes + 65536)]) {
    const worker = new WorkerDouble(), effects: string[] = [];
    const instance = new PluginSupervisor(worker, approved, (item) => effects.push(item.payload.text));
    const rejected = assert.rejects(instance.init(wasm, ""), { code: "worker_protocol" });
    prepare(worker); worker.success(json); await rejected;
    assert.deepEqual(effects, [], "protocol rejection must not hide a committed effect");
  }
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const rejected = assert.rejects(instance.init(wasm, ""), { code: "worker_protocol" });
  worker.hello(); worker.reply({ version: 1, type: "prepared", id: 999, wasmMemoryBytes: 16777216 }); await rejected;
});

test("invalid source/config are rejected before cloning; Worker validator failure is preserved", async () => {
  for (const [source, config] of [["x".repeat(SANDBOX_LIMITS.artifactBytes + 1), {}], ["", { value: "x".repeat(SANDBOX_LIMITS.configBytes + 1) }]] as const) {
    const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
    await assert.rejects(instance.init(wasm, source, config), { code: "invalid_input" });
    assert.equal(worker.commands.length, 0); assert.equal(worker.terminated, 1);
  }
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const rejected = assert.rejects(instance.init(wasm, ""), { code: "invalid_input" });
  worker.hello(); worker.reply({ version: 1, type: "result", id: 1, ok: false, failure: "invalid_input" }); await rejected;
});
