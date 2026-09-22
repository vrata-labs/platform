import test from "node:test";
import assert from "node:assert/strict";
import {
  SCREEN_SHARE_OBJECT_TYPE, WHITEBOARD_OBJECT_TYPE, MARKDOWN_BOARD_OBJECT_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE, PDF_PRESENTATION_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE,
  type MediaObjectInstance, type MediaSurface, type RoomMediaObjectsState
} from "@vrata/shared-types";
import { createMediaObjectQueries, type MediaObjectQueriesContext } from "./media-object-queries.js";

const kinds = [
  [SCREEN_SHARE_OBJECT_TYPE, "activeScreenShareObjectForSurface", "findActiveScreenShareObject"],
  [WHITEBOARD_OBJECT_TYPE, "activeWhiteboardObjectForSurface", "findActiveWhiteboardObject"],
  [MARKDOWN_BOARD_OBJECT_TYPE, "activeMarkdownBoardObjectForSurface", "findActiveMarkdownBoardObject"],
  [REMOTE_BROWSER_OBJECT_TYPE, "activeRemoteBrowserObjectForSurface", "findActiveRemoteBrowserObject"],
  [PDF_PRESENTATION_OBJECT_TYPE, "activePdfPresentationObjectForSurface", "findActivePdfPresentationObject"],
  [IMAGE_VIEWER_OBJECT_TYPE, "activeImageViewerObjectForSurface", "findActiveImageViewerObject"],
  [VIDEO_PLAYER_OBJECT_TYPE, "activeVideoPlayerObjectForSurface", "findActiveVideoPlayerObject"]
] as const;
const currentKinds = [
  [WHITEBOARD_OBJECT_TYPE, "currentWhiteboardObject"],
  [MARKDOWN_BOARD_OBJECT_TYPE, "currentMarkdownBoardObject"],
  [REMOTE_BROWSER_OBJECT_TYPE, "currentRemoteBrowserObject"],
  [PDF_PRESENTATION_OBJECT_TYPE, "currentPdfPresentationObject"],
  [IMAGE_VIEWER_OBJECT_TYPE, "currentImageViewerObject"],
  [VIDEO_PLAYER_OBJECT_TYPE, "currentVideoPlayerObject"]
] as const;
const listKinds = [
  [WHITEBOARD_OBJECT_TYPE, "activeWhiteboardObjects"],
  [MARKDOWN_BOARD_OBJECT_TYPE, "activeMarkdownBoardObjects"],
  [REMOTE_BROWSER_OBJECT_TYPE, "activeRemoteBrowserObjects"],
  [PDF_PRESENTATION_OBJECT_TYPE, "activePdfPresentationObjects"]
] as const;

function object(type: string, id = "first", surfaceId = id, ownerParticipantId = "local"): MediaObjectInstance {
  return {
    objectId: id, type, roomId: "room", surfaceId, ownerParticipantId,
    status: "active", revision: 1, createdAtMs: 0, updatedAtMs: 0,
    state: { status: "active", ownerParticipantId, surfaceId, strokes: [], notes: [], revision: 1,
      pageCount: 3, currentPage: 1, displayMode: "normal" }
  };
}
function surface(surfaceId: string, activeObjectId: string | null): MediaSurface {
  return { surfaceId, activeObjectId, roomId: "room", widthPx: 1280, heightPx: 720,
    inputEnabled: false, mediaAudioEnabled: false, visible: false, allowedObjectTypes: [], lockedByParticipantId: null };
}
function room(...objects: MediaObjectInstance[]): RoomMediaObjectsState {
  return { objects: Object.fromEntries(objects.map(o => [o.objectId, o])),
    surfaces: Object.fromEntries(objects.map(o => [o.surfaceId, surface(o.surfaceId, o.objectId)])) };
}
function harness(initial: RoomMediaObjectsState | null = null, selected = "missing") {
  let state = initial;
  let selection = selected;
  const physical = new Set(Object.keys(initial?.surfaces ?? {}));
  const reads = { state: 0, selection: 0 };
  const context: MediaObjectQueriesContext = {
    get roomMediaObjects() { reads.state += 1; return state; },
    get selectedMediaSurfaceId() { reads.selection += 1; return selection; },
    participantId: "local", mediaSurfaceViews: physical
  };
  const queries = createMediaObjectQueries(context);
  return { queries, physical, reads, setState(next: RoomMediaObjectsState | null) { state = next; },
    select(next: string) { selection = next; } };
}

