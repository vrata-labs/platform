import type { ProbeDevice, UiObservation } from "./probe-report.js";
import type { SandboxFailure } from "./limits.js";
import type { InstanceState } from "./supervisor.js";

/** Fixed diagnostic workload; these bounds never replace sandbox budgets. */
export const RESOURCE_PROBE_LIMITS = Object.freeze({
  cycles: 100,
  deadlineMs: 300_000,
  sustainedMs: 60_000,
  secondDeadlineMs: 5_000,
  minuteDeadlineMs: 70_000,
  eventIntervalMs: 250,
  maxPings: 1_200,
  maxBudgetTurns: 280,
  memorySampleDeadlineMs: 2_000
});

export type ResourcePhase = "wasm" | "companion" | "cycles" | "sustained" | "budget-second" | "budget-minute" | "cleanup" | "complete";
export type ResourceAbort = "cancelled" | "deadline" | "page-hidden" | "pagehide" | "clock-invalid";
export interface ResourceTurn {
  /** Parent round-trip; init includes Worker loading and trusted prepare. */
  wallMs: number;
  executionMs: number;
  jobs: number;
  /** Last successful turn's linear buffer, never total browser memory. */
  wasmLinearBytes: number;
}
export interface ResourceCycle {
  index: number;
  phase: "init" | "event" | "dispose" | "complete";
  init: ResourceTurn | null;
  event: ResourceTurn | null;
  dispose: ResourceTurn | null;
  failure: SandboxFailure | null;
  state: InstanceState;
  activeDuring: number;
  activeAfter: number;
  /** Sampled while the cycle instance and companion are both alive. */
  overlappingLinear: { primaryBytes: number; companionBytes: number } | null;
}
export interface ResourceEventSample { endedOffsetMs: number; turn: ResourceTurn }
export interface ResourceWorkload {
  phase: "init" | "event" | "dispose" | "complete";
  failure: SandboxFailure | null;
  state: InstanceState;
  elapsedMs: number;
  init: ResourceTurn | null;
  turns: ResourceEventSample[];
  dispose: ResourceTurn | null;
  activeAfter: number;
}
export interface ResourcePing {
  phase: ResourcePhase;
  sentOffsetMs: number;
  latencyMs: number | null;
  failure: SandboxFailure | null;
}
export interface ResourceBrowserMemory {
  method: "measureUserAgentSpecificMemory";
  crossOriginIsolated: boolean;
  samples: {
    phase: "baseline" | "two-instances" | "after-cleanup";
    status: "MEASURED" | "UNAVAILABLE" | "ERROR" | "TIMEOUT";
    bytes: number | null;
  }[];
}
export interface ResourceObservation {
  runId: string;
  device: ProbeDevice;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  wasmLoadWallMs: number | null;
  abort: ResourceAbort | null;
  failure: SandboxFailure | null;
  companionFailure: SandboxFailure | null;
  companionInit: ResourceTurn | null;
  companionDispose: ResourceTurn | null;
  companionPings: ResourcePing[];
  cycles: ResourceCycle[];
  sustained: ResourceWorkload | null;
  secondBudget: ResourceWorkload | null;
  minuteBudget: ResourceWorkload | null;
  instancesCreated: number;
  instancesClosed: number;
  activeAfterCleanup: number;
  browserMemory: ResourceBrowserMemory;
  ui: UiObservation | null;
}
