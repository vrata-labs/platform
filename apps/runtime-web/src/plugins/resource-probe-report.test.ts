import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionBudget, SANDBOX_LIMITS } from "./limits.js";
import { assessUi, type UiObservation } from "./probe-report.js";
import { RESOURCE_PROBE_LIMITS, type ResourceObservation, type ResourceTurn, type ResourceWorkload } from "./resource-probe-contract.js";
import { buildResourceProbeReport, serializeResourceProbeReport, resourceProbeSummary, type ResourceProbeReport } from "./resource-probe-report.js";

const MiB = 1024 * 1024;
test("FAIL summary requests JSON even when DURING evidence is missing or the failed run was cancelled", () => {
  for (const abort of [null, "cancelled", "page-hidden", "clock-invalid"] as const) {
    const report = reportWith((raw) => { raw.failure = "worker_error"; raw.abort = abort; raw.ui = null; });
    assert.equal(report.verdict, "FAIL");
    assert.equal(resourceProbeSummary(report), "Неожиданный результат: сохраните JSON с фазой и кодом остановки.");
  }
  assert.match(resourceProbeSummary(reportWith((raw) => { raw.abort = "cancelled"; })), /^Прогон прерван/);
  assert.match(resourceProbeSummary(reportWith((raw) => { raw.ui = null; })), /^Нужен настоящий клик/);
  assert.match(resourceProbeSummary(buildResourceProbeReport(input())), /^Это наблюдения данного браузера/);
});
function turn(wallMs = 5, executionMs = 1, wasmLinearBytes = 16 * MiB): ResourceTurn {
  return { wallMs, executionMs, jobs: 0, wasmLinearBytes };
}
function ui(): UiObservation {
  return { framesDuringSuite: 5000, frameSamples: 5000, maxFrameGapMs: 35, invalidFrameSamples: 0,
    startedVisible: true, endedVisible: true, hiddenTransitions: 0, trustedClicks: 1, duringClicks: 1,
    afterClicks: 0, visibleDuringClicks: 1, maxInputDelayMs: 10, invalidInputTimestamps: 0, clickPhase: "during-suite" };
}
function input(): ResourceObservation {
  const sustained: ResourceWorkload = { phase: "complete", failure: null, state: "disposed", elapsedMs: 60_010,
    init: turn(), turns: Array.from({ length: 240 }, (_, i) => ({ endedOffsetMs: (i + 1) * 250, turn: turn() })), dispose: turn(3), activeAfter: 1 };
  const secondBudget: ResourceWorkload = { phase: "event", failure: "execution_budget_second", state: "failed", elapsedMs: 800,
    init: turn(50, 40), turns: [300, 550].map((endedOffsetMs) => ({ endedOffsetMs, turn: turn(30, 30) })), dispose: null, activeAfter: 1 };
  const minuteBudget: ResourceWorkload = { phase: "event", failure: "execution_budget_minute", state: "failed", elapsedMs: 39_750,
    init: turn(10), turns: Array.from({ length: 79 }, (_, i) => ({ endedOffsetMs: (i + 1) * 500, turn: turn(25, 25) })), dispose: null, activeAfter: 1 };
  return {
    runId: "resource-100-test", device: { category: "quest", userAgent: "Quest Browser", language: "ru", viewport: { width: 900, height: 600, pixelRatio: 1 } },
    startedAt: "2026-10-06T10:00:00.000Z", completedAt: "2026-10-06T10:02:00.000Z", elapsedMs: 120_000,
    wasmLoadWallMs: 10, abort: null, failure: null, companionFailure: null, companionInit: turn(), companionDispose: turn(3),
    companionPings: [
      ...Array.from({ length: 5 }, (_, i) => ({ phase: "cycles" as const, sentOffsetMs: 250 + i * 250, latencyMs: 10, failure: null })),
      ...Array.from({ length: 241 }, (_, i) => ({ phase: "sustained" as const, sentOffsetMs: 2000 + i * 250, latencyMs: 10, failure: null })),
      ...Array.from({ length: 4 }, (_, i) => ({ phase: "budget-second" as const, sentOffsetMs: 63_000 + i * 250, latencyMs: 10, failure: null })),
      ...Array.from({ length: 159 }, (_, i) => ({ phase: "budget-minute" as const, sentOffsetMs: 65_000 + i * 250, latencyMs: 10, failure: null }))
    ],
    cycles: Array.from({ length: 100 }, (_, i) => ({ index: i + 1, phase: "complete", failure: null, state: "disposed",
      init: turn(), event: turn(4), dispose: turn(3), activeDuring: 2, activeAfter: 1,
      overlappingLinear: { primaryBytes: 16 * MiB, companionBytes: 16 * MiB } })),
    sustained, secondBudget, minuteBudget, instancesCreated: 104, instancesClosed: 104, activeAfterCleanup: 0,
    browserMemory: { method: "measureUserAgentSpecificMemory", crossOriginIsolated: true,
      samples: ["baseline", "two-instances", "after-cleanup"].map((phase) => ({ phase: phase as "baseline" | "two-instances" | "after-cleanup", status: "UNAVAILABLE", bytes: null })) },
    ui: ui()
  };
}
function reportWith(change: (observation: ResourceObservation) => void): ResourceProbeReport {
  const observation = input(); change(observation); return buildResourceProbeReport(observation);
}
/** Sequential parent phase exposure, sharing a periodic companion timeline.
 * A longer stats workload must lengthen exposure, not relax report coverage. */
