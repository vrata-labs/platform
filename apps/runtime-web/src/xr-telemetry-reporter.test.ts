import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { RuntimeFrameContext } from "./input/runtime-frame-context.js";
import { createXrTelemetryReporter, type XrTelemetryContext } from "./xr-telemetry-reporter.js";
import { createDiagnosticState } from "./testing/runtime-diagnostics-harness.js";

function frame(inputSources: XRInputSource[] = []): RuntimeFrameContext {
  // Reporting consumes only this already-sampled field, never a session or XRFrame.
  return { xr: { inputSources } } as unknown as RuntimeFrameContext;
}
function source(handedness = "right", axes: unknown = [], pressed = [false, false], profiles: unknown = ["controller"]): XRInputSource {
  return { handedness, targetRayMode: "tracked-pointer", profiles,
    gamepad: { axes, buttons: pressed.map(value => ({ pressed: value })) } } as unknown as XRInputSource;
}
function harness(t: TestContext, mock = false) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  let now = 0;
  const clock = t.mock.method(performance, "now", () => now);
  const context: { -readonly [K in keyof XrTelemetryContext]: XrTelemetryContext[K] } = {
    apiBaseUrl: "https://example.invalid/base", roomId: "room", participantId: "participant",
    renderer: { xr: { isPresenting: true } }, avatarVrMockEnabled: mock, roomStateAccessToken: "token-1",
    syntheticXrState: null, xrSelectEventCount: 0, debugState: createDiagnosticState(),
    localPoseController: { getYaw() { assert.equal(this, context.localPoseController); return 0.123456; } }
  };
  type Payload = {
    xrRawInputs: Array<{ axes: number[]; profiles: string[] }>;
    xrTurnCandidates: { rightPrimaryX: number; rightSecondaryX: number };
    [key: string]: unknown;
  };
  const requests: Array<{ url: string; init: RequestInit; payload: Payload }> = [];
  const fetchMock = t.mock.method(globalThis, "fetch", (url: URL | RequestInfo, init: RequestInit) => {
    requests.push({ url: String(url), init, payload: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response("{}"));
  });
  return { context, requests, fetchMock, clock, setTime(value: number) { now = value; }, runtime: createXrTelemetryReporter(context) };
}

test("construction and marking are inert with respect to runtime and XR sampling", (t) => {
  const h = harness(t); const runtime = createXrTelemetryReporter({ ...h.context,
    get debugState(): never { throw new Error("early diagnostics read"); },
    get syntheticXrState(): never { throw new Error("early input read"); },
    get roomStateAccessToken(): never { throw new Error("early token read"); },
    get xrSelectEventCount(): never { throw new Error("early event read"); }
  });
  runtime.markXrTelemetry("start");
  assert.deepEqual(Object.keys(runtime), ["markXrTelemetry", "reportXrTelemetry"]);
  assert.equal(h.clock.mock.callCount(), 0); assert.equal(h.requests.length, 0);
});

test("non-XR reporting requires both mock mode and synthetic state, without reading the clock", (t) => {
  for (const mock of [false, true]) {
    const h = harness(t, mock); h.context.renderer.xr.isPresenting = false;
    h.runtime.reportXrTelemetry(frame()); assert.equal(h.clock.mock.callCount(), 0);
    h.context.syntheticXrState = { triggerPressed: true, axes: { turnX: 0, turnY: 0 } };
    h.setTime(16); h.runtime.reportXrTelemetry(frame()); assert.equal(h.requests.length, mock ? 1 : 0);
    t.mock.restoreAll(); t.mock.timers.reset();
  }
});

test("idle reporting keeps the exact 300 ms boundary and supports frames without XR fields", (t) => {
  const h = harness(t); const noXr = {} as RuntimeFrameContext;
  h.setTime(299.999); h.runtime.reportXrTelemetry(noXr); assert.equal(h.requests.length, 0);
  h.setTime(300); h.runtime.reportXrTelemetry(noXr); assert.equal(h.requests.length, 1);
  h.setTime(599.999); h.runtime.reportXrTelemetry(noXr); assert.equal(h.requests.length, 1);
  h.setTime(600); h.runtime.reportXrTelemetry(noXr); assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0]!.payload.xrRawInputs, []);
});

