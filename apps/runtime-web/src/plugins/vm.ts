import {
  ROOM_PLUGIN_LIMITS, parseRoomPluginEvent, parseRoomPluginRequest,
  validateRoomPluginData, validateRoomPluginCapabilities, RoomPluginValidationError,
  roomPluginUtf8ByteLength, type RoomPluginConfig, type RoomPluginRequest, type RoomPluginCapability
} from "@vrata/room-plugin-sdk";
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule, VmCallResult } from "quickjs-emscripten-core";
import { ExecutionBudget, SANDBOX_FAILURES, SANDBOX_LIMITS, SandboxError, type SandboxFailure } from "./limits.js";
import { VM_BOOTSTRAP } from "./vm-bootstrap.js";

export interface VmTurn {
  requests: RoomPluginRequest[]; executionMs: number; jobs: number;
  /** Actual WASM buffer size, NOT VM heap usage or total Worker/browser memory. */
  wasmMemoryBytes: number;
}
export interface VmOptions { clock?: () => number; approvedCapabilities: readonly RoomPluginCapability[] }

/** One QuickJS runtime/context per instance. Only bounded strings produced by
 * retained trusted closures may cross the VM boundary; never unwrapResult/dump.
 */
export class PluginVm {
  private readonly runtime: QuickJSRuntime;
  private readonly vm: QuickJSContext;
  private readonly clock: () => number;
  private readonly budget = new ExecutionBudget();
  private readonly helpers = new Map<string, QuickJSHandle>();
  private started = 0;
  private active = false;
  private initializing = true;
  private closed = false;
  private interrupts = 0;
  private jobs = 0;
  private interrupted?: SandboxFailure;
  private bootstrapping = false;
  private readonly approvedCapabilities: readonly RoomPluginCapability[];

  constructor(private readonly module: Pick<QuickJSWASMModule, "newContext" | "getWasmMemory">, options: VmOptions) {
    try { this.approvedCapabilities = validateRoomPluginCapabilities(options?.approvedCapabilities); }
    catch { throw new SandboxError("invalid_input"); }
    this.clock = options.clock ?? (() => performance.now());
    // newContext owns its otherwise-private runtime (the official tracked
    // newRuntime wrapper in 0.32.0 loses ownedLifetimes in module.newRuntime).
    this.vm = module.newContext();
    this.runtime = this.vm.runtime;
    this.runtime.setMemoryLimit(SANDBOX_LIMITS.vmHeapBytes);
    this.runtime.setMaxStackSize(SANDBOX_LIMITS.vmStackBytes);
    this.runtime.removeModuleLoader();
    this.runtime.setInterruptHandler(() => {
      if (!this.active) { this.interrupted = "execution_timeout"; return true; }
      this.interrupted ??= this.checkDeadline();
      if (++this.interrupts > SANDBOX_LIMITS.interruptsPerTurn) this.interrupted ??= "interrupt_limit";
      return !!this.interrupted;
    });
  }

  /** Trusted primordial capture is part of bounded boot, before guest init. */
  prepare(): void {
    if (this.closed || this.helpers.size) throw new SandboxError("invalid_lifecycle");
    this.started = this.clock();
    this.active = this.bootstrapping = true;
    this.interrupted = undefined;
    this.interrupts = 0;
    try {
      const root = this.result(this.vm.evalCode(VM_BOOTSTRAP, "platform-bootstrap.js", { type: "global" }));
      try {
        for (const name of ["configure", "bind", "begin", "invoke", "validateReturn", "collect", "code", "exceptionCode"]) this.helpers.set(name, this.vm.getProp(root, name));
      } finally { root.dispose(); }
      this.guard();
    } catch (error) {
      try { this.close(); } catch { /* Worker termination is the outer boundary. */ }
      throw error instanceof SandboxError ? error : new SandboxError("native_failure");
    } finally { this.active = this.bootstrapping = false; }
  }

