import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionBudget, SandboxError, SANDBOX_LIMITS, type SandboxFailure } from "./limits.js";
import { RESOURCE_PROBE_LIMITS as LIMITS, type ResourceObservation, type ResourcePhase } from "./resource-probe-contract.js";
import { runResourceProbe, type ResourceProbeDependencies } from "./resource-probe-runner.js";
import type { InstanceState } from "./supervisor.js";
import type { VmTurn } from "./vm.js";

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const metadata = { runId: "unit-run", startedAt: "2026-10-06T10:00:00.000Z", device: {
  category: "other" as const, userAgent: "unit", language: "ru", viewport: { width: 1280, height: 720, pixelRatio: 1 }
} };
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

/** Virtual waits exist only in this test; concurrent sleeps share one timeline,
 * rather than each caller advancing the clock independently. */
class Timeline {
  now = 0;
  private nextId = 0;
  pending = new Map<number, { due: number; finish: () => void }>();
  sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const id = ++this.nextId;
    const finish = () => { this.pending.delete(id); signal.removeEventListener("abort", finish); resolve(); };
    this.pending.set(id, { due: this.now + ms, finish });
    signal.addEventListener("abort", finish, { once: true });
  });
  advance() {
    assert.ok(this.pending.size > 0, "campaign must have bounded pending work");
    this.now = Math.min(...[...this.pending.values()].map((job) => job.due));
    for (const job of [...this.pending.values()]) if (job.due <= this.now) job.finish();
  }
  async finish<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 6000; i++) {
      await flush();
      if (done) return promise;
      this.advance();
    }
    assert.fail("campaign failed to terminate within its bounded workload");
  }
}

type TurnKind = "init" | "event" | "dispose";
type WorkKind = "healthy" | "second" | "minute";
interface Options {
  before?: (instance: SupervisorDouble, kind: TurnKind) => void;
  error?: (instance: SupervisorDouble, kind: TurnKind) => unknown;
  duration?: (instance: SupervisorDouble, kind: TurnKind) => number;
  disableBudget?: boolean;
}
class SupervisorDouble {
  state: InstanceState = "booting";
  failure: SandboxFailure | undefined;
  wasmMemoryBytes: number | undefined;
  source = "";
  kind: WorkKind = "healthy";
  events = 0;
  inFlight = 0;
  terminated = 0;
  eventStarts: number[] = [];
  calls: TurnKind[] = [];
  module: WebAssembly.Module | undefined;
  private stop = new AbortController();
  private budget = new ExecutionBudget();
  constructor(readonly id: number, readonly timeline: Timeline, readonly options: Options) {}
  async init(module: WebAssembly.Module, source: string): Promise<VmTurn> {
    this.module = module; this.source = source;
    this.kind = source.includes("< 30") ? "second" : source.includes("< 12") ? "minute" : "healthy";
    const result = await this.execute("init");
    this.state = "ready";
    return result;
  }
  event(event: unknown): Promise<VmTurn> {
    assert.deepEqual(event, { sdkApiVersion: 1, type: "room.connection", state: "connected" });
    assert.equal(this.state, "ready");
    this.events++; this.eventStarts.push(this.timeline.now);
    return this.execute("event");
  }
  async dispose(): Promise<VmTurn> {
    assert.equal(this.inFlight, 0, "runner must join outstanding companion ACK before dispose");
    this.state = "disposing";
    const result = await this.execute("dispose");
    this.state = "disposed"; this.terminated++;
    this.stop.abort();
    return result;
  }
  terminate() {
    if (this.state === "failed" || this.state === "disposed") return;
    this.state = "failed"; this.failure ??= "instance_closed";
    this.terminated++; this.stop.abort();
  }
  fail(code: SandboxFailure) { this.failure = code; this.terminate(); }
  private async execute(kind: TurnKind): Promise<VmTurn> {
    this.calls.push(kind); this.inFlight++;
    try {
      this.options.before?.(this, kind);
      const executionMs = kind === "event" ? this.kind === "second" ? 30 : this.kind === "minute" ? 12 : 1 : 1;
      const duration = this.options.duration?.(this, kind) ?? (kind === "init" ? 7 : kind === "dispose" ? 2 : executionMs);
      await this.timeline.sleep(duration, this.stop.signal);
      if (this.stop.signal.aborted) throw new SandboxError(this.failure ?? "instance_closed");
      const customError = this.options.error?.(this, kind);
      if (customError !== undefined) throw customError;
      if (kind === "event" && !this.options.disableBudget) {
        const code = this.budget.charge(this.timeline.now, executionMs);
        if (code) throw new SandboxError(code);
      }
      this.wasmMemoryBytes = SANDBOX_LIMITS.wasmInitialMemoryBytes + (this.id % 3) * 65536;
      return { requests: [], executionMs, jobs: 0, wasmMemoryBytes: this.wasmMemoryBytes };
    } catch (error) {
      this.failure = error instanceof SandboxError ? error.code : "native_failure";
      this.terminate();
      throw error;
    } finally { this.inFlight--; }
  }
}