test("construction performs no state or selection reads and preserves named callable queries", () => {
  const h = harness();
  assert.deepEqual(h.reads, { state: 0, selection: 0 });
  assert.equal(Object.keys(h.queries).length, 29);
  for (const [name, fn] of Object.entries(h.queries)) {
    assert.equal(fn.name, name);
    assert.equal(fn.length, name.endsWith("ForSurface") || name === "findLocalActiveScreenShareObject" ? 1 : 0);
  }
});

test("empty room returns the original null, undefined and empty-list results", () => {
  const { queries } = harness();
  assert.equal(queries.activeMediaObjectForSurface("none"), null);
  assert.equal(queries.activeMediaObjectIdForSurface("none"), undefined);
  assert.equal(queries.findLocalActiveScreenShareObject(), null);
  assert.equal(queries.findRemoteBrowserObjectNeedingLiveKitRoom(), null);
  assert.equal(queries.findScreenShareObjectNeedingLiveKitRoom(), null);
  for (const [, bySurface, find] of kinds) {
    assert.equal(queries[bySurface]("none"), null);
    assert.equal(queries[find](), null);
  }
  for (const [, current] of currentKinds) assert.equal(queries[current](), null);
  for (const [, list] of listKinds) assert.deepEqual(queries[list](), []);
});

test("generic lookup follows the active ID without adding state, type or physical-view validation", () => {
  const first = object("custom", "first", "different-surface");
  first.status = "failed";
  first.state = null;
  const state = room(first);
  state.surfaces.alias = surface("alias", "first");
  const h = harness(state);
  h.physical.clear();
  assert.equal(h.queries.activeMediaObjectForSurface("alias"), first);
  assert.equal(h.queries.activeMediaObjectIdForSurface("alias"), "first");
  state.surfaces.alias.activeObjectId = "absent";
  assert.equal(h.queries.activeMediaObjectForSurface("alias"), null);
  assert.equal(h.queries.activeMediaObjectIdForSurface("alias"), undefined);
  state.surfaces.alias.activeObjectId = "";
  state.objects[""] = first;
  assert.equal(h.queries.activeMediaObjectForSurface("alias"), null);
});

test("remote real screen shares request transport only while linked to a physical surface", () => {
  const local = object(SCREEN_SHARE_OBJECT_TYPE, "local-share");
  const remote = object(SCREEN_SHARE_OBJECT_TYPE, "remote-share", "screen", "publisher");
  local.state = { ...(local.state as object), mediaTrackSid: "TR_local" };
  remote.state = { ...(remote.state as object), mediaTrackSid: "TR_remote" };
  const state = room(local, remote);
  const h = harness(state);
  const snapshot = structuredClone(state);
  assert.equal(h.queries.findScreenShareObjectNeedingLiveKitRoom(), remote);
  assert.deepEqual(state, snapshot);
  h.physical.delete("screen");
  assert.equal(h.queries.findScreenShareObjectNeedingLiveKitRoom(), null);
  h.physical.add("screen");
  state.surfaces.screen!.activeObjectId = null;
  assert.equal(h.queries.findScreenShareObjectNeedingLiveKitRoom(), null);
  state.surfaces.screen!.activeObjectId = remote.objectId;
  for (const patch of [{ status: "publishing" }, { status: "stopped" }, { mediaTrackSid: null }, { mediaTrackSid: "mock-screen-share:publisher:track" }]) {
    remote.state = { ...(snapshot.objects[remote.objectId]!.state as object), ...patch };
    assert.equal(h.queries.findScreenShareObjectNeedingLiveKitRoom(), null);
  }
  h.setState(null);
  assert.equal(h.queries.findScreenShareObjectNeedingLiveKitRoom(), null);
});

