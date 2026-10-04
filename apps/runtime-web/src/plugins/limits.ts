import { ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";

export const SANDBOX_LIMITS = Object.freeze({
  ...ROOM_PLUGIN_LIMITS,
  // The pinned WASM reserves 5 MiB for its linear C stack, but Chromium's
  // compiled-WASM/native call stack can exhaust first. Keep VM checks earlier.
  vmStackBytes: 32 * 1024,
  wasmInitialMemoryBytes: 16 * 1024 * 1024,
  wasmMaxMemoryBytes: 48 * 1024 * 1024,
  workerModuleLoadDeadlineMs: 3000,
  dataNodes: 512,
  jobsPerTurn: 1024,
  interruptsPerTurn: 4096,
  executionSamples: 4096,
  wasmBytes: 2 * 1024 * 1024,
  wasmLoadDeadlineMs: 3000
});

export const SANDBOX_FAILURES = [
  "execution_timeout", "execution_budget_second", "execution_budget_minute",
  "execution_sample_limit", "interrupt_limit", "job_limit", "pending_promise",
  "memory_exhausted", "stack_exhausted", "guest_exception", "native_failure",
  "invalid_lifecycle", "invalid_lifecycle_result", "invalid_data", "unsafe_key",
  "message_too_large", "nesting_too_deep", "node_limit", "bridge_rate_limit",
  "bridge_queue_limit", "status_rate_limit", "capability_denied",
  "worker_timeout", "worker_error", "worker_protocol", "host_queue_limit",
  "wasm_load_failed", "worker_boot_timeout", "invalid_input", "instance_closed"
] as const;
export type SandboxFailure = (typeof SANDBOX_FAILURES)[number];
export type GuestExceptionHint = "memory_exhausted" | "stack_exhausted";

export class SandboxError extends Error {
  constructor(readonly code: SandboxFailure, readonly exceptionHint?: GuestExceptionHint) { super(code); this.name = "SandboxError"; }
}

/** Monotonic wall-clock execution charges, including serialization and job draining. */
export class ExecutionBudget {
  private samples: { ended: number; cost: number }[] = [];

  check(now: number, runningMs = 0): SandboxFailure | undefined {
    this.samples = this.samples.filter((sample) => now - sample.ended < 60000);
    let second = runningMs;
    let minute = runningMs;
    for (const sample of this.samples) {
      minute += sample.cost;
      if (now - sample.ended < 1000) second += sample.cost;
    }
    if (second > SANDBOX_LIMITS.executionMsPerSecond) return "execution_budget_second";
    if (minute > SANDBOX_LIMITS.executionMsPerMinute) return "execution_budget_minute";
    return undefined;
  }

  charge(ended: number, cost: number): SandboxFailure | undefined {
    const failure = this.check(ended, cost);
    if (failure) return failure;
    if (cost > 0) {
      if (this.samples.length >= SANDBOX_LIMITS.executionSamples) return "execution_sample_limit";
      this.samples.push({ ended, cost });
    }
    return undefined;
  }
}
