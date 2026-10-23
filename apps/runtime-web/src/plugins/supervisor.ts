import {
  parseRoomPluginJson, validateRoomPluginRequest, validateRoomPluginResponse, validateRoomPluginEvent, validateRoomPluginData,
  validateRoomPluginCapabilities, roomPluginUtf8ByteLength,
  type RoomPluginEvent, type RoomPluginConfig, type RoomPluginRequest, type RoomPluginResponse, type RoomPluginCapability
} from "@vrata/room-plugin-sdk";
import { SANDBOX_FAILURES, SANDBOX_LIMITS, SandboxError, type SandboxFailure, type GuestExceptionHint } from "./limits.js";
import type { WorkerCommand, WorkerReply } from "./protocol.js";
import type { VmTurn } from "./vm.js";

export interface SandboxWorker {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(command: WorkerCommand, transfer: Transferable[]): void;
  terminate(): void;
}
export interface PluginActionResult extends VmTurn {
  /** Total measured VM work across resumed turns; each reply is separately <=50ms. */
  maxTurnExecutionMs: number;
  turnCount: number;
  requestCount: number;
}
interface Pending { command: WorkerCommand; resolve(turn: VmTurn): void; reject(error: SandboxError): void }
interface Action {
  command: WorkerCommand;
  promise: Promise<PluginActionResult>;
  resolve(turn: PluginActionResult): void;
  reject(error: SandboxError): void;
}
export type InstanceState = "booting" | "ready" | "disposing" | "disposed" | "failed";
export interface SupervisorOptions {
  clock?: () => number;
  dispatch?: (request: RoomPluginRequest, signal: AbortSignal, canCommit: () => boolean) => RoomPluginResponse | Promise<RoomPluginResponse>;
  onFailure?: (error: SandboxError) => void;
}

/** One logical lifecycle at a time. Only bounded VM commands run in the Worker;
 * asynchronous host waits do not extend their independent watchdog or authority. */
export class PluginSupervisor {
  private pending?: Pending;
  private queue: Action[] = [];
  private activeAction?: Action;
  private timer?: ReturnType<typeof setTimeout>;
  private actionTimer?: ReturnType<typeof setTimeout>;
  private actionAbort?: AbortController;
  private nextId = 0;
  private lastRequestId = 0;
  private currentState: InstanceState = "booting";
  private failureCode?: SandboxFailure;
  private hint?: GuestExceptionHint;
  private hello = false;
  private prepared = false;
  private preparation?: Extract<WorkerCommand, { type: "prepare" }>;
  private wasm?: WebAssembly.Module;
  private preparationReady?: { promise: Promise<void>; resolve(): void; reject(error: SandboxError): void };
  private prepareSent = false;
  private bootSubmitted = false;
  private readonly approved: readonly RoomPluginCapability[];
  private readonly clock: () => number;
  private readonly dispatch: NonNullable<SupervisorOptions["dispatch"]>;
  private readonly onFailure?: SupervisorOptions["onFailure"];
  private requestTimes: number[] = [];
  private statusTimes: number[] = [];
  private memoryBytes?: number;
  private moduleAgeMs: number | null = null;
  private prepareMs: number | null = null;

  constructor(private readonly worker: SandboxWorker, approvedCapabilities: readonly RoomPluginCapability[],
    onStatus: (request: Extract<RoomPluginRequest, { operation: "status.set" }>) => void = () => {}, options: SupervisorOptions = {}) {
    try { this.approved = validateRoomPluginCapabilities(approvedCapabilities); }
    catch { worker.terminate(); throw new SandboxError("invalid_input"); }
    this.clock = options.clock ?? (() => performance.now());
    this.onFailure = options.onFailure;
    this.dispatch = options.dispatch ?? (request => {
      if (request.operation !== "status.set") return { sdkApiVersion: 1, requestId: request.requestId, ok: false, error: "capability-denied" };
      onStatus(request);
      return { sdkApiVersion: 1, requestId: request.requestId, ok: true, result: null };
    });
    worker.onmessage = event => this.reply(event.data);
    worker.onerror = event => { event.preventDefault(); this.fail("worker_error"); };
    worker.onmessageerror = () => this.fail("worker_protocol");
    this.timer = setTimeout(() => this.fail("worker_boot_timeout"), SANDBOX_LIMITS.workerModuleLoadDeadlineMs);
  }

