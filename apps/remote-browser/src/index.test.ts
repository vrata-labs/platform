import test from "node:test";
import assert from "node:assert/strict";

import {
  createRemoteBrowserCurrentTabCaptureOptions,
  createRemoteBrowserViewportCaptureOptions,
  remoteBrowserChromiumArgs,
  remoteBrowserCurrentTabCaptureButtonId,
  remoteBrowserCaptureTargetTitle,
  remoteBrowserCaptureTitleGuard,
  remoteBrowserEventPoint,
  remoteBrowserInitScript,
  remoteBrowserMouseMoveSteps,
  remoteBrowserScrollDelta,
  remoteBrowserViewportPublisherButtonId,
  remoteBrowserViewportPublisherHtml,
  remoteBrowserViewportPublisherTitle,
  resolveRemoteBrowserFrameBackpressureBytes,
  resolveRemoteBrowserFrameIntervalMs,
  resolveRemoteBrowserMediaFrameIntervalMs,
  resolveRemoteBrowserMediaIceServers,
  shouldCaptureRemoteBrowserFrame,
  shouldPreserveRemoteBrowserMediaOverlays
} from "./index.js";
import type { SurfaceInputEvent } from "@noah/shared-types";

function surfaceInput(uv: { u: number; v: number }): SurfaceInputEvent {
  return {
    eventId: "event-1",
    roomId: "room-1",
    surfaceId: "debug-main",
    participantId: "host-1",
    source: "mouse",
    kind: "click",
    uv,
    pixel: { x: 0, y: 0 },
    clientTimeMs: 1,
    seq: 1
  };
}

function scrollEvent(scrollDelta?: SurfaceInputEvent["scrollDelta"]): SurfaceInputEvent {
  return {
    eventId: "p-1:1",
    roomId: "room-1",
    surfaceId: "debug-main",
    participantId: "p-1",
    source: "mouse",
    kind: "scroll",
    uv: { u: 0.5, v: 0.5 },
    pixel: { x: 640, y: 360 },
    scrollDelta,
    clientTimeMs: 10,
    seq: 1
  };
}

test("remote browser maps surface UV to browser viewport coordinates", () => {
  const viewport = { width: 1280, height: 720 };

  assert.deepEqual(remoteBrowserEventPoint(surfaceInput({ u: 0, v: 1 }), viewport), { x: 0, y: 0 });
  assert.deepEqual(remoteBrowserEventPoint(surfaceInput({ u: 1, v: 0 }), viewport), { x: 1279, y: 719 });
  assert.deepEqual(remoteBrowserEventPoint(surfaceInput({ u: 0.25, v: 0.75 }), viewport), { x: 320, y: 180 });
});

test("remote browser smooths hover pointer movement", () => {
  assert.equal(remoteBrowserMouseMoveSteps("pointer-move"), 8);
  assert.equal(remoteBrowserMouseMoveSteps("click"), 1);
});

test("remote browser viewport publisher page is not the capture target tab", () => {
  const html = remoteBrowserViewportPublisherHtml();

  assert.match(html, new RegExp(`<title>${remoteBrowserViewportPublisherTitle}</title>`));
  assert.match(html, new RegExp(`<button id="${remoteBrowserViewportPublisherButtonId}"`));
  assert.notEqual(remoteBrowserViewportPublisherTitle, remoteBrowserCaptureTargetTitle);
  assert.equal(remoteBrowserViewportPublisherTitle.includes(remoteBrowserCaptureTargetTitle), false);
  assert.equal(html.includes(`<title>${remoteBrowserCaptureTargetTitle}</title>`), false);
});

test("remote browser capture title guard keeps target tab selectable", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const intervals: Array<() => void> = [];
  const cleared: number[] = [];
  const fakeDocument = { title: "Rutube live" };
  const fakeWindow = {
    setInterval: (callback: () => void) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval: (id: number) => {
      cleared.push(id);
    }
  };

  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });

  try {
    remoteBrowserCaptureTitleGuard(remoteBrowserCaptureTargetTitle);
    assert.equal(fakeDocument.title, remoteBrowserCaptureTargetTitle);

    fakeDocument.title = "Rutube changed title";
    intervals[0]?.();
    assert.equal(fakeDocument.title, remoteBrowserCaptureTargetTitle);

    remoteBrowserCaptureTitleGuard(remoteBrowserCaptureTargetTitle);
    assert.deepEqual(cleared, [1]);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      delete (globalThis as Record<string, unknown>).document;
    }
  }
});

