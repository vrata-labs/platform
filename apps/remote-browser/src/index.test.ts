import test from "node:test";
import assert from "node:assert/strict";

import { remoteBrowserEventPoint, remoteBrowserScrollDelta, resolveRemoteBrowserFrameIntervalMs } from "./index.js";
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
