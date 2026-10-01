import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { PerspectiveCamera } from "three";
import { resolveClientCompatibility } from "../client-capabilities.js";
import { detectBrowserMediaCapabilities } from "../media-capabilities.js";
import { createRuntimeDebugState } from "../runtime-debug-state.js";
import { createRuntimeDiagnostics, type RuntimeDiagnosticsContext } from "../runtime-diagnostics.js";
import { createXrRendererWiringDebug } from "../xr.js";

export function createDiagnosticState() {
  const media = detectBrowserMediaCapabilities({ isSecureContext: false });
  const support = { available: false, canEnterVr: false };
  return createRuntimeDebugState({
    participantId: "participant", latestMode: "desktop", displayNameFromQuery: null,
    joinMutedPreference: false, activeNotesScope: "shared", notesSaveState: "idle",
    selectedDocumentId: "", debugSurfaceId: "surface", shareMockEnabled: false,
    browserMediaCapabilities: media,
    clientCompatibility: resolveClientCompatibility({
      resolvedJoinMode: "desktop", media, xr: support, enterVrFeatureEnabled: true,
      webGlAvailable: true, webSocketAvailable: true, touchInputAvailable: false
    }),
    spatialAudioQueryEnabled: true, initialLocalPosition: { x: 0, y: 0, z: 6 },
    xrSessionDebug: createXrRendererWiringDebug({
      featureEnabled: true, support, rendererXrEnabled: true, animationLoopConfigured: true, presenting: false
    }),
    botMode: "off", runtimeFlags: { remoteDiagnostics: true as boolean },
    faultConfig: { audio: null, roomState: false, xrUnavailable: false }
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function createDiagnosticsHarness(t: TestContext, debugEnabled = true) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "diagnostics-test" } });
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  const events: string[] = [];
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const hooks: {
    refresh?: () => Promise<void>;
    fetch?: () => Promise<Response>;
    inspect?: RuntimeDiagnosticsContext["inspectSceneObject"];
    capture?: RuntimeDiagnosticsContext["captureCanvasDiagnostics"];
  } = {};
  const screenshot = {
    width: 4, height: 2, centerPixel: { r: 1, g: 2, b: 3, a: 255 },
    averageColor: { r: 4, g: 5, b: 6, a: 255 }, darkPixelRatio: 0.25, pixelSamples: []
  };
  const context: RuntimeDiagnosticsContext = {
    apiBaseUrl: "https://example.invalid/base", roomId: "room", participantId: "participant",
    displayName: "Guest", roomStateAccessToken: "test-token", runtimeFlags: { remoteDiagnostics: true },
    activeSceneBundleRoot: null, debugState: createDiagnosticState(), debugEnabled,
    camera: new PerspectiveCamera(), renderer: { domElement: {} as HTMLCanvasElement },
    reportLineEl: { hidden: true, textContent: "" }, debugPanel: { textContent: "" }, xrDebugPanelEl: { textContent: "" },
    async refreshWebRtcDiagnostics(this: unknown) {
      assert.equal(this, undefined); events.push("refresh"); await hooks.refresh?.();
    },
    inspectSceneObject(this: unknown, input) {
      assert.equal(this, undefined); events.push("inspect");
      assert.equal(input.root, context.activeSceneBundleRoot); assert.equal(input.camera, context.camera);
      assert.equal(input.previous, context.debugState.sceneDebug);
      return hooks.inspect ? hooks.inspect(input) : { ...input.previous, meshCount: 7 };
    },
    captureCanvasDiagnostics(this: unknown, input) {
      assert.equal(this, undefined); events.push("capture");
      assert.deepEqual(input, { canvas: context.renderer.domElement, includeImage: false });
      return hooks.capture ? hooks.capture(input) : screenshot;
    },
    setStatus(this: unknown, message) {
      assert.equal(this, undefined); events.push("status"); context.debugState.statusLine = message;
    }
  };
  // Mutable inputs model main.ts live accessors rather than frozen construction snapshots.
  const inputs = context as { -readonly [K in keyof RuntimeDiagnosticsContext]: RuntimeDiagnosticsContext[K] };
  t.mock.method(globalThis, "fetch", async (url: URL | RequestInfo, init: RequestInit) => {
    events.push("fetch"); requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return hooks.fetch ? hooks.fetch() : new Response("{}", { status: 200 });
  });
  return { context, inputs, events, requests, hooks, screenshot, runtime: createRuntimeDiagnostics(context) };
}