function harness(options: Options = {}) {
  const timeline = new Timeline(), instances: SupervisorDouble[] = [];
  const progress: { phase: ResourcePhase; completed: number; total: number }[] = [];
  let loads = 0;
  const deps: ResourceProbeDependencies = {
    async loadWasm() { loads++; await timeline.sleep(5, new AbortController().signal); return wasm; },
    createInstance() { const instance = new SupervisorDouble(instances.length, timeline, options); instances.push(instance); return instance; },
    clock: () => timeline.now, sleep: timeline.sleep, crossOriginIsolated: false,
    onProgress(phase, completed, total) { progress.push({ phase, completed, total }); }
  };
  return { timeline, instances, deps, progress, get loads() { return loads; } };
}
function clean(result: ResourceObservation, h: ReturnType<typeof harness>) {
  assert.equal(result.activeAfterCleanup, 0);
  assert.equal(result.instancesCreated, h.instances.length);
  assert.equal(result.instancesClosed, h.instances.length);
  assert.ok(h.instances.every((instance) => instance.terminated === 1 && instance.inFlight === 0));
  assert.equal(h.timeline.pending.size, 0, "all injected sleep timers and listeners are released");
}

test("fixed campaign: 100 sequential cycles, concurrent buffers, real-shaped 60s timeline and both unchanged VM budgets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  const checkpoints: { phase: string; active: number; cycleCalls: TurnKind[] }[] = [];
  h.deps.readBrowserMemory = async (phase) => {
    checkpoints.push({ phase, active: h.instances.filter((instance) => instance.state === "ready").length,
      cycleCalls: [...(h.instances[1]?.calls ?? [])] });
    return { phase, status: "MEASURED", bytes: 123456 };
  };
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, null); assert.equal(result.failure, null); assert.equal(result.companionFailure, null); assert.equal(result.ui, null);
  assert.equal(result.runId, metadata.runId); assert.equal(result.device, metadata.device);
  assert.ok(result.completedAt); assert.equal(result.wasmLoadWallMs, 5); assert.equal(h.loads, 1);
  assert.equal(result.instancesCreated, 104);
  assert.deepEqual(checkpoints.map(({ phase, active }) => ({ phase, active })), [
    { phase: "baseline", active: 0 }, { phase: "two-instances", active: 2 }, { phase: "after-cleanup", active: 0 }
  ]);
  assert.deepEqual(checkpoints[1].cycleCalls, ["init"], "memory checkpoint happens before event/dispose");
  assert.deepEqual(result.browserMemory.samples.map((sample) => sample.status), ["MEASURED", "MEASURED", "MEASURED"]);
  assert.equal(result.cycles.length, 100);
  for (const [index, cycle] of result.cycles.entries()) {
    assert.equal(cycle.index, index + 1); assert.equal(cycle.phase, "complete"); assert.equal(cycle.failure, null);
    assert.equal(cycle.state, "disposed"); assert.equal(cycle.activeDuring, 2); assert.equal(cycle.activeAfter, 1);
    assert.equal(cycle.init?.wallMs, 7); assert.equal(cycle.init?.executionMs, 1);
    assert.equal(cycle.event?.wallMs, 1); assert.equal(cycle.dispose?.wallMs, 2);
    assert.deepEqual(cycle.overlappingLinear, { primaryBytes: h.instances[index + 1].wasmMemoryBytes,
      companionBytes: h.instances[0].wasmMemoryBytes });
  }
  assert.equal(result.sustained?.phase, "complete"); assert.equal(result.sustained?.failure, null);
  assert.ok(result.sustained!.elapsedMs >= 60000);
  assert.ok(result.sustained!.turns.length >= 200);
  for (const row of [result.sustained!, result.secondBudget!, result.minuteBudget!]) {
    assert.ok(row.turns.length <= 280);
    for (let i = 1; i < row.turns.length; i++) assert.ok(row.turns[i].endedOffsetMs - row.turns[i - 1].endedOffsetMs >= 250);
  }
  assert.equal(result.secondBudget?.phase, "event"); assert.equal(result.secondBudget?.failure, "execution_budget_second");
  assert.equal(result.secondBudget?.state, "failed"); assert.ok(result.secondBudget!.elapsedMs < 5000);
  assert.equal(result.minuteBudget?.phase, "event"); assert.equal(result.minuteBudget?.failure, "execution_budget_minute");
  assert.equal(result.minuteBudget?.state, "failed"); assert.ok(result.minuteBudget!.elapsedMs < 70000);
  assert.equal(result.secondBudget!.turns.length, 3);
  assert.equal(result.minuteBudget!.turns.length, 166);
  assert.ok(result.companionPings.length > 300 && result.companionPings.length <= 1200);
  assert.ok(result.companionPings.every((ping) => ping.failure === null && ping.latencyMs === 1));
  for (let i = 1; i < result.companionPings.length; i++) assert.ok(result.companionPings[i].sentOffsetMs - result.companionPings[i - 1].sentOffsetMs >= 250);
  for (const phase of ["cycles", "sustained", "budget-second", "budget-minute"]) assert.ok(result.companionPings.some((ping) => ping.phase === phase));
  assert.ok(h.instances.every((instance) => instance.module === wasm));
  assert.equal(new Set(h.instances.map((instance) => instance.source)).size, 3);
  assert.ok(h.instances.every((instance) => !instance.source.includes("status") && !instance.source.includes(metadata.runId)));
  assert.equal(h.progress.at(-1)?.phase, "complete");
  clean(result, h);
  const progressCount = h.progress.length;
  t.mock.timers.tick(300000);
  assert.equal(result.abort, null); assert.equal(h.progress.length, progressCount, "no native timer survives cleanup");
});