test("remote browser viewport capture excludes the publisher tab and requests audio", () => {
  const options = createRemoteBrowserViewportCaptureOptions({ width: 640, height: 360 }) as Record<string, unknown>;
  const video = options.video as { displaySurface?: string; width?: { ideal?: number }; height?: { ideal?: number } };

  assert.equal(video.displaySurface, "browser");
  assert.equal(video.width?.ideal, 640);
  assert.equal(video.height?.ideal, 360);
  assert.equal(options.audio, true);
  assert.equal(options.selfBrowserSurface, "exclude");
  assert.equal(options.surfaceSwitching, "exclude");
  assert.equal(options.systemAudio, "include");
  assert.equal("preferCurrentTab" in options, false);
});

test("remote browser Chromium auto-selects target tab by title instead of self-capturing", () => {
  const args = remoteBrowserChromiumArgs({ width: 640, height: 360 });

  assert.ok(args.includes(`--auto-select-tab-capture-source-by-title=${remoteBrowserCaptureTargetTitle}`));
  assert.equal(args.includes("--auto-accept-this-tab-capture"), false);
  assert.ok(args.includes("--window-size=640,360"));
});

test("remote browser current-tab capture requests this tab with audio", () => {
  const options = createRemoteBrowserCurrentTabCaptureOptions({ width: 640, height: 360 }) as Record<string, unknown>;
  const video = options.video as { displaySurface?: string; width?: { ideal?: number }; height?: { ideal?: number } };

  assert.equal(video.displaySurface, "browser");
  assert.equal(video.width?.ideal, 640);
  assert.equal(video.height?.ideal, 360);
  assert.equal(options.audio, true);
  assert.equal(options.preferCurrentTab, true);
  assert.equal(options.selfBrowserSurface, "include");
  assert.equal(options.surfaceSwitching, "exclude");
  assert.equal(options.systemAudio, "include");
  assert.notEqual(remoteBrowserCurrentTabCaptureButtonId, remoteBrowserViewportPublisherButtonId);
});

test("remoteBrowserScrollDelta preserves desktop wheel direction", () => {
  assert.deepEqual(remoteBrowserScrollDelta(scrollEvent({ x: 0, y: -360 })), { x: 0, y: -360 });
  assert.deepEqual(remoteBrowserScrollDelta(scrollEvent({ x: 24, y: 480 })), { x: 24, y: 480 });
});

test("remoteBrowserScrollDelta keeps legacy scroll events scrolling down", () => {
  assert.deepEqual(remoteBrowserScrollDelta(scrollEvent()), { x: 0, y: 480 });
});

test("remoteBrowserScrollDelta clamps invalid or extreme values", () => {
  assert.deepEqual(remoteBrowserScrollDelta(scrollEvent({ x: Number.NaN, y: 5000 })), { x: 0, y: 1600 });
  assert.deepEqual(remoteBrowserScrollDelta(scrollEvent({ x: -5000, y: -5000 })), { x: -1600, y: -1600 });
});

test("resolveRemoteBrowserFrameIntervalMs defaults to the fastest supported screenshot cadence", () => {
  assert.equal(resolveRemoteBrowserFrameIntervalMs(undefined), 250);
  assert.equal(resolveRemoteBrowserFrameIntervalMs("100"), 250);
  assert.equal(resolveRemoteBrowserFrameIntervalMs("500"), 500);
  assert.equal(resolveRemoteBrowserFrameIntervalMs("not-a-number"), 250);
});

