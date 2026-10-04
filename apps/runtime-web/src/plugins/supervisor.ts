import {
  parseRoomPluginJson, validateRoomPluginRequest, validateRoomPluginEvent, validateRoomPluginData,
  validateRoomPluginCapabilities, roomPluginUtf8ByteLength,
  type RoomPluginEvent, type RoomPluginConfig, type RoomPluginRequest, type RoomPluginCapability
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
interface Pending { command: WorkerCommand; resolve: (turn: VmTurn) => void; reject: (error: SandboxError) => void }
export type InstanceState = "booting" | "ready" | "disposing" | "disposed" | "failed";
export interface SupervisorOptions { clock?: () => number }

/** Independent native capability/rate fences; guest time/counts confer no authority. */
export class PluginSupervisor {
  private pending?: Pending;
  private queue: Pending[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private nextId = 0;
  private currentState: InstanceState = "booting";
  private failureCode?: SandboxFailure;
  private hint?: GuestExceptionHint;
  private hello = false;
  private prepared = false;
  private preparation?: Extract<WorkerCommand, { type: "prepare" }>;
  private prepareSent = false;
  private bootSubmitted = false;
  private readonly approved: readonly RoomPluginCapability[];
  private readonly clock: () => number;
  private requestTimes: number[] = [];
  private statusTimes: number[] = [];
  private memoryBytes?: number;

  constructor(
    private readonly worker: SandboxWorker,
    approvedCapabilities: readonly RoomPluginCapability[],
    private readonly onStatus: (request: Extract<RoomPluginRequest, { operation: "status.set" }>) => void = () => {},
    options: SupervisorOptions = {}
  ) {
    try { this.approved = validateRoomPluginCapabilities(approvedCapabilities); }
    catch { worker.terminate(); throw new SandboxError("invalid_input"); }
    this.clock = options.clock ?? (() => performance.now());
    worker.onmessage = (event) => this.reply(event.data);
    worker.onerror = (event) => { event.preventDefault(); this.fail("worker_error"); };
    worker.onmessageerror = () => this.fail("worker_protocol");
    // One finite budget covers native bundle loading, hello, module instantiation
    // and trusted primordial capture. No guest source is sent in this phase.
    this.timer = setTimeout(() => this.fail("worker_boot_timeout"), SANDBOX_LIMITS.workerModuleLoadDeadlineMs);
  }

  get state(): InstanceState { return this.currentState; }
  get failure(): SandboxFailure | undefined { return this.failureCode; }
  get exceptionHint(): GuestExceptionHint | undefined { return this.hint; }
  get wasmMemoryBytes(): number | undefined { return this.memoryBytes; }

  init(wasm: WebAssembly.Module, source: string, config: RoomPluginConfig = {}): Promise<VmTurn> {
    if (this.bootSubmitted || this.currentState !== "booting") return Promise.reject(new SandboxError("instance_closed"));
    this.bootSubmitted = true;
    try {
      if (!(wasm instanceof WebAssembly.Module) || typeof source !== "string" || source.length > SANDBOX_LIMITS.artifactBytes ||
          roomPluginUtf8ByteLength(source) > SANDBOX_LIMITS.artifactBytes) throw new SandboxError("invalid_input");
      const safeConfig = validateRoomPluginData(config);
      if (!safeConfig || Array.isArray(safeConfig) || typeof safeConfig !== "object" ||
          Object.values(safeConfig).some((value) => !["string", "number", "boolean"].includes(typeof value))) throw new SandboxError("invalid_input");
      const configJson = JSON.stringify(safeConfig);
      this.preparation = { version: 1, id: ++this.nextId, type: "prepare", wasm, approvedCapabilities: this.approved };
      const boot = this.submit({ version: 1, id: ++this.nextId, type: "init", source, configJson });
      this.sendPreparation();
      return boot;
    } catch {
      this.fail("invalid_input");
      return Promise.reject(new SandboxError("invalid_input"));
    }
  }

  event(event: RoomPluginEvent): Promise<VmTurn> {
    if (this.currentState !== "ready") return Promise.reject(new SandboxError("instance_closed"));
    try {
      const eventJson = JSON.stringify(validateRoomPluginEvent(event));
      return this.submit({ version: 1, id: ++this.nextId, type: "event", eventJson });
    } catch { return Promise.reject(new SandboxError("invalid_input")); }
  }

  dispose(): Promise<VmTurn> {
    if (this.currentState !== "ready") { this.terminate(); return Promise.reject(new SandboxError("instance_closed")); }
    this.currentState = "disposing";
    return this.submit({ version: 1, id: ++this.nextId, type: "dispose" });
  }

  terminate(): void { if (!this.isClosed()) this.fail("instance_closed"); }

  private sendPreparation(): void {
    if (!this.hello || !this.preparation || this.prepareSent || this.isClosed()) return;
    this.prepareSent = true;
    try { this.worker.postMessage(this.preparation, []); }
    catch { this.fail("worker_error"); }
  }

  private submit(command: WorkerCommand): Promise<VmTurn> {
    if (this.isClosed()) return Promise.reject(new SandboxError(this.failureCode ?? "instance_closed"));
    if (this.queue.length >= SANDBOX_LIMITS.requestQueueSize) {
      this.fail("host_queue_limit");
      return Promise.reject(new SandboxError("host_queue_limit"));
    }
    return new Promise((resolve, reject) => { this.queue.push({ command, resolve, reject }); this.flush(); });
  }

  private flush(): void {
    if (!this.prepared || this.pending || this.isClosed()) return;
    this.pending = this.queue.shift();
    if (!this.pending) return;
    this.timer = setTimeout(() => this.fail("worker_timeout"), SANDBOX_LIMITS.workerResponseDeadlineMs);
    try { this.worker.postMessage(this.pending.command, []); }
    catch { this.fail("worker_error"); }
  }

  private validMemory(bytes: number): boolean {
    return Number.isSafeInteger(bytes) && bytes >= SANDBOX_LIMITS.wasmInitialMemoryBytes && bytes <= SANDBOX_LIMITS.wasmMaxMemoryBytes;
  }

  private reply(reply: WorkerReply): void {
    if (this.isClosed()) return;
    if (!reply || reply.version !== 1) { this.fail("worker_protocol"); return; }
    if (reply.type === "hello") {
      if (this.hello || this.prepared) { this.fail("worker_protocol"); return; }
      this.hello = true; this.sendPreparation(); return;
    }
    if (reply.type === "prepared") {
      if (!this.prepareSent || this.prepared || reply.id !== this.preparation?.id || !this.validMemory(reply.wasmMemoryBytes)) { this.fail("worker_protocol"); return; }
      this.prepared = true; this.preparation = undefined; this.memoryBytes = reply.wasmMemoryBytes;
      clearTimeout(this.timer); this.flush(); return;
    }
    if (reply.type !== "result") { this.fail("worker_protocol"); return; }
    const expectedId = this.prepared ? this.pending?.command.id : this.preparation?.id;
    if (!expectedId || reply.id !== expectedId) { this.fail("worker_protocol"); return; }
    if (reply.ok === false) {
      if (reply.exceptionHint !== undefined && !["memory_exhausted", "stack_exhausted"].includes(reply.exceptionHint)) { this.fail("worker_protocol"); return; }
      this.fail((SANDBOX_FAILURES as readonly string[]).includes(reply.failure) ? reply.failure : "worker_protocol", reply.exceptionHint);
      return;
    }
    const pending = this.pending;
    if (!pending) { this.fail("worker_protocol"); return; }
    try {
      if (reply.ok !== true || typeof reply.turnJson !== "string") throw new SandboxError("worker_protocol");
      const turn = parseRoomPluginJson(reply.turnJson) as unknown as VmTurn;
      if (!turn || typeof turn.executionMs !== "number" || turn.executionMs < 0 || turn.executionMs > SANDBOX_LIMITS.handlerBudgetMs ||
          !Number.isInteger(turn.jobs) || turn.jobs < 0 || turn.jobs > SANDBOX_LIMITS.jobsPerTurn || !this.validMemory(turn.wasmMemoryBytes) ||
          !Array.isArray(turn.requests) || turn.requests.length > SANDBOX_LIMITS.requestQueueSize) throw new SandboxError("worker_protocol");
      const requests = turn.requests.map((request) => validateRoomPluginRequest(request));
      const ids = new Set<string>();
      for (const request of requests) {
        if (ids.has(request.requestId)) throw new SandboxError("worker_protocol");
        ids.add(request.requestId);
        if (!this.approved.includes(request.operation) || request.operation !== "status.set") throw new SandboxError("capability_denied");
      }
      // Entire-turn validation is atomic: no first status leaks out when a later
      // request has invalid data, lacks approval, or violates native quotas.
      const now = this.clock();
      const requestTimes = this.requestTimes.filter((time) => now - time < 1000);
      const statusTimes = this.statusTimes.filter((time) => now - time < 1000);
      if (requestTimes.length + requests.length > SANDBOX_LIMITS.requestsPerSecond) throw new SandboxError("bridge_rate_limit");
      if (statusTimes.length + requests.length > SANDBOX_LIMITS.statusUpdatesPerSecond) throw new SandboxError("status_rate_limit");
      for (const _ of requests) { requestTimes.push(now); statusTimes.push(now); }
      this.requestTimes = requestTimes; this.statusTimes = statusTimes;
      this.memoryBytes = turn.wasmMemoryBytes;
      for (const request of requests) {
        if (this.isClosed()) return;
        if (request.operation === "status.set") this.onStatus(request);
      }
      if (this.isClosed()) return;
      clearTimeout(this.timer); this.pending = undefined;
      if (pending.command.type === "init") this.currentState = "ready";
      if (pending.command.type === "dispose") { this.currentState = "disposed"; this.worker.terminate(); this.detach(); }
      pending.resolve({ ...turn, requests }); this.flush();
    } catch (error) { this.fail(error instanceof SandboxError ? error.code : "worker_protocol"); }
  }

  private fail(code: SandboxFailure, hint?: GuestExceptionHint): void {
    if (this.isClosed()) return;
    this.failureCode = code; this.hint = hint; this.currentState = "failed";
    clearTimeout(this.timer); this.worker.terminate(); this.detach();
    const error = new SandboxError(code, hint);
    this.pending?.reject(error); this.pending = undefined;
    for (const pending of this.queue) pending.reject(error);
    this.queue = []; this.preparation = undefined;
  }
  private detach(): void { this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null; }
  private isClosed(): boolean { return this.currentState === "failed" || this.currentState === "disposed"; }
}
