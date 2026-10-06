import { SANDBOX_FAILURES, SANDBOX_LIMITS, type SandboxFailure } from "./limits.js";
import type { ProbeDevice, UiObservation } from "./probe-report.js";
import { RESOURCE_PROBE_LIMITS, type ResourceObservation, type ResourceAbort, type ResourcePhase } from "./resource-probe-contract.js";

export type ResourceVerdict = "PASS" | "FAIL" | "INCOMPLETE";
export type ResourceCheckKey = "provenance" | "lifecycle" | "sustained" | "secondBudget" | "minuteBudget" | "companion" | "ui" | "cleanup";
const REASONS = [
  "invalid-record", "invalid-measurement", "missing-measurement", "record-overflow",
  "invalid-clock", "run-not-completed", "run-aborted", "deadline-exceeded", "unexpected-failure",
  "cycle-sequence-invalid", "cycles-incomplete", "lifecycle-incomplete", "state-contradiction",
  "instance-count-contradiction", "linear-buffer-out-of-bounds", "handler-budget-exceeded", "jobs-out-of-bounds", "linear-buffer-contradiction",
  "workload-missing", "events-incomplete", "events-not-periodic", "sustained-too-short",
  "wrong-budget-failure", "wrong-budget-phase", "budget-not-observed",
  "budget-window-contradiction", "companion-coverage-incomplete", "ping-spacing-invalid", "ping-ack-missing",
  "ping-deadline-exceeded", "ping-phase-invalid", "ui-hidden", "ui-frames-incomplete",
  "ui-click-incomplete", "ui-count-contradiction", "cleanup-incomplete", "instances-not-closed", "browser-memory-invalid"
] as const;
export type ResourceReason = (typeof REASONS)[number];
export interface ResourceReportCheck { verdict: ResourceVerdict; reasons: ResourceReason[] }
export interface ResourceStats { count: number; min: number | null; median: number | null; p95: number | null; max: number | null }
export interface ResourceTimingStats { wallMs: ResourceStats; executionMs: ResourceStats }
export interface ResourceReportedTurn { wallMs: number | null; executionMs: number | null; jobs: number | null; wasmLinearBytes: number | null }
type Failure = SandboxFailure | "unknown_failure" | null;
type LifecyclePhase = "init" | "event" | "dispose" | "complete" | "unknown_phase";
type State = "booting" | "ready" | "disposing" | "disposed" | "failed" | "unknown_state";
export interface ResourceReportedCycle {
  index: number | null; phase: LifecyclePhase; state: State; failure: Failure;
  init: ResourceReportedTurn | null; event: ResourceReportedTurn | null; dispose: ResourceReportedTurn | null;
  activeDuring: number | null; activeAfter: number | null;
  overlappingLinear: { primaryBytes: number | null; companionBytes: number | null; combinedLinearBytes: number | null } | null;
}
export interface ResourceReportedWorkload {
  phase: LifecyclePhase; state: State; failure: Failure; elapsedMs: number | null;
  init: ResourceReportedTurn | null; turns: { endedOffsetMs: number | null; turn: ResourceReportedTurn | null }[];
  dispose: ResourceReportedTurn | null; activeAfter: number | null; eventTimings: ResourceTimingStats;
}
export interface ResourceReportedPing { phase: ResourcePhase | "unknown_phase"; sentOffsetMs: number | null; latencyMs: number | null; failure: Failure }
export interface ResourceMemoryReport {
  method: "measureUserAgentSpecificMemory"; crossOriginIsolated: boolean;
  measurement: "MEASURED" | "PARTIAL" | "NOT_MEASURED";
  samples: { phase: "baseline" | "two-instances" | "after-cleanup";
    status: "MEASURED" | "UNAVAILABLE" | "ERROR" | "TIMEOUT";
    measurement: "MEASURED" | "NOT_MEASURED"; bytes: number | null }[];
}
export type ResourceReportedDevice = Omit<ProbeDevice, "category"> & { category: ProbeDevice["category"] | "android" };
export interface ResourceProbeReport {
  schemaVersion: 1; scope: "resource-benchmark"; verdict: ResourceVerdict; complete: boolean; deviceGate: "NOT_EVALUATED";
  runId: string; device: ResourceReportedDevice; startedAt: string; completedAt: string | null;
  elapsedMs: number | null; wasmLoadWallMs: number | null; abort: ResourceAbort | "unknown_abort" | null; failure: Failure; companionFailure: Failure;
  checks: Record<ResourceCheckKey, ResourceReportCheck>;
  cycleSummary: {
    requested: number; observed: number; exported: number; completed: number;
    init: ResourceTimingStats; event: ResourceTimingStats; dispose: ResourceTimingStats;
    overlappingLinearBytes: { primaryBytes: ResourceStats; companionBytes: ResourceStats; combinedLinearBytes: ResourceStats };
  };
  observations: {
    companionInit: ResourceReportedTurn | null; companionDispose: ResourceReportedTurn | null; companionPings: ResourceReportedPing[];
    cycles: ResourceReportedCycle[]; sustained: ResourceReportedWorkload | null;
    secondBudget: ResourceReportedWorkload | null; minuteBudget: ResourceReportedWorkload | null;
    instancesCreated: number | null; instancesClosed: number | null; activeAfterCleanup: number | null;
    cleanupEvidence: "INSTANCE_COUNTERS_ONLY"; ui: UiObservation | null;
  };
  browserMemory: ResourceMemoryReport;
  limits: typeof SANDBOX_LIMITS;
  resourceLimits: typeof RESOURCE_PROBE_LIMITS;
  limitations: readonly string[];
}

