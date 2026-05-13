import test from "node:test";
import assert from "node:assert/strict";

import type { SurfaceInputEvent } from "@noah/shared-types";

import { whiteboardPointFromSurfaceInput } from "./whiteboard-object.js";

function surfaceInput(input: Partial<SurfaceInputEvent>): SurfaceInputEvent {
  return {
    eventId: "event-1",
    roomId: "room-1",
    surfaceId: "debug-main",
    participantId: "participant-1",
    source: "mouse",
    kind: "pointer-down",
    clientTimeMs: 123,
    seq: 1,
    ...input
  };
}

test("whiteboard input maps surface UV into canvas coordinates", () => {
  const point = whiteboardPointFromSurfaceInput(surfaceInput({
    uv: { u: 0.25, v: 0.75 },
    pressure: 0.5
  }));

  assert.deepEqual(point, {
    u: 0.25,
    v: 0.25,
    t: 123,
    pressure: 0.5
  });
});

test("whiteboard input ignores events without a surface hit", () => {
  assert.equal(whiteboardPointFromSurfaceInput(surfaceInput({ uv: undefined })), null);
});
