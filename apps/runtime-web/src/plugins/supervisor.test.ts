import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginSupervisor, type SandboxWorker } from "./supervisor.js";
import type { WorkerCommand, WorkerReply } from "./protocol.js";
import { SANDBOX_LIMITS, SandboxError } from "./limits.js";

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const approved = ["status.set"] as const;
const event = { sdkApiVersion: 1, type: "room.connection", state: "connected" } as const;
const request = (id: string, text = "plain") => ({ sdkApiVersion: 1, requestId: id, operation: "status.set", payload: { text } });
const turn = (requests: unknown[] = [], wasmMemoryBytes = SANDBOX_LIMITS.wasmInitialMemoryBytes) => JSON.stringify({ requests, executionMs: 1, jobs: 0, wasmMemoryBytes, lifecycle: requests.length ? "pending" : "fulfilled" });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class WorkerDouble implements SandboxWorker {
  onmessage: SandboxWorker["onmessage"] = null;
  onerror: SandboxWorker["onerror"] = null;
  onmessageerror: SandboxWorker["onmessageerror"] = null;
  commands: WorkerCommand[] = [];
  transfers: Transferable[][] = [];
  terminated = 0;
  autoCompleteResponses = true;
  postMessage(command: WorkerCommand, transfer: Transferable[]) {
    this.transfers.push([...transfer]); this.commands.push(command);
    if (command.type === "respond" && this.autoCompleteResponses) queueMicrotask(() => this.reply({ version: 1, type: "result", id: command.id, ok: true, turnJson: turn() }));
  }
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
test("trusted prepare can finish before any author source/action is sent", async () => {
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const preparing = instance.prepare(wasm); prepare(worker); await preparing;
  assert.equal(worker.commands.length, 1); assert.equal(worker.commands[0].type, "prepare");
  assert.equal(instance.state, "booting");
  const boot = instance.init(wasm, "private-author-source"); assert.equal(worker.commands.length, 2);
  worker.success(); await boot; instance.terminate();
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
    [Array.from({ length: 11 }, (_, i) => request(String(i + 1))), "bridge_rate_limit"]
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

test("events serialize and repeated state notifications coalesce instead of growing a host backlog", async () => {
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(); await boot;
  const first = instance.event(event);
  const queued = instance.event({ ...event, state: "reconnecting" });
  for (let i = 0; i < 34; i++) assert.equal(instance.event({ ...event, state: "disconnected" }), queued);
  assert.equal(worker.commands.length, 3); worker.success(); await first;
  const latest = worker.commands.at(-1)!; assert.equal(latest.type, "event");
  assert.equal(latest.type === "event" && JSON.parse(latest.eventJson).state, "disconnected");
  worker.success(); await queued; assert.equal(worker.commands.length, 4);
  assert.equal(worker.terminated, 0); instance.terminate();
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

test("async broker acknowledgement is required before init resolves or response continuation runs", async () => {
  const worker = new WorkerDouble(); worker.autoCompleteResponses = false;
  let reply!: (value: any) => void;
  const instance = new PluginSupervisor(worker, approved, undefined, { dispatch: () => new Promise(resolve => { reply = resolve; }) });
  let completed = false;
  const boot = instance.init(wasm, "").then(value => { completed = true; return value; });
  prepare(worker); worker.success(turn([request("1")])); await flush();
  assert.equal(completed, false); assert.equal(worker.commands.at(-1)!.type, "init");
  reply({ sdkApiVersion: 1, requestId: "1", ok: true, result: null }); await flush();
  const response = worker.commands.at(-1)!; assert.equal(response.type, "respond");
  assert.deepEqual(response.type === "respond" && JSON.parse(response.responsesJson), [{ sdkApiVersion: 1, requestId: "1", ok: true, result: null }]);
  assert.equal(completed, false); worker.success();
  const result = await boot;
  assert.equal(result.turnCount, 2); assert.equal(result.requestCount, 1); assert.equal(result.executionMs, 2); assert.equal(result.maxTurnExecutionMs, 1);
  instance.terminate();
});

test("finite lifecycle timeout aborts pending native work and late replies cannot resurrect a Worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = new WorkerDouble(); let signal!: AbortSignal, reply!: (value: any) => void;
  const instance = new PluginSupervisor(worker, approved, undefined, { clock: () => 0,
    dispatch: (_request, cancellation) => { signal = cancellation; return new Promise(resolve => { reply = resolve; }); } });
  const boot = instance.init(wasm, ""); const rejected = assert.rejects(boot, { code: "lifecycle_timeout" });
  prepare(worker); worker.success(turn([request("1")])); await flush();
  t.mock.timers.tick(5000); await rejected; assert.equal(signal.aborted, true); assert.equal(worker.terminated, 1);
  reply({ sdkApiVersion: 1, requestId: "1", ok: true, result: null }); await flush(); assert.equal(worker.commands.length, 2);
});

test("broker failures and wrong response IDs are fixed host errors, not fabricated guest errors", async () => {
  for (const dispatch of [
    () => { throw new Error("private host details"); },
    () => Promise.reject(new Error("private host details")),
    () => ({ sdkApiVersion: 1, requestId: "other", ok: true, result: null })
  ]) {
    const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved, undefined, { dispatch: dispatch as never });
    const rejected = assert.rejects(instance.init(wasm, ""), { code: "host_error" });
    prepare(worker); worker.success(turn([request("1")])); await rejected; assert.equal(worker.terminated, 1);
  }
});

test("dispose never commits a queued SDK status and cancelling pending init terminates immediately", async () => {
  const worker = new WorkerDouble(), effects: string[] = [];
  const instance = new PluginSupervisor(worker, approved, item => effects.push(item.payload.text));
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(); await boot;
  const disposing = instance.dispose(); worker.success(turn([request("1", "must not commit")])); await disposing;
  assert.deepEqual(effects, []);
  const response = worker.commands.at(-1)!;
  assert.equal(response.type === "respond" && JSON.parse(response.responsesJson)[0].error, "cancelled");
  assert.equal(instance.state, "disposed");
  const pendingWorker = new WorkerDouble(), pending = new PluginSupervisor(pendingWorker, approved, undefined, { dispatch: () => new Promise(() => {}) });
  const rejected = assert.rejects(pending.init(wasm, ""), { code: "instance_closed" });
  prepare(pendingWorker); pendingWorker.success(turn([request("1")])); await flush();
  await assert.rejects(pending.dispose(), { code: "instance_closed" }); await rejected; assert.equal(pendingWorker.terminated, 1);
});

test("Worker request IDs are monotonic across turns and cannot forge host-only failure codes", async () => {
  const worker = new WorkerDouble(), effects: string[] = [], instance = new PluginSupervisor(worker, approved, item => effects.push(item.payload.text));
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(turn([request("2")])); await boot;
  const repeated = assert.rejects(instance.event(event), { code: "worker_protocol" }); worker.success(turn([request("2")])); await repeated;
  assert.equal(effects.length, 1);
  const forged = new WorkerDouble(), other = new PluginSupervisor(forged, approved);
  const rejected = assert.rejects(other.init(wasm, ""), { code: "worker_protocol" }); prepare(forged);
  forged.reply({ version: 1, type: "result", id: forged.commands.at(-1)!.id, ok: false, failure: "host_error" }); await rejected;
});

test("one rejected or throwing broker call cancels every other in-flight call in the batch", async () => {
  for (const synchronous of [false, true]) {
    const worker = new WorkerDouble(); let pendingSignal!: AbortSignal;
    const instance = new PluginSupervisor(worker, approved, undefined, { dispatch: (item, signal) => {
      if (item.requestId === "1") { pendingSignal = signal; return new Promise(() => {}); }
      if (synchronous) throw new SandboxError("execution_timeout");
      return Promise.reject(new SandboxError("execution_timeout"));
    } });
    const rejected = assert.rejects(instance.init(wasm, ""), { code: "host_error" });
    prepare(worker); worker.success(turn([request("1"), request("2")])); await rejected;
    assert.equal(pendingSignal.aborted, true); assert.equal(worker.terminated, 1);
  }
});

test("coalescing mixed snapshot/ready events preserves the order of the latest observations", async () => {
  const worker = new WorkerDouble(), instance = new PluginSupervisor(worker, approved);
  const boot = instance.init(wasm, ""); prepare(worker); worker.success(); await boot;
  const active = instance.event(event), snapshot = { ownParticipantAlias: "own", arrivalAllowed: false, seats: [] };
  const first = instance.event({ sdkApiVersion: 1, type: "seating.snapshot", snapshot });
  const ready = instance.event({ sdkApiVersion: 1, type: "room.ready", snapshot });
  assert.equal(instance.event({ sdkApiVersion: 1, type: "seating.snapshot", snapshot: { ...snapshot, arrivalAllowed: true } }), first);
  worker.success(); await active;
  let command = worker.commands.at(-1)!; assert.equal(command.type === "event" && JSON.parse(command.eventJson).type, "room.ready");
  worker.success(); await ready;
  command = worker.commands.at(-1)!; assert.equal(command.type === "event" && JSON.parse(command.eventJson).snapshot.arrivalAllowed, true);
  worker.success(); await first; instance.terminate();
});

test("a guest-driven chain exhausts a finite lifecycle, not a supposedly innocent host failure", async () => {
  class ChainingWorker extends WorkerDouble {
    nextRequest = 2;
    override postMessage(command: WorkerCommand, transfer: Transferable[]) {
      this.autoCompleteResponses = false; super.postMessage(command, transfer);
      if (command.type === "respond") queueMicrotask(() => this.reply({ version: 1, type: "result", id: command.id, ok: true,
        turnJson: turn([request(String(this.nextRequest++))]) }));
    }
  }
  let now = 0, calls = 0; const worker = new ChainingWorker();
  const instance = new PluginSupervisor(worker, approved, undefined, { clock: () => now,
    dispatch: item => { calls++; now += 500; return { sdkApiVersion: 1, requestId: item.requestId, ok: true, result: null }; } });
  const rejected = assert.rejects(instance.init(wasm, ""), { code: "lifecycle_timeout" });
  prepare(worker); worker.success(turn([request("1")])); await rejected;
  assert.ok(calls > 2); assert.equal(worker.terminated, 1);
});
test("abort listeners cannot overwrite a broker failure with instance_closed", async () => {
  const worker = new WorkerDouble(); let instance: PluginSupervisor;
  instance = new PluginSupervisor(worker, approved, undefined, { dispatch: (_request, signal) => {
    signal.addEventListener("abort", () => instance.terminate()); throw new Error("fixed host failure");
  } });
  const rejected = assert.rejects(instance.init(wasm, ""), { code: "host_error" });
  prepare(worker); worker.success(turn([request("1")])); await rejected; assert.equal(instance.failure, "host_error");
});