for (const [type, bySurface, find] of kinds) {
  test(`${type}: surface selection uses the existing type/state guard and original reference`, () => {
    const first = object(type);
    const state = room(first);
    const h = harness(state);
    h.physical.clear();
    assert.equal(h.queries[bySurface](first.surfaceId), first);
    first.type = "wrong-type";
    assert.equal(h.queries[bySurface](first.surfaceId), null);
    first.type = type;
    first.state = {};
    assert.equal(h.queries[bySurface](first.surfaceId), null);
    h.physical.add(first.surfaceId);
    // Room-wide fallback intentionally checks linkage/type, not the surface selector's state guard.
    assert.equal(h.queries[find](), first);
  });

  test(`${type}: room search preserves object order, physical filtering and active linkage`, () => {
    const hidden = object(type, "hidden");
    const stale = object(type, "stale");
    const other = object("other", "other");
    const first = object(type, "first");
    const last = object(type, "last");
    const state = room(hidden, stale, other, first, last);
    state.surfaces.stale.activeObjectId = "missing";
    first.status = "stopped";
    first.state = {};
    const h = harness(state);
    h.physical.delete("hidden");
    assert.equal(h.queries[find](), first);
    h.physical.delete("first");
    assert.equal(h.queries[find](), last);
    delete state.surfaces.last;
    assert.equal(h.queries[find](), null);
    h.physical.add("hidden");
    assert.equal(h.queries[find](), hidden);
  });

  test(`${type}: previously captured queries observe replaced room snapshots`, () => {
    const first = object(type);
    const h = harness(room(first));
    const select = h.queries[bySurface];
    const search = h.queries[find];
    const replacement = object(type, "replacement", "first");
    h.setState(room(replacement));
    assert.equal(select("first"), replacement);
    assert.equal(search(), replacement);
    h.setState(null);
    assert.equal(select("first"), null);
    assert.equal(search(), null);
  });
}

for (const [type, current] of currentKinds) {
  test(`${type}: current selection wins, updates live, then falls back to the first physical match`, () => {
    const first = object(type, "first");
    const second = object(type, "second");
    const state = room(first, second);
    const h = harness(state, "second");
    const query = h.queries[current];
    h.physical.delete("second");
    assert.equal(query(), second);
    h.select("first");
    assert.equal(query(), first);
    h.select("missing");
    assert.equal(query(), first);
    h.physical.clear();
    assert.equal(query(), null);
    h.physical.add("second");
    assert.equal(query(), second);
    h.select("second");
    second.state = {};
    assert.equal(query(), second);
  });
}

for (const [type, list] of listKinds) {
  test(`${type}: list preserves logical-surface order, duplicate references and state filtering`, () => {
    const a = object(type, "a");
    const b = object(type, "b");
    const malformed = object(type, "malformed");
    malformed.state = {};
    const state = room(a, b, malformed, object("wrong", "wrong"));
    state.surfaces = { b: state.surfaces.b, a: state.surfaces.a,
      alias: surface("alias", "a"), malformed: state.surfaces.malformed,
      wrong: state.surfaces.wrong, dangling: surface("dangling", "missing") };
    const h = harness(state);
    h.physical.clear();
    const result = h.queries[list]();
    assert.deepEqual(result, [b, a, a]);
    assert.equal(result[0], b);
    assert.equal(result[1], a);
    assert.notEqual(result, h.queries[list]());
    h.setState(room(b));
    assert.deepEqual(h.queries[list](), [b]);
  });
}