for (const activity of ["axis", "button0", "button1", "ray"] as const) {
  test(`${activity} activity keeps the 16 ms boundary`, (t) => {
    const h = harness(t); h.context.debugState.interactionRay.active = activity === "ray";
    const sample = frame([source("left", activity === "axis" ? [0.011] : [], [activity === "button0", activity === "button1"])]);
    h.setTime(15.999); h.runtime.reportXrTelemetry(sample); assert.equal(h.requests.length, 0);
    h.setTime(16); h.runtime.reportXrTelemetry(sample); assert.equal(h.requests.length, 1);
    h.setTime(31.999); h.runtime.reportXrTelemetry(sample); assert.equal(h.requests.length, 1);
    h.setTime(32); h.runtime.reportXrTelemetry(sample); assert.equal(h.requests.length, 2);
  });
}

test("raw activity uses rounded axes before the existing strict 0.01 threshold", (t) => {
  const h = harness(t); h.setTime(16);
  h.runtime.reportXrTelemetry(frame([source("right", [0.0104, -0.0104])])); assert.equal(h.requests.length, 0);
  h.runtime.reportXrTelemetry(frame([source("right", [-0.0106])])); assert.equal(h.requests.length, 1);
});

test("real input preserves exact transport, payload keys, right-hand precedence and rounding", (t) => {
  const h = harness(t); h.setTime(300); h.context.roomStateAccessToken = "token-2"; h.context.xrSelectEventCount = 4;
  h.context.debugState.xrAxes = { moveX: 0, moveY: 0, turnX: 0.56789, turnY: -0.56789 };
  const inputs = [source("left", [1, 2]), source("right", [0.11111, -0.22222, 0.33333, -0.44444], [true, false])];
  const before = structuredClone(inputs); h.runtime.markXrTelemetry("snap_turn"); h.runtime.markXrTelemetry("ray");
  h.runtime.reportXrTelemetry(frame(inputs)); assert.deepEqual(inputs, before);
  const request = h.requests[0]!; const state = h.context.debugState;
  assert.equal(request.url, "https://example.invalid/api/rooms/room/xr-telemetry/participant");
  assert.equal(request.init.method, "PUT");
  assert.deepEqual(request.init.headers, { "content-type": "application/json", authorization: "Bearer token-2" });
  assert.deepEqual(request.payload, {
    participantId: "participant", roomId: "room", updatedAt: "2023-11-14T22:13:20.000Z",
    kind: "ray", kinds: ["snap_turn", "ray"], statusLine: state.statusLine, currentSeatId: null,
    xrAxes: state.xrAxes, interactionRay: state.interactionRay, xrAvatarDebug: null,
    xrRawInputs: [
      { index: 0, handedness: "left", targetRayMode: "tracked-pointer", profiles: ["controller"], button0Pressed: false, button1Pressed: false, axes: [1, 2] },
      { index: 1, handedness: "right", targetRayMode: "tracked-pointer", profiles: ["controller"], button0Pressed: true, button1Pressed: false, axes: [0.111, -0.222, 0.333, -0.444] }
    ],
    xrTurnCandidates: { rightPrimaryX: 0.111, rightPrimaryY: -0.222, rightSecondaryX: 0.333, rightSecondaryY: -0.444,
      mappedTurnX: 0.568, mappedTurnY: -0.568, snapTurnFired: true, playerYaw: 0.123, selectEventCount: 4 }
  });
});

test("missing right source falls back to the first, and non-array profiles/axes retain original handling", (t) => {
  const h = harness(t); h.setTime(300);
  h.runtime.reportXrTelemetry(frame([source("left", new Float32Array([0.25, 0.5]), [false, false], "not-an-array")]));
  assert.deepEqual(h.requests[0]!.payload.xrRawInputs[0]!.axes, []);
  assert.deepEqual(h.requests[0]!.payload.xrRawInputs[0]!.profiles, []);
  assert.equal(h.requests[0]!.payload.xrTurnCandidates.rightPrimaryX, 0.25);
  assert.equal(h.requests[0]!.payload.xrTurnCandidates.rightSecondaryX, 0);
});

test("synthetic inputs take precedence even during a real session and retain unrounded raw axes", (t) => {
  const h = harness(t, false); h.context.syntheticXrState = { triggerPressed: true, axes: { turnX: 0.123456, turnY: -0.987654 } };
  h.setTime(16); h.runtime.reportXrTelemetry(frame([source("right", [9, 9])]));
  assert.deepEqual(h.requests[0]!.payload.xrRawInputs, [{ index: 0, handedness: "right", targetRayMode: "tracked-pointer",
    profiles: ["synthetic-right"], button0Pressed: true, button1Pressed: false, axes: [0.123456, -0.987654, 0.123456, -0.987654] }]);
  assert.equal(h.requests[0]!.payload.xrTurnCandidates.rightSecondaryX, 0.123);
});