const CHECKS: readonly ResourceCheckKey[] = ["provenance", "lifecycle", "sustained", "secondBudget", "minuteBudget", "companion", "ui", "cleanup"];
const PHASES: readonly ResourcePhase[] = ["wasm", "companion", "cycles", "sustained", "budget-second", "budget-minute", "cleanup", "complete"];
const WORKLOAD_PHASES = ["cycles", "sustained", "budget-second", "budget-minute"] as const;
const MEMORY_PHASES = ["baseline", "two-instances", "after-cleanup"] as const;
const LIFECYCLE_PHASES = ["init", "event", "dispose", "complete"] as const;
const STATES = ["booting", "ready", "disposing", "disposed", "failed"] as const;
const ABORTS: readonly ResourceAbort[] = ["cancelled", "deadline", "page-hidden", "pagehide", "clock-invalid"];
// A scheduled ping/event may await the existing native response deadline before
// scheduling the next interval. This is coverage, not a new UI/FPS threshold.
const PERIOD_COVERAGE_MS = RESOURCE_PROBE_LIMITS.eventIntervalMs + SANDBOX_LIMITS.workerResponseDeadlineMs;
const MAX_INSTANCES = RESOURCE_PROBE_LIMITS.cycles + 4;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const integer = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const text = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
function date(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value ? value : null;
}
function failure(value: unknown): Failure {
  return value === null ? null : typeof value === "string" && (SANDBOX_FAILURES as readonly string[]).includes(value) ? value as SandboxFailure : "unknown_failure";
}
function stats(values: readonly (number | null | undefined)[]): ResourceStats {
  const sorted = values.filter((value): value is number => finite(value) !== null).sort((a, b) => a - b);
  const count = sorted.length, middle = Math.floor(count / 2);
  return { count, min: sorted[0] ?? null, median: count ? count % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2 : null,
    p95: count ? sorted[Math.ceil(count * 0.95) - 1] : null, max: sorted[count - 1] ?? null };
}
function timings(turns: readonly (ResourceReportedTurn | null)[]): ResourceTimingStats {
  return { wallMs: stats(turns.map((turn) => turn?.wallMs)), executionMs: stats(turns.map((turn) => turn?.executionMs)) };
}

/** One evidence ledger is used by projection and semantic checks. In particular,
 * truncation or replacement of invalid numbers cannot erase a failed check. */
class Evidence {
  readonly checks = Object.fromEntries(CHECKS.map((key): [ResourceCheckKey, ResourceReportCheck] => [key, { verdict: "PASS", reasons: [] }])) as ResourceProbeReport["checks"];
  readonly incomplete = new Set<ResourceCheckKey>();
  issues = 0;
  constructor(readonly aborted: boolean, readonly companionStopped: boolean) {}
  get primaryStopped(): boolean { return this.aborted || this.companionStopped; }
  add(key: ResourceCheckKey, verdict: "FAIL" | "INCOMPLETE", reason: ResourceReason): void {
    this.issues++;
    if (verdict === "INCOMPLETE") this.incomplete.add(key);
    const check = this.checks[key];
    if (verdict === "FAIL" || check.verdict === "PASS") check.verdict = verdict;
    if (!check.reasons.includes(reason)) check.reasons.push(reason);
  }
  number(value: unknown, key: ResourceCheckKey, whole = false, max = Number.MAX_SAFE_INTEGER): number | null {
    const result = whole ? integer(value) : finite(value);
    if (result === null) {
      this.incomplete.add(key);
      this.add(key, value === null || value === undefined ? "INCOMPLETE" : "FAIL", value === null || value === undefined ? "missing-measurement" : "invalid-measurement");
    } else if (result > max) { this.incomplete.add(key); this.add(key, "FAIL", "invalid-measurement"); return null; }
    return result;
  }
  array(value: unknown, max: number, key: ResourceCheckKey): unknown[] {
    if (!Array.isArray(value)) { this.add(key, "FAIL", "invalid-record"); return []; }
    if (value.length > max) this.add(key, "FAIL", "record-overflow");
    return Array.from({ length: Math.min(value.length, max) }, (_, index) => value[index]);
  }
  object(value: unknown, key: ResourceCheckKey): Record<string, unknown> {
    const result = record(value);
    if (value === null || typeof value !== "object" || Array.isArray(value)) this.add(key, "FAIL", "invalid-record");
    return result;
  }
  unexpected(value: Failure, key: ResourceCheckKey): void {
    if (value !== null) this.add(key, this.aborted && value === "instance_closed" ? "INCOMPLETE" : "FAIL", "unexpected-failure");
  }
  turn(value: unknown, key: ResourceCheckKey): ResourceReportedTurn | null {
    if (value === null || value === undefined) { this.add(key, "INCOMPLETE", "missing-measurement"); return null; }
    const raw = this.object(value, key);
    const wallMs = this.number(raw.wallMs, key), executionMs = this.number(raw.executionMs, key), jobs = this.number(raw.jobs, key, true);
    const wasmLinearBytes = this.linear(raw.wasmLinearBytes, key);
    if (executionMs !== null && executionMs > SANDBOX_LIMITS.handlerBudgetMs) this.add(key, "FAIL", "handler-budget-exceeded");
    if (wallMs !== null && executionMs !== null && executionMs > wallMs) this.add(key, "FAIL", "invalid-clock");
    if (jobs !== null && jobs > SANDBOX_LIMITS.jobsPerTurn) this.add(key, "FAIL", "jobs-out-of-bounds");
    return { wallMs, executionMs, jobs, wasmLinearBytes };
  }
  linear(value: unknown, key: ResourceCheckKey): number | null {
    const bytes = this.number(value, key, true);
    if (bytes !== null && (bytes < SANDBOX_LIMITS.wasmInitialMemoryBytes || bytes > SANDBOX_LIMITS.wasmMaxMemoryBytes)) {
      this.incomplete.add(key);
      this.add(key, "FAIL", "linear-buffer-out-of-bounds"); return null;
    }
    return bytes;
  }
  lifecycle(raw: Record<string, unknown>, key: ResourceCheckKey): { phase: LifecyclePhase; state: State; failure: Failure } {
    const phase = (LIFECYCLE_PHASES as readonly unknown[]).includes(raw.phase) ? raw.phase as LifecyclePhase : "unknown_phase";
    const state = (STATES as readonly unknown[]).includes(raw.state) ? raw.state as State : "unknown_state";
    const code = failure(raw.failure);
    if (phase === "unknown_phase" || state === "unknown_state" || code === "unknown_failure") this.add(key, "FAIL", "invalid-record");
    if (code !== null && state !== "failed") this.add(key, "FAIL", "state-contradiction");
    return { phase, state, failure: code };
  }
  healthy(phase: LifecyclePhase, state: State, code: Failure, key: ResourceCheckKey): void {
    this.unexpected(code, key);
    // A companion stop terminates the primary too. Its null failure records an
    // interrupted lifecycle, not an independently observed healthy failure.
    if (state === "failed" && code === null && !this.primaryStopped) this.add(key, "FAIL", "unexpected-failure");
    if (phase !== "complete" || state !== "disposed") this.add(key, "INCOMPLETE", "lifecycle-incomplete");
    if (phase === "complete" && state !== "disposed") this.add(key, "FAIL", "state-contradiction");
  }
}