test("a failed cycle stops further allocation and retains its actual phase/code", async () => {
  const h = harness({ error: (instance, kind) => instance.id === 3 && kind === "event" ? new SandboxError("worker_timeout") : undefined });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.cycles.length, 3); assert.equal(result.cycles[2].phase, "event");
  assert.equal(result.cycles[2].failure, "worker_timeout"); assert.equal(result.failure, "worker_timeout");
  assert.equal(result.companionFailure, null, "terminating companion after a primary failure is not a companion cause");
  assert.equal(result.sustained, null); assert.equal(result.instancesCreated, 4);
  clean(result, h);
});

for (const failedPhase of ["init", "dispose"] as const) {
  test(`cycle ${failedPhase} failure closes all owned instances without starting the next cycle`, async () => {
    const h = harness({ error: (instance, kind) => instance.id === 1 && kind === failedPhase
      ? new SandboxError("worker_error") : undefined });
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].phase, failedPhase);
    assert.equal(result.cycles[0].failure, "worker_error"); assert.equal(result.failure, "worker_error");
    assert.equal(result.instancesCreated, 2); clean(result, h);
  });
}

test("wrong second-budget failure is retained, never calibrated or promoted to expected success", async () => {
  const h = harness({ error: (instance, kind) => instance.kind === "second" && kind === "event" ? new SandboxError("execution_timeout") : undefined });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.secondBudget?.phase, "event"); assert.equal(result.secondBudget?.failure, "execution_timeout");
  assert.equal(result.failure, "execution_timeout"); assert.equal(result.minuteBudget, null);
  assert.equal(result.instancesCreated, 103);
  clean(result, h);
});

test("minute workload keeps a wrong second-budget error and its accepted turns", async () => {
  const h = harness({ error: (instance, kind) => instance.kind === "minute" && kind === "event" && instance.events === 3
    ? new SandboxError("execution_budget_second") : undefined });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.minuteBudget?.failure, "execution_budget_second"); assert.equal(result.minuteBudget?.phase, "event");
  assert.equal(result.minuteBudget?.turns.length, 2); assert.equal(result.failure, "execution_budget_second");
  clean(result, h);
});

test("a budget-like init error is not an expected EVENT budget failure", async () => {
  const h = harness({ error: (instance, kind) => instance.kind === "second" && kind === "init"
    ? new SandboxError("execution_budget_second") : undefined });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.secondBudget?.phase, "init"); assert.equal(result.secondBudget?.failure, "execution_budget_second");
  assert.equal(result.failure, "execution_budget_second"); assert.equal(result.minuteBudget, null);
  clean(result, h);
});

for (const budget of ["second", "minute"] as const) {
  test(`${budget} budget rejection includes its delayed parent wall time without inventing a VM turn`, async () => {
    let rejecting = false, clockReadsDuringReject = 0;
    const code = budget === "second" ? "execution_budget_second" : "execution_budget_minute";
    const h = harness({
      before(instance, kind) { if (instance.kind === budget && kind === "event" && instance.events === 1) rejecting = true; },
      error(instance, kind) {
        if (instance.kind !== budget || kind !== "event" || instance.events !== 1) return;
        rejecting = false;
        return new SandboxError(code);
      },
      duration(instance, kind) {
        // No companion ACK/clock read lands inside the rejected 30ms turn.
        if (instance.id === 0 && kind === "event") return 250;
        if (kind === "init") return 7;
        if (kind === "dispose") return 2;
        return instance.kind === "healthy" ? 1 : instance.kind === "second" || instance.events === 1 ? 30 : 12;
      }
    });
    h.deps.clock = () => { if (rejecting) clockReadsDuringReject++; return h.timeline.now; };
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    const row = budget === "second" ? result.secondBudget! : result.minuteBudget!;
    assert.equal(clockReadsDuringReject, 0);
    assert.equal(row.elapsedMs, 37, "7ms init plus the actual 30ms rejected round-trip");
    assert.equal(row.phase, "event"); assert.equal(row.failure, code); assert.equal(row.state, "failed");
    assert.deepEqual(row.turns, [], "a rejection provides no accepted VmTurn or execution measurement");
    assert.equal(row.dispose, null); assert.equal(result.failure, null); assert.equal(result.abort, null);
    clean(result, h);
  });
}

