import assert from "node:assert/strict";
import test from "node:test";
import {
  DISABLED_EXTENSION_CARD_TYPE,
  EXTENSION_TEST_CARD_TYPE,
  MARKDOWN_BOARD_OBJECT_TYPE,
  MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  SURFACE_TEST_CARD_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  type MarkdownBoardPatch,
  type MarkdownBoardState,
  type MediaObjectInstance,
  type RemoteBrowserPatch,
  type RemoteBrowserObjectState,
  type RoomPermission,
  type ScreenShareObjectState,
  type WhiteboardPatch,
  type WhiteboardState
} from "@vrata/shared-types";

import { createMediaObjectTestControls, type MediaObjectTestControls, type MediaObjectTestControlsContext } from "./media-object-test-controls.js";

function object<State>(state: State): MediaObjectInstance<State> {
  return {
    objectId: "object-1", type: MARKDOWN_BOARD_OBJECT_TYPE, roomId: "room-1", surfaceId: "object-surface",
    ownerParticipantId: "owner", state, status: "active", revision: 7, createdAtMs: 1, updatedAtMs: 2
  };
}

function harness() {
  const calls: Array<[string, ...unknown[]]> = [];
  const lookups: Array<[string, ...unknown[]]> = [];
  const state = {
    selected: "selected-1", permissions: ["markdown-board.edit"] as RoomPermission[],
    selectionReads: 0, permissionReads: 0, result: true,
    active: object({}) as MediaObjectInstance | null,
    markdown: object({ notes: [], lastInputEventId: "markdown-event" } as unknown as MarkdownBoardState) as MediaObjectInstance<MarkdownBoardState> | null,
    fallbackMarkdown: null as MediaObjectInstance<MarkdownBoardState> | null,
    whiteboard: object({ lastInputEventId: "whiteboard-event" } as WhiteboardState) as MediaObjectInstance<WhiteboardState> | null,
    screenShare: object({} as ScreenShareObjectState) as MediaObjectInstance<ScreenShareObjectState> | null,
    fallbackScreenShare: null as MediaObjectInstance<ScreenShareObjectState> | null,
    remoteBrowser: object({} as RemoteBrowserObjectState) as MediaObjectInstance<RemoteBrowserObjectState> | null,
    fallbackRemoteBrowser: null as MediaObjectInstance<RemoteBrowserObjectState> | null,
    noteId: "latest-note" as string | null
  };
  const patch = { type: "test-patch" };
  const commands: MediaObjectTestControlsContext["mediaSurfaceCommands"] = {
    createCommandId(kind) { assert.equal(this, commands); calls.push(["id", kind]); return `command:${kind}`; },
    sendCreateObject(...args) { assert.equal(this, commands); calls.push(["create", ...args]); return state.result; },
    sendStopObject(input) { assert.equal(this, commands); calls.push(["stop", input]); return state.result; },
    sendPatchObjectState(kind, input) { assert.equal(this, commands); calls.push(["patch", kind, input]); return state.result; },
    sendMediaAudio(input) { assert.equal(this, commands); calls.push(["audio", input]); return state.result; }
  };
  const markdownRuntime: ReturnType<MediaObjectTestControlsContext["getMarkdownBoardRuntime"]> = {
    createNotePatch(input) { assert.equal(this, markdownRuntime); calls.push(["note", input]); return patch as unknown as MarkdownBoardPatch; },
    createUpdateNotePatch(...args) { assert.equal(this, markdownRuntime); calls.push(["update", ...args]); return patch as unknown as MarkdownBoardPatch; },
    createMoveNotePatch(...args) { assert.equal(this, markdownRuntime); calls.push(["move", ...args]); return patch as unknown as MarkdownBoardPatch; },
    createDeleteNotePatch(...args) { assert.equal(this, markdownRuntime); calls.push(["delete", ...args]); return patch as unknown as MarkdownBoardPatch; }
  };
  const whiteboardRuntime: ReturnType<MediaObjectTestControlsContext["getWhiteboardRuntime"]> = {
    createClearPatch() { assert.equal(this, whiteboardRuntime); calls.push(["clear"]); return patch as unknown as WhiteboardPatch; }
  };
  const remoteRuntime: ReturnType<MediaObjectTestControlsContext["getRemoteBrowserRuntime"]> = {
    createTakeControlPatch() { assert.equal(this, remoteRuntime); calls.push(["take"]); return patch as unknown as RemoteBrowserPatch; },
    createReleaseControlPatch() { assert.equal(this, remoteRuntime); calls.push(["release"]); return patch as unknown as RemoteBrowserPatch; }
  };
  const context: MediaObjectTestControlsContext = {
    participantId: "participant-1", debugSurfaceId: "debug-screen", mediaSurfaceCommands: commands,
    get selectedMediaSurfaceId() { state.selectionReads += 1; return state.selected; },
    get permissions() { state.permissionReads += 1; return state.permissions; },
    activeMediaObjectForSurface(id) { lookups.push(["active", id]); return state.active; },
    activeScreenShareObjectForSurface(id) { lookups.push(["screen", id]); return state.screenShare; },
    findActiveScreenShareObject() { lookups.push(["screen-fallback"]); return state.fallbackScreenShare; },
    activeWhiteboardObjectForSurface(id) { lookups.push(["whiteboard", id]); return state.whiteboard; },
    getWhiteboardRuntime(id) { lookups.push(["whiteboard-runtime", id]); return whiteboardRuntime; },
    activeMarkdownBoardObjectForSurface(id) { lookups.push(["markdown", id]); return state.markdown; },
    findActiveMarkdownBoardObject() { lookups.push(["markdown-fallback"]); return state.fallbackMarkdown; },
    getMarkdownBoardRuntime(id) { lookups.push(["markdown-runtime", id]); return markdownRuntime; },
    latestStickyNoteId(value) { lookups.push(["latest-note", value]); return state.noteId; },
    activeRemoteBrowserObjectForSurface(id) { lookups.push(["remote", id]); return state.remoteBrowser; },
    findActiveRemoteBrowserObject() { lookups.push(["remote-fallback"]); return state.fallbackRemoteBrowser; },
    getRemoteBrowserRuntime(id) { lookups.push(["remote-runtime", id]); return remoteRuntime; }
  };
  return { api: createMediaObjectTestControls(context), state, context, calls, lookups, patch, commands, markdownRuntime };
}