function projectCycles(value: unknown, evidence: Evidence): { cycles: ResourceReportedCycle[]; completed: number } {
  let completed = 0;
  const cycles = evidence.array(value, RESOURCE_PROBE_LIMITS.cycles, "lifecycle").map((item, position) => {
    const issuesBefore = evidence.issues;
    const raw = evidence.object(item, "lifecycle"), lifecycle = evidence.lifecycle(raw, "lifecycle");
    const index = evidence.number(raw.index, "lifecycle", true);
    if (index !== position + 1) evidence.add("lifecycle", "FAIL", "cycle-sequence-invalid");
    evidence.healthy(lifecycle.phase, lifecycle.state, lifecycle.failure, "lifecycle");
    const init = evidence.turn(raw.init, "lifecycle"), event = evidence.turn(raw.event, "lifecycle"), dispose = evidence.turn(raw.dispose, "lifecycle");
    const activeDuring = evidence.number(raw.activeDuring, "lifecycle", true, 2), activeAfter = evidence.number(raw.activeAfter, "lifecycle", true, 2);
    if (activeDuring !== 2 || activeAfter !== 1) evidence.add("lifecycle", lifecycle.phase === "complete" && !evidence.primaryStopped ? "FAIL" : "INCOMPLETE", "instance-count-contradiction");
    let overlappingLinear: ResourceReportedCycle["overlappingLinear"] = null;
    if (raw.overlappingLinear === null || raw.overlappingLinear === undefined) evidence.add("lifecycle", "INCOMPLETE", "missing-measurement");
    else {
      const overlapping = evidence.object(raw.overlappingLinear, "lifecycle");
      const primaryBytes = evidence.linear(overlapping.primaryBytes, "lifecycle"), companionBytes = evidence.linear(overlapping.companionBytes, "lifecycle");
      overlappingLinear = { primaryBytes, companionBytes, combinedLinearBytes: primaryBytes !== null && companionBytes !== null ? primaryBytes + companionBytes : null };
      if (primaryBytes !== null && init?.wasmLinearBytes !== null && event?.wasmLinearBytes !== null && init && event &&
          primaryBytes !== init.wasmLinearBytes && primaryBytes !== event.wasmLinearBytes) evidence.add("lifecycle", "FAIL", "linear-buffer-contradiction");
    }
    checkLinearHistory([init, event, dispose], "lifecycle", evidence);
    if (evidence.issues === issuesBefore) completed++;
    return { index, ...lifecycle, init, event, dispose, activeDuring, activeAfter, overlappingLinear };
  });
  return { cycles, completed };
}
function checkLinearHistory(turns: readonly (ResourceReportedTurn | null)[], key: ResourceCheckKey, evidence: Evidence): void {
  let previous = 0;
  for (const turn of turns) {
    if (turn?.wasmLinearBytes === null || !turn) continue;
    if (turn.wasmLinearBytes < previous) evidence.add(key, "FAIL", "linear-buffer-contradiction");
    previous = turn.wasmLinearBytes;
  }
}

