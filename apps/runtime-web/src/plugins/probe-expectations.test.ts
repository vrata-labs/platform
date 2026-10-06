import assert from "node:assert/strict";
import { test } from "node:test";
import { PROBE_FIXTURES, type ProbeFixture } from "./probe-fixtures.js";
import { PROBE_EXPECTATIONS, PROBE_FIXTURE_ORDER, assessProbeResult } from "./probe-expectations.js";
import type { ProbeResult } from "./probe.js";

const healthy = (): ProbeResult => ({ fixture: "healthy", phase: "complete", state: "disposed", failure: null, exceptionHint: null,
  statuses: ["Welcome plugin initialized", "Probe greeting"], elapsedMs: 30, executionMs: 3, jobs: 0, wasmMemoryBytes: 16 * 1024 * 1024, hostFramesDuring: 2 });
const hostile = (): ProbeResult => ({ ...healthy(), fixture: "loop", phase: "init", state: "failed", failure: "execution_timeout", statuses: [], executionMs: null, jobs: null });

test("all 37 fixed fixtures have explicit Russian expectations and concrete failure lists", () => {
  assert.equal(PROBE_FIXTURE_ORDER.length, 37);
  assert.deepEqual([...PROBE_FIXTURE_ORDER].sort(), Object.keys(PROBE_EXPECTATIONS).sort());
  assert.deepEqual(Object.keys(PROBE_FIXTURES).sort(), Object.keys(PROBE_EXPECTATIONS).sort());
  for (const expectation of Object.values(PROBE_EXPECTATIONS)) {
    assert.match(expectation.label, /[А-Яа-я]/);
    assert.match(expectation.purpose, /[А-Яа-я]/);
    assert.match(expectation.expected, /[А-Яа-я]/);
    if (expectation.mode === "contained") {
      assert.ok(expectation.allowedFailures.length > 0);
      assert.ok(!expectation.allowedFailures.includes("native_failure"));
      assert.ok(!expectation.allowedFailures.includes("worker_boot_timeout"));
    }
  }
});
test("healthy completion is PASS; unexpected healthy failed is FAIL", () => {
  assert.equal(assessProbeResult(healthy()).verdict, "PASS");
  assert.equal(assessProbeResult({ ...healthy(), state: "failed", failure: "worker_error" }).verdict, "FAIL");
  assert.equal(assessProbeResult({ ...healthy(), statuses: [] }).verdict, "FAIL");
});
test("hostile failed is PASS only for concrete expected code and contained instance with no effects", () => {
  const result = assessProbeResult(hostile());
  assert.equal(result.verdict, "PASS");
  assert.match(result.actual, /failed — состояние этого плагина/);
  for (const change of [
    { failure: "native_failure" }, { failure: "worker_boot_timeout" }, { failure: null },
    { state: "ready" }, { state: "disposed" }, { statuses: ["MUST NOT COMMIT"] }
  ] as const) assert.equal(assessProbeResult({ ...hostile(), ...change } as ProbeResult).verdict, "FAIL");
});
test("normal globals/tamper/seating denial require their exact expected statuses and disposed state", () => {
  for (const [fixture, message] of [
    ["globals", "VM globals and network unavailable"],
    ["primordialTamper", "Captured primordials intact"],
    ["seatingDenied", "Seating backend not integrated"]
  ] as [ProbeFixture, string][]) {
    const result = { ...healthy(), fixture, statuses: [message] };
    assert.equal(assessProbeResult(result).verdict, "PASS");
    assert.equal(assessProbeResult({ ...result, state: "failed", failure: "capability_denied" }).verdict, "FAIL");
    assert.equal(assessProbeResult({ ...result, statuses: ["wrong"] }).verdict, "FAIL");
  }
});
test("native regexp watchdog is explicitly allowed; ordinary JS loop watchdog is not substituted", () => {
  assert.equal(assessProbeResult({ ...hostile(), fixture: "regex", phase: "event", failure: "worker_timeout" }).verdict, "PASS");
  assert.equal(assessProbeResult({ ...hostile(), failure: "worker_timeout" }).verdict, "FAIL");
});
test("a matching denial code on the wrong lifecycle phase cannot pass event/dispose fixtures", () => {
  for (const [fixture, phase] of [["eventLoop", "event"], ["regex", "event"], ["disposeLoop", "dispose"]] as const) {
    assert.equal(assessProbeResult({ ...hostile(), fixture, phase }).verdict, "PASS");
    for (const wrong of ["loaded", "init", "complete"] as const) {
      assert.equal(assessProbeResult({ ...hostile(), fixture, phase: wrong }).verdict, "FAIL");
    }
  }
  assert.equal(assessProbeResult({ ...healthy(), phase: "dispose" }).verdict, "FAIL");
});
test("observed globals timeout under load stays FAIL, not an accepted hostile outcome", () => {
  const result: ProbeResult = { ...healthy(), fixture: "globals", phase: "init", state: "failed", failure: "execution_timeout", statuses: [], elapsedMs: 669, executionMs: null, hostFramesDuring: 0 };
  const assessment = assessProbeResult(result);
  assert.equal(assessment.verdict, "FAIL");
  assert.match(assessment.reasons.join(" "), /init/); assert.match(assessment.reasons.join(" "), /execution_timeout/);
});
test("import observation never infers causal import denial from a guest exception/hint", () => {
  for (const fixture of ["staticImport", "dynamicImport", "generatedImport"] as const) {
    const result = { ...hostile(), fixture, failure: "guest_exception" as const, exceptionHint: "stack_exhausted" as const };
    const assessment = assessProbeResult(result);
    assert.equal(assessment.verdict, "PASS");
    assert.match(assessment.actual, /Причина исключения не доказана/);
    assert.match(assessment.expected, /не доказывает import_denied/);
  }
});
test("heap/stack hints alone never replace failed-instance containment, code checks and bounded memory", () => {
  for (const [fixture, exceptionHint] of [["heapLimit", "memory_exhausted"], ["stack", "stack_exhausted"]] as const) {
    const result = { ...hostile(), fixture, failure: "guest_exception" as const, exceptionHint };
    assert.equal(assessProbeResult(result).verdict, "PASS");
    for (const change of [{ state: "ready" }, { failure: "native_failure" }, { exceptionHint: null },
      { statuses: ["leaked"] }, { wasmMemoryBytes: null }, { wasmMemoryBytes: 49 * 1024 * 1024 }]) {
      assert.equal(assessProbeResult({ ...result, ...change } as ProbeResult).verdict, "FAIL");
    }
  }
});
test("invalid telemetry and unknown scenario fail rather than inheriting a generic expectation", () => {
  for (const change of [{ elapsedMs: NaN }, { executionMs: 51 }, { hostFramesDuring: -1 }, { fixture: "unknown" }]) {
    assert.equal(assessProbeResult({ ...healthy(), ...change } as ProbeResult).verdict, "FAIL");
  }
});