test("native budget-window expiry retains its elapsed wall time while the event is still pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let workloadStarted = 0, windowStarted = 0;
  const h = harness({
    before(instance, kind) {
      if (instance.kind !== "second") return;
      if (kind === "init") workloadStarted = h.timeline.now;
      if (kind === "event") windowStarted = h.timeline.now;
    },
    duration(instance, kind) {
      if (instance.kind === "second" && kind === "event") return 10000;
      return kind === "init" ? 7 : kind === "dispose" ? 2 : 1;
    }
  });
  h.deps.signal = controller.signal;
  h.deps.onProgress = (phase) => { if (phase === "budget-minute") controller.abort(); };
  const run = runResourceProbe(h.deps, metadata);
  for (let i = 0; i < 3000; i++) {
    await flush();
    if (h.instances[102]?.events === 1) break;
    h.timeline.advance();
  }
  assert.equal(h.instances[102]?.inFlight, 1);
  assert.equal(windowStarted - workloadStarted, 7);
  h.timeline.now = windowStarted + LIMITS.secondDeadlineMs;
  t.mock.timers.tick(LIMITS.secondDeadlineMs);
  const result = await run; await flush();
  assert.equal(result.secondBudget?.elapsedMs, 5007, "init and the entire native event window are included");
  assert.equal(result.secondBudget?.phase, "event"); assert.equal(result.secondBudget?.failure, null);
  assert.deepEqual(result.secondBudget?.turns, []); assert.equal(result.secondBudget?.dispose, null);
  assert.equal(result.abort, "cancelled"); assert.equal(result.failure, null);
  clean(result, h);
});

test("invalid final workload clock retains the last good reading and the raw expected budget code", async () => {
  let invalidFinalClock = false, readsAfterRejection = 0, lastGood = 0;
  const h = harness({
    before(instance, kind) { if (instance.kind === "second" && kind === "event") lastGood = h.timeline.now; },
    error(instance, kind) {
      if (instance.kind !== "second" || kind !== "event") return;
      invalidFinalClock = true;
      return new SandboxError("execution_budget_second");
    }
  });
  h.deps.clock = () => {
    if (!invalidFinalClock) return h.timeline.now;
    return ++readsAfterRejection === 1 ? lastGood - 1 : h.timeline.now + 1000;
  };
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "clock-invalid"); assert.equal(result.failure, null);
  assert.equal(result.secondBudget?.elapsedMs, 7); assert.equal(result.elapsedMs, lastGood);
  assert.equal(result.secondBudget?.phase, "event"); assert.equal(result.secondBudget?.failure, "execution_budget_second");
  assert.deepEqual(result.secondBudget?.turns, []); assert.equal(result.minuteBudget, null);
  assert.equal(readsAfterRejection, 1, "an invalid clock is not sampled again during termination or cleanup");
  clean(result, h);
});

test("cancelled workload with a backwards clock preserves the cancellation reason and last good elapsed time", async () => {
  const controller = new AbortController();
  let lastGood = 0;
  const h = harness({ before(instance, kind) {
    if (instance.kind !== "second" || kind !== "event") return;
    lastGood = h.timeline.now;
    h.timeline.now -= 100;
    controller.abort("page-hidden");
  } });
  h.deps.signal = controller.signal;
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "page-hidden"); assert.equal(result.failure, null); assert.equal(result.completedAt, null);
  assert.equal(result.secondBudget?.elapsedMs, 7); assert.equal(result.elapsedMs, lastGood);
  assert.equal(result.secondBudget?.phase, "event"); assert.equal(result.secondBudget?.failure, null);
  assert.deepEqual(result.secondBudget?.turns, []); assert.equal(result.minuteBudget, null);
  clean(result, h);
});

for (const interrupted of ["init", "event"] as const) {
  test(`cancellation during pending cycle ${interrupted} terminates immediately and allocates no successor`, async () => {
    const controller = new AbortController();
    const h = harness({ before(instance, kind) { if (instance.id === 1 && kind === interrupted) controller.abort("secret abort text"); } });
    h.deps.signal = controller.signal;
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    assert.equal(result.abort, "cancelled"); assert.equal(result.completedAt, null); assert.equal(result.failure, null);
    assert.equal(result.companionFailure, null);
    assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].phase, interrupted);
    assert.equal(result.cycles[0].failure, null, "termination on cancellation is not a healthy workload failure");
    assert.equal(result.instancesCreated, 2); assert.equal(result.sustained, null);
    assert.ok(!JSON.stringify(result).includes("secret abort text"));
    clean(result, h);
  });
}