/** VM init is not charged to ExecutionBudget. Parent ACK offsets are not Worker
 * charge timestamps, so they cannot reconstruct rolling execution windows.
 * Only an impossible upper bound is checked: even ALL successful event costs
 * plus a full allowed handler could not reach the reported budget. This neither
 * locates nor measures the rejected turn, and never certifies the actual window. */
function checkPossibleBudgetTotal(workload: ResourceReportedWorkload, key: "secondBudget" | "minuteBudget", evidence: Evidence): void {
  const expected = key === "secondBudget" ? "execution_budget_second" : "execution_budget_minute";
  if (workload.failure !== expected || workload.phase !== "event" || workload.state !== "failed") return;
  const costs = workload.turns.map((sample) => sample.turn?.executionMs);
  if (!costs.length || costs.some((cost) => cost === null || cost === undefined || cost > SANDBOX_LIMITS.handlerBudgetMs)) return;
  const limit = key === "secondBudget" ? SANDBOX_LIMITS.executionMsPerSecond : SANDBOX_LIMITS.executionMsPerMinute;
  const upperBound = costs.reduce<number>((sum, cost) => sum + cost!, SANDBOX_LIMITS.handlerBudgetMs);
  // Allow summation/rounding differences at the boundary; this is not a timing
  // tolerance and must not reject merely because the rounded bound equals it.
  const roundingMargin = Number.EPSILON * (costs.length + 1) * Math.max(upperBound, limit);
  if (upperBound + roundingMargin < limit) evidence.add(key, "FAIL", "budget-window-contradiction");
}
function projectWorkload(value: unknown, key: "sustained" | "secondBudget" | "minuteBudget", evidence: Evidence): ResourceReportedWorkload | null {
  if (value === null || value === undefined) { evidence.add(key, "INCOMPLETE", "workload-missing"); return null; }
  const raw = evidence.object(value, key), lifecycle = evidence.lifecycle(raw, key);
  const elapsedMs = evidence.number(raw.elapsedMs, key), init = evidence.turn(raw.init, key);
  const activeAfter = evidence.number(raw.activeAfter, key, true, 2);
  const turns = evidence.array(raw.turns, RESOURCE_PROBE_LIMITS.maxBudgetTurns, key).map((item) => {
    const sample = evidence.object(item, key);
    return { endedOffsetMs: evidence.number(sample.endedOffsetMs, key), turn: evidence.turn(sample.turn, key) };
  });
  // Failed budget instances are already closed and cannot have a successful dispose.
  const dispose = raw.dispose === null ? null : evidence.turn(raw.dispose, key);
  const workload: ResourceReportedWorkload = { ...lifecycle, elapsedMs, init, turns, dispose, activeAfter, eventTimings: timings(turns.map((sample) => sample.turn)) };
  let previous = init?.wallMs ?? 0;
  for (const sample of turns) {
    if (sample.endedOffsetMs === null) continue;
    if (sample.endedOffsetMs <= previous || (elapsedMs !== null && sample.endedOffsetMs > elapsedMs) ||
        (sample.turn?.wallMs !== null && sample.turn && sample.endedOffsetMs - previous < sample.turn.wallMs)) evidence.add(key, "FAIL", "invalid-clock");
    if (key === "sustained" && sample.endedOffsetMs - previous > PERIOD_COVERAGE_MS) evidence.add(key, "INCOMPLETE", "events-not-periodic");
    previous = sample.endedOffsetMs;
  }
  if (elapsedMs !== null && init?.wallMs !== null && init && init.wallMs > elapsedMs) evidence.add(key, "FAIL", "invalid-clock");
  if (elapsedMs !== null && dispose?.wallMs !== null && dispose && elapsedMs - previous < dispose.wallMs) evidence.add(key, "FAIL", "invalid-clock");
  checkLinearHistory([init, ...turns.map((sample) => sample.turn), dispose], key, evidence);
  if (activeAfter !== 1) evidence.add(key, !evidence.primaryStopped && (lifecycle.state === "disposed" || lifecycle.state === "failed") ? "FAIL" : "INCOMPLETE", "instance-count-contradiction");
  if (key === "sustained") {
    evidence.healthy(lifecycle.phase, lifecycle.state, lifecycle.failure, key);
    if (!dispose) evidence.add(key, "INCOMPLETE", "missing-measurement");
    if (elapsedMs !== null && elapsedMs - (init?.wallMs ?? 0) - (dispose?.wallMs ?? 0) < RESOURCE_PROBE_LIMITS.sustainedMs) evidence.add(key, "INCOMPLETE", "sustained-too-short");
    if (turns.length < 2 || !turns.some((sample) => (sample.turn?.executionMs ?? 0) > 0) || previous < (init?.wallMs ?? 0) + RESOURCE_PROBE_LIMITS.sustainedMs - PERIOD_COVERAGE_MS) evidence.add(key, "INCOMPLETE", "events-incomplete");
    if (elapsedMs !== null && elapsedMs - previous - (dispose?.wallMs ?? 0) > PERIOD_COVERAGE_MS) evidence.add(key, "INCOMPLETE", "events-not-periodic");
  } else {
    const expected = key === "secondBudget" ? "execution_budget_second" : "execution_budget_minute";
    if (lifecycle.failure === null || (evidence.aborted && lifecycle.failure === "instance_closed")) evidence.add(key, "INCOMPLETE", "budget-not-observed");
    else {
      if (lifecycle.failure !== expected) evidence.add(key, "FAIL", "wrong-budget-failure");
      if (lifecycle.phase !== "event") evidence.add(key, "FAIL", "wrong-budget-phase");
      if (lifecycle.state !== "failed" || dispose !== null) evidence.add(key, "FAIL", "state-contradiction");
    }
    const deadline = key === "secondBudget" ? RESOURCE_PROBE_LIMITS.secondDeadlineMs : RESOURCE_PROBE_LIMITS.minuteDeadlineMs;
    if (elapsedMs !== null && elapsedMs - (init?.wallMs ?? 0) > deadline) evidence.add(key, "INCOMPLETE", "deadline-exceeded");
    if (!turns.length || !turns.some((sample) => (sample.turn?.executionMs ?? 0) > 0)) evidence.add(key, "INCOMPLETE", "events-incomplete");
  }
  if (key !== "sustained") checkPossibleBudgetTotal(workload, key, evidence);
  return workload;
}