const creationCases = [
  ["createExtensionTestCard", "extension-test-card-create", EXTENSION_TEST_CARD_TYPE],
  ["createMissingCapabilityExtensionObject", "missing-capability-extension-create", MISSING_CAPABILITY_EXTENSION_CARD_TYPE],
  ["createDisabledExtensionObject", "disabled-extension-create", DISABLED_EXTENSION_CARD_TYPE],
  ["createScreenShareObject", "screen-share-create-test", SCREEN_SHARE_OBJECT_TYPE],
  ["createWhiteboardObject", "whiteboard-create-test", WHITEBOARD_OBJECT_TYPE],
  ["createMarkdownBoardObject", "markdown-board-create-test", MARKDOWN_BOARD_OBJECT_TYPE],
  ["createRemoteBrowserObject", "remote-browser-create-test", REMOTE_BROWSER_OBJECT_TYPE]
] as const;

for (const [method, kind, type] of creationCases) {
  test(`${method} uses live default selection, preserves explicit IDs and send results`, () => {
    const h = harness();
    for (const id of [undefined, "explicit", ""]) {
      h.state.selected = "selected-2";
      h.state.result = !h.state.result;
      h.calls.length = 0;
      h.state.selectionReads = 0;
      assert.equal(h.api[method](id), h.state.result);
      assert.deepEqual(h.calls, [["id", kind], ["create", {
        commandId: `command:${kind}`, surfaceId: id ?? "selected-2", objectType: type, probeOnly: false
      }]]);
      assert.equal(h.state.selectionReads, id === undefined ? 1 : 0);
      assert.equal(h.state.permissionReads, 0);
    }
  });
}

test("construction does not query state, allocate runtimes or send commands", () => {
  const h = harness();
  assert.equal(Object.keys(h.api).length, 25);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.lookups, []);
  assert.equal(h.state.selectionReads, 0);
  assert.equal(h.state.permissionReads, 0);
});