test("cancellation releases the production native companion sleep and the hard deadline timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) => {
    const timer = schedule(() => { pending.delete(timer); callback(); }, ms);
    pending.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer !== undefined) pending.delete(timer);
    cancel(timer);
  });
  const controller = new AbortController();
  const h = harness({ before(instance, kind) { if (instance.id === 1 && kind === "event") controller.abort(); } });
  delete h.deps.sleep; h.deps.signal = controller.signal;
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "cancelled"); assert.equal(result.companionPings.length, 1);
  assert.equal(result.companionPings[0].latencyMs, 1);
  assert.equal(pending.size, 0, "both native wait and campaign watchdog have been cancelled");
  clean(result, h);
});

test("abort inside the factory still registers and terminates its just-created supervisor", async () => {
  const controller = new AbortController(), h = harness();
  const create = h.deps.createInstance;
  h.deps.createInstance = () => { const instance = create(); if (h.instances.length === 2) controller.abort(); return instance; };
  h.deps.signal = controller.signal;
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "cancelled"); assert.equal(result.instancesCreated, 2);
  assert.deepEqual(h.instances[1].calls, [], "abort is checked again before init"); clean(result, h);
});

test("pre-cancel and explicit page lifecycle reasons are retained without loading or allocation", async () => {
  for (const reason of [undefined, "page-hidden", "pagehide"] as const) {
    const h = harness(), controller = new AbortController(); controller.abort(reason);
    h.deps.signal = controller.signal;
    const result = await runResourceProbe(h.deps, metadata);
    assert.equal(result.abort, reason ?? "cancelled"); assert.equal(h.loads, 0); assert.equal(result.instancesCreated, 0);
    assert.equal(result.failure, null); assert.equal(result.ui, null); clean(result, h);
  }
});

test("native hard deadline interrupts stalled WASM loading with no clock or fake sleep progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); h.deps.loadWasm = () => new Promise(() => {});
  const run = runResourceProbe(h.deps, metadata);
  await flush(); t.mock.timers.tick(LIMITS.deadlineMs);
  const result = await run;
  assert.equal(result.abort, "deadline"); assert.equal(result.failure, null); assert.equal(result.completedAt, null);
  clean(result, h);
});

test("native deadline also terminates pending supervisor init and drains owned turns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ duration: (instance, kind) => instance.id === 1 && kind === "init" ? 1_000_000 : kind === "init" ? 7 : 1 });
  const run = runResourceProbe(h.deps, metadata);
  for (let i = 0; i < 10 && !h.instances[1]?.calls.includes("init"); i++) { await flush(); h.timeline.advance(); }
  await flush(); t.mock.timers.tick(300000);
  const result = await run; await flush();
  assert.equal(result.abort, "deadline"); assert.equal(result.cycles[0].failure, null);
  assert.equal(result.instancesCreated, 2); clean(result, h);
});

test("nonfinite, throwing, backwards and overall-deadline clock readings halt before the next allocation", async () => {
  for (const invalid of [NaN, Infinity, -1, "throw", 300000] as const) {
    const h = harness(); h.deps.clock = () => { if (invalid === "throw") throw new Error("private clock"); return invalid; };
    if (invalid === 300000) {
      let first = true;
      h.deps.clock = () => { if (first) { first = false; return 0; } return 300000; };
    }
    const result = await runResourceProbe(h.deps, metadata);
    assert.equal(result.abort, invalid === 300000 ? "deadline" : "clock-invalid");
    assert.equal(result.failure, null); assert.equal(result.instancesCreated, 0); clean(result, h);
  }
  const h = harness({ before(instance, kind) { if (instance.id === 1 && kind === "event") h.timeline.now -= 100; } });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "clock-invalid"); assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].failure, null);
  clean(result, h);
});

test("a failed concurrent companion ping aborts a still-pending primary", async () => {
  const h = harness({
    error: (instance, kind) => instance.id === 0 && kind === "event" ? new SandboxError("worker_error") : undefined,
    duration: (instance, kind) => instance.id === 1 ? 100 : kind === "init" ? 7 : 1
  });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.failure, "worker_error"); assert.equal(result.abort, null);
  assert.equal(result.companionFailure, "worker_error");
  assert.equal(result.companionPings[0].failure, "worker_error"); assert.equal(result.companionPings[0].latencyMs, null);
  assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].failure, null); assert.equal(result.cycles[0].init, null);
  assert.equal(result.instancesCreated, 2); clean(result, h);
});