function projectPings(value: unknown, elapsedMs: number | null, durations: readonly number[], evidence: Evidence): ResourceReportedPing[] {
  const pings = evidence.array(value, RESOURCE_PROBE_LIMITS.maxPings, "companion").map((item): ResourceReportedPing => {
    const raw = evidence.object(item, "companion");
    const phase = (PHASES as readonly unknown[]).includes(raw.phase) ? raw.phase as ResourcePhase : "unknown_phase";
    if (phase === "unknown_phase") evidence.add("companion", "FAIL", "ping-phase-invalid");
    const code = failure(raw.failure); evidence.unexpected(code, "companion");
    const sentOffsetMs = evidence.number(raw.sentOffsetMs, "companion"), latencyMs = evidence.number(raw.latencyMs, "companion");
    if (latencyMs === null) evidence.add("companion", "INCOMPLETE", "ping-ack-missing");
    if (latencyMs !== null && latencyMs > SANDBOX_LIMITS.workerResponseDeadlineMs) evidence.add("companion", "FAIL", "ping-deadline-exceeded");
    if (sentOffsetMs !== null && elapsedMs !== null && (sentOffsetMs > elapsedMs || (latencyMs !== null && sentOffsetMs + latencyMs > elapsedMs))) evidence.add("companion", "FAIL", "invalid-clock");
    return { phase, sentOffsetMs, latencyMs, failure: code };
  });
  let previous: ResourceReportedPing | undefined;
  for (const ping of pings) {
    if (previous) {
      if (ping.sentOffsetMs !== null && previous.sentOffsetMs !== null && ping.sentOffsetMs - previous.sentOffsetMs < RESOURCE_PROBE_LIMITS.eventIntervalMs) evidence.add("companion", "FAIL", "ping-spacing-invalid");
      if (PHASES.indexOf(ping.phase as ResourcePhase) < PHASES.indexOf(previous.phase as ResourcePhase)) evidence.add("companion", "FAIL", "ping-phase-invalid");
    }
    previous = ping;
  }
  WORKLOAD_PHASES.forEach((phase, index) => {
    const samples = pings.filter((ping) => ping.phase === phase && ping.sentOffsetMs !== null);
    if (!samples.length) { evidence.add("companion", "INCOMPLETE", "companion-coverage-incomplete"); return; }
    for (let i = 1; i < samples.length; i++) if (samples[i].sentOffsetMs! - samples[i - 1].sentOffsetMs! > PERIOD_COVERAGE_MS) evidence.add("companion", "INCOMPLETE", "companion-coverage-incomplete");
    // Phase tags are trusted runner observations. The contract has no individual
    // cycle start clock; do not invent per-cycle concurrent ACK timestamps.
    if (samples[samples.length - 1].sentOffsetMs! - samples[0].sentOffsetMs! + 2 * PERIOD_COVERAGE_MS < durations[index]) evidence.add("companion", "INCOMPLETE", "companion-coverage-incomplete");
  });
  return pings;
}