test("privileged probe forwards no arguments and preserves a false send result", () => {
  const h = harness(); h.state.result = false;
  assert.equal(h.api.sendPrivilegedSurfaceCreate(), false);
  assert.deepEqual(h.calls, [["create"]]);
});

for (const [method, kind, type] of [
  ["createSurfaceTestCard", "create", SURFACE_TEST_CARD_TYPE],
  ["createUnknownSurfaceObject", "unknown", "unknown-object"]
] as const) {
  test(`${method} keeps the fixed debug surface and bypasses local permission checks`, () => {
    const h = harness(); h.state.permissions = [];
    assert.equal(h.api[method](), true);
    assert.deepEqual(h.calls, [["id", kind], ["create", {
      commandId: `command:${kind}`, surfaceId: "debug-screen", objectType: type, probeOnly: false
    }]]);
    assert.equal(h.state.selectionReads, 0);
    assert.equal(h.state.permissionReads, 0);
  });
}

const noteCases: Array<[keyof Pick<MediaObjectTestControls, "createStickyNote" | "updateStickyNote" | "moveStickyNote" | "deleteStickyNote">, string, [string, ...unknown[]]]> = [
  ["createStickyNote", "create", ["note", { text: "# Sticky note\n- synced", x: 0.12, y: 0.18 }]],
  ["updateStickyNote", "update", ["update", "latest-note", "## Updated\nSafe Markdown"]],
  ["moveStickyNote", "move", ["move", "latest-note", 0.54, 0.42]],
  ["deleteStickyNote", "delete", ["delete", "latest-note"]]
];
for (const [method, kind, expected] of noteCases) {
  test(`${method} forwards the original defaults, revision and patch identity`, () => {
    const h = harness();
    assert.equal(h.api[method](), true);
    assert.deepEqual(h.calls, [expected, ["patch", `markdown-board-${kind}-note-test`, {
      surfaceId: "object-surface", objectId: "object-1", expectedRevision: 7, patch: h.patch
    }]]);
    assert.equal((h.calls[1]![2] as { patch: unknown }).patch, h.patch);
    assert.equal(h.lookups[0]![1], "selected-1");
    assert.equal(h.lookups.some(call => call[0] === "markdown-fallback"), false);
  });
  test(`${method} re-reads permissions and finds the fallback after selection changes`, () => {
    const h = harness();
    h.state.fallbackMarkdown = h.state.markdown; h.state.markdown = null;
    h.state.selected = "other"; h.state.permissions = [];
    assert.equal(h.api[method](), false);
    assert.deepEqual(h.calls, []);
    h.state.permissions = ["markdown-board.edit"];
    h.state.result = false;
    assert.equal(h.api[method](), false);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.lookups.slice(0, 2), [["markdown", "other"], ["markdown-fallback"]]);
    assert.equal(h.state.permissionReads, 2);
  });
  test(`${method} does not create patches or read permissions without an object`, () => {
    const h = harness(); h.state.markdown = null;
    assert.equal(h.api[method](), false);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state.permissionReads, 0);
  });
}

test("note inputs preserve empty strings and zero coordinates rather than replacing them with defaults", () => {
  const h = harness();
  h.api.createStickyNote({ text: "", x: 0, y: 0, surfaceId: "" });
  h.api.updateStickyNote("explicit-note", "", "");
  h.api.moveStickyNote("explicit-note", 0, 0, "");
  h.api.deleteStickyNote("explicit-note", "");
  assert.deepEqual(h.calls.filter(call => call[0] !== "patch"), [
    ["note", { text: "", x: 0, y: 0 }], ["update", "explicit-note", ""],
    ["move", "explicit-note", 0, 0], ["delete", "explicit-note"]
  ]);
  assert.deepEqual(h.lookups.filter(call => call[0] === "markdown"), Array(4).fill(["markdown", ""]));
  assert.equal(h.state.selectionReads, 0);
  assert.equal(h.lookups.some(call => call[0] === "latest-note"), false);
});

for (const method of ["updateStickyNote", "moveStickyNote", "deleteStickyNote"] as const) {
  test(`${method} rejects absent or empty note IDs before checking permissions`, () => {
    const h = harness(); h.state.noteId = null;
    assert.equal(h.api[method](), false);
    assert.equal(h.api[method](""), false);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state.permissionReads, 0);
    assert.equal(h.lookups.filter(call => call[0] === "latest-note").length, 1);
  });
}