test("marking deduplicates without reordering, resets the throttle and clears kinds after send", (t) => {
  const h = harness(t); h.setTime(300); h.runtime.reportXrTelemetry(frame());
  h.runtime.markXrTelemetry("first"); h.runtime.markXrTelemetry("second"); h.runtime.markXrTelemetry("first");
  h.setTime(301); h.runtime.reportXrTelemetry(frame()); assert.deepEqual(h.requests[1]!.payload.kinds, ["first", "second"]);
  assert.equal(h.requests[1]!.payload.kind, "second");
  h.setTime(601); h.runtime.reportXrTelemetry(frame()); assert.deepEqual(h.requests[2]!.payload.kinds, []);
  assert.equal(h.requests[2]!.payload.kind, null);
});

test("marking does not bypass the initial idle threshold or reset another instance", (t) => {
  const h = harness(t); const other = createXrTelemetryReporter(h.context);
  h.setTime(100); h.runtime.markXrTelemetry("early"); h.runtime.reportXrTelemetry(frame()); assert.equal(h.requests.length, 0);
  h.setTime(300); h.runtime.reportXrTelemetry(frame()); other.reportXrTelemetry(frame()); assert.equal(h.requests.length, 2);
  h.runtime.markXrTelemetry("again"); h.setTime(301); h.runtime.reportXrTelemetry(frame()); other.reportXrTelemetry(frame());
  assert.equal(h.requests.length, 3); assert.deepEqual(h.requests[1]!.payload.kinds, []);
});

test("asynchronous network failure is swallowed and still consumes the queue and throttle", async (t) => {
  const h = harness(t); h.fetchMock.mock.mockImplementation(() => Promise.reject(new Error("offline")));
  h.setTime(300); h.runtime.markXrTelemetry("snap_turn"); h.runtime.reportXrTelemetry(frame());
  await new Promise(resolve => setImmediate(resolve));
  h.setTime(301); h.runtime.reportXrTelemetry(frame()); assert.equal(h.fetchMock.mock.callCount(), 1);
  h.setTime(600); h.runtime.reportXrTelemetry(frame());
  const init = h.fetchMock.mock.calls[1]!.arguments[1] as RequestInit;
  assert.deepEqual(JSON.parse(String(init.body)).kinds, []);
  await new Promise(resolve => setImmediate(resolve));
});

test("synchronous transport exceptions retain queued kinds but still advance the throttle", (t) => {
  const h = harness(t); const error = new Error("sync"); h.fetchMock.mock.mockImplementation(() => { throw error; });
  h.setTime(300); h.runtime.markXrTelemetry("snap_turn");
  assert.throws(() => h.runtime.reportXrTelemetry(frame()), value => value === error);
  h.setTime(301); h.runtime.reportXrTelemetry(frame()); assert.equal(h.fetchMock.mock.callCount(), 1);
  h.setTime(600); assert.throws(() => h.runtime.reportXrTelemetry(frame()), value => value === error);
  const init = h.fetchMock.mock.calls[1]!.arguments[1] as RequestInit;
  assert.deepEqual(JSON.parse(String(init.body)).kinds, ["snap_turn"]);
});

test("reporting uses one pre-sampled input list and only the original live avatar fields", (t) => {
  const h = harness(t); h.context.debugState = createDiagnosticState(); h.setTime(300);
  h.context.debugState.currentSeatId = "seat";
  h.context.debugState.xrAvatarDebug = {
    profile: "dual", playerRoot: { x: 9, y: 8, z: 7, yaw: 6 }, headWorld: { x: 1, y: 2, z: 3 },
    leftGrip: null, leftController: null, leftResolved: null,
    rightGrip: { x: 4, y: 5, z: 6 }, rightController: null, rightResolved: null,
    rightHandWorld: { x: 7, y: 8, z: 9 }, rightControllerWorld: null
  };
  let reads = 0;
  const sample = { xr: {
    get inputSources() { reads++; return []; },
    get frame(): never { throw new Error("must not resample frame"); },
    get session(): never { throw new Error("must not resample session"); }
  } } as unknown as RuntimeFrameContext;
  const before = structuredClone(h.context.debugState);
  h.runtime.reportXrTelemetry(sample); assert.equal(reads, 1); assert.deepEqual(h.context.debugState, before);
  assert.equal(h.requests[0]!.payload.currentSeatId, "seat");
  assert.deepEqual(h.requests[0]!.payload.xrAvatarDebug, {
    profile: "dual", rightGrip: { x: 4, y: 5, z: 6 }, rightController: null,
    rightResolved: null, rightHandWorld: { x: 7, y: 8, z: 9 }, rightControllerWorld: null
  });
});