  init(source: string, config: RoomPluginConfig = {}): VmTurn {
    if (!this.closed && !this.helpers.size) this.prepare();
    return this.turn(() => {
      if (!this.initializing) throw new SandboxError("invalid_lifecycle");
      if (typeof source !== "string" || source.length > ROOM_PLUGIN_LIMITS.artifactBytes || roomPluginUtf8ByteLength(source) > ROOM_PLUGIN_LIMITS.artifactBytes) throw new SandboxError("invalid_input");
      const safeConfig = validateRoomPluginData(config);
      if (safeConfig === null || Array.isArray(safeConfig) || typeof safeConfig !== "object" ||
          Object.values(safeConfig).some((value) => !["string", "number", "boolean"].includes(typeof value))) throw new SandboxError("invalid_input");
      this.withStrings([JSON.stringify(safeConfig)], ([json]) => {
        this.call("configure", [json, this.approvedCapabilities.includes("status.set") ? this.vm.true : this.vm.false]).dispose();
      });
      this.begin();
      const namespace = this.result(this.vm.evalCode(source, "room-plugin.mjs", { type: "module" }));
      try {
        this.settled(namespace, (exports) => { this.call("bind", [exports]).dispose(); });
      } finally { namespace.dispose(); }
      const returned = this.invoke("init");
      try { this.settled(returned, (value) => { this.call("validateReturn", [value]).dispose(); }); }
      finally { returned.dispose(); }
    });
  }

  event(eventJson: string): VmTurn {
    return this.turn(() => {
      if (this.initializing) throw new SandboxError("invalid_lifecycle");
      parseRoomPluginEvent(eventJson);
      this.begin();
      const returned = this.invoke("onEvent", eventJson);
      try { this.settled(returned, (value) => { this.call("validateReturn", [value]).dispose(); }); }
      finally { returned.dispose(); }
    });
  }

  dispose(): VmTurn {
    try {
      return this.turn(() => {
        this.begin();
        const returned = this.invoke("dispose");
        try { this.settled(returned, (value) => { this.call("validateReturn", [value]).dispose(); }); }
        finally { returned.dispose(); }
      });
    } finally { this.close(); }
  }

