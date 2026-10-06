import assert from "node:assert/strict";
import { test } from "node:test";
import { PROBE_FIXTURE_ORDER, PROBE_EXPECTATIONS, HOSTILE_FIXTURES } from "./probe-expectations.js";
import { buildProbeReport, serializeProbeReport, assessUi, assessCompanionOperation, inputDelayMs, type ReportInput, type UiObservation, type CompanionOperation } from "./probe-report.js";
import type { ProbeResult } from "./probe.js";

function input(): ReportInput {
  return {
    scope: "full-suite", startedAt: "2026-10-04T10:00:00.000Z", completedAt: "2026-10-04T10:00:03.000Z",
    device: { category: "quest", userAgent: "Quest Browser diagnostic", language: "ru", viewport: { width: 900, height: 600, pixelRatio: 1 } },
    results: PROBE_FIXTURE_ORDER.map((fixture): ProbeResult => {
      const expectation = PROBE_EXPECTATIONS[fixture];
      return { fixture, phase: expectation.phase, state: expectation.mode === "normal" ? "disposed" : "failed", failure: expectation.allowedFailures[0] ?? null,
        exceptionHint: expectation.hint ?? null, statuses: [...expectation.statuses], elapsedMs: 10, executionMs: null, jobs: null, wasmMemoryBytes: 16 * 1024 * 1024, hostFramesDuring: 1 };
    }),
    continuity: { failure: null, completedChecks: 37, allReady: true, finalStatusSeen: true, activeAfterCleanup: 0, elapsedMs: 3000,
      operations: HOSTILE_FIXTURES.map((fixture) => ({ fixture, phase: PROBE_EXPECTATIONS[fixture].phase, durationMs: 2, pings: [{ sentOffsetMs: 0, ackOffsetMs: 1, latencyMs: 1, failure: null }] })) },
    ui: goodUi()
  };
}
function goodUi(): UiObservation {
  return { framesDuringSuite: 100, frameSamples: 100, maxFrameGapMs: 30, invalidFrameSamples: 0,
    startedVisible: true, endedVisible: true, hiddenTransitions: 0, trustedClicks: 1, duringClicks: 1,
    afterClicks: 0, visibleDuringClicks: 1, maxInputDelayMs: 2, invalidInputTimestamps: 0, clickPhase: "during-suite" };
}
test("completed full diagnostic report may PASS but always leaves full device gate NOT_EVALUATED", () => {
  const report = buildProbeReport(input());
  assert.equal(report.verdict, "PASS"); assert.equal(report.complete, true);
  assert.equal(report.passed, 37); assert.equal(report.failed, 0);
  assert.equal(report.deviceGate, "NOT_EVALUATED");
  assert.match(report.limitations.join(" "), /не вся память/);
  assert.deepEqual(JSON.parse(serializeProbeReport(report)), report);
});
test("Quest UA or a manual click cannot PASS an incomplete or failing report", () => {
  for (const change of [
    { results: [] }, { completedAt: null }, { results: input().results.slice(1) },
    { continuity: null }, { ui: { ...goodUi(), trustedClicks: 0, duringClicks: 0, visibleDuringClicks: 0, clickPhase: null } }
  ]) assert.equal(buildProbeReport({ ...input(), ...change } as ReportInput).verdict, "INCOMPLETE");
  const failed = input(); failed.results = failed.results.map((result) => result.fixture === "healthy" ? { ...result, state: "failed", failure: "worker_error" } : result);
  assert.equal(buildProbeReport(failed).verdict, "FAIL");
});
test("duplicate scenarios cannot replace missing coverage, and live/failed companion or stalled UI fails", () => {
  const duplicate = input(); duplicate.results = [...duplicate.results.slice(1), duplicate.results[1]];
  const report = buildProbeReport(duplicate);
  assert.equal(report.verdict, "FAIL"); assert.ok(report.missing.includes("healthy")); assert.ok(report.duplicates.length > 0);
  for (const continuity of [
    { ...input().continuity!, allReady: false }, { ...input().continuity!, activeAfterCleanup: 1 },
    { ...input().continuity!, finalStatusSeen: false }, { ...input().continuity!, failure: "worker_timeout" }
  ]) assert.equal(buildProbeReport({ ...input(), continuity }).verdict, "FAIL");
  assert.equal(buildProbeReport({ ...input(), ui: { ...goodUi(), framesDuringSuite: 0, frameSamples: 0 } }).verdict, "FAIL");
});
test("after-suite click is recorded but cannot replace a visible during-suite trusted click", () => {
  const after: UiObservation = { ...goodUi(), duringClicks: 0, visibleDuringClicks: 0, afterClicks: 1, clickPhase: "after-suite" };
  const assessment = assessUi(after);
  assert.equal(assessment.verdict, "PENDING"); assert.equal(assessment.measurements.afterClicks, 1);
  assert.equal(buildProbeReport({ ...input(), ui: after }).verdict, "INCOMPLETE");
  assert.equal(assessUi(goodUi()).verdict, "PASS");
});
test("one RAF, hidden visibility, invalid timing or only a non-visible click never pass responsiveness", () => {
  for (const change of [
    { framesDuringSuite: 1, frameSamples: 1 }, { startedVisible: false }, { endedVisible: false }, { hiddenTransitions: 1 },
    { invalidFrameSamples: 1 }, { maxFrameGapMs: NaN }, { maxInputDelayMs: NaN }, { invalidInputTimestamps: 1 }
  ]) assert.notEqual(assessUi({ ...goodUi(), ...change }).verdict, "PASS");
  assert.equal(assessUi({ ...goodUi(), visibleDuringClicks: 0 }).verdict, "PENDING");
  // Measurements only: do not manufacture a 250ms/FPS SLA.
  const measured = assessUi({ ...goodUi(), maxFrameGapMs: 600, maxInputDelayMs: 300 });
  assert.equal(measured.verdict, "PASS"); assert.equal(measured.measurements.maxFrameGapMs, 600);
});
test("input delay normalizes monotonic/epoch timestamps and rejects non-finite/future values", () => {
  assert.equal(inputDelayMs(50, 40, 1000000), 10);
  assert.equal(inputDelayMs(50, 1000040, 1000000), 10);
  for (const timestamp of [NaN, Infinity, -1, 51, 1000051]) assert.equal(inputDelayMs(50, timestamp, 1000000), null);
});
test("short concurrent ping joins after operation; long operation requires an overlapping ACK within 500ms", () => {
  const base: CompanionOperation = { fixture: "loop", phase: "init", durationMs: 5, pings: [{ sentOffsetMs: 0, ackOffsetMs: 8, latencyMs: 8, failure: null }] };
  assert.equal(assessCompanionOperation(base), true);
  assert.equal(assessCompanionOperation({ ...base, durationMs: 500, pings: [{ sentOffsetMs: 490, ackOffsetMs: 510, latencyMs: 20, failure: null }] }), false);
  assert.equal(assessCompanionOperation({ ...base, durationMs: 700, pings: [
    { sentOffsetMs: 0, ackOffsetMs: 10, latencyMs: 10, failure: null }, { sentOffsetMs: 250, ackOffsetMs: 260, latencyMs: 10, failure: null }
  ] }), true);
  for (const change of [
    { pings: [] }, { phase: "dispose" }, { pings: [{ sentOffsetMs: 0, ackOffsetMs: 501, latencyMs: 501, failure: null }] },
    { pings: [{ sentOffsetMs: 6, ackOffsetMs: 7, latencyMs: 1, failure: null }] }
  ]) assert.equal(assessCompanionOperation({ ...base, ...change } as CompanionOperation), false);
  assert.equal(assessCompanionOperation({ ...base, durationMs: 100, pings: [
    { sentOffsetMs: 0, ackOffsetMs: 1, latencyMs: 1, failure: null }, { sentOffsetMs: 10, ackOffsetMs: 11, latencyMs: 1, failure: null }
  ] }), false);
});
test("post-case checks alone cannot pass companion continuity without concurrent hostile coverage", () => {
  assert.equal(buildProbeReport({ ...input(), continuity: { ...input().continuity!, operations: [] } }).verdict, "FAIL");
});
test("export strips room/user/auth/context extras and unknown guest status or failure text", () => {
  const secret = "ROOM_USER_TOKEN_CANARY_NOT_FOR_EXPORT";
  const raw = input();
  raw.results = raw.results.map((result) => result.fixture === "healthy" ? {
    ...result, statuses: [secret], failure: secret as never, stack: secret, roomId: secret, participantId: secret, config: { token: secret }
  } : result);
  const report = buildProbeReport({ ...raw, cookie: secret, url: `https://example.invalid/?token=${secret}`, room: secret } as ReportInput);
  const json = serializeProbeReport(report);
  assert.equal(report.verdict, "FAIL"); assert.ok(!json.includes(secret));
  assert.ok(!json.includes("participantId")); assert.ok(!json.includes("config"));
  assert.equal(report.scenarios[0].result.failure, "unknown_failure");
});
test("a single valid scenario report cannot masquerade as completed full-suite coverage", () => {
  const raw = input(); raw.scope = "single-scenario"; raw.results = raw.results.slice(0, 1); raw.ui = raw.continuity = null;
  const report = buildProbeReport(raw);
  assert.equal(report.verdict, "PASS"); assert.equal(report.expectedScenarios, 1); assert.equal(report.scope, "single-scenario");
  assert.equal(report.deviceGate, "NOT_EVALUATED");
});