function exposeWorkloads(raw: ResourceObservation): void {
  let elapsed = raw.wasmLoadWallMs! + raw.companionInit!.wallMs;
  let nextSent = elapsed;
  raw.companionPings = [];
  const phases = [
    { phase: "cycles" as const, duration: raw.cycles.reduce((sum, cycle) => sum + cycle.init!.wallMs + cycle.event!.wallMs + cycle.dispose!.wallMs, 0) },
    { phase: "sustained" as const, duration: raw.sustained!.elapsedMs },
    { phase: "budget-second" as const, duration: raw.secondBudget!.elapsedMs },
    { phase: "budget-minute" as const, duration: raw.minuteBudget!.elapsedMs }
  ];
  for (const { phase, duration } of phases) {
    const ended = elapsed + duration;
    while (nextSent < ended) {
      raw.companionPings.push({ phase, sentOffsetMs: nextSent, latencyMs: 10, failure: null });
      nextSent += RESOURCE_PROBE_LIMITS.eventIntervalMs;
    }
    elapsed = ended;
  }
  const lastPing = raw.companionPings.at(-1)!;
  raw.elapsedMs = Math.max(elapsed, lastPing.sentOffsetMs + lastPing.latencyMs!) + raw.companionDispose!.wallMs;
  raw.completedAt = new Date(Date.parse(raw.startedAt) + Math.ceil(raw.elapsedMs)).toISOString();
}
function assertFiniteTree(value: unknown): void {
  if (typeof value === "number") assert.ok(Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER);
  else if (value && typeof value === "object") Object.values(value).forEach(assertFiniteTree);
}