  /** Fatal shutdown skips guest dispose entirely. Idempotent; no restart loop. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.helpers.values()) handle.dispose();
    this.helpers.clear();
    try { this.vm.dispose(); } finally { if (this.runtime.alive) this.runtime.dispose(); }
  }

  private checkDeadline(): SandboxFailure | undefined {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.started);
    if (elapsed > (this.bootstrapping ? SANDBOX_LIMITS.workerModuleLoadDeadlineMs : SANDBOX_LIMITS.handlerBudgetMs)) return "execution_timeout";
    if (!this.initializing) return this.budget.check(now, elapsed);
    return undefined;
  }

  private guard(): void {
    this.interrupted ??= this.checkDeadline();
    if (this.interrupted) throw new SandboxError(this.interrupted);
  }

  private turn(action: () => void): VmTurn {
    if (this.closed) throw new SandboxError("instance_closed");
    this.started = this.clock();
    this.active = true;
    this.interrupted = undefined;
    this.interrupts = this.jobs = 0;
    try {
      this.guard();
      action();
      this.drain();
      this.guard();
      this.checkStickyFailure();
      // collect() is the VM serializer, not JSON dump of arbitrary guest values.
      const collected = this.call("collect");
      let json: string;
      try { this.guard(); json = this.vm.getString(collected); } finally { collected.dispose(); }
      const requests = JSON.parse(json) as string[];
      if (!Array.isArray(requests) || requests.length > SANDBOX_LIMITS.requestQueueSize) throw new SandboxError("worker_protocol");
      const parsed = requests.map((request) => parseRoomPluginRequest(request));
      const wasmMemoryBytes = this.module.getWasmMemory().buffer.byteLength;
      this.guard();
      const ended = this.clock();
      const executionMs = Math.max(0, ended - this.started);
      if (executionMs > SANDBOX_LIMITS.handlerBudgetMs) throw new SandboxError("execution_timeout");
      if (!this.initializing) {
        const failure = this.budget.charge(ended, executionMs);
        if (failure) throw new SandboxError(failure);
      }
      this.initializing = false;
      return { requests: parsed, executionMs, jobs: this.jobs, wasmMemoryBytes };
    } catch (error) {
      // Do not stringify unknown native errors or inspect live guest exceptions.
      const failure = error instanceof SandboxError ? error : new SandboxError(error instanceof RoomPluginValidationError ? "invalid_input" : "native_failure");
      try { this.close(); } catch { /* Preserve the bounded original failure. */ }
      throw failure;
    } finally { this.active = false; }
  }

  private begin(): void {
    const now = this.vm.newNumber(this.started);
    try { this.call("begin", [now]).dispose(); } finally { now.dispose(); }
  }

  private invoke(name: string, json = "null"): QuickJSHandle {
    return this.withStrings([name, json], (args) => this.call("invoke", args));
  }

  private withStrings<T>(strings: string[], action: (handles: QuickJSHandle[]) => T): T {
    const handles: QuickJSHandle[] = [];
    try { for (const value of strings) handles.push(this.vm.newString(value)); return action(handles); }
    finally { for (const handle of handles) handle.dispose(); }
  }

  private call(name: string, args: QuickJSHandle[] = []): QuickJSHandle {
    this.guard();
    const helper = this.helpers.get(name);
    if (!helper) throw new SandboxError("invalid_lifecycle");
    return this.result(this.vm.callFunction(helper, this.vm.undefined, args));
  }

  private checkStickyFailure(): void {
    const helper = this.helpers.get("code");
    if (!helper) return;
    this.guard();
    const result = this.vm.callFunction(helper, this.vm.undefined);
    if (result.error) { result.error.dispose(); throw new SandboxError(this.interrupted ?? "guest_exception"); }
    try {
      // Trusted closure returns ONLY a fixed code, never any guest string.
      const code = this.vm.getString(result.value);
      if (code && (SANDBOX_FAILURES as readonly string[]).includes(code)) throw new SandboxError(code as SandboxFailure);
    } finally { result.value.dispose(); }
  }

  private result(result: VmCallResult<QuickJSHandle>): QuickJSHandle {
    if (!result.error) return result.value;
    try {
      this.guard();
      this.checkStickyFailure();
      const formatter = this.helpers.get("exceptionCode");
      if (formatter) {
        const diagnostic = this.vm.callFunction(formatter, this.vm.undefined, result.error);
        try {
          this.guard();
          if (!diagnostic.error) {
            const code = this.vm.getString(diagnostic.value);
            if (code === "memory_exhausted" || code === "stack_exhausted") throw new SandboxError("guest_exception", code);
          }
        } finally { diagnostic.dispose(); }
      }
      throw new SandboxError("guest_exception");
    } finally { result.error.dispose(); }
  }

  private drain(): void {
    while (this.runtime.hasPendingJob()) {
      this.guard();
      if (++this.jobs > SANDBOX_LIMITS.jobsPerTurn) throw new SandboxError("job_limit");
      const result = this.runtime.executePendingJobs(1);
      if (result.error) {
        try { this.guard(); this.checkStickyFailure(); throw new SandboxError("guest_exception"); }
        finally { result.error.dispose(); }
      }
      result.dispose();
    }
  }

  private settled(handle: QuickJSHandle, use: (value: QuickJSHandle) => void): void {
    this.drain();
    this.guard();
    const state = this.vm.getPromiseState(handle);
    if (state.type === "pending") throw new SandboxError("pending_promise");
    if (state.type === "rejected") { this.result({ error: state.error } as VmCallResult<QuickJSHandle>); return; }
    // In 0.32.0 the notAPromise branch borrows the input handle; it does not dup.
    try { use(state.value); } finally { if (!state.notAPromise) state.value.dispose(); }
  }
}