function projectUi(value: unknown, evidence: Evidence): UiObservation | null {
  if (value === null || value === undefined) { evidence.add("ui", "INCOMPLETE", "ui-click-incomplete"); return null; }
  const raw = evidence.object(value, "ui");
  const count = (key: string): number => evidence.number(raw[key], "ui", true) ?? 0;
  const visible = (key: string): boolean => { if (typeof raw[key] !== "boolean") evidence.add("ui", "FAIL", "invalid-record"); return raw[key] === true; };
  const clickPhase = raw.clickPhase === "during-suite" || raw.clickPhase === "after-suite" ? raw.clickPhase : null;
  if (raw.clickPhase !== null && clickPhase === null) evidence.add("ui", "FAIL", "invalid-record");
  const ui: UiObservation = {
    framesDuringSuite: count("framesDuringSuite"), frameSamples: count("frameSamples"), maxFrameGapMs: evidence.number(raw.maxFrameGapMs, "ui"), invalidFrameSamples: count("invalidFrameSamples"),
    startedVisible: visible("startedVisible"), endedVisible: visible("endedVisible"), hiddenTransitions: count("hiddenTransitions"),
    trustedClicks: count("trustedClicks"), duringClicks: count("duringClicks"), afterClicks: count("afterClicks"), visibleDuringClicks: count("visibleDuringClicks"),
    maxInputDelayMs: evidence.number(raw.maxInputDelayMs, "ui"), invalidInputTimestamps: count("invalidInputTimestamps"), clickPhase
  };
  if (!ui.startedVisible || !ui.endedVisible || ui.hiddenTransitions > 0) evidence.add("ui", "INCOMPLETE", "ui-hidden");
  if (ui.frameSamples !== ui.framesDuringSuite || ui.visibleDuringClicks > ui.duringClicks || ui.duringClicks + ui.afterClicks > ui.trustedClicks) evidence.add("ui", "FAIL", "ui-count-contradiction");
  if (clickPhase === "during-suite" && ui.duringClicks === 0 || clickPhase === "after-suite" && ui.afterClicks === 0 || clickPhase === null && ui.duringClicks + ui.afterClicks > 0) evidence.add("ui", "FAIL", "ui-count-contradiction");
  if (ui.invalidFrameSamples > 0 || ui.invalidInputTimestamps > 0) evidence.add("ui", "FAIL", "invalid-clock");
  if (ui.framesDuringSuite < 2 || ui.maxFrameGapMs === null) evidence.add("ui", "INCOMPLETE", "ui-frames-incomplete");
  if (ui.duringClicks < 1 || ui.visibleDuringClicks < 1 || ui.maxInputDelayMs === null) evidence.add("ui", "INCOMPLETE", "ui-click-incomplete");
  return ui;
}
function projectMemory(value: unknown, evidence: Evidence): ResourceMemoryReport {
  const raw = record(value);
  const samples = new Map<string, ResourceMemoryReport["samples"][number]>();
  if (value !== null && value !== undefined) {
    if (raw.method !== "measureUserAgentSpecificMemory" || typeof raw.crossOriginIsolated !== "boolean") evidence.add("provenance", "FAIL", "browser-memory-invalid");
    for (const item of evidence.array(raw.samples, MEMORY_PHASES.length, "provenance")) {
      const sample = record(item);
      if (!(MEMORY_PHASES as readonly unknown[]).includes(sample.phase)) { evidence.add("provenance", "FAIL", "browser-memory-invalid"); continue; }
      const phase = sample.phase as ResourceMemoryReport["samples"][number]["phase"];
      if (samples.has(phase)) evidence.add("provenance", "FAIL", "browser-memory-invalid");
      const status = ["MEASURED", "UNAVAILABLE", "ERROR", "TIMEOUT"].includes(sample.status as string) ? sample.status as ResourceMemoryReport["samples"][number]["status"] : "ERROR";
      if (status !== sample.status) evidence.add("provenance", "FAIL", "browser-memory-invalid");
      if (status === "MEASURED" && sample.bytes !== null && integer(sample.bytes) === null) evidence.add("provenance", "FAIL", "browser-memory-invalid");
      const bytes = status === "MEASURED" && integer(sample.bytes) !== null && (sample.bytes as number) > 0 ? sample.bytes as number : null;
      samples.set(phase, { phase, status, measurement: bytes === null ? "NOT_MEASURED" : "MEASURED", bytes });
    }
  }
  const projected = MEMORY_PHASES.map((phase) => samples.get(phase) ?? { phase, status: "UNAVAILABLE" as const, measurement: "NOT_MEASURED" as const, bytes: null });
  const measured = projected.filter((sample) => sample.measurement === "MEASURED").length;
  return { method: "measureUserAgentSpecificMemory", crossOriginIsolated: raw.crossOriginIsolated === true,
    measurement: measured === projected.length ? "MEASURED" : measured ? "PARTIAL" : "NOT_MEASURED", samples: projected };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Standalone fixed-source diagnostics only. Every exported property is selected
 * here; guest status/source, arbitrary errors, URLs and host context are absent. */
export function buildResourceProbeReport(input: ResourceObservation): ResourceProbeReport {
  return projectReport(input);
}
function projectReport(input: unknown): ResourceProbeReport {
  const raw = record(input);
  const abort = raw.abort === null ? null : (ABORTS as readonly unknown[]).includes(raw.abort) ? raw.abort as ResourceAbort : "unknown_abort";
  const companionFailure = failure(raw.companionFailure);
  const evidence = new Evidence(abort !== null && abort !== "unknown_abort", companionFailure !== null);
  if (companionFailure !== null) evidence.add("companion", "FAIL", "unexpected-failure");
  if (abort !== null) evidence.add("provenance", abort === "unknown_abort" || abort === "clock-invalid" ? "FAIL" : "INCOMPLETE", abort === "clock-invalid" ? "invalid-clock" : "run-aborted");
  const code = failure(raw.failure); evidence.unexpected(code, "provenance");
  const startedAt = date(raw.startedAt), completedAt = date(raw.completedAt);
  if (!startedAt || (raw.completedAt !== null && !completedAt) || (completedAt && startedAt && completedAt < startedAt)) evidence.add("provenance", "FAIL", "invalid-clock");
  if (!completedAt) evidence.add("provenance", "INCOMPLETE", "run-not-completed");
  const elapsedMs = evidence.number(raw.elapsedMs, "provenance"), wasmLoadWallMs = evidence.number(raw.wasmLoadWallMs, "provenance");
  if (elapsedMs !== null && elapsedMs > RESOURCE_PROBE_LIMITS.deadlineMs) evidence.add("provenance", "INCOMPLETE", "deadline-exceeded");
  if (elapsedMs !== null && wasmLoadWallMs !== null && wasmLoadWallMs > elapsedMs) evidence.add("provenance", "FAIL", "invalid-clock");
  const { cycles, completed: completedCycles } = projectCycles(raw.cycles, evidence);
  if (cycles.length !== RESOURCE_PROBE_LIMITS.cycles) evidence.add("lifecycle", "INCOMPLETE", "cycles-incomplete");
  const sustained = projectWorkload(raw.sustained, "sustained", evidence), secondBudget = projectWorkload(raw.secondBudget, "secondBudget", evidence), minuteBudget = projectWorkload(raw.minuteBudget, "minuteBudget", evidence);
  const companionInit = evidence.turn(raw.companionInit, "companion"), companionDispose = evidence.turn(raw.companionDispose, "companion");
  checkLinearHistory([companionInit, companionDispose], "companion", evidence);
  const cycleWallMs = cycles.reduce((sum, cycle) => sum + (cycle.init?.wallMs ?? 0) + (cycle.event?.wallMs ?? 0) + (cycle.dispose?.wallMs ?? 0), 0);
  const durations = [cycleWallMs, sustained?.elapsedMs ?? 0, secondBudget?.elapsedMs ?? 0, minuteBudget?.elapsedMs ?? 0];
  if (elapsedMs !== null && (durations.some((duration) => duration > elapsedMs) || durations.reduce((sum, duration) => sum + duration, 0) + (wasmLoadWallMs ?? 0) + (companionInit?.wallMs ?? 0) + (companionDispose?.wallMs ?? 0) > elapsedMs)) evidence.add("provenance", "FAIL", "invalid-clock");
  const companionPings = projectPings(raw.companionPings, elapsedMs, durations, evidence), ui = projectUi(raw.ui, evidence);
  const instancesCreated = evidence.number(raw.instancesCreated, "cleanup", true, MAX_INSTANCES), instancesClosed = evidence.number(raw.instancesClosed, "cleanup", true, MAX_INSTANCES), activeAfterCleanup = evidence.number(raw.activeAfterCleanup, "cleanup", true, 2);
  if (activeAfterCleanup !== null && activeAfterCleanup !== 0 || instancesCreated !== null && instancesClosed !== null && instancesCreated !== instancesClosed) evidence.add("cleanup", "FAIL", "instances-not-closed");
  const observedInstances = cycles.length + Number(sustained !== null) + Number(secondBudget !== null) + Number(minuteBudget !== null) + Number(companionInit !== null);
  if (instancesCreated !== null && instancesCreated < observedInstances) evidence.add("cleanup", "FAIL", "instance-count-contradiction");
  if (instancesCreated !== MAX_INSTANCES) evidence.add("cleanup", "INCOMPLETE", "cleanup-incomplete");
  const browserMemory = projectMemory(raw.browserMemory, evidence);
  const complete = evidence.incomplete.size === 0 && abort === null && completedAt !== null;
  const verdict = CHECKS.some((key) => evidence.checks[key].verdict === "FAIL") ? "FAIL" : complete ? "PASS" : "INCOMPLETE";
  const device = record(raw.device), viewport = record(device.viewport);
  return freeze({
    schemaVersion: 1, scope: "resource-benchmark", verdict, complete, deviceGate: "NOT_EVALUATED",
    runId: typeof raw.runId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.runId) ? raw.runId : "",
    device: { category: ["unspecified", "quest", "windows", "android", "other"].includes(device.category as string) ? device.category as ResourceReportedDevice["category"] : "unspecified",
      userAgent: text(device.userAgent, 512), language: text(device.language, 48), viewport: { width: finite(viewport.width) ?? 0, height: finite(viewport.height) ?? 0, pixelRatio: finite(viewport.pixelRatio) ?? 0 } },
    startedAt: startedAt ?? "", completedAt, elapsedMs, wasmLoadWallMs, abort, failure: code, companionFailure, checks: evidence.checks,
    cycleSummary: { requested: RESOURCE_PROBE_LIMITS.cycles, observed: Array.isArray(raw.cycles) ? raw.cycles.length : 0, exported: cycles.length,
      completed: completedCycles,
      init: timings(cycles.map((cycle) => cycle.init)), event: timings(cycles.map((cycle) => cycle.event)), dispose: timings(cycles.map((cycle) => cycle.dispose)),
      overlappingLinearBytes: { primaryBytes: stats(cycles.map((cycle) => cycle.overlappingLinear?.primaryBytes)), companionBytes: stats(cycles.map((cycle) => cycle.overlappingLinear?.companionBytes)), combinedLinearBytes: stats(cycles.map((cycle) => cycle.overlappingLinear?.combinedLinearBytes)) } },
    observations: { cycles, sustained, secondBudget, minuteBudget, companionInit, companionDispose, companionPings, instancesCreated, instancesClosed, activeAfterCleanup, cleanupEvidence: "INSTANCE_COUNTERS_ONLY", ui },
    browserMemory, limits: { ...SANDBOX_LIMITS }, resourceLimits: { ...RESOURCE_PROBE_LIMITS },
    limitations: [
      "PASS относится только к фиксированному resource-benchmark. T03/device gate НЕ оценивался; категория устройства, User-Agent и клик не являются сертификацией.",
      "init.wallMs включает загрузку Worker и trusted prepare до ответа init; event/dispose.wallMs — parent round-trip. executionMs — измеренное исполнение VM успешного turn, не всё время prepare.",
      "overlappingLinear — одновременно наблюдавшиеся последние успешные PRIMARY и companion WASM buffer; combinedLinearBytes — их сумма, не вся память Worker/браузера и не heap VM.",
      "Browser memory записывается только из measureUserAgentSpecificMemory. NOT_MEASURED означает отсутствие измерения, а не нулевое потребление; линейные буферы не заменяют browser memory.",
      "Ожидаемые budget failures подтверждаются точным кодом host на EVENT и закрытием экземпляра. init не списывается в cumulative ExecutionBudget; parent ACK offsets не являются Worker timestamps и не восстанавливают rolling VM windows. Проверяется только заведомо невозможная сумма всех успешных событий с верхней границей handler. Стоимость и время отвергнутого turn контракт не передаёт; они не подставляются в статистику.",
      "Companion phase/offset — наблюдения доверенного runner. Контракт не содержит start/end каждого цикла и не позволяет восстановить индивидуальный concurrent ACK каждого цикла.",
      "Счётчики created/closed и active=0 подтверждают логическое закрытие экземпляров, но не физическое освобождение памяти, отсутствие утечки или завершение GC.",
      "Frame gap и input delay — измерения, без выдуманного FPS SLA. Скрытая страница и отсутствие настоящего видимого DURING-клика оставляют прогон INCOMPLETE.",
      "Этот отчёт не заменяет длительную проверку реального устройства, полную 37-сценарную диагностику и проверку функций комнаты."
    ]
  } satisfies ResourceProbeReport);
}