test("100 sequential healthy cycles, sustained workload, contained budgets and concurrent companion may PASS without T03 certification", () => {
  const report = buildResourceProbeReport(input());
  assert.equal(report.verdict, "PASS", JSON.stringify(report.checks)); assert.equal(report.complete, true);
  assert.equal(report.scope, "resource-benchmark"); assert.equal(report.schemaVersion, 1); assert.equal(report.deviceGate, "NOT_EVALUATED");
  assert.equal(report.companionFailure, null);
  assert.equal(report.cycleSummary.requested, RESOURCE_PROBE_LIMITS.cycles); assert.equal(report.cycleSummary.completed, 100);
  assert.equal(report.observations.cycles.length, 100);
  for (const check of Object.values(report.checks)) assert.deepEqual(check, { verdict: "PASS", reasons: [] });
  assert.deepEqual(report.limits, SANDBOX_LIMITS); assert.deepEqual(report.resourceLimits, RESOURCE_PROBE_LIMITS);
  assert.equal(report.browserMemory.measurement, "NOT_MEASURED");
  assert.deepEqual(JSON.parse(serializeResourceProbeReport(report)), report); assertFiniteTree(report);
});
test("99 healthy cycles remain INCOMPLETE even with completedAt and plausible device metadata", () => {
  const report = reportWith((raw) => { raw.cycles.pop(); raw.instancesCreated = raw.instancesClosed = 103; });
  assert.equal(report.verdict, "INCOMPLETE"); assert.equal(report.complete, false);
  assert.equal(report.cycleSummary.completed, 99); assert.equal(report.cycleSummary.observed, 99);
  assert.ok(report.checks.lifecycle.reasons.includes("cycles-incomplete"));
});
test("one actual healthy failure is FAIL, including when the page was hidden or the run aborted", () => {
  for (const abort of [null, "cancelled", "page-hidden"] as const) {
    const report = reportWith((raw) => { raw.abort = abort;
      raw.cycles[49] = { ...raw.cycles[49], phase: "event", state: "failed", failure: "guest_exception", dispose: null }; });
    assert.equal(report.verdict, "FAIL"); assert.equal(report.cycleSummary.completed, 99);
    assert.ok(report.checks.lifecycle.reasons.includes("unexpected-failure"));
  }
});
test("only the corresponding cumulative code on EVENT, failed and closed, passes negative budget checks", () => {
  for (const key of ["secondBudget", "minuteBudget"] as const) {
    for (const code of ["guest_exception", "execution_timeout", "worker_timeout", key === "secondBudget" ? "execution_budget_minute" : "execution_budget_second"] as const) {
      const report = reportWith((raw) => { raw[key]!.failure = code; });
      assert.equal(report.verdict, "FAIL"); assert.ok(report.checks[key].reasons.includes("wrong-budget-failure"));
    }
    for (const phase of ["init", "dispose", "complete"] as const) {
      const report = reportWith((raw) => { raw[key]!.phase = phase; });
      assert.equal(report.verdict, "FAIL"); assert.ok(report.checks[key].reasons.includes("wrong-budget-phase"));
    }
    assert.equal(reportWith((raw) => { raw[key]!.state = "ready"; }).verdict, "FAIL");
    assert.equal(reportWith((raw) => { raw[key]!.activeAfter = 2; }).verdict, "FAIL");
    assert.equal(reportWith((raw) => { raw[key]!.dispose = turn(); }).verdict, "FAIL");
  }
});
test("completed negative budgets may end before 60s; healthy sustained cannot", () => {
  const good = buildResourceProbeReport(input());
  assert.ok(good.observations.secondBudget!.elapsedMs! < 60_000); assert.ok(good.observations.minuteBudget!.elapsedMs! < 60_000);
  assert.equal(good.checks.secondBudget.verdict, "PASS"); assert.equal(good.checks.minuteBudget.verdict, "PASS");
  const short = reportWith((raw) => { raw.sustained!.elapsedMs = 59_999; raw.sustained!.turns.pop(); });
  assert.equal(short.verdict, "INCOMPLETE"); assert.ok(short.checks.sustained.reasons.includes("sustained-too-short"));
  assert.equal(reportWith((raw) => { raw.sustained!.failure = "worker_error"; raw.sustained!.state = "failed"; raw.sustained!.phase = "event"; raw.sustained!.dispose = null; }).verdict, "FAIL");
});
test("workload time includes init, but init cannot substitute for 60s healthy event time", () => {
  const shortEvents = reportWith((raw) => { raw.sustained!.init!.wallMs = 1000; raw.sustained!.turns = raw.sustained!.turns.filter((sample) => sample.endedOffsetMs > 1000); });
  assert.equal(shortEvents.verdict, "INCOMPLETE"); assert.ok(shortEvents.checks.sustained.reasons.includes("sustained-too-short"));
  const longInit = reportWith((raw) => {
    raw.secondBudget!.init!.wallMs += 4500; raw.secondBudget!.elapsedMs += 4500;
    raw.secondBudget!.turns.forEach((sample) => { sample.endedOffsetMs += 4500; });
    raw.companionPings = raw.companionPings.map((ping) => ({ ...ping, sentOffsetMs: ping.phase === "budget-minute" ? ping.sentOffsetMs + 4500 : ping.sentOffsetMs }));
    raw.companionPings.splice(raw.companionPings.findIndex((ping) => ping.phase === "budget-minute"), 0,
      ...Array.from({ length: 18 }, (_, i) => ({ phase: "budget-second" as const, sentOffsetMs: 64_000 + i * 250, latencyMs: 10, failure: null })));
  });
  assert.equal(longInit.checks.secondBudget.verdict, "PASS", JSON.stringify(longInit.checks));
  assert.equal(longInit.verdict, "PASS", JSON.stringify(longInit.checks));
});
test("every successful turn remains subject to the handler fence", () => {
  assert.equal(reportWith((raw) => { raw.cycles[0].event = turn(51, 51); }).verdict, "FAIL");
  for (const key of ["sustained", "secondBudget", "minuteBudget"] as const) {
    const report = reportWith((raw) => { raw[key]!.turns[0].turn = turn(51, 51); });
    assert.equal(report.verdict, "FAIL"); assert.ok(report.checks[key].reasons.includes("handler-budget-exceeded"));
  }
});
test("init is not charged: 40ms init plus 90ms successful events does not falsely exceed the second budget", () => {
  const raw = input();
  raw.secondBudget!.turns = [80, 360, 640].map((endedOffsetMs) => ({ endedOffsetMs, turn: turn(30, 30) }));
  raw.secondBudget!.elapsedMs = 920;
  const vmBudget = new ExecutionBudget();
  for (const sample of raw.secondBudget!.turns) assert.equal(vmBudget.charge(sample.endedOffsetMs, sample.turn.executionMs), undefined);
  assert.equal(vmBudget.check(920, 30), "execution_budget_second");
  assert.equal(raw.secondBudget!.init!.executionMs, 40);
  assert.equal(raw.secondBudget!.turns.reduce((sum, sample) => sum + sample.turn.executionMs, 0), 90);
  const report = buildResourceProbeReport(raw);
  assert.equal(report.verdict, "PASS", JSON.stringify(report.checks)); assert.equal(report.checks.secondBudget.verdict, "PASS");
  assert.equal(report.observations.secondBudget!.init!.executionMs, 40);
  assert.equal(report.observations.secondBudget!.eventTimings.executionMs.count, 3);
  assert.deepEqual(report.observations.secondBudget!.turns, raw.secondBudget!.turns);
  assert.deepEqual(JSON.parse(serializeResourceProbeReport(report)), report);
});
test("parent ACK jitter cannot invalidate successful turns by reconstructing an exact Worker rolling window", () => {
  // The Worker legitimately evicts the first cost before accepting the third.
  // Different reply latency compresses parent ACK spacing below one second.
  const workerBudget = new ExecutionBudget();
  for (const [ended, cost] of [[80, 30], [600, 40], [1099.5, 40]]) assert.equal(workerBudget.charge(ended, cost), undefined);
  const report = reportWith((raw) => {
    raw.sustained!.init = turn(50, 1);
    raw.sustained!.turns.splice(0, 3,
      { endedOffsetMs: 100, turn: turn(50, 30) },
      { endedOffsetMs: 600.25, turn: turn(40.25, 40) },
      { endedOffsetMs: 1099.75, turn: turn(40.25, 40) });
    raw.sustained!.turns.slice(3).forEach((sample) => { sample.endedOffsetMs += 500; });
    raw.sustained!.elapsedMs = 60_600;
  });
  assert.ok(1099.75 - 100 < 1000); assert.ok(30 + 40 + 40 > SANDBOX_LIMITS.executionMsPerSecond);
  assert.equal(report.verdict, "PASS", JSON.stringify(report.checks)); assert.equal(report.checks.sustained.verdict, "PASS");
});
test("budget codes use trusted enforcement, not inferred rejection timestamps or ACK-window expiration", () => {
  const raw = input(); raw.secondBudget!.elapsedMs = 2000;
  const report = buildResourceProbeReport(raw);
  assert.equal(report.verdict, "PASS", JSON.stringify(report.checks));
  assert.equal(report.observations.secondBudget!.failure, "execution_budget_second");
  assert.deepEqual(report.observations.secondBudget!.turns, raw.secondBudget!.turns);
  assert.deepEqual(report.observations.secondBudget!.eventTimings.executionMs, { count: 2, min: 30, median: 30, p95: 30, max: 30 });
  assert.deepEqual(Object.keys(report.observations.secondBudget!).sort(), ["phase", "state", "failure", "elapsedMs", "init", "turns", "dispose", "activeAfter", "eventTimings"].sort());
  assert.match(report.limitations.join(" "), /parent ACK offsets.*не являются Worker timestamps/);
});
test("only a conservative whole-history upper bound can reject an impossible budget; init cannot rescue it", () => {
  for (const key of ["secondBudget", "minuteBudget"] as const) {
    const invented = reportWith((raw) => { raw[key]!.turns.forEach((sample) => { sample.turn.executionMs = 0.01; }); raw[key]!.init!.executionMs = 0.01; });
    assert.equal(invented.verdict, "FAIL"); assert.ok(invented.checks[key].reasons.includes("budget-window-contradiction"));
  }
  const initOnly = reportWith((raw) => { raw.secondBudget!.init = turn(50, 50); raw.secondBudget!.turns.forEach((sample) => { sample.turn.executionMs = 10; }); });
  assert.equal(initOnly.verdict, "FAIL"); assert.ok(initOnly.checks.secondBudget.reasons.includes("budget-window-contradiction"));
  const boundary = reportWith((raw) => { raw.secondBudget!.turns.forEach((sample) => { sample.turn.executionMs = 25; }); });
  assert.equal(boundary.checks.secondBudget.verdict, "PASS", "an equal/rounded bound alone is not authoritative rejection evidence");
});
test("sustained observations need meaningful periodic events through the duration, not an idle 60s label", () => {
  for (const change of [
    (raw: ResourceObservation) => { raw.sustained!.turns = []; },
    (raw: ResourceObservation) => { raw.sustained!.turns = raw.sustained!.turns.slice(0, 2); },
    (raw: ResourceObservation) => { raw.sustained!.turns = [raw.sustained!.turns[0], raw.sustained!.turns[239]]; },
    (raw: ResourceObservation) => { raw.sustained!.turns.forEach((sample) => { sample.turn.executionMs = 0; }); }
  ]) assert.equal(reportWith(change).verdict, "INCOMPLETE");
});
test("companion boot and dispose, all four workload phases and periodic concurrent ACKs are required", () => {
  for (const phase of ["cycles", "sustained", "budget-second", "budget-minute"] as const) {
    const report = reportWith((raw) => { raw.companionPings = raw.companionPings.filter((ping) => ping.phase !== phase); });
    assert.equal(report.verdict, "INCOMPLETE"); assert.ok(report.checks.companion.reasons.includes("companion-coverage-incomplete"));
  }
  for (const key of ["companionInit", "companionDispose"] as const) assert.equal(reportWith((raw) => { raw[key] = null; }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.companionPings = raw.companionPings.filter((ping) => ping.phase !== "sustained" || ping.sentOffsetMs === 2000); }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.companionPings = raw.companionPings.filter((ping) => ping.sentOffsetMs < 10_000 || ping.sentOffsetMs > 12_000); }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.companionPings[0].failure = "worker_error"; }).verdict, "FAIL");
  assert.equal(reportWith((raw) => { raw.failure = "worker_error"; raw.companionDispose = null; }).verdict, "FAIL");
});
test("async companion worker_error/worker_protocol remains the cause; a forcibly terminated primary is incomplete", () => {
  for (const cause of ["worker_error", "worker_protocol"] as const) {
    for (const phase of ["init", "event"] as const) {
      // An idle companion crash may have no failed ping; its last ACK succeeded.
      for (const globalFailure of [null, cause]) {
        const raw = input(); raw.failure = globalFailure; raw.companionFailure = cause;
        raw.elapsedMs = 25; raw.completedAt = "2026-10-06T10:00:00.025Z";
        raw.cycles = [{ ...raw.cycles[0], phase, state: "failed", failure: null,
          init: phase === "init" ? null : turn(), event: null, dispose: null, activeAfter: 0,
          overlappingLinear: phase === "init" ? null : raw.cycles[0].overlappingLinear }];
        raw.sustained = raw.secondBudget = raw.minuteBudget = null;
        raw.companionDispose = null; raw.instancesCreated = raw.instancesClosed = 2;
        raw.companionPings = [{ phase: "companion", sentOffsetMs: 15, latencyMs: 1, failure: null }];
        const report = buildResourceProbeReport(raw);
        assert.equal(report.verdict, "FAIL"); assert.equal(report.complete, false);
        assert.equal(report.companionFailure, cause); assert.equal(report.failure, globalFailure);
        assert.equal(report.checks.companion.verdict, "FAIL"); assert.ok(report.checks.companion.reasons.includes("unexpected-failure"));
        assert.equal(report.checks.lifecycle.verdict, "INCOMPLETE");
        assert.ok(!report.checks.lifecycle.reasons.includes("unexpected-failure"));
        assert.equal(report.observations.cycles[0].state, "failed"); assert.equal(report.observations.cycles[0].failure, null);
        assert.equal(report.cycleSummary.completed, 0);
        assert.deepEqual(JSON.parse(serializeResourceProbeReport(report)), report);
      }
    }
  }
});
test("companion stop interrupts a healthy sustained workload without inventing its own failure", () => {
  const report = reportWith((raw) => {
    raw.failure = raw.companionFailure = "worker_protocol";
    raw.elapsedMs = 3000; raw.completedAt = "2026-10-06T10:00:03.000Z";
    raw.sustained = { ...raw.sustained!, phase: "event", state: "failed", failure: null,
      elapsedMs: 1000, turns: raw.sustained!.turns.slice(0, 2), dispose: null, activeAfter: 0 };
    raw.secondBudget = raw.minuteBudget = null; raw.instancesCreated = raw.instancesClosed = 102;
    raw.companionDispose = null; raw.companionPings = raw.companionPings.filter((ping) => ping.sentOffsetMs <= 2250);
  });
  assert.equal(report.verdict, "FAIL"); assert.equal(report.companionFailure, "worker_protocol");
  assert.equal(report.checks.companion.verdict, "FAIL"); assert.equal(report.checks.sustained.verdict, "INCOMPLETE");
  assert.ok(!report.checks.sustained.reasons.includes("unexpected-failure"));
  assert.equal(report.observations.sustained!.failure, null);
  assert.deepEqual(JSON.parse(serializeResourceProbeReport(report)), report);
  const both = reportWith((raw) => { raw.companionFailure = "worker_protocol";
    raw.cycles[0] = { ...raw.cycles[0], phase: "event", state: "failed", failure: "guest_exception", dispose: null }; });
  assert.equal(both.checks.companion.verdict, "FAIL"); assert.equal(both.checks.lifecycle.verdict, "FAIL");
  assert.equal(both.observations.cycles[0].failure, "guest_exception");
});
test("abort and global primary failure do not synthesize a companion cause", () => {
  for (const change of [
    { abort: "cancelled" as const, failure: null }, { abort: "deadline" as const, failure: "instance_closed" as const },
    { abort: null, failure: "worker_error" as const }, { abort: null, failure: "worker_protocol" as const }
  ]) {
    const report = reportWith((raw) => { Object.assign(raw, change); raw.companionDispose = null; });
    assert.equal(report.companionFailure, null); assert.equal(report.checks.companion.verdict, "INCOMPLETE");
    assert.ok(!report.checks.companion.reasons.includes("unexpected-failure"));
    assert.equal(JSON.parse(serializeResourceProbeReport(report)).companionFailure, null);
  }
});
test("companion failure projection and serialization whitelist codes without source or arbitrary reason leaks", () => {
  const secret = "SECRET_COMPANION_CAUSE_NEVER_EXPORT";
  for (const cause of [secret, { message: secret, stack: secret, source: secret, credentials: secret }]) {
    const raw = input(); raw.companionFailure = cause as never;
    Object.assign(raw, { companionSource: secret, companionError: { stack: secret } });
    const report = buildResourceProbeReport(raw), json = serializeResourceProbeReport(report);
    assert.equal(report.companionFailure, "unknown_failure"); assert.equal(report.checks.companion.verdict, "FAIL");
    assert.ok(!json.includes(secret)); assert.deepEqual(JSON.parse(json), report);
    const copied = structuredClone(buildResourceProbeReport(input())); copied.companionFailure = cause as never;
    copied.checks.companion.reasons.push(secret as never);
    Object.assign(copied, { source: secret, companionSource: secret });
    const copiedJson = serializeResourceProbeReport(copied), projected = JSON.parse(copiedJson);
    assert.equal(projected.companionFailure, "unknown_failure"); assert.equal(projected.checks.companion.verdict, "FAIL");
    assert.equal(projected.verdict, "FAIL"); assert.ok(!copiedJson.includes(secret));
    assert.ok(!copiedJson.includes('"source"')); assert.ok(!copiedJson.includes('"companionSource"'));
  }
});
test("companion latencies use native 500ms deadline and send spacing is at least 250ms", () => {
  assert.equal(reportWith((raw) => { raw.companionPings[0].latencyMs = 500; }).verdict, "PASS");
  assert.equal(reportWith((raw) => { raw.companionPings[0].latencyMs = 501; }).verdict, "FAIL");
  assert.equal(reportWith((raw) => { raw.companionPings[0].latencyMs = null; }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.companionPings[1].sentOffsetMs = raw.companionPings[0].sentOffsetMs + 249; }).verdict, "FAIL");
});
test("manual category or spoofed UA cannot close T03 or replace workload and UI evidence", () => {
  for (const category of ["quest", "windows", "android", "other", "unspecified"] as const) {
    const pass = reportWith((raw) => { raw.device.category = category as ResourceObservation["device"]["category"]; raw.device.userAgent = "CERTIFIED Quest Windows Android T03 PASS"; });
    assert.equal(pass.device.category, category); assert.equal(JSON.parse(serializeResourceProbeReport(pass)).device.category, category);
    assert.equal(pass.deviceGate, "NOT_EVALUATED");
    const missing = reportWith((raw) => { raw.device.category = category as ResourceObservation["device"]["category"]; raw.device.userAgent = "CERTIFIED T03 PASS"; raw.ui = null; });
    assert.equal(missing.verdict, "INCOMPLETE"); assert.equal(missing.deviceGate, "NOT_EVALUATED");
  }
});
test("hidden resource runs and missing real DURING clicks are INCOMPLETE; full37 hidden semantics stay FAIL", () => {
  for (const change of [{ startedVisible: false }, { endedVisible: false }, { hiddenTransitions: 1 },
    { trustedClicks: 0, duringClicks: 0, visibleDuringClicks: 0, clickPhase: null },
    { duringClicks: 0, visibleDuringClicks: 0, afterClicks: 1, clickPhase: "after-suite" as const }, { visibleDuringClicks: 0 }]) {
    const report = reportWith((raw) => { raw.ui = { ...ui(), ...change }; });
    assert.equal(report.verdict, "INCOMPLETE"); assert.equal(report.complete, false);
  }
  assert.equal(assessUi({ ...ui(), hiddenTransitions: 1 }).verdict, "FAIL");
  assert.equal(reportWith((raw) => { raw.ui!.hiddenTransitions = 1; raw.ui!.duringClicks = raw.ui!.visibleDuringClicks = 0; raw.ui!.afterClicks = 1; raw.ui!.clickPhase = "after-suite"; }).verdict, "INCOMPLETE");
});
test("UI measurements obey trusted-click/frame invariants but have no invented FPS/input SLA", () => {
  for (const change of [{ trustedClicks: 0 }, { visibleDuringClicks: 2 }, { afterClicks: 1 }, { frameSamples: 4 },
    { invalidFrameSamples: 1 }, { invalidInputTimestamps: 1 }, { maxFrameGapMs: NaN }, { maxInputDelayMs: Infinity }]) {
    assert.equal(reportWith((raw) => { raw.ui = { ...ui(), ...change }; }).verdict, "FAIL");
  }
  assert.equal(reportWith((raw) => { raw.ui!.framesDuringSuite = raw.ui!.frameSamples = 1; }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.ui!.maxFrameGapMs = 4000; raw.ui!.maxInputDelayMs = 2000; }).verdict, "PASS");
});
test("cancelled/deadline/hidden runs remain incomplete, but real program failures still dominate", () => {
  for (const abort of ["cancelled", "deadline", "page-hidden", "pagehide"] as const) {
    assert.equal(reportWith((raw) => { raw.abort = abort; }).verdict, "INCOMPLETE");
    assert.equal(reportWith((raw) => { raw.abort = abort; raw.failure = "guest_exception"; }).verdict, "FAIL");
    assert.equal(reportWith((raw) => { raw.abort = abort; raw.failure = "instance_closed"; }).verdict, "INCOMPLETE");
  }
  assert.equal(reportWith((raw) => { raw.completedAt = null; }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.elapsedMs = RESOURCE_PROBE_LIMITS.deadlineMs + 1; }).verdict, "INCOMPLETE");
  assert.notEqual(reportWith((raw) => { raw.abort = "clock-invalid"; }).verdict, "PASS");
});
test("cancellation closes both concurrent instances without manufacturing a healthy or companion failure", () => {
  const cancelled = reportWith((raw) => {
    raw.abort = "cancelled"; raw.completedAt = null; raw.cycles = raw.cycles.slice(0, 1);
    raw.cycles[0] = { ...raw.cycles[0], phase: "event", event: null, dispose: null, state: "failed", failure: null, activeAfter: 0 };
    raw.sustained = raw.secondBudget = raw.minuteBudget = null; raw.companionDispose = null;
    raw.instancesCreated = raw.instancesClosed = 2;
  });
  assert.equal(cancelled.verdict, "INCOMPLETE"); assert.equal(cancelled.complete, false);
  const sustained = reportWith((raw) => { raw.abort = "pagehide"; raw.completedAt = null; raw.sustained!.phase = "event"; raw.sustained!.state = "failed";
    raw.sustained!.dispose = null; raw.sustained!.activeAfter = 0; raw.secondBudget = raw.minuteBudget = null; raw.instancesCreated = raw.instancesClosed = 102; raw.companionDispose = null; });
  assert.equal(sustained.verdict, "INCOMPLETE");
});
test("browser memory is exclusively measured API bytes; unavailable/error/timeout/null never becomes zero or linear total", () => {
  for (const status of ["UNAVAILABLE", "ERROR", "TIMEOUT", "MEASURED"] as const) {
    const report = reportWith((raw) => { raw.browserMemory.samples.forEach((sample) => { sample.status = status; sample.bytes = null; }); });
    assert.equal(report.verdict, "PASS"); assert.equal(report.browserMemory.measurement, "NOT_MEASURED");
    for (const sample of report.browserMemory.samples) { assert.equal(sample.bytes, null); assert.equal(sample.measurement, "NOT_MEASURED"); }
  }
  const forged = reportWith((raw) => { raw.browserMemory.samples.forEach((sample) => { sample.status = "TIMEOUT"; sample.bytes = 32 * MiB; }); });
  assert.equal(forged.browserMemory.measurement, "NOT_MEASURED"); assert.ok(forged.browserMemory.samples.every((sample) => sample.bytes === null));
  const measured = reportWith((raw) => { raw.browserMemory.samples.forEach((sample, i) => { sample.status = "MEASURED"; sample.bytes = (100 + i) * MiB; }); });
  assert.equal(measured.verdict, "PASS"); assert.equal(measured.browserMemory.measurement, "MEASURED");
  assert.deepEqual(measured.browserMemory.samples.map((sample) => sample.bytes), [100, 101, 102].map((value) => value * MiB));
  const partial = reportWith((raw) => { raw.browserMemory.samples[0].status = "MEASURED"; raw.browserMemory.samples[0].bytes = 100 * MiB; });
  assert.equal(partial.browserMemory.measurement, "PARTIAL");
  assert.equal(reportWith((raw) => { raw.browserMemory.samples = []; }).verdict, "PASS");
  const zero = reportWith((raw) => { raw.browserMemory.samples.forEach((sample) => { sample.status = "MEASURED"; sample.bytes = 0; }); });
  assert.equal(zero.browserMemory.measurement, "NOT_MEASURED"); assert.ok(zero.browserMemory.samples.every((sample) => sample.bytes === null));
});
test("linear buffers retain simultaneous primary and companion samples, separately from browser memory", () => {
  const report = reportWith((raw) => { raw.cycles[0].init!.wasmLinearBytes = raw.cycles[0].event!.wasmLinearBytes = raw.cycles[0].dispose!.wasmLinearBytes = 48 * MiB;
    raw.cycles[0].overlappingLinear = { primaryBytes: 48 * MiB, companionBytes: 32 * MiB }; });
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.observations.cycles[0].overlappingLinear, { primaryBytes: 48 * MiB, companionBytes: 32 * MiB, combinedLinearBytes: 80 * MiB });
  assert.equal(report.browserMemory.samples[1].bytes, null); assert.equal(report.cycleSummary.overlappingLinearBytes.combinedLinearBytes.max, 80 * MiB);
  for (const bytes of [0, 16 * MiB - 1, 48 * MiB + 1, Infinity, 16 * MiB + 0.5]) assert.equal(reportWith((raw) => { raw.cycles[0].overlappingLinear!.primaryBytes = bytes; }).verdict, "FAIL");
});
test("whitelist projection drops malicious extras, source/status, room/URL/credentials and arbitrary error text", () => {
  const secret = "SECRET_RESOURCE_CANARY_NEVER_EXPORT";
  const raw = input();
  const extras = { source: secret, statuses: [secret], error: secret, stack: secret, url: `https://example.invalid/?token=${secret}`, credentials: { token: secret }, roomId: secret };
  Object.assign(raw, extras); Object.assign(raw.device, extras); Object.assign(raw.device.viewport, extras);
  Object.assign(raw.cycles[0], extras); Object.assign(raw.cycles[0].event!, extras); Object.assign(raw.cycles[0].overlappingLinear!, extras);
  Object.assign(raw.sustained!, extras); Object.assign(raw.sustained!.turns[0], extras); Object.assign(raw.sustained!.turns[0].turn, extras);
  Object.assign(raw.companionInit!, extras); Object.assign(raw.companionPings[0], extras); Object.assign(raw.ui!, extras);
  Object.assign(raw.browserMemory, extras); Object.assign(raw.browserMemory.samples[0], extras);
  raw.cycles[0].failure = secret as never; raw.companionPings[0].failure = secret as never;
  const report = buildResourceProbeReport(raw), json = serializeResourceProbeReport(report);
  assert.equal(report.verdict, "FAIL"); assert.equal(report.observations.cycles[0].failure, "unknown_failure");
  assert.ok(!json.includes(secret));
  for (const key of ["source", "statuses", "stack", "url", "credentials", "roomId"]) assert.ok(!json.includes(`"${key}"`));
});
test("serializer reuses whitelist, preserves discarded overflow evidence and cannot serialize forged device certification", () => {
  const secret = "SECRET_IN_COPIED_REPORT";
  const original = reportWith((raw) => { raw.cycles.push({ ...raw.cycles[0], index: 101 }); });
  const copied = structuredClone(original);
  Object.assign(copied, { url: secret, credentials: secret, limitations: [secret], deviceGate: "PASS", limits: { vmHeapBytes: secret } });
  Object.assign(copied.observations.cycles[0].event!, { source: secret, stack: secret });
  Object.assign(copied.checks.lifecycle, { error: secret });
  copied.checks.lifecycle.reasons.push(secret as never);
  const json = serializeResourceProbeReport(copied), serialized = JSON.parse(json);
  assert.ok(!json.includes(secret)); assert.equal(serialized.verdict, "FAIL");
  assert.equal(serialized.cycleSummary.observed, 101); assert.equal(serialized.deviceGate, "NOT_EVALUATED");
  assert.deepEqual(serialized.checks.lifecycle.reasons, original.checks.lifecycle.reasons); assert.deepEqual(serialized.limits, SANDBOX_LIMITS);
  const unfinished = structuredClone(buildResourceProbeReport(input())); unfinished.complete = false;
  assert.equal(JSON.parse(serializeResourceProbeReport(unfinished)).verdict, "INCOMPLETE");
  const tampered = structuredClone(buildResourceProbeReport(input())); tampered.observations.cycles[0].event!.executionMs = Infinity;
  const rejected = JSON.parse(serializeResourceProbeReport(tampered));
  assert.equal(rejected.verdict, "FAIL"); assert.equal(rejected.checks.lifecycle.verdict, "FAIL"); assert.equal(rejected.complete, false);
  const extras = structuredClone(buildResourceProbeReport(input()));
  Object.defineProperty(extras.observations, "credentials", { enumerable: true, get() { throw new Error("unrecognized properties must not be read"); } });
  assert.equal(JSON.parse(serializeResourceProbeReport(extras)).verdict, "PASS");
});
test("duplicate, skipped and reordered cycle indices cannot stand in for 100 sequential cycles", () => {
  for (const change of [(raw: ResourceObservation) => { raw.cycles[1].index = 1; }, (raw: ResourceObservation) => { raw.cycles[0].index = 2; },
    (raw: ResourceObservation) => { [raw.cycles[0], raw.cycles[1]] = [raw.cycles[1], raw.cycles[0]]; }]) {
    const report = reportWith(change); assert.equal(report.verdict, "FAIL"); assert.ok(report.checks.lifecycle.reasons.includes("cycle-sequence-invalid")); assert.ok(report.cycleSummary.completed < 100);
  }
});
test("bounded projection never trims overflowing input into PASS, even if the extra record contains failure", () => {
  const cycles = reportWith((raw) => { raw.cycles.push({ ...raw.cycles[0], index: 101, failure: "worker_error", state: "failed" }); });
  assert.equal(cycles.verdict, "FAIL"); assert.equal(cycles.observations.cycles.length, 100); assert.equal(cycles.cycleSummary.observed, 101);
  assert.ok(cycles.checks.lifecycle.reasons.includes("record-overflow"));
  const pings = reportWith((raw) => { raw.companionPings = Array.from({ length: RESOURCE_PROBE_LIMITS.maxPings + 1 }, (_, i) => ({ phase: "cycles", sentOffsetMs: i * 250, latencyMs: 1, failure: null })); });
  assert.equal(pings.verdict, "FAIL"); assert.equal(pings.observations.companionPings.length, RESOURCE_PROBE_LIMITS.maxPings);
  const events = reportWith((raw) => { raw.sustained!.turns = Array.from({ length: RESOURCE_PROBE_LIMITS.maxBudgetTurns + 1 }, (_, i) => ({ endedOffsetMs: (i + 1) * 250, turn: turn() })); });
  assert.equal(events.verdict, "FAIL"); assert.equal(events.observations.sustained!.turns.length, RESOURCE_PROBE_LIMITS.maxBudgetTurns);
  const memory = reportWith((raw) => { raw.browserMemory.samples.push({ ...raw.browserMemory.samples[0] }); });
  assert.equal(memory.verdict, "FAIL"); assert.equal(memory.browserMemory.samples.length, 3);
});
test("invalid/nonfinite/duplicate clocks and missing measurements never PASS and export only finite numbers", () => {
  const changes = [
    (raw: ResourceObservation) => { raw.elapsedMs = Infinity; }, (raw: ResourceObservation) => { raw.wasmLoadWallMs = NaN; },
    (raw: ResourceObservation) => { raw.cycles[0].init!.wallMs = NaN; }, (raw: ResourceObservation) => { raw.cycles[0].event!.executionMs = Infinity; },
    (raw: ResourceObservation) => { raw.cycles[0].dispose!.wallMs = -1; }, (raw: ResourceObservation) => { raw.cycles[0].event = turn(1, 2); },
    (raw: ResourceObservation) => { raw.sustained!.turns[1].endedOffsetMs = raw.sustained!.turns[0].endedOffsetMs; },
    (raw: ResourceObservation) => { raw.sustained!.turns[0].endedOffsetMs = 60_100; },
    (raw: ResourceObservation) => { raw.secondBudget!.turns[0].endedOffsetMs = Infinity; },
    (raw: ResourceObservation) => { raw.companionPings[1].sentOffsetMs = 0; },
    (raw: ResourceObservation) => { raw.companionPings[0].latencyMs = NaN; },
    (raw: ResourceObservation) => { raw.companionPings[0].sentOffsetMs = raw.elapsedMs + 1; },
    (raw: ResourceObservation) => { raw.completedAt = "2026-10-05T10:00:00.000Z"; },
    (raw: ResourceObservation) => { raw.browserMemory.samples[0].status = "MEASURED"; raw.browserMemory.samples[0].bytes = Infinity; },
    (raw: ResourceObservation) => { raw.cycles[0].event!.jobs = 0.5; }
  ];
  for (const change of changes) { const report = reportWith(change); assert.notEqual(report.verdict, "PASS"); assertFiniteTree(report); assert.deepEqual(JSON.parse(serializeResourceProbeReport(report)), report); }
  assert.equal(reportWith((raw) => { raw.cycles[0].event = null; }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.cycles[0].overlappingLinear = null; }).verdict, "INCOMPLETE");
  assert.equal(reportWith((raw) => { raw.secondBudget = null; }).verdict, "INCOMPLETE");
});
test("terminal dispose must fit the workload clock and a single instance's linear buffer cannot shrink", () => {
  const impossibleDispose = reportWith((raw) => { raw.sustained!.elapsedMs = 61_010; raw.sustained!.dispose!.wallMs = 1100; });
  assert.equal(impossibleDispose.verdict, "FAIL"); assert.ok(impossibleDispose.checks.sustained.reasons.includes("invalid-clock"));
  const cycle = reportWith((raw) => { raw.cycles[0].event!.wasmLinearBytes = 32 * MiB; });
  assert.equal(cycle.verdict, "FAIL"); assert.ok(cycle.checks.lifecycle.reasons.includes("linear-buffer-contradiction"));
  const workload = reportWith((raw) => { raw.sustained!.turns[0].turn.wasmLinearBytes = 32 * MiB; });
  assert.equal(workload.verdict, "FAIL"); assert.ok(workload.checks.sustained.reasons.includes("linear-buffer-contradiction"));
  const companion = reportWith((raw) => { raw.companionInit!.wasmLinearBytes = 32 * MiB; });
  assert.equal(companion.verdict, "FAIL"); assert.ok(companion.checks.companion.reasons.includes("linear-buffer-contradiction"));
});
test("structural contradictions, sparse records and invalid enums cannot become PASS after sanitization", () => {
  for (const change of [
    (raw: ResourceObservation) => { raw.cycles[0].state = "ready"; },
    (raw: ResourceObservation) => { raw.cycles[0].activeDuring = 1; },
    (raw: ResourceObservation) => { raw.cycles[0].activeAfter = 0; },
    (raw: ResourceObservation) => { delete raw.cycles[2]; },
    (raw: ResourceObservation) => { raw.companionPings[0].phase = "malicious-phase" as never; },
    (raw: ResourceObservation) => { raw.browserMemory.samples[1].phase = "baseline"; },
    (raw: ResourceObservation) => { raw.browserMemory.method = "performance.memory" as never; },
    (raw: ResourceObservation) => { raw.abort = "malicious-abort" as never; }
  ]) assert.equal(reportWith(change).verdict, "FAIL");
});
test("timing statistics use count/min/median/nearest-rank p95/max, retain init total and leave input/report immutable", () => {
  const raw = input();
  raw.cycles.forEach((cycle, i) => { cycle.init = turn(i + 1, (i + 1) / 10); });
  const underexposed = buildResourceProbeReport(raw);
  assert.equal(underexposed.verdict, "INCOMPLETE"); assert.ok(underexposed.checks.companion.reasons.includes("companion-coverage-incomplete"));
  exposeWorkloads(raw);
  const before = structuredClone(raw), report = buildResourceProbeReport(raw);
  assert.equal(report.verdict, "PASS", JSON.stringify(report.checks));
  assert.deepEqual(report.cycleSummary.init.wallMs, { count: 100, min: 1, median: 50.5, p95: 95, max: 100 });
  assert.deepEqual(report.cycleSummary.init.executionMs, { count: 100, min: 0.1, median: 5.05, p95: 9.5, max: 10 });
  assert.deepEqual(report.cycleSummary.event.wallMs, { count: 100, min: 4, median: 4, p95: 4, max: 4 });
  assert.deepEqual(raw, before); assert.ok(!Object.isFrozen(raw));
  assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.observations.cycles[0].init)); assert.ok(Object.isFrozen(report.checks.lifecycle.reasons));
  raw.cycles[0].init!.wallMs = 123; raw.device.viewport.width = 1; raw.ui!.duringClicks = 0;
  assert.equal(report.observations.cycles[0].init!.wallMs, 1); assert.equal(report.device.viewport.width, 900); assert.equal(report.observations.ui!.duringClicks, 1);
  assert.throws(() => { report.observations.cycles[0].index = 101; }, TypeError);
  const empty = reportWith((observation) => { observation.cycles = []; observation.instancesCreated = observation.instancesClosed = 4; });
  assert.deepEqual(empty.cycleSummary.init.wallMs, { count: 0, min: null, median: null, p95: null, max: null });
});
test("cleanup requires zero live instances and created/closed parity, which is not physical GC evidence", () => {
  for (const change of [(raw: ResourceObservation) => { raw.activeAfterCleanup = 1; },
    (raw: ResourceObservation) => { raw.instancesClosed = 103; }, (raw: ResourceObservation) => { raw.instancesCreated = raw.instancesClosed = 103; },
    (raw: ResourceObservation) => { raw.instancesCreated = raw.instancesClosed = 105; }]) assert.equal(reportWith(change).verdict, "FAIL");
  const report = buildResourceProbeReport(input()); assert.equal(report.checks.cleanup.verdict, "PASS");
  assert.equal(report.observations.cleanupEvidence, "INSTANCE_COUNTERS_ONLY");
  assert.match(report.limitations.join(" "), /не физическое освобождение памяти.*GC/);
  assert.match(report.limitations.join(" "), /не вся память Worker\/браузера/);
});
