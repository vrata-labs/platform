import { parseRoomPluginJson, validateRoomPluginCapabilities, validateRoomPluginData,
  validateRoomPluginEvent, validateRoomPluginRequest, validateRoomPluginResponse, roomPluginUtf8ByteLength,
  type RoomPluginCapability, type RoomPluginConfig, type RoomPluginEvent, type RoomPluginRequest, type RoomPluginResponse } from "@vrata/room-plugin-sdk";
import { SANDBOX_FAILURES, SANDBOX_LIMITS, SandboxError, type SandboxFailure, type SandboxHostPhase, type SandboxStartupTiming } from "./limits.js";
import { RoomPluginRuntimeError } from "./runtime-errors.js";
import { KERNEL_EFFECT_MARGIN_MS, KERNEL_TERMINATE_ACK_MS, KERNEL_TRANSPORT_TIMEOUT_MS,
  type KernelCommand, type KernelReply, type KernelBridgeFailure, type KernelStartupTiming } from "./kernel-protocol.js";
import type { PluginActionResult, InstanceState, SupervisorOptions } from "./supervisor.js";

export interface KernelWorker {
  onmessage: ((event: MessageEvent<KernelReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(command: KernelCommand, transfer: Transferable[]): void;
  terminate(): void;
}
interface Operation {
  id: number; type: "prepare" | "init" | "event" | "dispose"; effectDeadline: number;
  startedAtMs: number;
  lastBatchId: number;
  resolve(value: PluginActionResult | undefined): void; reject(error: Error): void;
  abort: AbortController; timer: ReturnType<typeof setTimeout>; batches: Map<number, AbortController>;
}
interface QueuedEvent { event: RoomPluginEvent; promise: Promise<PluginActionResult>; resolve(value: PluginActionResult): void; reject(error: Error): void }
const bridgeFailures = new Set<KernelBridgeFailure>(["kernel-transport-timeout", "kernel-unsupported", "kernel-protocol"]);
const hostPhases: readonly SandboxHostPhase[] = ["worker-hello", "worker-prepare", "init", "event", "respond", "dispose"];

/** Main-thread transport only. Security watchdogs execute in the trusted kernel
 * Worker. This facade holds authority-local action windows and cannot execute source. */
export class PluginKernelClient {
  private currentState: InstanceState = "booting";
  private failureCode?: SandboxFailure;
  private hint?: "memory_exhausted" | "stack_exhausted";
  private memoryBytes?: number;
  private startup: SandboxStartupTiming = { moduleAgeMs: null, prepareMs: null, prepareRoundTripMs: null, wasmLoadMs: null };
  private operation?: Operation;
  private events: QueuedEvent[] = [];
  private nextId = 0;
  private lastRequestId = 0;
  private submitted = false;
  private module?: WebAssembly.Module;
  private preparing?: Promise<void>;
  private shutdownTimer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private readonly approved: readonly RoomPluginCapability[];
  private readonly clock: () => number;
  private readonly dispatch: NonNullable<SupervisorOptions["dispatch"]>;

  constructor(private readonly worker: KernelWorker, capabilities: readonly RoomPluginCapability[],
    onStatus: (request: Extract<RoomPluginRequest, { operation: "status.set" }>) => void = () => {}, options: SupervisorOptions & { wasmLoadMs?: number } = {}) {
    try { this.approved = validateRoomPluginCapabilities(capabilities); }
    catch { worker.terminate(); throw new SandboxError("invalid_input"); }
    this.clock = options.clock ?? (() => performance.now());
    if (Number.isFinite(options.wasmLoadMs) && options.wasmLoadMs! >= 0) this.startup.wasmLoadMs = Math.min(60_000, options.wasmLoadMs!);
    this.dispatch = options.dispatch ?? ((request, signal, canCommit) => {
      if (signal.aborted || !canCommit()) return { sdkApiVersion: 1, requestId: request.requestId, ok: false, error: "cancelled" };
      if (request.operation !== "status.set") return { sdkApiVersion: 1, requestId: request.requestId, ok: false, error: "capability-denied" };
      onStatus(request); return { sdkApiVersion: 1, requestId: request.requestId, ok: true, result: null };
    });
    worker.onmessage = event => this.reply(event.data);
    worker.onerror = event => { event.preventDefault(); this.fail(new RoomPluginRuntimeError("kernel-protocol")); };
    worker.onmessageerror = () => this.fail(new RoomPluginRuntimeError("kernel-protocol"));
  }
  get state(): InstanceState { return this.currentState; }
  get failure(): SandboxFailure | undefined { return this.failureCode; }
  get exceptionHint() { return this.hint; }
  get wasmMemoryBytes() { return this.memoryBytes; }
  get startupTiming() { return this.startup; }
  get busy() { return Boolean(this.operation); }

  prepare(wasm: WebAssembly.Module): Promise<void> {
    if (this.closed() || this.currentState !== "booting") return Promise.reject(new SandboxError("instance_closed"));
    if (!(wasm instanceof WebAssembly.Module) || this.module && this.module !== wasm) return Promise.reject(new SandboxError("invalid_input"));
    if (this.preparing) return this.preparing;
    this.module = wasm;
    this.preparing = this.send({ version: 1, id: ++this.nextId, type: "prepare", wasm, approvedCapabilities: this.approved }).then(() => undefined);
    return this.preparing;
  }
  async init(wasm: WebAssembly.Module, source: string, config: RoomPluginConfig = {}): Promise<PluginActionResult> {
    if (this.submitted || this.closed()) throw new SandboxError("instance_closed"); this.submitted = true;
    let safe: RoomPluginConfig;
    try {
      if (typeof source !== "string" || roomPluginUtf8ByteLength(source, SANDBOX_LIMITS.artifactBytes, "artifact_too_large") > SANDBOX_LIMITS.artifactBytes) throw new SandboxError("invalid_input");
      const data = validateRoomPluginData(config);
      if (!data || Array.isArray(data) || typeof data !== "object" || Object.values(data).some(value => !["string", "number", "boolean"].includes(typeof value))) throw new SandboxError("invalid_input");
      safe = data as RoomPluginConfig;
    } catch { this.fail(new SandboxError("invalid_input")); throw new SandboxError("invalid_input"); }
    await this.prepare(wasm);
    if (this.closed()) throw new SandboxError("instance_closed");
    return (await this.send({ version: 1, id: ++this.nextId, type: "init", source, config: safe }))!;
  }
  event(event: RoomPluginEvent): Promise<PluginActionResult> {
    if (this.currentState !== "ready") return Promise.reject(new SandboxError("instance_closed"));
    let safe: RoomPluginEvent;
    try { safe = validateRoomPluginEvent(event); } catch { return Promise.reject(new SandboxError("invalid_input")); }
    const index = this.events.findIndex(value => value.event.type === safe.type);
    if (index >= 0) { const [queued] = this.events.splice(index, 1); queued.event = safe; this.events.push(queued); return queued.promise; }
    if (this.events.length >= SANDBOX_LIMITS.requestQueueSize) { this.fail(new SandboxError("host_queue_limit")); return Promise.reject(new SandboxError("host_queue_limit")); }
    let resolve!: QueuedEvent["resolve"], reject!: QueuedEvent["reject"];
    const promise = new Promise<PluginActionResult>((yes, no) => { resolve = yes; reject = no; });
    this.events.push({ event: safe, promise, resolve, reject }); this.pump(); return promise;
  }
  async dispose(): Promise<PluginActionResult> {
    if (this.currentState !== "ready" || this.operation) { this.terminate(); throw new SandboxError("instance_closed"); }
    this.currentState = "disposing";
    return (await this.send({ version: 1, id: ++this.nextId, type: "dispose" }))!;
  }
  terminate(): void { if (!this.closed()) this.fail(new SandboxError("instance_closed")); }

  private pump(): void {
    if (this.operation || this.currentState !== "ready") return;
    const queued = this.events.shift(); if (!queued) return;
    void this.send({ version: 1, id: ++this.nextId, type: "event", event: queued.event }).then(value => queued.resolve(value!), queued.reject);
  }
  private send(command: Extract<KernelCommand, { id: number }>): Promise<PluginActionResult | undefined> {
    if (this.operation || this.closed()) return Promise.reject(new SandboxError("instance_closed"));
    const now = this.clock(); if (!Number.isFinite(now) || now < 0) return Promise.reject(new RoomPluginRuntimeError("kernel-protocol"));
    return new Promise((resolve, reject) => {
      const lifetime = command.type === "prepare" ? 0 : command.type === "dispose" ? SANDBOX_LIMITS.workerResponseDeadlineMs : SANDBOX_LIMITS.bindingLeaseMs;
      this.operation = { id: command.id, type: command.type, startedAtMs: now, effectDeadline: now + Math.max(0, lifetime - KERNEL_EFFECT_MARGIN_MS), resolve, reject,
        lastBatchId: 0, abort: new AbortController(), batches: new Map(), timer: setTimeout(() => this.fail(new RoomPluginRuntimeError("kernel-transport-timeout")), KERNEL_TRANSPORT_TIMEOUT_MS) };
      try { this.worker.postMessage(command, []); } catch { this.fail(new RoomPluginRuntimeError("kernel-protocol")); }
    });
  }
  private live(operation: Operation): boolean {
    const now = this.clock();
    return this.operation === operation && !this.closed() && !operation.abort.signal.aborted && operation.type !== "prepare"
      && Number.isFinite(now) && now >= 0 && now < operation.effectDeadline;
  }
  private async requests(message: Extract<KernelReply, { type: "requests" }>): Promise<void> {
    const operation = this.operation;
    if (!operation || operation.id !== message.actionId || operation.type === "prepare" || operation.type === "dispose") throw new RoomPluginRuntimeError("kernel-protocol");
    if (!Number.isSafeInteger(message.batchId) || message.batchId <= operation.lastBatchId || operation.batches.size) throw new RoomPluginRuntimeError("kernel-protocol");
    const raw = parseRoomPluginJson(message.requestsJson);
    if (!Array.isArray(raw) || !raw.length || raw.length > SANDBOX_LIMITS.requestQueueSize) throw new RoomPluginRuntimeError("kernel-protocol");
    const requests = raw.map(validateRoomPluginRequest); let lastId = this.lastRequestId;
    for (const request of requests) {
      const id = Number(request.requestId);
      if (!Number.isSafeInteger(id) || id <= lastId || String(id) !== request.requestId || !this.approved.includes(request.operation)) throw new RoomPluginRuntimeError("kernel-protocol");
      lastId = id;
    }
    this.lastRequestId = lastId; operation.lastBatchId = message.batchId;
    const abort = new AbortController(); operation.batches.set(message.batchId, abort);
    const cancel = () => abort.abort(); operation.abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      const pending: Array<Promise<RoomPluginResponse>> = [];
      for (const request of requests) {
        const withinAction = () => this.live(operation) && !abort.signal.aborted;
        const value = withinAction() ? this.dispatch(request, abort.signal, withinAction)
          : { sdkApiVersion: 1 as const, requestId: request.requestId, ok: false as const, error: "cancelled" as const };
        const response = Promise.resolve(value); void response.catch(() => undefined); pending.push(response);
      }
      const values = await this.waitForResponses(pending, abort.signal);
      if (!values) return;
      const responses = values.map(validateRoomPluginResponse);
      if (responses.some((response, index) => response.requestId !== requests[index].requestId)) throw new RoomPluginRuntimeError("kernel-protocol");
      if (this.operation !== operation || this.closed() || abort.signal.aborted) return;
      this.worker.postMessage({ version: 1, type: "respond", actionId: operation.id, batchId: message.batchId, responsesJson: JSON.stringify(responses) }, []);
    } catch {
      // Mark the failure before abort listeners run, and never let a late
      // rejection from an already-cancelled batch fail a newer operation.
      if (this.operation === operation && !abort.signal.aborted) this.fail(new SandboxError("host_error"));
      abort.abort();
    } finally { operation.abort.signal.removeEventListener("abort", cancel); operation.batches.delete(message.batchId); }
  }
  private waitForResponses(pending: Array<Promise<RoomPluginResponse>>, signal: AbortSignal): Promise<RoomPluginResponse[] | null> {
    return new Promise((resolve, reject) => {
      const cancelled = () => { signal.removeEventListener("abort", cancelled); resolve(null); };
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      void Promise.all(pending).then(values => { signal.removeEventListener("abort", cancelled); resolve(values); },
        error => { signal.removeEventListener("abort", cancelled); reject(error); });
    });
  }
  private reply(message: KernelReply): void {
    if (message?.version === 1 && message.type === "closed") { this.finalize(); return; }
    if (this.closed()) return;
    try {
      if (!message || message.version !== 1) throw new RoomPluginRuntimeError("kernel-protocol");
      if (message.type === "requests") {
        const operation = this.operation;
        void this.requests(message).catch(() => {
          if (this.operation === operation) this.fail(new RoomPluginRuntimeError("kernel-protocol"));
        }); return;
      }
      if (message.type === "cancel") {
        if (this.operation?.id === message.actionId) this.operation.batches.get(message.batchId)?.abort(); return;
      }
      if (message.type === "failed") {
        if (message.channel === "bridge") {
          if (!bridgeFailures.has(message.failure)) throw new RoomPluginRuntimeError("kernel-protocol");
          this.fail(new RoomPluginRuntimeError(message.failure)); return;
        }
        if (!(SANDBOX_FAILURES as readonly string[]).includes(message.failure)
          || message.exceptionHint !== undefined && !["memory_exhausted", "stack_exhausted"].includes(message.exceptionHint)
          || message.hostPhase !== undefined && !hostPhases.includes(message.hostPhase)) throw new RoomPluginRuntimeError("kernel-protocol");
        this.hint = message.exceptionHint; this.memory(message.wasmMemoryBytes); this.timings(message.startupTiming);
        this.fail(new SandboxError(message.failure, message.exceptionHint, message.hostPhase)); return;
      }
      if (message.type === "closed") throw new RoomPluginRuntimeError("kernel-protocol");
      const operation = this.operation;
      if (!operation || operation.id !== message.id || operation.batches.size) throw new RoomPluginRuntimeError("kernel-protocol");
      if (message.type === "prepared") {
        if (operation.type !== "prepare") throw new RoomPluginRuntimeError("kernel-protocol");
        this.memory(message.wasmMemoryBytes); this.timings(message.startupTiming); this.finish(operation); return;
      }
      if (message.type !== "result" || operation.type === "prepare") throw new RoomPluginRuntimeError("kernel-protocol");
      const result = message.result;
      if (!result || result.lifecycle !== "fulfilled" || !Array.isArray(result.requests) || result.requests.length > SANDBOX_LIMITS.requestQueueSize
        || !Number.isSafeInteger(result.turnCount) || result.turnCount < 1 || result.turnCount > 1000
        || !Number.isFinite(result.executionMs) || result.executionMs < 0 || result.executionMs > result.turnCount * SANDBOX_LIMITS.handlerBudgetMs
        || !Number.isFinite(result.maxTurnExecutionMs) || result.maxTurnExecutionMs < 0 || result.maxTurnExecutionMs > SANDBOX_LIMITS.handlerBudgetMs
        || !Number.isSafeInteger(result.jobs) || result.jobs < 0 || result.jobs > result.turnCount * SANDBOX_LIMITS.jobsPerTurn
        || !Number.isSafeInteger(result.requestCount) || result.requestCount < result.requests.length || result.requestCount > result.turnCount * SANDBOX_LIMITS.requestQueueSize) throw new RoomPluginRuntimeError("kernel-protocol");
      result.requests.forEach(validateRoomPluginRequest); this.memory(result.wasmMemoryBytes);
      if (operation.type === "init") this.currentState = "ready";
      if (operation.type === "dispose") this.currentState = "disposed";
      this.finish(operation, result);
      // The kernel explicitly stops its child before acknowledging closure.
      // Do not terminate the outer worker in the result task ahead of that ACK.
      if (this.currentState === "disposed") this.awaitClosed(); else this.pump();
    } catch { this.fail(new RoomPluginRuntimeError("kernel-protocol")); }
  }
  private finish(operation: Operation, value?: PluginActionResult): void {
    this.observePrepare(operation);
    clearTimeout(operation.timer); this.operation = undefined; operation.abort.abort(); operation.resolve(value);
  }
  private observePrepare(operation: Operation | undefined): void {
    if (operation?.type !== "prepare") return;
    const elapsed = this.clock() - operation.startedAtMs;
    this.startup.prepareRoundTripMs = Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(60_000, elapsed) : null;
  }
  private memory(value: number | undefined): void {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < SANDBOX_LIMITS.wasmInitialMemoryBytes || value > SANDBOX_LIMITS.wasmMaxMemoryBytes) throw new RoomPluginRuntimeError("kernel-protocol");
    this.memoryBytes = value;
  }
  private timings(value: KernelStartupTiming | undefined): void {
    if (!value) return;
    const safe = (number: number | null) => number !== null && Number.isFinite(number) && number >= 0 ? Math.min(number, 60_000) : null;
    this.startup = { ...this.startup, moduleAgeMs: safe(value.moduleAgeMs), prepareMs: safe(value.prepareMs) };
  }
  private fail(error: Error): void {
    if (this.closed()) return;
    this.currentState = "failed"; this.failureCode = error instanceof SandboxError ? error.code : "worker_error";
    const operation = this.operation; this.operation = undefined;
    this.observePrepare(operation);
    const diagnosed = error instanceof SandboxError ? new SandboxError(error.code, error.exceptionHint, error.hostPhase, { ...this.startup })
      : error instanceof RoomPluginRuntimeError ? new RoomPluginRuntimeError(error.code, { ...this.startup }) : error;
    if (operation) { clearTimeout(operation.timer); operation.abort.abort(); for (const batch of operation.batches.values()) batch.abort(); operation.reject(diagnosed); }
    for (const queued of this.events.splice(0)) queued.reject(diagnosed);
    if (!this.closing) {
      this.closing = true;
      try { this.worker.postMessage({ version: 1, type: "terminate" }, []); } catch { /* Fallback still closes the trusted outer worker. */ }
      this.awaitClosed();
    }
  }
  private awaitClosed(): void {
    if (this.shutdownTimer === undefined) this.shutdownTimer = setTimeout(() => this.finalize(), KERNEL_TERMINATE_ACK_MS);
  }
  private finalize(): void {
    if (!this.closed()) this.fail(new RoomPluginRuntimeError("kernel-protocol"));
    clearTimeout(this.shutdownTimer); this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null; this.worker.terminate();
  }
  private closed() { return this.currentState === "failed" || this.currentState === "disposed"; }
}