test("remote browser throttles screenshots after media transport connects", () => {
  assert.equal(resolveRemoteBrowserMediaFrameIntervalMs(undefined), 1000);
  assert.equal(resolveRemoteBrowserMediaFrameIntervalMs("250"), 1000);
  assert.equal(resolveRemoteBrowserMediaFrameIntervalMs("1500"), 1500);
  assert.equal(resolveRemoteBrowserFrameBackpressureBytes(undefined), 1000000);
  assert.equal(resolveRemoteBrowserFrameBackpressureBytes("0"), 0);

  assert.equal(shouldCaptureRemoteBrowserFrame({
    frameCaptureInFlight: false,
    writableClientCount: 1,
    mediaClientCount: 0,
    lastFrameAtMs: 9900,
    nowMs: 10000,
    mediaFrameIntervalMs: 1000
  }), true);
  assert.equal(shouldCaptureRemoteBrowserFrame({
    frameCaptureInFlight: false,
    writableClientCount: 1,
    mediaClientCount: 1,
    lastFrameAtMs: 9500,
    nowMs: 10000,
    mediaFrameIntervalMs: 1000
  }), false);
  assert.equal(shouldCaptureRemoteBrowserFrame({
    frameCaptureInFlight: false,
    writableClientCount: 1,
    mediaClientCount: 1,
    lastFrameAtMs: 9000,
    nowMs: 10000,
    mediaFrameIntervalMs: 1000
  }), true);
  assert.equal(shouldCaptureRemoteBrowserFrame({
    frameCaptureInFlight: false,
    writableClientCount: 0,
    mediaClientCount: 1,
    lastFrameAtMs: 9000,
    nowMs: 10000,
    mediaFrameIntervalMs: 1000
  }), false);
  assert.equal(shouldCaptureRemoteBrowserFrame({
    frameCaptureInFlight: false,
    writableClientCount: 1,
    mediaClientCount: 1,
    lastFrameAtMs: 9900,
    nowMs: 10000,
    mediaFrameIntervalMs: 1000,
    force: true
  }), true);
});

test("remote browser marks frames after input as media overlay preserving", () => {
  assert.equal(shouldPreserveRemoteBrowserMediaOverlays({ lastInputAtMs: 0, capturedAtMs: 1000, preserveMs: 3000 }), false);
  assert.equal(shouldPreserveRemoteBrowserMediaOverlays({ lastInputAtMs: 1200, capturedAtMs: 1000, preserveMs: 3000 }), false);
  assert.equal(shouldPreserveRemoteBrowserMediaOverlays({ lastInputAtMs: 1000, capturedAtMs: 3900, preserveMs: 3000 }), true);
  assert.equal(shouldPreserveRemoteBrowserMediaOverlays({ lastInputAtMs: 1000, capturedAtMs: 4101, preserveMs: 3000 }), false);
});

test("resolveRemoteBrowserMediaIceServers parses comma-separated STUN/TURN URLs", () => {
  assert.deepEqual(resolveRemoteBrowserMediaIceServers(undefined), [{ urls: ["stun:stun.l.google.com:19302"] }]);
  assert.deepEqual(resolveRemoteBrowserMediaIceServers(" stun:a.example.test, turn:b.example.test "), [{ urls: ["stun:a.example.test", "turn:b.example.test"] }]);
  assert.deepEqual(resolveRemoteBrowserMediaIceServers(" , "), []);
});

test("remoteBrowserInitScript blocks fullscreen entry but preserves native exit", async () => {
  type Listener = ((event?: Event) => void) | { handleEvent: (event?: Event) => void };
  const listeners = new Map<string, Listener[]>();
  let exitCalls = 0;

  class TestElement {}
  class TestDocument {
    fullscreenElement: unknown = null;
    head = { appendChild: () => undefined };
    documentElement = { appendChild: () => undefined };

    getElementById(): null {
      return null;
    }

    createElement(): { id: string; textContent: string } {
      return { id: "", textContent: "" };
    }

    addEventListener(type: string, listener: Listener): void {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    }

    exitFullscreen(): Promise<void> {
      exitCalls += 1;
      this.fullscreenElement = null;
      return Promise.resolve();
    }
  }
  class TestVideoElement extends TestElement {}

  const document = new TestDocument();
  const nativeExitFullscreen = TestDocument.prototype.exitFullscreen;
  const globalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    globalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const restoreGlobals = () => {
    for (const [key, descriptor] of globalDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<PropertyKey, unknown>)[key];
      }
    }
  };

  installGlobal("Element", TestElement);
  installGlobal("Document", TestDocument);
  installGlobal("HTMLVideoElement", TestVideoElement);
  installGlobal("document", document);

  try {
    remoteBrowserInitScript("");

    assert.equal(TestDocument.prototype.exitFullscreen, nativeExitFullscreen);
    assert.equal(exitCalls, 0);
    assert.equal(await (new TestElement() as TestElement & { requestFullscreen: () => Promise<void> }).requestFullscreen(), undefined);
    assert.equal(exitCalls, 0);

    document.fullscreenElement = new TestElement();
    for (const listener of listeners.get("fullscreenchange") ?? []) {
      if (typeof listener === "function") {
        listener();
      } else {
        listener.handleEvent();
      }
    }
    assert.equal(exitCalls, 1);
    assert.equal(document.fullscreenElement, null);
  } finally {
    restoreGlobals();
  }
});
