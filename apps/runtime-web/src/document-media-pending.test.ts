import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ImageViewerState, MediaObjectInstance, VideoPlayerState } from "@vrata/shared-types";
import { createDocumentMediaPendingPatch, DOCUMENT_MEDIA_CONFIRMATION_GRACE_MS } from "./document-media-pending.js";
import { createDocumentSurfaceActions } from "./document-surface-actions.js";
import { createDocumentSurfaceView } from "./document-surface-view.js";
import { accepted, createHarness, deferred, makeObject } from "./testing/document-surface-actions-harness.js";
import { createDocumentSurfaceViewHarness } from "./testing/document-surface-view-harness.js";
import type { SurfaceCommandResult } from "./room-state-client.js";

// Real actions and view share one room-state object, the busy flag and the pending request,
// as they do in main.ts. Room-state replaces the object; the command answer arrives separately.
function mediaControls<K extends "video" | "image">(t: TestContext, kind: K) {
  const clock = { nowMs: 10000 };
  t.mock.method(Date, "now", () => clock.nowMs);
  const actionsHarness = createHarness(kind);
  const viewHarness = createDocumentSurfaceViewHarness(t);
  const pending = createDocumentMediaPendingPatch();
  type State = K extends "video" ? VideoPlayerState : ImageViewerState;
  let object = makeObject(kind) as unknown as MediaObjectInstance<State>;
  const deliver = (next: MediaObjectInstance<State>) => {
    object = next;
    if (kind === "video") {
      actionsHarness.state.video = next as unknown as MediaObjectInstance<VideoPlayerState>;
      viewHarness.state.video = next as unknown as MediaObjectInstance<VideoPlayerState>;
    } else {
      actionsHarness.state.image = next as unknown as MediaObjectInstance<ImageViewerState>;
      viewHarness.state.image = next as unknown as MediaObjectInstance<ImageViewerState>;
    }
  };
  deliver(object);
  viewHarness.context.documentMediaPending = pending;
  Object.defineProperty(viewHarness.context, "presentationActionInFlight", { get: () => actionsHarness.context.presentationActionInFlight });
  const view = createDocumentSurfaceView(viewHarness.context);
  actionsHarness.context.documentMediaPending = pending;
  actionsHarness.context.renderDocumentMediaControls = () => view.renderDocumentMediaControls();
  const actions = createDocumentSurfaceActions(actionsHarness.context);
  const command = deferred<SurfaceCommandResult>();
  actionsHarness.hooks.commands.patchVideoPlayerObject = () => command.promise;
  actionsHarness.hooks.commands.patchImageViewerObject = () => command.promise;
  return {
    clock, actions, view, command, ui: viewHarness.context,
    status: actionsHarness.context.documentMediaStatusEl,
    // Room-state publishes the applied patch as the next revision.
    confirm: (state: Partial<State>) => deliver({ ...object, revision: object.revision + 1, state: { ...object.state, ...state } })
  };
}

test("loop click keeps the requested value through an early command answer until room-state confirms it", async (t) => {
  const h = mediaControls(t, "video");
  h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, false);
  assert.equal(h.ui.documentMediaLoopInput.disabled, false);
  h.ui.documentMediaLoopInput.checked = true;
  const click = h.actions.patchCurrentDocumentMedia({ type: "set-loop", loop: true, inputEventId: "loop-1" });
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  assert.equal(h.ui.documentMediaLoopInput.disabled, true);
  h.command.resolve(accepted({ revision: 13 })); await click;
  // Accepted, but room-state has not delivered revision 13 yet: no snap back, controls stay locked.
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  assert.equal(h.ui.documentMediaLoopInput.disabled, true);
  h.clock.nowMs += 250; h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  assert.equal(h.ui.documentMediaPlayButton.disabled, true);
  assert.equal(h.ui.documentMediaSeekInput.disabled, true);
  h.confirm({ loop: true, lastInputEventId: "loop-1" }); h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  assert.equal(h.ui.documentMediaLoopInput.disabled, false);
  assert.equal(h.status.textContent, "initial");
});

test("loop click stays checked when room-state confirms before the command answer", async (t) => {
  const h = mediaControls(t, "video");
  h.ui.documentMediaLoopInput.checked = true;
  const click = h.actions.patchCurrentDocumentMedia({ type: "set-loop", loop: true, inputEventId: "loop-1" });
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  h.confirm({ loop: true, lastInputEventId: "loop-1" }); h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  assert.equal(h.ui.documentMediaLoopInput.disabled, true);
  h.command.resolve(accepted({ revision: 13 })); await click;
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  assert.equal(h.ui.documentMediaLoopInput.disabled, false);
});