for (const code of ["worker_error", "worker_protocol"] as const) {
  test(`async companion ${code} between pings during primary init keeps the companion cause`, async () => {
    let asynchronousClose: Promise<void> | undefined;
    const h = harness({
      before(instance, kind) {
        if (instance.id !== 1 || kind !== "init") return;
        asynchronousClose = h.timeline.sleep(5, new AbortController().signal).then(() => {
          assert.equal(h.instances[0].inFlight, 0, "companion is between ACKs, in its 250ms pause");
          assert.equal(instance.inFlight, 1, "primary init has not completed");
          h.instances[0].fail(code);
        });
      },
      duration: (instance, kind) => instance.id === 1 && kind === "init" ? 40 : kind === "init" ? 7 : kind === "dispose" ? 2 : 1
    });
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    await asynchronousClose;
    assert.equal(result.companionFailure, code); assert.equal(result.failure, code); assert.equal(result.abort, null);
    assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].phase, "init");
    assert.equal(result.cycles[0].failure, null, "a successful primary init must not inherit companion failure");
    assert.equal(result.cycles[0].init?.wallMs, 40); assert.equal(result.cycles[0].event, null);
    assert.deepEqual(h.instances[1].calls, ["init"]);
    assert.equal(result.companionPings.length, 1); assert.equal(result.companionPings[0].failure, null);
    assert.equal(result.instancesCreated, 2); assert.equal(result.sustained, null);
    clean(result, h);
  });
}

for (const code of ["worker_error", "worker_protocol", null] as const) {
  for (const reason of ["cancelled", "page-hidden"] as const) {
    test(`stop snapshot preserves ${code ?? "no companion fault"} between pings on ${reason}`, async (t) => {
      const controller = new AbortController();
      const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
      if (reason === "page-hidden") {
        const original = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
        t.after(() => {
          if (original) Object.defineProperty(globalThis, "document", original);
          else Reflect.deleteProperty(globalThis, "document");
        });
      }
      let asynchronousStop: Promise<void> | undefined;
      const h = harness({
        before(instance, kind) {
          if (instance.id !== 1 || kind !== "init") return;
          asynchronousStop = h.timeline.sleep(5, new AbortController().signal).then(() => {
            assert.equal(h.instances[0].inFlight, 0, "companion is in its ping-spacing pause");
            assert.equal(instance.inFlight, 1, "primary init is pending at cancellation");
            if (code) h.instances[0].fail(code);
            if (reason === "cancelled") controller.abort();
            else { doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); }
          });
        },
        duration: (instance, kind) => instance.id === 1 && kind === "init" ? 40 : kind === "init" ? 7 : kind === "dispose" ? 2 : 1
      });
      h.deps.signal = controller.signal;
      const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
      await asynchronousStop;
      assert.equal(result.abort, reason); assert.equal(result.completedAt, null);
      assert.equal(result.companionFailure, code); assert.equal(result.failure, code);
      assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].failure, null);
      assert.equal(result.cycles[0].phase, "init"); assert.equal(result.cycles[0].init, null);
      assert.equal(result.companionPings.length, 1); assert.equal(result.companionPings[0].failure, null);
      assert.equal(result.instancesCreated, 2); assert.equal(result.sustained, null);
      clean(result, h);
    });
  }
}

for (const code of ["worker_error", "worker_protocol"] as const) {
  test(`stop snapshot keeps primary ${code} registered during the first-cycle memory await`, async () => {
    const controller = new AbortController(), h = harness();
    const reason = code === "worker_error" ? "cancelled" : "page-hidden";
    let asynchronousStop: Promise<void> | undefined;
    h.deps.signal = controller.signal;
    h.deps.readBrowserMemory = (phase) => {
      if (phase !== "two-instances") return Promise.resolve({ phase, status: "UNAVAILABLE", bytes: null });
      asynchronousStop = h.timeline.sleep(5, new AbortController().signal).then(() => {
        assert.equal(h.instances[1].state, "ready", "the primary's init succeeded before the memory checkpoint");
        h.instances[1].fail(code);
        controller.abort(reason);
      });
      return new Promise(() => {});
    };
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    await asynchronousStop;
    assert.equal(result.abort, reason); assert.equal(result.failure, code); assert.equal(result.companionFailure, null);
    assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].failure, code);
    assert.equal(result.cycles[0].phase, "init"); assert.equal(result.cycles[0].state, "failed");
    assert.ok(result.cycles[0].init); assert.equal(result.cycles[0].event, null); assert.equal(result.cycles[0].dispose, null);
    assert.equal(result.instancesCreated, 2); assert.equal(result.sustained, null);
    clean(result, h);
  });
}

