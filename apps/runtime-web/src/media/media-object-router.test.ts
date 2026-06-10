import test from "node:test";
import assert from "node:assert/strict";

import {
  EXTENSION_TEST_CARD_TYPE,
  type MediaObjectInstance,
  type SurfaceInputEvent,
  type SurfaceTestCardState
} from "@noah/shared-types";

import { routeMediaObjectSurfaceInput } from "./media-object-router.js";

function createInput(kind: SurfaceInputEvent["kind"] = "click"): SurfaceInputEvent {
  return {
    eventId: "evt-1",
    roomId: "room-1",
    surfaceId: "debug-main",
    objectId: "extension-card-1",
    participantId: "member-1",
    source: "mouse",
    kind,
    uv: { u: 0.5, v: 0.5 },
    pixel: { x: 960, y: 540 },
    clientTimeMs: 1,
    seq: 1
  };
}

function createExtensionTestCard(): MediaObjectInstance<SurfaceTestCardState> {
  return {
    objectId: "extension-card-1",
    type: EXTENSION_TEST_CARD_TYPE,
    roomId: "room-1",
    surfaceId: "debug-main",
    ownerParticipantId: "host-1",
    state: {
      clickCount: 0,
      lastInputEventId: null
    },
    status: "active",
    revision: 0,
    createdAtMs: 0,
    updatedAtMs: 0
  };
}

test("surface input router routes extension test cards through generic test-card behavior", () => {
  let testCardPatchCount = 0;
  const routed = routeMediaObjectSurfaceInput({
    event: createInput(),
    object: createExtensionTestCard(),
    routeWhiteboardInput: () => false,
    routeRemoteBrowserInput: () => false,
    sendTestCardPatch: () => {
      testCardPatchCount += 1;
      return true;
    }
  });

  assert.equal(routed, true);
  assert.equal(testCardPatchCount, 1);
});

test("surface input router ignores non-click extension test-card events", () => {
  const routed = routeMediaObjectSurfaceInput({
    event: createInput("pointer-down"),
    object: createExtensionTestCard(),
    routeWhiteboardInput: () => false,
    routeRemoteBrowserInput: () => false,
    sendTestCardPatch: () => true
  });

  assert.equal(routed, false);
});