test("local screen share uses the outer owner and accepts an omitted or empty surface filter", () => {
  const wrongType = object(WHITEBOARD_OBJECT_TYPE, "wrong-type");
  const foreign = object(SCREEN_SHARE_OBJECT_TYPE, "foreign", "foreign", "other");
  const hidden = object(SCREEN_SHARE_OBJECT_TYPE, "hidden");
  const stale = object(SCREEN_SHARE_OBJECT_TYPE, "stale");
  const first = object(SCREEN_SHARE_OBJECT_TYPE, "first");
  const second = object(SCREEN_SHARE_OBJECT_TYPE, "second");
  first.status = "failed";
  first.state = { ownerParticipantId: "other", status: "stopped" };
  const state = room(wrongType, foreign, hidden, stale, first, second);
  state.surfaces.stale.activeObjectId = null;
  const h = harness(state);
  h.physical.delete("hidden");
  assert.equal(h.queries.findLocalActiveScreenShareObject(), first);
  assert.equal(h.queries.findLocalActiveScreenShareObject(""), first);
  assert.equal(h.queries.findLocalActiveScreenShareObject("second"), second);
  assert.equal(h.queries.findLocalActiveScreenShareObject("missing"), null);
  h.physical.delete("first");
  assert.equal(h.queries.findLocalActiveScreenShareObject(), second);
  h.setState(null);
  assert.equal(h.queries.findLocalActiveScreenShareObject(), null);
});

test("LiveKit lookup preserves real-track requirements, physical filtering and logical-surface order", () => {
  const first = object(REMOTE_BROWSER_OBJECT_TYPE, "first");
  const second = object(REMOTE_BROWSER_OBJECT_TYPE, "second");
  const setTrack = (o: MediaObjectInstance, track: string) => {
    Object.assign(o.state as object, { mediaParticipantId: "browser-participant", mediaTrackSid: track });
  };
  setTrack(first, "real-video");
  setTrack(second, "mock-remote-browser-video:second");
  const state = room(first, second);
  state.surfaces = { second: state.surfaces.second, first: state.surfaces.first };
  const h = harness(state);
  assert.equal(h.queries.findRemoteBrowserObjectNeedingLiveKitRoom(), first);
  Object.assign(second.state as object, { audioTrackSid: "real-audio" });
  assert.equal(h.queries.findRemoteBrowserObjectNeedingLiveKitRoom(), second);
  h.physical.delete("second");
  assert.equal(h.queries.findRemoteBrowserObjectNeedingLiveKitRoom(), first);
  setTrack(first, "mock-remote-browser-video:first");
  assert.equal(h.queries.findRemoteBrowserObjectNeedingLiveKitRoom(), null);
  h.setState(null);
  assert.equal(h.queries.findRemoteBrowserObjectNeedingLiveKitRoom(), null);
});

test("queries are read-only and independent across runtime contexts", () => {
  const first = object(WHITEBOARD_OBJECT_TYPE);
  const state = room(first);
  Object.freeze(first.state);
  Object.freeze(first);
  Object.freeze(state.surfaces.first);
  Object.freeze(state.surfaces);
  Object.freeze(state.objects);
  Object.freeze(state);
  const h = harness(state, "first");
  assert.equal(h.queries.currentWhiteboardObject(), first);
  assert.deepEqual(h.queries.activeWhiteboardObjects(), [first]);
  assert.equal(h.queries.findActiveWhiteboardObject(), first);
  assert.equal(harness().queries.currentWhiteboardObject(), null);
});

test("physical lookup preserves its receiver, exception identity and short-circuit order", () => {
  const wrong = object("wrong", "wrong");
  const first = object(WHITEBOARD_OBJECT_TYPE);
  const calls: string[] = [];
  const failure = new Error("physical lookup failed");
  const physical = { has(id: string) {
    assert.equal(this, physical);
    calls.push(id);
    if (id === "first") throw failure;
    return true;
  } };
  const queries = createMediaObjectQueries({ roomMediaObjects: room(wrong, first),
    selectedMediaSurfaceId: "first", participantId: "local", mediaSurfaceViews: physical });
  assert.equal(queries.currentWhiteboardObject(), first);
  assert.deepEqual(calls, []);
  assert.throws(() => queries.findActiveWhiteboardObject(), error => error === failure);
  assert.deepEqual(calls, ["wrong", "first"]);
});
