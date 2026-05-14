import assert from "node:assert/strict";
import test from "node:test";
import type { SurfaceInputEvent } from "@noah/shared-types";

import { remoteBrowserEventPoint } from "./index.js";

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

test("remote browser maps surface UV to browser viewport coordinates", () => {
  const viewport = { width: 1280, height: 720 };

  assert.deepEqual(remoteBrowserEventPoint(surfaceInput({ u: 0, v: 1 }), viewport), { x: 0, y: 0 });
  assert.deepEqual(remoteBrowserEventPoint(surfaceInput({ u: 1, v: 0 }), viewport), { x: 1279, y: 719 });
  assert.deepEqual(remoteBrowserEventPoint(surfaceInput({ u: 0.25, v: 0.75 }), viewport), { x: 320, y: 180 });
});
