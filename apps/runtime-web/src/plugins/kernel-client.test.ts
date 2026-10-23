import test from "node:test";
import assert from "node:assert/strict";
import { PluginKernelClient, type KernelWorker } from "./kernel-client.js";
import type { KernelCommand, KernelReply } from "./kernel-protocol.js";
import { KERNEL_TERMINATE_ACK_MS, KERNEL_TRANSPORT_TIMEOUT_MS } from "./kernel-protocol.js";
import { SANDBOX_LIMITS } from "./limits.js";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const stats = () => ({ requests: [], executionMs: 1, jobs: 0, wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes,
  lifecycle: "fulfilled" as const, maxTurnExecutionMs: 1, turnCount: 1, requestCount: 0 });
class WorkerDouble implements KernelWorker {
  onmessage: KernelWorker["onmessage"] = null; onerror: KernelWorker["onerror"] = null; onmessageerror: KernelWorker["onmessageerror"] = null;
  commands: KernelCommand[] = []; terminated = 0;
  postMessage(command: KernelCommand) { this.commands.push(command); }
  terminate() { this.terminated++; }
  reply(message: KernelReply) { this.onmessage?.({ data: message } as MessageEvent<KernelReply>); }
  id() { const command = this.commands.at(-1)!; assert.ok("id" in command); return command.id; }
  prepared() { this.reply({ version: 1, type: "prepared", id: this.id(), wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes,
    startupTiming: { moduleAgeMs: 2, prepareMs: 3 } }); }
  success() { this.reply({ version: 1, type: "result", id: this.id(), result: stats() }); }
  close() { this.reply({ version: 1, type: "closed" }); }
  requests(id: number, requestId = "1") { this.reply({ version: 1, type: "requests", actionId: id, batchId: 1,
    requestsJson: JSON.stringify([{ sdkApiVersion: 1, requestId, operation: "status.set", payload: { text: "literal" } }]) }); }
}

test("two-phase prepare sends no author source and only then opens the native effect window", async () => {
  let now = 0; const worker = new WorkerDouble(), effects: string[] = [];
  const client = new PluginKernelClient(worker, ["status.set"], item => effects.push(item.payload.text), { clock: () => now });
  const boot = client.init(module, "private-author-source", { label: "owned" });
  assert.equal(worker.commands.length, 1); assert.equal(worker.commands[0].type, "prepare");
  assert.equal(JSON.stringify(worker.commands[0]).includes("private-author-source"), false);
  now = 7000; worker.prepared(); await flush();
  assert.equal(worker.commands.at(-1)!.type, "init"); const id = worker.id();
  now = 7001; worker.requests(id); await flush(); assert.deepEqual(effects, ["literal"]);
  assert.equal(worker.commands.at(-1)!.type, "respond");
  worker.reply({ version: 1, type: "result", id, result: stats() }); await boot;
  assert.equal(client.state, "ready"); assert.deepEqual(client.startupTiming, { moduleAgeMs: 2, prepareMs: 3, prepareRoundTripMs: 7000, wasmLoadMs: null });
  client.terminate(); worker.close();
});

test("a stale queued SDK message cannot commit even if a binding lease was renewed", async () => {
  let now = 0; const worker = new WorkerDouble(), effects: string[] = [];
  const client = new PluginKernelClient(worker, ["status.set"], item => effects.push(item.payload.text), { clock: () => now });
  const boot = client.init(module, "source"); const failed = assert.rejects(boot, { code: "lifecycle_timeout" });
  worker.prepared(); await flush(); const id = worker.id(); now = 5000;
  worker.requests(id); await flush(); assert.deepEqual(effects, []);
  const response = worker.commands.at(-1)!;
  assert.equal(response.type === "respond" && JSON.parse(response.responsesJson)[0].error, "cancelled");
  worker.reply({ version: 1, type: "failed", id, channel: "sandbox", failure: "lifecycle_timeout" }); await failed;
  assert.equal(client.failure, "lifecycle_timeout"); worker.close();
});

test("action liveness is rechecked at the final native status commit, not just message entry", async () => {
  let now = 0; const worker = new WorkerDouble(), effects: string[] = [];
  const client = new PluginKernelClient(worker, ["status.set"], undefined, { clock: () => now,
    dispatch: (request, _signal, canCommit) => {
      now = 5000; if (canCommit()) effects.push("MUST NOT COMMIT");
      return { sdkApiVersion: 1, requestId: request.requestId, ok: false, error: "cancelled" };
    } });
  const boot = client.init(module, "source"); const failed = assert.rejects(boot, { code: "instance_closed" });
  worker.prepared(); await flush(); const id = worker.id(); worker.requests(id); await flush();
  assert.deepEqual(effects, []); client.terminate(); await failed; worker.close();
});

test("termination fences synchronously, sends stop first, and closes outer only after child-stop ACK", async () => {
  const worker = new WorkerDouble(), client = new PluginKernelClient(worker, []);
  const boot = client.init(module, "source"); const failed = assert.rejects(boot, { code: "instance_closed" });
  client.terminate(); await failed;
  assert.equal(worker.commands.at(-1)!.type, "terminate"); assert.equal(worker.terminated, 0);
  worker.close(); assert.equal(worker.terminated, 1);
});

test("a missing outer ACK has a bounded fallback separate from all guest security budgets", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = new WorkerDouble(), client = new PluginKernelClient(worker, []);
  const failed = assert.rejects(client.init(module, "source"), { code: "kernel-transport-timeout" });
  t.mock.timers.tick(KERNEL_TRANSPORT_TIMEOUT_MS); await failed;
  assert.equal(worker.terminated, 0); assert.equal(worker.commands.at(-1)!.type, "terminate");
  t.mock.timers.tick(KERNEL_TERMINATE_ACK_MS); assert.equal(worker.terminated, 1);
  assert.equal(SANDBOX_LIMITS.workerResponseDeadlineMs, 500); assert.equal(SANDBOX_LIMITS.workerModuleLoadDeadlineMs, 3000);
});

