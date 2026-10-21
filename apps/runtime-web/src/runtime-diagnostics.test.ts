import assert from "node:assert/strict";
import test from "node:test";
import { Object3D } from "three";
import { createRuntimeDiagnostics, reportRuntimeBootDiagnostics } from "./runtime-diagnostics.js";
import { SessionUpgradeError } from "./session-upgrade.js";
import { createDiagnosticState, createDiagnosticsHarness, deferred } from "./testing/runtime-diagnostics-harness.js";

const reportedStateKeys = [
  "mode", "statusLine", "locomotionMode", "roomStateConnected", "roomStateUrl", "roomStateMode",
  "audioState", "localMicLevel", "speakerOutputLevel", "media", "access", "surfaceInput", "screenShareState",
  "mediaCapabilities", "clientCompatibility", "localPose", "localPosition", "spatialAudioState", "spatialAudio",
  "xrSession", "xrAxes", "remoteAvatarCount", "remoteTargets", "remoteParticipants", "remoteAvatarReliableStates",
  "remoteAvatarPoseFrames", "remoteAvatarParticipants", "issueCode", "issueSeverity", "degradedMode", "retryCount",
  "lastRecoveryAction", "lastPresenceSyncAt", "lastPresenceRefreshAt", "featureFlags", "faultInjection", "avatarDebug",
  "avatarSnapshot", "avatarTransportPreview", "avatarPoseTransport", "xrAvatarDebug"
] as const;

test("construction does not read live state, render or send before main initializes diagnostics", (t) => {
  const h = createDiagnosticsHarness(t);
  const runtime = createRuntimeDiagnostics({ ...h.context,
    get participantId(): never { throw new Error("early identity read"); },
    get debugState(): never { throw new Error("early diagnostics read"); },
    get runtimeFlags(): never { throw new Error("early flag read"); },
    get displayName(): never { throw new Error("early name read"); },
    get roomStateAccessToken(): never { throw new Error("early token read"); },
    get activeSceneBundleRoot(): never { throw new Error("early scene read"); }
  });
  assert.deepEqual(Object.keys(runtime), ["renderDebugPanel", "reportDiagnostics", "reportUnhandledRuntimeError"]);
  assert.deepEqual(h.events, []);
});

test("disabled remote diagnostics return before refresh, scene capture or transport", async (t) => {
  const h = createDiagnosticsHarness(t); h.inputs.runtimeFlags = { remoteDiagnostics: false };
  await h.runtime.reportDiagnostics(); assert.deepEqual(h.events, []);
  h.inputs.runtimeFlags = { remoteDiagnostics: true };
  await h.runtime.reportDiagnostics(); assert.equal(h.requests.length, 1);
});

test("boot diagnostics return immediately while stats collection is held", async t => {
  const h = createDiagnosticsHarness(t), stats = deferred<void>(); h.hooks.refresh = () => stats.promise;
  assert.equal(reportRuntimeBootDiagnostics(h.runtime.reportDiagnostics), undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(h.events, ["refresh"]);
  stats.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.note, "runtime_booted");
});

test("boot diagnostics do not propagate a pending HTTP response or a reporting failure", async t => {
  const h = createDiagnosticsHarness(t), response = deferred<Response>(); h.hooks.fetch = () => response.promise;
  assert.equal(reportRuntimeBootDiagnostics(h.runtime.reportDiagnostics), undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 1);
  const status = h.inputs.debugState.statusLine, issue = h.inputs.debugState.issueCode;
  response.reject(new Error("diagnostics_unavailable")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.inputs.debugState.statusLine, status); assert.equal(h.inputs.debugState.issueCode, issue);
});