test("stop snapshot attributes a registered terminal sustained-primary fault to its workload", async () => {
  const controller = new AbortController(), h = harness();
  h.deps.signal = controller.signal;
  h.deps.onProgress = (phase, completed) => {
    if (phase !== "sustained" || completed !== 1) return;
    h.instances[101].fail("worker_error");
    controller.abort();
  };
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "cancelled"); assert.equal(result.failure, "worker_error"); assert.equal(result.companionFailure, null);
  assert.equal(result.sustained?.failure, "worker_error"); assert.equal(result.sustained?.phase, "event");
  assert.equal(result.sustained?.turns.length, 1); assert.equal(result.sustained?.dispose, null);
  assert.equal(result.instancesCreated, 102); assert.equal(result.secondBudget, null);
  clean(result, h);
});

test("stop snapshot during cleanup does not promote handled expected budget failures into campaign faults", async () => {
  const controller = new AbortController(), h = harness();
  h.deps.signal = controller.signal;
  h.deps.onProgress = (phase, completed) => { if (phase === "cleanup" && completed === 0) controller.abort(); };
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "cancelled"); assert.equal(result.failure, null); assert.equal(result.companionFailure, null);
  assert.equal(result.secondBudget?.failure, "execution_budget_second"); assert.equal(result.secondBudget?.phase, "event");
  assert.equal(result.minuteBudget?.failure, "execution_budget_minute"); assert.equal(result.minuteBudget?.phase, "event");
  assert.equal(result.instancesCreated, 104); assert.equal(result.companionDispose, null);
  clean(result, h);
});

test("stop snapshot keeps an expected EVENT budget fault registered just before cancellation without promoting it", async () => {
  const controller = new AbortController();
  const h = harness({ error(instance, kind) {
    if (instance.kind !== "second" || kind !== "event" || instance.events !== 4) return;
    instance.fail("execution_budget_second");
    controller.abort();
    return new SandboxError("execution_budget_second");
  } });
  h.deps.signal = controller.signal;
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "cancelled"); assert.equal(result.failure, null); assert.equal(result.companionFailure, null);
  assert.equal(result.secondBudget?.failure, "execution_budget_second"); assert.equal(result.secondBudget?.phase, "event");
  assert.equal(result.secondBudget?.state, "failed"); assert.equal(result.secondBudget?.turns.length, 3);
  assert.equal(result.instancesCreated, 103); assert.equal(result.minuteBudget, null);
  clean(result, h);
});

test("a companion closed after one cycle prevents the next primary allocation", async () => {
  const h = harness();
  h.deps.onProgress = (phase, completed) => {
    if (phase === "cycles" && completed === 1 && h.instances[0].state === "ready") h.instances[0].fail("worker_protocol");
  };
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.companionFailure, "worker_protocol"); assert.equal(result.failure, "worker_protocol");
  assert.equal(result.cycles.length, 1); assert.equal(result.cycles[0].phase, "complete");
  assert.equal(result.cycles[0].failure, null); assert.equal(result.instancesCreated, 2);
  clean(result, h);
});

for (const failedPhase of ["init", "dispose"] as const) {
  test(`companion ${failedPhase} rejection keeps its original native cause`, async () => {
    const code = failedPhase === "init" ? "worker_boot_timeout" : "worker_protocol";
    const h = harness({ error: (instance, kind) => instance.id === 0 && kind === failedPhase ? new SandboxError(code) : undefined });
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    assert.equal(result.companionFailure, code); assert.equal(result.failure, code); assert.equal(result.abort, null);
    assert.equal(result.companionDispose, null);
    if (failedPhase === "init") {
      assert.equal(result.companionInit, null); assert.equal(result.instancesCreated, 1); assert.equal(result.cycles.length, 0);
    } else {
      assert.ok(result.companionInit); assert.equal(result.instancesCreated, 104);
      assert.ok(result.cycles.every((cycle) => cycle.failure === null));
      assert.equal(result.sustained?.failure, null);
    }
    clean(result, h);
  });
}

for (const interrupted of ["init", "event", "dispose"] as const) {
  test(`cancelled companion ${interrupted} does not turn runner termination into a companion error`, async () => {
    const controller = new AbortController();
    const h = harness({ before(instance, kind) { if (instance.id === 0 && kind === interrupted) controller.abort(); } });
    h.deps.signal = controller.signal;
    const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
    assert.equal(result.abort, "cancelled"); assert.equal(result.failure, null); assert.equal(result.companionFailure, null);
    assert.equal(h.instances[0].failure, "instance_closed", "supervisor termination itself is not a diagnostic cause");
    clean(result, h);
  });
}

test("healthy sustained failure retains partial event measurements and skips budget instances", async () => {
  const h = harness({ error: (instance, kind) => instance.id === 101 && kind === "event" && instance.events === 5
    ? new SandboxError("guest_exception") : undefined });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.sustained?.phase, "event"); assert.equal(result.sustained?.turns.length, 4);
  assert.equal(result.sustained?.failure, "guest_exception"); assert.equal(result.failure, "guest_exception");
  assert.equal(result.secondBudget, null); assert.equal(result.instancesCreated, 102); clean(result, h);
});

