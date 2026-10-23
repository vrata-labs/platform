import { SandboxError, SANDBOX_FAILURES, type SandboxFailure } from "./limits.js";
import { RESOURCE_PROBE_LIMITS as LIMITS, type ResourceAbort, type ResourceBrowserMemory,
  type ResourceCycle, type ResourceObservation, type ResourcePhase, type ResourceTurn,
  type ResourceWorkload } from "./resource-probe-contract.js";
import type { ProbeDevice } from "./probe-report.js";
import type { PluginSupervisor } from "./supervisor.js";
import type { VmTurn } from "./vm.js";

type Instance = Pick<PluginSupervisor, "init" | "event" | "dispose" | "terminate" | "state" | "failure" | "wasmMemoryBytes">;
type MemorySample = ResourceBrowserMemory["samples"][number];
export interface ResourceProbeDependencies {
  loadWasm: () => Promise<WebAssembly.Module>;
  /** Production factory owns the normal Worker and supplies empty approvals. */
  createInstance: () => Instance;
  clock?: () => number;
  signal?: AbortSignal;
  onProgress?: (phase: ResourcePhase, completed: number, total: number) => void;
  readBrowserMemory?: (phase: MemorySample["phase"]) => Promise<MemorySample>;
  crossOriginIsolated: boolean;
  /** Test seam only; the browser uses cancellable native setTimeout waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Platform-owned programs, never supplied through arguments, room data or URLs.
const HEALTHY = `
  export function init() {}
  export function onEvent() {}
  export function dispose() {}
`;
const SECOND = `
  export function init() {}
  export function onEvent() {
    const started = Date.now();
    while (Date.now() - started < 30) {}
  }
  export function dispose() {}
`;
const MINUTE = `
  export function init() {}
  export function onEvent() {
    const started = Date.now();
    while (Date.now() - started < 12) {}
  }
  export function dispose() {}
`;
const CONNECTION = { sdkApiVersion: 1, type: "room.connection", state: "connected" } as const;
const HALTED = Symbol("resource probe halted");
const WINDOW_ENDED = Symbol("resource probe event window ended");
const closed = (instance: Instance) => instance.state === "failed" || instance.state === "disposed";
const disposed = (instance: Instance) => instance.state === "disposed";
const failureCode = (error: unknown): SandboxFailure => error instanceof SandboxError &&
  (SANDBOX_FAILURES as readonly string[]).includes(error.code) ? error.code : "native_failure";

function nativeSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const tick = () => {
      const remaining = ms - (performance.now() - started);
      // Native timers may fire fractionally early; keep the >=250ms fence real.
      if (remaining > 0) timer = setTimeout(tick, remaining);
      else finish();
    };
    timer = setTimeout(tick, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Owns only its supervisors. Closed counts prove supervisor termination, not
 * physical collection, total browser memory, or the OS's live Worker count. */
export async function runResourceProbe(
  deps: ResourceProbeDependencies,
  metadata: { runId: string; device: ProbeDevice; startedAt: string }
): Promise<ResourceObservation> {
  const observation: ResourceObservation = {
    ...metadata, completedAt: null, elapsedMs: 0, wasmLoadWallMs: null, abort: null, failure: null,
    companionFailure: null, companionInit: null, companionDispose: null, companionPings: [], cycles: [], sustained: null,
    secondBudget: null, minuteBudget: null, instancesCreated: 0, instancesClosed: 0,
    activeAfterCleanup: 0, browserMemory: {
      method: "measureUserAgentSpecificMemory", crossOriginIsolated: deps.crossOriginIsolated, samples: []
    }, ui: null
  };
  const owned: Instance[] = [];
  const currentRows = new Map<Instance, ResourceCycle | ResourceWorkload>();
  const stop = new AbortController(), pumpStop = new AbortController();
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? nativeSleep;
  let phase: ResourcePhase = "wasm", companion: Instance | undefined;
  let pump: Promise<void> | undefined, origin: number | undefined, last = 0;

  function terminate(instance: Instance) {
    try { if (!closed(instance)) instance.terminate(); }
    catch { observation.failure ??= "native_failure"; }
  }
  function registeredFailure(instance: Instance | undefined): SandboxFailure | null {
    if (!instance || instance.state !== "failed") return null;
    const code = instance.failure;
    return code !== undefined && code !== "instance_closed" && (SANDBOX_FAILURES as readonly string[]).includes(code) ? code : null;
  }
  function snapshotRegisteredFaults() {
    const companionCode = registeredFailure(companion);
    if (companionCode) {
      observation.companionFailure ??= companionCode;
      observation.failure ??= companionCode;
    }
    for (const [instance, row] of currentRows) {
      if (row.failure !== null) continue;
      const code = registeredFailure(instance);
      if (!code) continue;
      row.failure = code;
      const expected = row.phase === "event" && (
        (row === observation.secondBudget && code === "execution_budget_second") ||
        (row === observation.minuteBudget && code === "execution_budget_minute")
      );
      if (!expected) observation.failure ??= code;
    }
  }
  function stopAll() {
    // Capture native faults already registered before cancellation wakes waits
    // or our termination replaces healthy instances with instance_closed.
    snapshotRegisteredFaults();
    if (observation.abort !== "clock-invalid") {
      try {
        const value = clock();
        if (Number.isFinite(value) && value >= last && origin !== undefined) last = value;
      } catch { /* Retain the original stop reason and last good clock sample. */ }
    }
    stop.abort();
    for (const instance of owned) terminate(instance);
  }
  function abort(reason: ResourceAbort) {
    if (stop.signal.aborted) return;
    observation.abort = reason;
    stopAll();
  }
  function fail(code: SandboxFailure) {
    if (stop.signal.aborted) return;
    observation.failure ??= code;
    stopAll();
  }
  function check() { if (stop.signal.aborted) throw HALTED; }
  function failCompanion(code: SandboxFailure) {
    if (stop.signal.aborted) return;
    observation.companionFailure ??= code;
    fail(code);
  }
  function requireCompanionReady() {
    check(); // stopAll's termination is not evidence of a companion failure.
    if (companion && companion.state !== "ready") {
      failCompanion(companion.failure ?? "instance_closed");
      throw HALTED;
    }
  }
  function now(): number {
    check();
    let value: number;
    try { value = clock(); } catch { abort("clock-invalid"); throw HALTED; }
    if (!Number.isFinite(value) || value < 0 || (origin !== undefined && value < last)) {
      abort("clock-invalid"); throw HALTED;
    }
    origin ??= value;
    last = value;
    if (value - origin >= LIMITS.deadlineMs) { abort("deadline"); throw HALTED; }
    return value;
  }
  function recordFinalTime() {
    if (stop.signal.aborted) return;
    try { now(); } catch { /* Keep the recorded abort reason and last good sample. */ }
  }
  function progress(next: ResourcePhase, completed: number, total: number) {
    phase = next;
    // A presentation callback cannot interrupt the campaign's cleanup.
    try { deps.onProgress?.(next, completed, total); } catch { /* Presentation only. */ }
  }
  function active() { return owned.filter((instance) => !closed(instance)).length; }
  function allocate(): Instance {
    now(); // Check cancellation/clock/deadline before every allocation.
    requireCompanionReady();
    const instance = deps.createInstance();
    if (owned.includes(instance)) throw new SandboxError("native_failure");
    owned.push(instance); observation.instancesCreated = owned.length;
    if (stop.signal.aborted) { terminate(instance); throw HALTED; }
    return instance;
  }

  // Every external promise has rejection handlers even when cancellation wins.
  // Supervisor termination settles pending turns; a hung memory/WASM reader
  // cannot prevent return, and its eventual rejection never escapes the runner.
  async function wait<T>(action: () => Promise<T>, extra?: AbortSignal): Promise<T> {
    check();
    if (extra?.aborted) throw WINDOW_ENDED;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => finish(false, stop.signal.aborted ? HALTED : WINDOW_ENDED);
      let settled = false;
      function finish(ok: boolean, value: unknown) {
        if (settled) return;
        settled = true;
        stop.signal.removeEventListener("abort", cancel);
        extra?.removeEventListener("abort", cancel);
        if (ok) resolve(value as T); else reject(value);
      }
      stop.signal.addEventListener("abort", cancel, { once: true });
      extra?.addEventListener("abort", cancel, { once: true });
      try { Promise.resolve(action()).then((value) => finish(true, value), (error) => finish(false, error)); }
      catch (error) { finish(false, error); }
    });
  }
  async function turn(action: () => Promise<VmTurn>, extra?: AbortSignal): Promise<ResourceTurn> {
    const started = now();
    const result = await wait(action, extra);
    return { wallMs: now() - started, executionMs: result.executionMs, jobs: result.jobs,
      wasmLinearBytes: result.wasmMemoryBytes };
  }
  async function pause(ms: number, extra?: AbortSignal) {
    // The linked signal lets even injected waits release their pending timers.
    const linked = new AbortController();
    const cancel = () => linked.abort();
    stop.signal.addEventListener("abort", cancel, { once: true });
    extra?.addEventListener("abort", cancel, { once: true });
    if (stop.signal.aborted || extra?.aborted) linked.abort();
    try { await wait(() => sleep(ms, linked.signal), extra); now(); }
    finally {
      linked.abort();
      stop.signal.removeEventListener("abort", cancel);
      extra?.removeEventListener("abort", cancel);
    }
  }

  async function memory(samplePhase: MemorySample["phase"]) {
    const sample: MemorySample = { phase: samplePhase, status: "UNAVAILABLE", bytes: null };
    observation.browserMemory.samples.push(sample);
    if (!deps.readBrowserMemory || stop.signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await wait(() => Promise.race([
        Promise.resolve().then(() => deps.readBrowserMemory!(samplePhase)),
        new Promise<MemorySample>((resolve) => {
          timer = setTimeout(() => resolve({ phase: samplePhase, status: "TIMEOUT", bytes: null }), LIMITS.memorySampleDeadlineMs);
        })
      ]));
      if (result && ["MEASURED", "UNAVAILABLE", "ERROR", "TIMEOUT"].includes(result.status)) {
        sample.status = result.status;
        if (result.status === "MEASURED") {
          if (Number.isSafeInteger(result.bytes) && result.bytes! >= 0) sample.bytes = result.bytes;
          else sample.status = "ERROR";
        }
      } else sample.status = "ERROR";
    } catch (error) { if (error !== HALTED) sample.status = "ERROR"; }
    finally { clearTimeout(timer); }
  }

  async function pumpCompanion() {
    try {
      while (!pumpStop.signal.aborted && !stop.signal.aborted && observation.companionPings.length < LIMITS.maxPings) {
        const sent = now();
        const ping = { phase, sentOffsetMs: sent - origin!, latencyMs: null as number | null, failure: null as SandboxFailure | null };
        observation.companionPings.push(ping);
        try {
          if (companion!.state !== "ready") throw new SandboxError(companion!.failure ?? "instance_closed");
          await wait(() => companion!.event(CONNECTION));
          ping.latencyMs = now() - sent;
          if (companion!.state !== "ready") throw new SandboxError(companion!.failure ?? "instance_closed");
        } catch (error) {
          if (error !== HALTED && !stop.signal.aborted) { ping.failure = failureCode(error); failCompanion(ping.failure); }
          break;
        }
        if (pumpStop.signal.aborted) break;
        await pause(LIMITS.eventIntervalMs, pumpStop.signal);
      }
    } catch (error) { if (error !== HALTED && error !== WINDOW_ENDED) failCompanion(failureCode(error)); }
  }

  async function cycle(wasm: WebAssembly.Module, index: number) {
    now();
    requireCompanionReady();
    const row: ResourceCycle = { index, phase: "init", init: null, event: null, dispose: null,
      failure: null, state: "booting", activeDuring: 0, activeAfter: active(), overlappingLinear: null };
    observation.cycles.push(row);
    let instance: Instance | undefined;
    try {
      instance = allocate(); currentRows.set(instance, row); row.activeDuring = active();
      row.init = await turn(() => instance!.init(wasm, HEALTHY));
      if (instance.state !== "ready") throw new SandboxError("instance_closed");
      requireCompanionReady();
      const primaryBytes = instance.wasmMemoryBytes, companionBytes = companion!.wasmMemoryBytes;
      if (primaryBytes !== undefined && companionBytes !== undefined) row.overlappingLinear = { primaryBytes, companionBytes };
      if (index === 1) await memory("two-instances");
      requireCompanionReady();
      row.phase = "event"; row.event = await turn(() => instance!.event(CONNECTION));
      requireCompanionReady();
      row.phase = "dispose"; row.dispose = await turn(() => instance!.dispose());
      if (!disposed(instance)) throw new SandboxError("worker_protocol");
      requireCompanionReady();
      row.phase = "complete";
    } catch (error) {
      if (error !== HALTED && !stop.signal.aborted) { row.failure = failureCode(error); fail(row.failure); }
      throw HALTED;
    } finally {
      if (instance) { terminate(instance); row.state = instance.state; }
      else row.state = "failed";
      row.activeAfter = active();
      if (instance) currentRows.delete(instance);
    }
  }

  async function workload(wasm: WebAssembly.Module, kind: "sustained" | "budget-second" | "budget-minute") {
    const started = now();
    requireCompanionReady();
    const row: ResourceWorkload = { phase: "init", failure: null, state: "booting", elapsedMs: 0,
      init: null, turns: [], dispose: null, activeAfter: active() };
    if (kind === "sustained") observation.sustained = row;
    else if (kind === "budget-second") observation.secondBudget = row;
    else observation.minuteBudget = row;
    const duration = kind === "sustained" ? LIMITS.sustainedMs : kind === "budget-second" ? LIMITS.secondDeadlineMs : LIMITS.minuteDeadlineMs;
    const expected = kind === "budget-second" ? "execution_budget_second" : kind === "budget-minute" ? "execution_budget_minute" : null;
    const window = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, instance: Instance | undefined;
    progress(kind, 0, kind === "sustained" ? duration : LIMITS.maxBudgetTurns);
    try {
      instance = allocate();
      currentRows.set(instance, row);
      row.init = await turn(() => instance!.init(wasm, kind === "sustained" ? HEALTHY : kind === "budget-second" ? SECOND : MINUTE));
      if (instance.state !== "ready") throw new SandboxError(instance.failure ?? "instance_closed");
      requireCompanionReady();
      row.phase = "event";
      const eventStarted = now();
      if (expected) timer = setTimeout(() => { window.abort(); terminate(instance!); }, duration);
      while (now() - eventStarted < duration && row.turns.length < LIMITS.maxBudgetTurns) {
        requireCompanionReady();
        const sample = await turn(() => instance!.event(CONNECTION), window.signal);
        const ended = now();
        row.turns.push({ endedOffsetMs: ended - started, turn: sample });
        if (instance.state !== "ready") throw new SandboxError(instance.failure ?? "instance_closed");
        requireCompanionReady();
        progress(kind, kind === "sustained" ? Math.min(duration, ended - eventStarted) : row.turns.length,
          kind === "sustained" ? duration : LIMITS.maxBudgetTurns);
        const remaining = duration - (ended - eventStarted);
        if (remaining > 0) await pause(Math.min(LIMITS.eventIntervalMs, remaining), window.signal);
      }
      clearTimeout(timer);
      if (kind === "sustained" && now() - eventStarted < duration) { abort("clock-invalid"); throw HALTED; }
      if (!expected) {
        requireCompanionReady();
        row.phase = "dispose"; row.dispose = await turn(() => instance!.dispose());
        if (!disposed(instance)) throw new SandboxError("worker_protocol");
        requireCompanionReady();
        row.phase = "complete";
        progress(kind, duration, duration);
      }
      // Budget expiration without the exact EVENT failure remains an observed
      // missing failure. Never manufacture a budget code or lower its threshold.
    } catch (error) {
      if (error !== HALTED && error !== WINDOW_ENDED && !stop.signal.aborted) {
        row.failure = failureCode(error);
        if (row.phase !== "event" || row.failure !== expected) fail(row.failure);
      }
    } finally {
      clearTimeout(timer); window.abort();
      if (instance) { terminate(instance); row.state = instance.state; }
      else row.state = "failed";
      // Rejected turns/window expiry provide no VmTurn, but their parent wall
      // time still belongs to the workload. Do not sample again after a stop.
      recordFinalTime();
      row.elapsedMs = Math.max(0, last - started);
      row.activeAfter = active();
      if (instance) currentRows.delete(instance);
    }
    requireCompanionReady();
  }

  const externalAbort = () => abort(deps.signal?.reason === "page-hidden" ? "page-hidden" : deps.signal?.reason === "pagehide" ? "pagehide" : "cancelled");
  const hidden = () => { if (document.visibilityState !== "visible") abort("page-hidden"); };
  const pagehide = () => abort("pagehide");
  const deadline = setTimeout(() => abort("deadline"), LIMITS.deadlineMs);
  deps.signal?.addEventListener("abort", externalAbort, { once: true });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
  if (typeof window !== "undefined") window.addEventListener("pagehide", pagehide);
  try {
    if (deps.signal?.aborted) externalAbort();
    if (typeof document !== "undefined") hidden();
    now();
    progress("wasm", 0, 1);
    await memory("baseline");
    const loadStarted = now();
    const wasm = await wait(deps.loadWasm);
    observation.wasmLoadWallMs = now() - loadStarted;
    progress("wasm", 1, 1);
    progress("companion", 0, 1);
    try {
      companion = allocate();
      observation.companionInit = await turn(() => companion!.init(wasm, HEALTHY));
      requireCompanionReady();
    } catch (error) {
      if (error !== HALTED && !stop.signal.aborted) failCompanion(failureCode(error));
      throw HALTED;
    }
    progress("companion", 1, 1);
    pump = pumpCompanion();
    for (let index = 1; index <= LIMITS.cycles; index++) {
      progress("cycles", index - 1, LIMITS.cycles);
      await cycle(wasm, index);
      progress("cycles", index, LIMITS.cycles);
    }
    await workload(wasm, "sustained");
    await workload(wasm, "budget-second");
    await workload(wasm, "budget-minute");
  } catch (error) { if (error !== HALTED && !stop.signal.aborted) fail(failureCode(error)); }
  finally {
    progress("cleanup", 0, 1);
    pumpStop.abort();
    // Join an in-flight ping before submitting the companion's dispose turn.
    await pump;
    if (companion && !stop.signal.aborted) {
      try {
        requireCompanionReady();
        observation.companionDispose = await turn(() => companion!.dispose());
        if (!disposed(companion)) failCompanion(companion.failure ?? "worker_protocol");
      } catch (error) { if (error !== HALTED && !stop.signal.aborted) failCompanion(failureCode(error)); }
    }
    for (const instance of owned) terminate(instance);
    observation.instancesClosed = owned.filter(closed).length;
    observation.activeAfterCleanup = active();
    await memory("after-cleanup");
    recordFinalTime();
    observation.elapsedMs = origin === undefined ? 0 : Math.max(0, last - origin);
    observation.completedAt = observation.abort === null ? new Date().toISOString() : null;
    clearTimeout(deadline);
    deps.signal?.removeEventListener("abort", externalAbort);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", pagehide);
    progress("cleanup", 1, 1);
    if (!observation.abort && !observation.failure) progress("complete", 1, 1);
  }
  return observation;
}