test("report preserves the complete payload, URL, method and optional-field omission", async (t) => {
  const h = createDiagnosticsHarness(t);
  h.inputs.debugState.sceneDebug.missingAssets = ["first", "second"];
  await h.runtime.reportDiagnostics();
  assert.deepEqual(h.events, ["refresh", "capture", "fetch"]);
  const request = h.requests[0]!;
  assert.equal(request.url, "https://example.invalid/api/rooms/room/diagnostics");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(request.init.headers, { "content-type": "application/json", authorization: "Bearer test-token" });
  const state = h.context.debugState;
  const expected = {
    participantId: "participant", displayName: "Guest", userAgent: "diagnostics-test",
    ...Object.fromEntries(reportedStateKeys.map(key => [key, state[key]])),
    sceneDebug: { ...state.sceneDebug, template: state.template, missingAssetCount: 2, screenshot: h.screenshot },
    createdAt: "2023-11-14T22:13:20.000Z"
  };
  assert.deepEqual(request.body, JSON.parse(JSON.stringify(expected)));
  assert.equal(state.sceneDebug.screenshot, h.screenshot);
  assert.ok(!("reportId" in request.body)); assert.ok(!("note" in request.body));
});

test("after refresh, the report observes replaced state, scene, token, name and options", async (t) => {
  const h = createDiagnosticsHarness(t); const pending = deferred<void>(); h.hooks.refresh = () => pending.promise;
  const options = { reportId: "before" }; const request = h.runtime.reportDiagnostics("note", options);
  h.inputs.debugState = createDiagnosticState(); h.inputs.debugState.statusLine = "latest";
  h.inputs.activeSceneBundleRoot = new Object3D(); h.inputs.displayName = "Renamed";
  h.inputs.roomStateAccessToken = "refreshed-token"; options.reportId = "after";
  // The existing flag is checked only before await; changing it does not cancel a started report.
  h.inputs.runtimeFlags = { remoteDiagnostics: false }; pending.resolve(); await request;
  assert.deepEqual(h.events, ["refresh", "inspect", "capture", "fetch"]);
  assert.equal(h.requests[0]!.body.displayName, "Renamed"); assert.equal(h.requests[0]!.body.statusLine, "latest");
  assert.equal(h.requests[0]!.body.reportId, "after"); assert.equal(h.requests[0]!.body.note, "note");
  assert.equal(h.inputs.debugState.sceneDebug.meshCount, 7);
  assert.equal(new Headers(h.requests[0]!.init.headers).get("authorization"), "Bearer refreshed-token");
});

test("a scene removed during refresh is not inspected and null screenshots remain null", async (t) => {
  const h = createDiagnosticsHarness(t); h.inputs.activeSceneBundleRoot = new Object3D();
  h.hooks.refresh = async () => { h.inputs.activeSceneBundleRoot = null; };
  h.hooks.capture = () => null;
  await h.runtime.reportDiagnostics(); assert.deepEqual(h.events, ["refresh", "capture", "fetch"]);
  assert.equal(h.inputs.debugState.sceneDebug.screenshot, null);
});

test("HTTP errors still record the request header but never parse their response body", async (t) => {
  const h = createDiagnosticsHarness(t); h.inputs.debugState.lastReportId = "previous";
  h.hooks.fetch = async () => ({ ok: false, headers: new Headers({ "x-request-id": "header-id" }),
    json() { assert.fail("HTTP error body must not be read"); } } as unknown as Response);
  await h.runtime.reportDiagnostics();
  assert.equal(h.inputs.debugState.lastReportRequestId, "header-id");
  assert.equal(h.inputs.debugState.lastReportId, "previous"); assert.equal(h.context.reportLineEl.hidden, true);
});

for (const body of ["{", "null", "{}", '{"requestId":"","reportId":""}']) {
  test(`empty or malformed success body retains previous IDs: ${body}`, async (t) => {
    const h = createDiagnosticsHarness(t); h.inputs.debugState.lastReportId = "old";
    h.inputs.debugState.lastReportRequestId = "old-request";
    h.hooks.fetch = async () => new Response(body);
    await h.runtime.reportDiagnostics();
    assert.equal(h.inputs.debugState.lastReportId, "old"); assert.equal(h.inputs.debugState.lastReportRequestId, "old-request");
  });
}