for (const [method, action] of [["takeRemoteBrowserControl", "take"], ["releaseRemoteBrowserControl", "release"]] as const) {
  test(`${method} uses the selected object or fallback without adding permission checks`, () => {
    const h = harness(); h.state.permissions = [];
    for (const fallback of [false, true]) {
      if (fallback) { h.state.fallbackRemoteBrowser = h.state.remoteBrowser; h.state.remoteBrowser = null; }
      h.calls.length = 0;
      assert.equal(h.api[method](), true);
      assert.deepEqual(h.calls, [[action], ["patch", `remote-browser-${action}-control-test`, {
        surfaceId: "object-surface", objectId: "object-1", expectedRevision: 7, patch: h.patch
      }]]);
    }
    h.state.fallbackRemoteBrowser = null; h.calls.length = 0;
    assert.equal(h.api[method](), false);
    assert.deepEqual(h.calls, []);
    assert.equal(h.state.permissionReads, 0);
  });
}

test("stop uses the requested surface, not the object's surface, and skips missing objects", () => {
  const h = harness(); h.state.selected = "selected-2";
  assert.equal(h.api.stopActiveSurfaceObject(), true);
  assert.deepEqual(h.calls, [["id", "stop"], ["stop", {
    commandId: "command:stop", surfaceId: "selected-2", objectId: "object-1"
  }]]);
  h.calls.length = 0; h.state.active = null;
  assert.equal(h.api.stopActiveSurfaceObject("explicit"), false);
  assert.deepEqual(h.calls, []);
});

test("stale test-card patch keeps separate live selection reads and call-time timestamp", (t) => {
  const h = harness(); t.mock.method(Date, "now", () => 101);
  h.context.activeMediaObjectForSurface = () => { h.state.selected = "changed-during-lookup"; return h.state.active; };
  const api = createMediaObjectTestControls(h.context);
  assert.equal(api.sendStaleSurfaceTestCardPatch(), true);
  assert.deepEqual(h.calls, [["patch", "stale-patch", {
    surfaceId: "changed-during-lookup", objectId: "object-1", expectedRevision: 8,
    patch: { type: "increment-click-count", inputEventId: "participant-1:stale:101" }
  }]]);
  assert.equal(h.state.selectionReads, 2);
});

test("stale screen-share and markdown patches preserve fallback objects and revision increment", (t) => {
  const h = harness(); t.mock.method(Date, "now", () => 102);
  h.state.fallbackScreenShare = h.state.screenShare; h.state.screenShare = null;
  h.state.fallbackMarkdown = h.state.markdown; h.state.markdown = null;
  assert.equal(h.api.sendStaleScreenSharePatch(), true);
  assert.equal(h.api.sendStaleMarkdownBoardPatch(), true);
  assert.deepEqual(h.calls, [
    ["patch", "stale-screen-share-patch", { surfaceId: "object-surface", objectId: "object-1", expectedRevision: 8,
      patch: { type: "mark-active", mediaTrackSid: "stale:participant-1:102" } }],
    ["note", { text: "# Stale note", x: 0.2, y: 0.2 }],
    ["patch", "stale-markdown-board-patch", { surfaceId: "object-surface", objectId: "object-1", expectedRevision: 8, patch: h.patch }]
  ]);
});

test("stale whiteboard preserves both clock reads and the complete stroke payload", (t) => {
  const h = harness(); let now = 200; t.mock.method(Date, "now", () => ++now);
  assert.equal(h.api.sendStaleWhiteboardPatch(), true);
  assert.deepEqual(h.calls, [["patch", "stale-whiteboard-patch", {
    surfaceId: "object-surface", objectId: "object-1", expectedRevision: 8,
    patch: { type: "append-stroke", inputEventId: "participant-1:stale-whiteboard:201", stroke: {
      strokeId: "participant-1:stale-stroke", participantId: "participant-1", tool: "pen", color: "#111827", width: 2,
      points: [{ u: 0.25, v: 0.25, t: 202 }]
    } }
  }]]);
});