test("bounded arrays and absent budget failures do not fabricate a successful budget result", async () => {
  const h = harness({ disableBudget: true });
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.cycles.length, 100); assert.ok(result.companionPings.length <= 1200);
  assert.equal(result.secondBudget?.failure, null); assert.equal(result.secondBudget?.phase, "event");
  assert.equal(result.minuteBudget?.failure, null); assert.equal(result.minuteBudget?.phase, "event");
  assert.ok(result.secondBudget!.turns.length <= Math.ceil(5000 / 250));
  assert.ok(result.minuteBudget!.turns.length <= 280);
  assert.ok(result.sustained!.turns.length <= 280); assert.equal(result.instancesCreated, 104);
  clean(result, h);
});

test("a stuck injected clock cannot grow either event or companion arrays without bound", async () => {
  const h = harness({ duration: (instance, kind) => instance.id === 1 && kind === "init" ? 400000 : kind === "init" ? 7 : 1 });
  h.deps.clock = () => 0;
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.abort, "clock-invalid"); assert.equal(result.cycles.length, 100);
  assert.equal(result.companionPings.length, 1200); assert.equal(result.sustained?.turns.length, 280);
  assert.equal(result.sustained?.phase, "event"); assert.equal(result.secondBudget, null);
  clean(result, h);
});

test("memory errors are whitelisted and each hung browser sample times out at its native 2s bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ error: (instance, kind) => instance.id === 1 && kind === "event" ? new SandboxError("worker_timeout") : undefined });
  h.deps.crossOriginIsolated = true;
  h.deps.readBrowserMemory = async (phase) => {
    if (phase === "baseline") throw new Error("private browser rejection");
    if (phase === "two-instances") return new Promise(() => {});
    return { phase, status: "UNAVAILABLE", bytes: 1234 };
  };
  const run = runResourceProbe(h.deps, metadata);
  for (let i = 0; i < 10; i++) {
    await flush();
    if (h.instances[1]?.state === "ready") break;
    h.timeline.advance();
  }
  await flush(); t.mock.timers.tick(1999); await flush();
  assert.deepEqual(h.instances[1].calls, ["init"], "both buffers stay alive while sampling memory");
  t.mock.timers.tick(1);
  const result = await h.timeline.finish(run);
  assert.deepEqual(result.browserMemory.samples, [
    { phase: "baseline", status: "ERROR", bytes: null }, { phase: "two-instances", status: "TIMEOUT", bytes: null },
    { phase: "after-cleanup", status: "UNAVAILABLE", bytes: null }
  ]);
  assert.equal(result.browserMemory.crossOriginIsolated, true);
  assert.ok(!JSON.stringify(result).includes("private browser rejection")); clean(result, h);
});

test("progress/factory/unknown native exceptions cannot escape or destroy cleanup", async () => {
  const h = harness();
  h.deps.onProgress = () => { throw new Error("private UI callback"); };
  const create = h.deps.createInstance;
  h.deps.createInstance = () => { if (h.instances.length === 3) throw { secret: "private factory" }; return create(); };
  const result = await h.timeline.finish(runResourceProbe(h.deps, metadata));
  assert.equal(result.failure, "native_failure"); assert.equal(result.instancesCreated, 3);
  assert.equal(result.cycles.length, 3); assert.equal(result.cycles[2].failure, "native_failure");
  assert.ok(!JSON.stringify(result).includes("private")); clean(result, h);
});

test("page listeners and external abort listeners are removed on every exit", async (t) => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const controller = new AbortController(), h = harness();
  const documentAdd = t.mock.method(doc, "addEventListener"), documentRemove = t.mock.method(doc, "removeEventListener");
  const windowAdd = t.mock.method(win, "addEventListener"), windowRemove = t.mock.method(win, "removeEventListener");
  const signalAdd = t.mock.method(controller.signal, "addEventListener"), signalRemove = t.mock.method(controller.signal, "removeEventListener");
  h.deps.signal = controller.signal;
  const run = runResourceProbe(h.deps, metadata);
  await flush(); h.timeline.advance(); await flush();
  win.dispatchEvent(new Event("pagehide"));
  const result = await run; await flush();
  assert.equal(result.abort, "pagehide"); clean(result, h);
  for (const [add, remove] of [[documentAdd, documentRemove], [windowAdd, windowRemove], [signalAdd, signalRemove]]) {
    assert.equal(add.mock.callCount(), 1); assert.equal(remove.mock.callCount(), 1);
    assert.equal(remove.mock.calls[0].arguments[0], add.mock.calls[0].arguments[0]);
    assert.equal(remove.mock.calls[0].arguments[1], add.mock.calls[0].arguments[1], "the exact installed listener is removed");
  }
  const before = JSON.stringify(result);
  doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); controller.abort();
  assert.equal(JSON.stringify(result), before);
});