test("header is recorded before JSON, whose IDs update the current state and report line", async (t) => {
  const h = createDiagnosticsHarness(t); const json = deferred<{ requestId: string; reportId: string }>();
  h.hooks.fetch = async () => ({ ok: true, headers: new Headers({ "x-request-id": "header" }),
    json() { assert.equal(h.inputs.debugState.lastReportRequestId, "header"); return json.promise; } } as unknown as Response);
  const pending = h.runtime.reportDiagnostics(); await new Promise(resolve => setImmediate(resolve));
  const oldState = h.inputs.debugState; h.inputs.debugState = createDiagnosticState();
  json.resolve({ requestId: "body-request", reportId: "server-report" }); await pending;
  assert.equal(oldState.lastReportRequestId, "header"); assert.equal(oldState.lastReportId, null);
  assert.equal(h.inputs.debugState.lastReportRequestId, "body-request"); assert.equal(h.inputs.debugState.lastReportId, "server-report");
  assert.equal(h.context.reportLineEl.textContent, "Report ID: server-report"); assert.equal(h.context.reportLineEl.hidden, false);
});

for (const phase of ["refresh", "inspect", "capture", "fetch"] as const) {
  test(`${phase} failure propagates unchanged from an explicit report`, async (t) => {
    const h = createDiagnosticsHarness(t); const error = new Error(phase); h.inputs.activeSceneBundleRoot = new Object3D();
    if (phase === "refresh" || phase === "fetch") h.hooks[phase] = async () => { throw error; };
    else h.hooks[phase] = () => { throw error; };
    await assert.rejects(h.runtime.reportDiagnostics(), value => value === error);
    const order = ["refresh", "inspect", "capture", "fetch"];
    assert.deepEqual(h.events, order.slice(0, order.indexOf(phase) + 1));
  });
}

test("concurrent reports are not coalesced and IDs follow response arrival order", async (t) => {
  const h = createDiagnosticsHarness(t); const first = deferred<Response>(); const second = deferred<Response>();
  h.hooks.fetch = () => h.requests.length === 1 ? first.promise : second.promise;
  const one = h.runtime.reportDiagnostics("one"), two = h.runtime.reportDiagnostics("two");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 2);
  second.resolve(new Response('{"reportId":"second"}')); await two; assert.equal(h.inputs.debugState.lastReportId, "second");
  first.resolve(new Response('{"reportId":"first"}')); await one; assert.equal(h.inputs.debugState.lastReportId, "first");
});
test("a terminal identity gate prevents diagnostic refresh and network publication", async (t) => {
  const h = createDiagnosticsHarness(t);
  h.inputs.sessionGate = { reason: "identity_upgrade_required" };
  await h.runtime.reportDiagnostics("blocked");
  h.runtime.reportUnhandledRuntimeError(new Error("private error"), "blocked");
  assert.deepEqual(h.events, []); assert.deepEqual(h.requests, []);
});

test("an identity-upgrade exception is not converted to a generic runtime error report", (t) => {
  const h = createDiagnosticsHarness(t);
  h.runtime.reportUnhandledRuntimeError(new SessionUpgradeError("identity_upgrade_required"), "upgrade");
  assert.deepEqual(h.events, []); assert.deepEqual(h.requests, []);
});

test("identity loss during a pending diagnostic refresh prevents capture and transport", async (t) => {
  const h = createDiagnosticsHarness(t), ready = deferred<void>(), resume = deferred<void>();
  h.hooks.refresh = async () => { ready.resolve(); await resume.promise; };
  const pending = h.runtime.reportDiagnostics("pending"); await ready.promise;
  h.inputs.sessionGate = { reason: "identity_recovery_required" }; resume.resolve(); await pending;
  assert.deepEqual(h.events, ["refresh"]); assert.deepEqual(h.requests, []);
});

test("diagnostic subject follows identity adoption during refresh and matches the refreshed session token", async (t) => {
  const h = createDiagnosticsHarness(t), ready = deferred<void>(), resume = deferred<void>();
  h.hooks.refresh = async () => { ready.resolve(); await resume.promise; };
  const pending = h.runtime.reportDiagnostics("after-admission"); await ready.promise;
  h.inputs.participantId = "server-issued"; h.inputs.roomStateAccessToken = "fresh-session";
  resume.resolve(); await pending;
  assert.equal(h.requests[0]!.body.participantId, "server-issued");
  assert.equal((h.requests[0]!.init.headers as Record<string, string>).authorization, "Bearer fresh-session");
});