test("duplicate patches reuse the last event ID and current revision", (t) => {
  const h = harness(); t.mock.method(Date, "now", () => 300);
  assert.equal(h.api.sendDuplicateMarkdownBoardPatch(), true);
  assert.equal(h.api.sendDuplicateWhiteboardPatch(), true);
  assert.deepEqual(h.calls, [
    ["patch", "duplicate-markdown-board-patch", { surfaceId: "object-surface", objectId: "object-1", expectedRevision: 7,
      patch: { type: "create-note", inputEventId: "markdown-event", noteId: "participant-1:duplicate-note", text: "Duplicate", x: 0.24, y: 0.24 } }],
    ["patch", "duplicate-whiteboard-patch", { surfaceId: "object-surface", objectId: "object-1", expectedRevision: 7,
      patch: { type: "append-stroke", inputEventId: "whiteboard-event", stroke: {
        strokeId: "participant-1:duplicate-stroke", participantId: "participant-1", tool: "pen", color: "#111827", width: 2,
        points: [{ u: 0.35, v: 0.35, t: 300 }]
      } } }]
  ]);
});

for (const method of ["sendStaleSurfaceTestCardPatch", "sendStaleScreenSharePatch", "sendStaleWhiteboardPatch", "sendStaleMarkdownBoardPatch", "sendDuplicateMarkdownBoardPatch", "sendDuplicateWhiteboardPatch", "clearWhiteboardObject"] as const) {
  test(`${method} is a no-op when no applicable object exists`, () => {
    const h = harness(); h.state.active = h.state.screenShare = h.state.whiteboard = h.state.markdown = null;
    assert.equal(h.api[method](), false);
    assert.deepEqual(h.calls, []);
  });
}

test("duplicate patches reject null and empty event IDs, while markdown still supports fallback", () => {
  const h = harness();
  for (const id of [null, ""]) {
    h.state.markdown!.state.lastInputEventId = id; h.state.whiteboard!.state.lastInputEventId = id;
    assert.equal(h.api.sendDuplicateMarkdownBoardPatch(), false);
    assert.equal(h.api.sendDuplicateWhiteboardPatch(), false);
  }
  assert.deepEqual(h.calls, []);
  h.state.markdown!.state.lastInputEventId = "fallback-event";
  h.state.fallbackMarkdown = h.state.markdown; h.state.markdown = null;
  assert.equal(h.api.sendDuplicateMarkdownBoardPatch(), true);
  assert.equal((h.calls[0]![2] as { patch: { inputEventId: string } }).patch.inputEventId, "fallback-event");
});

test("clear forwards the existing whiteboard patch and send result", () => {
  const h = harness(); h.state.result = false;
  assert.equal(h.api.clearWhiteboardObject(), false);
  assert.deepEqual(h.calls, [["clear"], ["patch", "whiteboard-clear-test", {
    surfaceId: "object-surface", objectId: "object-1", expectedRevision: 7, patch: h.patch
  }]]);
});

test("surface audio uses live default selection and preserves false and explicit empty IDs", () => {
  const h = harness(); h.state.selected = "selected-2";
  assert.equal(h.api.setDebugSurfaceMediaAudioEnabled(false), true);
  h.state.result = false;
  assert.equal(h.api.setDebugSurfaceMediaAudioEnabled(true, ""), false);
  assert.deepEqual(h.calls, [
    ["id", "surface-audio-test"], ["audio", { commandId: "command:surface-audio-test", surfaceId: "selected-2", enabled: false }],
    ["id", "surface-audio-test"], ["audio", { commandId: "command:surface-audio-test", surfaceId: "", enabled: true }]
  ]);
});

test("lookup, patch creation and send exceptions escape unchanged without extra commands", () => {
  const h = harness(); const error = new Error("expected-failure");
  h.context.activeMediaObjectForSurface = () => { throw error; };
  assert.throws(() => createMediaObjectTestControls(h.context).stopActiveSurfaceObject(), value => value === error);
  h.markdownRuntime.createNotePatch = () => { throw error; };
  assert.throws(() => h.api.createStickyNote(), value => value === error);
  h.commands.sendCreateObject = () => { throw error; };
  assert.throws(() => h.api.sendPrivilegedSurfaceCreate(), value => value === error);
  assert.deepEqual(h.calls, []);
});