  get state(): InstanceState { return this.currentState; }
  get failure(): SandboxFailure | undefined { return this.failureCode; }
  get exceptionHint(): GuestExceptionHint | undefined { return this.hint; }
  get wasmMemoryBytes(): number | undefined { return this.memoryBytes; }
  get busy(): boolean { return Boolean(this.activeAction); }
  get startupTiming() { return { moduleAgeMs: this.moduleAgeMs, prepareMs: this.prepareMs }; }

  /** Trusted module only, without author source or lifecycle work. This split
   * lets a main-thread facade stamp its effect window AFTER preparation ACK. */
  prepare(wasm: WebAssembly.Module): Promise<void> {
    if (this.isClosed() || this.currentState !== "booting") return Promise.reject(new SandboxError("instance_closed"));
    if (!(wasm instanceof WebAssembly.Module) || this.wasm && this.wasm !== wasm) {
      this.fail("invalid_input"); return Promise.reject(new SandboxError("invalid_input"));
    }
    if (this.preparationReady) return this.preparationReady.promise;
    this.wasm = wasm;
    let resolve!: () => void, reject!: (error: SandboxError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.preparationReady = { promise, resolve, reject };
    this.preparation = { version: 1, id: ++this.nextId, type: "prepare", wasm, approvedCapabilities: this.approved };
    this.sendPreparation(); return promise;
  }

  init(wasm: WebAssembly.Module, source: string, config: RoomPluginConfig = {}): Promise<PluginActionResult> {
    if (this.bootSubmitted || this.currentState !== "booting") return Promise.reject(new SandboxError("instance_closed"));
    this.bootSubmitted = true;
    try {
      if (!(wasm instanceof WebAssembly.Module) || typeof source !== "string" || source.length > SANDBOX_LIMITS.artifactBytes
        || roomPluginUtf8ByteLength(source) > SANDBOX_LIMITS.artifactBytes) throw new SandboxError("invalid_input");
      const safe = validateRoomPluginData(config);
      if (!safe || Array.isArray(safe) || typeof safe !== "object"
        || Object.values(safe).some(value => !["string", "number", "boolean"].includes(typeof value))) throw new SandboxError("invalid_input");
      void this.prepare(wasm).catch(() => undefined);
      const result = this.enqueue({ version: 1, id: ++this.nextId, type: "init", source, configJson: JSON.stringify(safe) });
      this.sendPreparation(); return result;
    } catch {
      this.fail("invalid_input"); return Promise.reject(new SandboxError("invalid_input"));
    }
  }

  event(event: RoomPluginEvent): Promise<PluginActionResult> {
    if (this.currentState !== "ready") return Promise.reject(new SandboxError("instance_closed"));
    try {
      const validated = validateRoomPluginEvent(event), eventJson = JSON.stringify(validated);
      // Informational state notifications are latest-value data, not an
      // unbounded queue of events while the guest awaits a broker response.
      const index = this.queue.findIndex(action => action.command.type === "event"
        && JSON.parse(action.command.eventJson).type === validated.type);
      if (index >= 0) {
        const [queued] = this.queue.splice(index, 1);
        queued.command = { version: 1, id: queued.command.id, type: "event", eventJson };
        this.queue.push(queued); return queued.promise;
      }
      return this.enqueue({ version: 1, id: ++this.nextId, type: "event", eventJson });
    } catch { return Promise.reject(new SandboxError("invalid_input")); }
  }

  dispose(): Promise<PluginActionResult> {
    if (this.currentState !== "ready" || this.activeAction) {
      this.terminate(); return Promise.reject(new SandboxError("instance_closed"));
    }
    this.currentState = "disposing";
    return this.enqueue({ version: 1, id: ++this.nextId, type: "dispose" });
  }

  terminate(): void { if (!this.isClosed()) this.fail("instance_closed"); }

  private enqueue(command: WorkerCommand): Promise<PluginActionResult> {
    if (this.isClosed()) return Promise.reject(new SandboxError(this.failureCode ?? "instance_closed"));
    if (this.queue.length >= SANDBOX_LIMITS.requestQueueSize) {
      this.fail("host_queue_limit"); return Promise.reject(new SandboxError("host_queue_limit"));
    }
    let resolve!: Action["resolve"], reject!: Action["reject"];
    const promise = new Promise<PluginActionResult>((yes, no) => { resolve = yes; reject = no; });
    this.queue.push({ command, promise, resolve, reject }); this.flush(); return promise;
  }

  private flush(): void {
    if (!this.prepared || this.activeAction || this.isClosed()) return;
    const action = this.queue.shift(); if (!action) return;
    this.activeAction = action;
    void this.execute(action).then(result => {
      if (this.isClosed()) return;
      this.activeAction = undefined;
      if (action.command.type === "init") this.currentState = "ready";
      if (action.command.type === "dispose") { this.currentState = "disposed"; this.worker.terminate(); this.detach(); }
      action.resolve(result); this.flush();
    }, error => this.fail(error instanceof SandboxError ? error.code : "host_error"));
  }

  private async execute(action: Action): Promise<PluginActionResult> {
    const lifetime = action.command.type === "dispose" ? SANDBOX_LIMITS.workerResponseDeadlineMs : SANDBOX_LIMITS.bindingLeaseMs;
    const started = this.clock();
    if (!Number.isFinite(started) || started < 0) throw new SandboxError("host_error");
    const deadline = started + lifetime, abort = new AbortController(); this.actionAbort = abort;
    this.actionTimer = setTimeout(() => this.fail("lifecycle_timeout"), lifetime);
    try {
      let turn = await this.exchange(action.command);
      let executionMs = 0, jobs = 0, maxTurnExecutionMs = 0, turnCount = 0, requestCount = 0;
      const requests: RoomPluginRequest[] = [];
      for (;;) {
        this.checkAction(deadline);
        executionMs += turn.executionMs; jobs += turn.jobs; maxTurnExecutionMs = Math.max(maxTurnExecutionMs, turn.executionMs); turnCount++;
        requestCount += turn.requests.length; requests.push(...turn.requests);
        if (requests.length > SANDBOX_LIMITS.requestQueueSize) requests.splice(0, requests.length - SANDBOX_LIMITS.requestQueueSize);
        if (turn.lifecycle === "fulfilled") return { ...turn, requests, executionMs, jobs, maxTurnExecutionMs, turnCount, requestCount };
        const responses: RoomPluginResponse[] = [];
        const pending: Array<Promise<RoomPluginResponse>> = [];
        // Invoking a broker is synchronous, so its lease/identity check and
        // status commit happen together. Only the trusted response may await.
        for (const request of turn.requests) {
          this.checkAction(deadline);
          if (action.command.type === "dispose") responses.push({ sdkApiVersion: 1, requestId: request.requestId, ok: false, error: "cancelled" });
          else {
            let response: Promise<RoomPluginResponse>;
            try { response = Promise.resolve(this.dispatch(request, abort.signal,
              () => !this.isClosed() && Number.isFinite(this.clock()) && this.clock() < deadline)); }
            catch { throw new SandboxError("host_error"); }
            void response.catch(() => undefined); pending.push(response);
          }
        }
        let settled: RoomPluginResponse[];
        try { settled = await this.waitForHost(pending, abort.signal); }
        catch { throw new SandboxError(this.isClosed() ? this.failureCode ?? "instance_closed" : "host_error"); }
        this.checkAction(deadline);
        responses.push(...settled);
        const checked = responses.map((response, index) => {
          const value = validateRoomPluginResponse(response);
          if (value.requestId !== turn.requests[index].requestId) throw new SandboxError("host_error");
          return value;
        });
        turn = await this.exchange({ version: 1, id: ++this.nextId, type: "respond", responsesJson: JSON.stringify(checked) });
      }
    } catch (error) {
      this.fail(error instanceof SandboxError ? error.code : "host_error");
      abort.abort(); throw error;
    } finally { clearTimeout(this.actionTimer); this.actionTimer = undefined; this.actionAbort = undefined; }
  }

  private waitForHost(pending: Array<Promise<RoomPluginResponse>>, signal: AbortSignal): Promise<RoomPluginResponse[]> {
    return new Promise((resolve, reject) => {
      const cancelled = () => { signal.removeEventListener("abort", cancelled); reject(new SandboxError(this.failureCode ?? "instance_closed")); };
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      void Promise.all(pending).then(value => { signal.removeEventListener("abort", cancelled); resolve(value); },
        error => { signal.removeEventListener("abort", cancelled); reject(error); });
    });
  }

  private checkAction(deadline: number): void {
    if (this.isClosed()) throw new SandboxError("instance_closed");
    const now = this.clock();
    if (!Number.isFinite(now) || now < 0) throw new SandboxError("host_error");
    if (now >= deadline) throw new SandboxError("lifecycle_timeout");
  }

  private exchange(command: WorkerCommand): Promise<VmTurn> {
    if (this.isClosed() || this.pending) return Promise.reject(new SandboxError("instance_closed"));
    return new Promise((resolve, reject) => {
      this.pending = { command, resolve, reject };
      this.timer = setTimeout(() => this.fail("worker_timeout"), SANDBOX_LIMITS.workerResponseDeadlineMs);
      try { this.worker.postMessage(command, []); } catch { this.fail("worker_error"); }
    });
  }

  private sendPreparation(): void {
    if (!this.hello || !this.preparation || this.prepareSent || this.isClosed()) return;
    this.prepareSent = true;
    try { this.worker.postMessage(this.preparation, []); } catch { this.fail("worker_error"); }
  }

  private validMemory(bytes: number): boolean {
    return Number.isSafeInteger(bytes) && bytes >= SANDBOX_LIMITS.wasmInitialMemoryBytes && bytes <= SANDBOX_LIMITS.wasmMaxMemoryBytes;
  }

  private reply(reply: WorkerReply): void {
    if (this.isClosed()) return;
    if (!reply || reply.version !== 1) { this.fail("worker_protocol"); return; }
    if (reply.type === "hello") {
      if (this.hello || this.prepared) { this.fail("worker_protocol"); return; }
      if (typeof reply.moduleAgeMs === "number" && Number.isFinite(reply.moduleAgeMs) && reply.moduleAgeMs >= 0) this.moduleAgeMs = Math.min(60_000, reply.moduleAgeMs);
      this.hello = true; this.sendPreparation(); return;
    }
    if (reply.type === "prepared") {
      if (!this.prepareSent || this.prepared || reply.id !== this.preparation?.id || !this.validMemory(reply.wasmMemoryBytes)) { this.fail("worker_protocol"); return; }
      this.prepared = true; this.preparation = undefined; this.memoryBytes = reply.wasmMemoryBytes;
      if (typeof reply.prepareMs === "number" && Number.isFinite(reply.prepareMs) && reply.prepareMs >= 0) this.prepareMs = Math.min(60_000, reply.prepareMs);
      clearTimeout(this.timer); this.timer = undefined; this.preparationReady?.resolve(); this.flush(); return;
    }
    if (reply.type !== "result") { this.fail("worker_protocol"); return; }
    const expectedId = this.prepared ? this.pending?.command.id : this.preparation?.id;
    if (!expectedId || reply.id !== expectedId) { this.fail("worker_protocol"); return; }
    if (reply.ok === false) {
      if (reply.exceptionHint !== undefined && !["memory_exhausted", "stack_exhausted"].includes(reply.exceptionHint)) { this.fail("worker_protocol"); return; }
      const allowed = (SANDBOX_FAILURES as readonly string[]).includes(reply.failure) && !["host_error", "lifecycle_timeout"].includes(reply.failure);
      this.fail(allowed ? reply.failure : "worker_protocol", reply.exceptionHint); return;
    }
    const pending = this.pending;
    if (!pending) { this.fail("worker_protocol"); return; }
    try {
      if (reply.ok !== true || typeof reply.turnJson !== "string") throw new SandboxError("worker_protocol");
      const turn = parseRoomPluginJson(reply.turnJson) as unknown as VmTurn;
      if (!turn || Object.keys(turn).length !== 5 || !["requests", "executionMs", "jobs", "wasmMemoryBytes", "lifecycle"].every(key => Object.hasOwn(turn, key))
        || typeof turn.executionMs !== "number" || turn.executionMs < 0 || turn.executionMs > SANDBOX_LIMITS.handlerBudgetMs
        || !Number.isInteger(turn.jobs) || turn.jobs < 0 || turn.jobs > SANDBOX_LIMITS.jobsPerTurn || !this.validMemory(turn.wasmMemoryBytes)
        || !["pending", "fulfilled"].includes(turn.lifecycle) || !Array.isArray(turn.requests) || turn.requests.length > SANDBOX_LIMITS.requestQueueSize
        || (turn.requests.length > 0) !== (turn.lifecycle === "pending")) throw new SandboxError("worker_protocol");
      const requests = turn.requests.map(request => validateRoomPluginRequest(request));
      let lastId = this.lastRequestId;
      for (const request of requests) {
        const id = Number(request.requestId);
        if (!Number.isSafeInteger(id) || id <= lastId || String(id) !== request.requestId) throw new SandboxError("worker_protocol");
        lastId = id;
        if (!this.approved.includes(request.operation)) throw new SandboxError("capability_denied");
      }
      const now = this.clock(); if (!Number.isFinite(now) || now < 0) throw new SandboxError("host_error");
      const requestTimes = this.requestTimes.filter(time => now - time < 1000), statusTimes = this.statusTimes.filter(time => now - time < 1000);
      const statuses = requests.filter(request => request.operation === "status.set").length;
      if (requestTimes.length + requests.length > SANDBOX_LIMITS.requestsPerSecond) throw new SandboxError("bridge_rate_limit");
      if (statusTimes.length + statuses > SANDBOX_LIMITS.statusUpdatesPerSecond) throw new SandboxError("status_rate_limit");
      this.requestTimes = [...requestTimes, ...requests.map(() => now)]; this.statusTimes = [...statusTimes, ...Array.from({ length: statuses }, () => now)];
      this.lastRequestId = lastId; this.memoryBytes = turn.wasmMemoryBytes;
      clearTimeout(this.timer); this.timer = undefined; this.pending = undefined;
      pending.resolve({ ...turn, requests });
    } catch (error) { this.fail(error instanceof SandboxError ? error.code : "worker_protocol"); }
  }

  private fail(code: SandboxFailure, hint?: GuestExceptionHint): void {
    if (this.isClosed()) return;
    this.failureCode = code; this.hint = hint; this.currentState = "failed";
    clearTimeout(this.timer); clearTimeout(this.actionTimer); this.actionAbort?.abort(); this.worker.terminate(); this.detach();
    const phase = !this.hello ? "worker-hello" : !this.prepared ? "worker-prepare" : this.pending?.command.type ?? this.activeAction?.command.type;
    const hostPhase = phase && phase !== "prepare" ? phase : undefined;
    const error = new SandboxError(code, hint, hostPhase);
    this.preparationReady?.reject(error);
    this.pending?.reject(error); this.pending = undefined;
    this.activeAction?.reject(error); this.activeAction = undefined;
    for (const action of this.queue) action.reject(error);
    this.queue = [];
    try { this.onFailure?.(error); } catch { /* Failure notification cannot reopen the stopped child or interrupt cleanup. */ }
  }
  private detach(): void { this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null; }
  private isClosed(): boolean { return this.currentState === "failed" || this.currentState === "disposed"; }
}
