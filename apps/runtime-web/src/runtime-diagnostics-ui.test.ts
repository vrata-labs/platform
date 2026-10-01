import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { createDiagnosticState, createDiagnosticsHarness } from "./testing/runtime-diagnostics-harness.js";

test("disabled debug panels neither read state nor overwrite text", (t) => {
  const h = createDiagnosticsHarness(t, false);
  const runtime = createRuntimeDiagnostics({ ...h.context,
    get debugState(): never { throw new Error("unexpected debug read"); }
  });
  runtime.renderDebugPanel(); assert.equal(h.context.debugPanel.textContent, "");
  assert.equal(h.context.xrDebugPanelEl.textContent, ""); assert.deepEqual(h.events, []);
});

test("debug panels preserve JSON, line order, coordinate formatting and missing-value labels", (t) => {
  const h = createDiagnosticsHarness(t); h.inputs.debugState = createDiagnosticState();
  const state = h.inputs.debugState;
  state.xrSession.sessionState = "active"; state.xrSession.enterVrVisible = true;
  state.xrAxes = { moveX: -0.123, moveY: 0.456, turnX: 0.789, turnY: -0.999 };
  state.interactionRay.source = { index: 1, handedness: "right" };
  state.interactionRay.origin = { x: 1, y: 2, z: 3 }; state.interactionRay.direction = { x: 0, y: -1, z: 0 };
  state.statusLine = "Ready";
  h.runtime.renderDebugPanel(); assert.equal(h.context.debugPanel.textContent, JSON.stringify(state, null, 2));
  assert.deepEqual(h.context.xrDebugPanelEl.textContent?.split("\n"), [
    "XR session: active visible=true", "XR profile: none", "XR axes: turn=(0.79, -1.00) move=(-0.12, 0.46)",
    `Ray active: ${state.interactionRay.active} mode=${state.interactionRay.mode} target=${state.interactionRay.targetKind} seat=-`,
    "Ray source: right#1", "Ray origin: 1, 2, 3", "Ray direction: 0, -1, 0",
    "Right grip: -", "Right controller: -", "Right resolved: -", "Right hand world: -", "Status: Ready"
  ]);
});

for (const value of [new Error("a".repeat(190)), "plain", null, undefined, 0]) {
  test(`unhandled error keeps report ID, issue fields and message normalization: ${String(value).slice(0, 25)}`, async (t) => {
    const h = createDiagnosticsHarness(t); const uuid = "00000000-0000-4000-8000-000000000001";
    t.mock.method(crypto, "randomUUID", () => uuid);
    h.hooks.fetch = async () => { throw new Error("unavailable transport"); };
    h.runtime.reportUnhandledRuntimeError(value, "runtime_error");
    assert.equal(h.context.reportLineEl.hidden, false);
    assert.equal(h.context.reportLineEl.textContent, `Report ID: rpt_${uuid}`);
    assert.equal(h.inputs.debugState.statusLine, `Runtime error. Report ID: rpt_${uuid}`);
    assert.equal(h.inputs.debugState.issueCode, "runtime_unhandled_error");
    assert.equal(h.inputs.debugState.issueSeverity, "error");
    assert.equal(h.inputs.debugState.lastRecoveryAction, "report_runtime_error");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests[0]!.body.reportId, `rpt_${uuid}`);
    const message = value instanceof Error ? value.message : String(value ?? "unknown");
    assert.equal(h.requests[0]!.body.note, `runtime_error:${message.slice(0, 160)}`);
    assert.deepEqual(h.events, ["status", "refresh", "capture", "fetch"]);
  });
}

test("an unhandled error still displays a report ID when remote reports are disabled", async (t) => {
  const h = createDiagnosticsHarness(t); h.inputs.runtimeFlags = { remoteDiagnostics: false };
  h.runtime.reportUnhandledRuntimeError("offline", "runtime_unhandled_rejection");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.context.reportLineEl.textContent, /^Report ID: rpt_/);
  assert.deepEqual(h.events, ["status"]); assert.equal(h.requests.length, 0);
});