/** A real failure outranks missing UI evidence or cancellation instructions. */
export function resourceProbeSummary(report: Pick<ResourceProbeReport, "verdict" | "abort" | "checks">): string {
  if (report.verdict === "FAIL") return "Неожиданный результат: сохраните JSON с фазой и кодом остановки.";
  if (report.abort) return "Прогон прерван; повторите с видимой страницей и нажмите отклик во время проверки.";
  if (report.checks.ui.verdict === "INCOMPLETE") return "Нужен настоящий клик во время прогона, на видимой странице.";
  return "Это наблюдения данного браузера, не автоматическое принятие device gate.";
}

export function serializeResourceProbeReport(report: ResourceProbeReport): string {
  // Reuse the same whitelist even for a copied/parsed report. Preserve original
  // verdicts/reasons: bounded exported arrays cannot recover discarded overflow
  // evidence, so re-projecting must never upgrade FAIL/INCOMPLETE into PASS.
  const raw = record(report), observed = record(raw.observations);
  const projected = projectReport({ runId: raw.runId, device: raw.device,
    startedAt: raw.startedAt, completedAt: raw.completedAt, elapsedMs: raw.elapsedMs,
    wasmLoadWallMs: raw.wasmLoadWallMs, abort: raw.abort, failure: raw.failure, companionFailure: raw.companionFailure, browserMemory: raw.browserMemory,
    companionInit: observed.companionInit, companionDispose: observed.companionDispose, companionPings: observed.companionPings,
    cycles: observed.cycles, sustained: observed.sustained, secondBudget: observed.secondBudget, minuteBudget: observed.minuteBudget,
    instancesCreated: observed.instancesCreated, instancesClosed: observed.instancesClosed, activeAfterCleanup: observed.activeAfterCleanup, ui: observed.ui });
  const rank: Record<ResourceVerdict, number> = { PASS: 0, INCOMPLETE: 1, FAIL: 2 };
  const verdict = (value: unknown): ResourceVerdict => value === "PASS" || value === "INCOMPLETE" || value === "FAIL" ? value : "FAIL";
  const original = verdict(raw.verdict), summary = record(raw.cycleSummary), checks = record(raw.checks);
  const safeChecks = Object.fromEntries(CHECKS.map((key): [ResourceCheckKey, ResourceReportCheck] => {
    const check = record(checks[key]);
    const reasons = Array.isArray(check.reasons) ? check.reasons.slice(0, REASONS.length).filter((reason): reason is ResourceReason => (REASONS as readonly unknown[]).includes(reason)) : [];
    const originalVerdict = verdict(check.verdict);
    return [key, rank[originalVerdict] >= rank[projected.checks[key].verdict] ? { verdict: originalVerdict, reasons: [...new Set(reasons)] } : projected.checks[key]];
  })) as ResourceProbeReport["checks"];
  const complete = raw.complete === true && projected.complete;
  const finalVerdict = rank[original] >= rank[projected.verdict] ? original : projected.verdict;
  return JSON.stringify({ ...projected, verdict: finalVerdict === "PASS" && !complete ? "INCOMPLETE" : finalVerdict,
    complete, checks: safeChecks,
    cycleSummary: { ...projected.cycleSummary, observed: integer(summary.observed) ?? projected.cycleSummary.observed }
  }, null, 2);
}