test("broker failure aborts other native batch work and no token/binding metadata crosses the channel", async () => {
  const worker = new WorkerDouble(); let signal!: AbortSignal;
  const client = new PluginKernelClient(worker, ["status.set"], undefined, { dispatch: (request, cancellation) => {
    if (request.requestId === "1") { signal = cancellation; return new Promise(() => {}); }
    throw new Error("private-native-token-and-error");
  } });
  const boot = client.init(module, "source"); const failed = assert.rejects(boot, { code: "host_error" });
  worker.prepared(); await flush(); const id = worker.id();
  worker.reply({ version: 1, type: "requests", actionId: id, batchId: 1, requestsJson: JSON.stringify([1, 2].map(value => ({
    sdkApiVersion: 1, requestId: String(value), operation: "status.set", payload: { text: "plain" }
  }))) });
  await failed; assert.equal(signal.aborted, true);
  const bytes = JSON.stringify(worker.commands); assert.equal(bytes.includes("private-native-token"), false); assert.equal(bytes.includes("bindingId"), false);
  worker.close();
});

test("successful dispose waits for the explicit child-stop closure acknowledgement", async () => {
  const worker = new WorkerDouble(), client = new PluginKernelClient(worker, []);
  const boot = client.init(module, "source"); worker.prepared(); await flush(); worker.success(); await boot;
  const disposed = client.dispose(); worker.success(); await disposed;
  assert.equal(client.state, "disposed"); assert.equal(worker.terminated, 0);
  worker.close(); assert.equal(worker.terminated, 1);
});

test("cancelled native batches stop waiting and consume a late rejection without sending a response", async () => {
  const worker = new WorkerDouble(); let reject!: (error: Error) => void, signal!: AbortSignal;
  const client = new PluginKernelClient(worker, ["status.set"], undefined, { dispatch: (_request, cancellation) => {
    signal = cancellation; return new Promise((_resolve, no) => { reject = no; });
  } });
  const boot = client.init(module, "source"), failed = assert.rejects(boot, { code: "lifecycle_timeout" });
  worker.prepared(); await flush(); const id = worker.id(); worker.requests(id); await flush();
  worker.reply({ version: 1, type: "cancel", actionId: id, batchId: 1 }); await flush();
  assert.equal(signal.aborted, true);
  reject(new Error("late private host failure")); await flush();
  assert.equal(worker.commands.at(-1)!.type, "init"); assert.equal(client.state, "booting");
  worker.reply({ version: 1, type: "failed", id, channel: "sandbox", failure: "lifecycle_timeout" }); await failed; worker.close();
});

test("facade broker errors are fixed before reentrant abort listeners can overwrite them", async () => {
  const worker = new WorkerDouble(); let client: PluginKernelClient;
  client = new PluginKernelClient(worker, ["status.set"], undefined, { dispatch: (_request, signal) => {
    signal.addEventListener("abort", () => client.terminate()); throw new Error("private host failure");
  } });
  const boot = client.init(module, "source"), failed = assert.rejects(boot, { code: "host_error" });
  worker.prepared(); await flush(); worker.requests(worker.id()); await failed;
  assert.equal(client.failure, "host_error"); worker.close();
});

test("facade event coalescing preserves latest-observation order and a single promise per queued type", async () => {
  const worker = new WorkerDouble(), client = new PluginKernelClient(worker, []);
  const boot = client.init(module, "source"); worker.prepared(); await flush(); worker.success(); await boot;
  const active = client.event({ sdkApiVersion: 1, type: "room.connection", state: "connected" });
  const snapshot = { ownParticipantAlias: "own", arrivalAllowed: false, seats: [] };
  const seating = client.event({ sdkApiVersion: 1, type: "seating.snapshot", snapshot });
  const ready = client.event({ sdkApiVersion: 1, type: "room.ready", snapshot });
  assert.equal(client.event({ sdkApiVersion: 1, type: "seating.snapshot", snapshot: { ...snapshot, arrivalAllowed: true } }), seating);
  worker.success(); await active;
  let command = worker.commands.at(-1)!; assert.ok(command.type === "event"); assert.equal(command.event.type, "room.ready");
  worker.success(); await ready;
  command = worker.commands.at(-1)!; assert.ok(command.type === "event" && command.event.type === "seating.snapshot"); assert.equal(command.event.snapshot.arrivalAllowed, true);
  worker.success(); await seating; client.terminate(); worker.close();
});

test("the facade validates the entire SDK batch before any native effect", async () => {
  const worker = new WorkerDouble(), effects: string[] = [];
  const client = new PluginKernelClient(worker, ["status.set"], item => effects.push(item.payload.text));
  const boot = client.init(module, "source"), failed = assert.rejects(boot, { code: "kernel-protocol" });
  worker.prepared(); await flush();
  worker.reply({ version: 1, type: "requests", actionId: worker.id(), batchId: 1, requestsJson: JSON.stringify([
    { sdkApiVersion: 1, requestId: "1", operation: "status.set", payload: { text: "MUST NOT COMMIT" } },
    { sdkApiVersion: 1, requestId: "2", operation: "status.set", payload: { text: "wrong" }, participantId: "foreign" }
  ]) });
  await failed; assert.deepEqual(effects, []); worker.close();
});