for (const failure of ["rejected", "thrown"] as const) {
  test(`${failure} loop request returns to the room-state value and reports the failure`, async (t) => {
    const h = mediaControls(t, "video");
    h.ui.documentMediaLoopInput.checked = true;
    const click = h.actions.patchCurrentDocumentMedia({ type: "set-loop", loop: true, inputEventId: "loop-1" });
    assert.equal(h.ui.documentMediaLoopInput.checked, true);
    if (failure === "thrown") h.command.reject(new Error("surface_command_timeout"));
    else h.command.resolve(accepted({ accepted: false, blockedReason: "missing-permission", revision: 12 }));
    await click;
    assert.equal(h.ui.documentMediaLoopInput.checked, false);
    assert.equal(h.ui.documentMediaLoopInput.disabled, false);
    assert.equal(h.status.textContent, `Media control failed: ${failure === "thrown" ? "surface_command_timeout" : "missing-permission"}`);
  });
}

test("seek shows the requested position while the request is pending", async (t) => {
  const h = mediaControls(t, "video");
  h.ui.documentMediaSeekInput.value = "2500";
  const seek = h.actions.patchCurrentDocumentMedia({ type: "seek", positionMs: 2500, inputEventId: "seek-1" });
  assert.equal(h.ui.documentMediaSeekInput.value, "2500");
  assert.equal(h.ui.documentMediaSeekInput.disabled, true);
  assert.equal(h.ui.documentMediaTimeEl.textContent, "00:03 / 00:06");
  h.command.resolve(accepted({ revision: 13 })); await seek;
  assert.equal(h.ui.documentMediaSeekInput.value, "2500");
  h.confirm({ positionMs: 2500, lastInputEventId: "seek-1" }); h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaSeekInput.value, "2500");
  assert.equal(h.ui.documentMediaSeekInput.disabled, false);
});

test("play shows Pause and a running position while the request is pending", async (t) => {
  const h = mediaControls(t, "video");
  const play = h.actions.toggleDocumentMediaPlayback();
  assert.equal(h.ui.documentMediaPlayButton.textContent, "Pause");
  assert.equal(h.ui.documentMediaPlayButton.disabled, true);
  h.clock.nowMs += 1000; h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaSeekInput.value, "1000");
  h.command.resolve(accepted({ revision: 13 })); await play;
  assert.equal(h.ui.documentMediaPlayButton.textContent, "Pause");
  h.confirm({ playbackState: "playing", anchorServerTimeMs: 10000, lastInputEventId: "media:playback" });
  h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaPlayButton.textContent, "Pause");
  assert.equal(h.ui.documentMediaPlayButton.disabled, false);
});

test("image fit shows the requested mode while the request is pending", async (t) => {
  const h = mediaControls(t, "image");
  const fit = h.actions.toggleDocumentMediaFit();
  assert.equal(h.ui.documentMediaFitButton.textContent, "Contain");
  assert.equal(h.ui.documentMediaFitButton.disabled, true);
  h.command.resolve(accepted({ revision: 13 })); await fit;
  assert.equal(h.ui.documentMediaFitButton.textContent, "Contain");
  h.confirm({ fitMode: "cover" }); h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaFitButton.textContent, "Contain");
  assert.equal(h.ui.documentMediaFitButton.disabled, false);
});

test("a newer room-state revision replaces the requested value", async (t) => {
  const h = mediaControls(t, "video");
  h.ui.documentMediaLoopInput.checked = true;
  const click = h.actions.patchCurrentDocumentMedia({ type: "set-loop", loop: true, inputEventId: "loop-1" });
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  // Another presenter's change wins; this request is then rejected by revision.
  h.confirm({ loop: false, lastInputEventId: "other" }); h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, false);
  h.command.resolve(accepted({ accepted: false, blockedReason: "revision-mismatch", revision: 13 })); await click;
  assert.equal(h.ui.documentMediaLoopInput.checked, false);
  assert.equal(h.status.textContent, "Media control failed: revision-mismatch");
});

test("an accepted request without a room-state update falls back to the room-state value", async (t) => {
  const h = mediaControls(t, "video");
  h.ui.documentMediaLoopInput.checked = true;
  const click = h.actions.patchCurrentDocumentMedia({ type: "set-loop", loop: true, inputEventId: "loop-1" });
  h.command.resolve(accepted({ revision: 13 })); await click;
  h.clock.nowMs += DOCUMENT_MEDIA_CONFIRMATION_GRACE_MS; h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, true);
  h.clock.nowMs += 1; h.view.renderDocumentMediaControls();
  assert.equal(h.ui.documentMediaLoopInput.checked, false);
  assert.equal(h.ui.documentMediaLoopInput.disabled, false);
});
