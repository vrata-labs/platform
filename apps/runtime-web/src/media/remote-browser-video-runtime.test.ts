import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { Room, Track } from "livekit-client";
import { REMOTE_BROWSER_OBJECT_TYPE, type MediaObjectInstance, type RemoteBrowserObjectState, type RoomMediaObjectsState } from "@vrata/shared-types";
import { createMediaSurfaceView, DEFAULT_RUNTIME_MEDIA_SURFACES } from "./media-surface-view.js";
import { createRemoteBrowserVideoRuntime, type RemoteBrowserVideoEntry, type RemoteBrowserVideoRuntimeContext } from "./remote-browser-video-runtime.js";

type BrowserObject = MediaObjectInstance<RemoteBrowserObjectState>;
type FrameCallback = (now: number, metadata: { presentedFrames?: number }) => void;
function browser(objectId = "one", surfaceId = "first"): BrowserObject {
  return { objectId, surfaceId, type: REMOTE_BROWSER_OBJECT_TYPE, roomId: "room", ownerParticipantId: "owner",
    status: "active", revision: 1, createdAtMs: 0, updatedAtMs: 0,
    state: { status: "active", surfaceId, mediaTrackSid: "video" } } as BrowserObject;
}
function snapshot(...objects: BrowserObject[]): RoomMediaObjectsState {
  return { objects: Object.fromEntries(objects.map(o => [o.objectId, o])),
    surfaces: Object.fromEntries(objects.map(o => [o.surfaceId, { surfaceId: o.surfaceId, activeObjectId: o.objectId }])) } as RoomMediaObjectsState;
}
function harness() {
  const events: unknown[][] = [];
  const entries = new Map<string, RemoteBrowserVideoEntry>();
  const retained = new Set<THREE.Texture>();
  const surfaces = new Map(["first", "second"].map(surfaceId => [surfaceId,
    createMediaSurfaceView({ ...DEFAULT_RUNTIME_MEDIA_SURFACES[0], surfaceId })]));
  const state: { room: RoomMediaObjectsState | null; livekit: Room | null; active: BrowserObject | null } = {
    room: null, livekit: null, active: null
  };
  const reads = { room: 0, livekit: 0 };
  const runtime = { sync(object: BrowserObject) { assert.equal(this, runtime); events.push(["sync", object]); } };
  const context: RemoteBrowserVideoRuntimeContext = {
    remoteBrowserVideoByObjectId: entries, retainedDisplayTextures: retained, mediaSurfaceViews: surfaces,
    get roomMediaObjects() { reads.room += 1; return state.room; },
    get livekitRoom() { reads.livekit += 1; return state.livekit; },
    getMediaSurfaceView: function (id) { assert.equal(this, undefined); events.push(["view", id]); return surfaces.get(id)!; },
    applySurfaceTexture: function (id, texture) {
      assert.equal(this, undefined); events.push(["apply", id, texture, [...retained]]);
      (surfaces.get(id)!.object.material as THREE.MeshBasicMaterial).map = texture;
    },
    activeRemoteBrowserObjectForSurface: function (id) { assert.equal(this, undefined); events.push(["active", id]); return state.active; },
    getRemoteBrowserRuntime: function (id) { assert.equal(this, undefined); events.push(["runtime", id]); return runtime; },
    reconcileMediaRoomIdleDisconnect: function (room, reason) { assert.equal(this, undefined); events.push(["idle", room, reason]); }
  };
  const controls = createRemoteBrowserVideoRuntime(context);
  function entry(objectId = "one", surfaceId = "first") {
    const frames: FrameCallback[] = [];
    const video = { paused: false, readyState: 4, currentTime: 1.23456, videoWidth: 1280, videoHeight: 720,
      muted: true, autoplay: true, remove() { assert.equal(this, video); events.push(["element.remove", objectId]); },
      requestVideoFrameCallback(callback: FrameCallback) { assert.equal(this, video); frames.push(callback); return frames.length; }
    };
    const attached = [0, 1].map(index => ({ remove() { events.push(["attached.remove", index]); } }));
    const track = { detach() { assert.equal(this, track); events.push(["detach", objectId]); return attached; } };
    const texture = new THREE.Texture(); texture.addEventListener("dispose", () => events.push(["dispose", objectId]));
    const value: RemoteBrowserVideoEntry = { objectId, surfaceId, track: track as unknown as Track,
      element: video as unknown as HTMLVideoElement, texture, trackSid: "video", playError: null,
      frameCount: 0, lastFrameAtMs: 0, presentedFrames: 0 };
    entries.set(objectId, value);
    return { value, video, track, frames };
  }
  return { controls, context, entries, retained, surfaces, state, reads, events, runtime, entry };
}

test("construction has no session reads or effects and preserves callable metadata", () => {
  const h = harness(); assert.deepEqual(h.reads, { room: 0, livekit: 0 }); assert.deepEqual(h.events, []);
  assert.equal(Object.keys(h.controls).length, 8);
  for (const [name, fn] of Object.entries(h.controls)) {
    assert.equal(fn.name, name);
    assert.equal(fn.length, name === "syncRemoteBrowserVideoRuntimeWithObjects" ? 0 : name === "moveRemoteBrowserVideoEntryToSurface" ? 2 : 1);
  }
});

test("lookup observes registry changes, falsy IDs and exact track identity in insertion order", () => {
  const h = harness(); const first = h.entry().value; const second = h.entry("two").value;
  h.entries.set("", first);
  for (const id of [null, undefined, "", "missing"]) assert.equal(h.controls.remoteBrowserVideoEntryForObject(id), null);
  assert.equal(h.controls.remoteBrowserVideoEntryForObject("one"), first);
  assert.equal(h.controls.remoteBrowserVideoEntryForTrack({ ...first.track } as Track), null);
  second.track = first.track; assert.equal(h.controls.remoteBrowserVideoEntryForTrack(first.track), first);
  h.entries.delete("one"); assert.equal(h.controls.remoteBrowserVideoEntryForTrack(first.track), second);
  h.entries.set("one", second); assert.equal(h.controls.remoteBrowserVideoEntryForObject("one"), second);
});

test("video textures retain their element and sRGB color space", () => {
  const h = harness(); const { value } = h.entry();
  const texture = h.controls.createRemoteBrowserVideoTexture(value.element);
  assert.ok(texture instanceof THREE.VideoTexture); assert.equal(texture.image, value.element);
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace); texture.dispose();
});

test("moving to the same surface is an exact no-op", () => {
  const h = harness(); const { value } = h.entry(); h.controls.moveRemoteBrowserVideoEntryToSurface(value, "first");
  assert.deepEqual(h.events, []); assert.equal(value.surfaceId, "first");
});

test("moving the attached texture retains it only while clearing the old surface", () => {
  const h = harness(); const { value } = h.entry();
  (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = value.texture;
  h.controls.moveRemoteBrowserVideoEntryToSurface(value, "second");
  assert.deepEqual(h.events, [["view", "first"], ["apply", "first", null, [value.texture]], ["apply", "second", value.texture, []]]);
  assert.equal(value.surfaceId, "second"); assert.equal(h.retained.size, 0);
});

for (const material of ["different-map", "standard", "array"] as const) {
  test(`moving does not clear a ${material} source material`, () => {
    const h = harness(); const { value } = h.entry();
    (h.surfaces.get("first")!.object as THREE.Mesh).material = material === "standard" ? new THREE.MeshStandardMaterial({ map: value.texture })
      : material === "array" ? [new THREE.MeshBasicMaterial({ map: value.texture })] : new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    h.controls.moveRemoteBrowserVideoEntryToSurface(value, "second");
    assert.deepEqual(h.events, [["view", "first"], ["apply", "second", value.texture, []]]);
  });
}

test("moving preserves the existing removal of an already retained texture", () => {
  const h = harness(); const { value } = h.entry(); h.retained.add(value.texture);
  (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = value.texture;
  h.controls.moveRemoteBrowserVideoEntryToSurface(value, "second"); assert.equal(h.retained.has(value.texture), false);
});

for (const failSurface of ["first", "second"]) {
  test(`a ${failSurface} apply failure preserves exception and partial move state`, () => {
    const h = harness(); const { value } = h.entry(); const error = new Error("apply failed");
    (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = value.texture;
    const apply = h.context.applySurfaceTexture;
    const controls = createRemoteBrowserVideoRuntime({ ...h.context, applySurfaceTexture: (id, texture) => {
      if (id === failSurface) throw error; apply(id, texture);
    } });
    assert.throws(() => controls.moveRemoteBrowserVideoEntryToSurface(value, "second"), e => e === error);
    assert.equal(value.surfaceId, "first"); assert.equal(h.retained.has(value.texture), failSurface === "first");
  });
}

test("detach preserves resource cleanup order, object identity, sync receiver and current room", () => {
  const h = harness(); const { value } = h.entry(); const object = browser(); const room = {} as Room;
  h.state.active = object; h.state.livekit = room;
  h.controls.detachRemoteBrowserVideoEntry(value);
  assert.deepEqual(h.events, [["detach", "one"], ["attached.remove", 0], ["attached.remove", 1], ["element.remove", "one"],
    ["view", "first"], ["dispose", "one"], ["active", "first"], ["runtime", "first"], ["sync", object],
    ["idle", room, "remote_browser_consumer_detached_idle"]]);
  assert.equal(h.entries.size, 0); assert.equal(value.surfaceId, "first"); assert.equal(value.texture.isTexture, true);
});

for (const attached of [false, true]) for (const retained of [false, true]) {
  test(`detach handles attached=${attached} retained=${retained} without double disposal`, () => {
    const h = harness(); const { value } = h.entry();
    if (attached) (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = value.texture;
    if (retained) h.retained.add(value.texture);
    h.controls.detachRemoteBrowserVideoEntry(value);
    assert.equal(h.events.filter(([name]) => name === "dispose").length, !attached && !retained ? 1 : 0);
    assert.equal(h.events.filter(([name]) => name === "apply").length, attached ? 1 : 0);
    assert.equal(h.retained.has(value.texture), retained); assert.equal(h.events.some(([name]) => name === "sync"), false);
    assert.deepEqual(h.events.at(-1), ["idle", null, "remote_browser_consumer_detached_idle"]);
  });
}

test("detach still deletes by object ID even when another entry replaced that ID", () => {
  const h = harness(); const old = h.entry().value; h.entry(); h.controls.detachRemoteBrowserVideoEntry(old);
  assert.equal(h.entries.has("one"), false);
});

test("a track detach failure propagates and does not run later cleanup", () => {
  const h = harness(); const { value, track } = h.entry(); const error = new Error("detach failed");
  track.detach = () => { throw error; };
  assert.throws(() => h.controls.detachRemoteBrowserVideoEntry(value), e => e === error);
  assert.deepEqual(h.events, []); assert.equal(h.entries.get("one"), value);
});

test("a runtime sync failure occurs after removal and prevents idle reconciliation", () => {
  const h = harness(); const { value } = h.entry(); const error = new Error("sync failed"); h.state.active = browser();
  h.runtime.sync = () => { throw error; };
  assert.throws(() => h.controls.detachRemoteBrowserVideoEntry(value), e => e === error);
  assert.equal(h.entries.size, 0); assert.equal(h.reads.livekit, 0); assert.equal(h.events.some(([name]) => name === "idle"), false);
});

test("null room snapshots leave the registry untouched", () => {
  const h = harness(); const { value } = h.entry(); h.controls.syncRemoteBrowserVideoRuntimeWithObjects();
  assert.equal(h.entries.get("one"), value); assert.deepEqual(h.events, []);
});

for (const invalid of ["missing", "wrong-type", "stopped", "failed", "not-current", "missing-view", "wrong-track"] as const) {
  test(`reconciliation detaches a ${invalid} object`, () => {
    const h = harness(); h.entry(); const object = browser(); h.state.room = snapshot(object);
    if (invalid === "missing") delete h.state.room.objects.one;
    if (invalid === "wrong-type") object.type = "other";
    if (invalid === "stopped" || invalid === "failed") object.state.status = invalid;
    if (invalid === "not-current") h.state.room.surfaces.first.activeObjectId = "other";
    if (invalid === "missing-view") h.surfaces.delete("first");
    if (invalid === "wrong-track") object.state.mediaTrackSid = "other";
    // Runtime lookup retains main's fallback semantics when a physical view is absent.
    const controls = createRemoteBrowserVideoRuntime({ ...h.context,
      getMediaSurfaceView: id => h.surfaces.get(id) ?? createMediaSurfaceView(DEFAULT_RUNTIME_MEDIA_SURFACES[0]) });
    controls.syncRemoteBrowserVideoRuntimeWithObjects(); assert.equal(h.entries.size, 0);
    assert.equal(h.events.filter(([name]) => name === "detach").length, 1);
  });
}

for (const status of ["idle", "starting", "loading", "publishing", "active", "stopping"] as const) {
  test(`reconciliation retains current ${status} objects without adding stricter filters`, () => {
    const h = harness(); const { value } = h.entry(); const object = browser("one", "second");
    object.state.status = status; object.status = "stopped";
    h.state.room = snapshot(object); h.state.room.surfaces.second.visible = false;
    h.state.room.surfaces.second.inputEnabled = false;
    for (const sid of [undefined, "", "video"]) {
      object.state.mediaTrackSid = sid; h.controls.syncRemoteBrowserVideoRuntimeWithObjects();
      assert.equal(h.entries.get("one"), value); assert.equal(value.surfaceId, "second");
    }
  });
}

test("captured reconciliation callbacks see replacement snapshots and live map mutations", () => {
  const h = harness(); const { value } = h.entry(); const sync = h.controls.syncRemoteBrowserVideoRuntimeWithObjects;
  h.state.room = snapshot(browser("one", "second")); sync(); assert.equal(value.surfaceId, "second");
  h.state.room = snapshot(); sync(); assert.equal(h.entries.size, 0);
  h.entry("two"); h.state.room = snapshot(browser("two", "second")); sync(); assert.equal(h.entries.get("two")!.surfaceId, "second");
});

test("reconciliation iterates a snapshot of entries but reads the latest room for each entry", () => {
  const h = harness(); h.entry(); const second = h.entry("two").value; h.state.room = snapshot();
  const controls = createRemoteBrowserVideoRuntime({ ...h.context,
    get roomMediaObjects() { return h.state.room; },
    reconcileMediaRoomIdleDisconnect: () => {
      h.entry("late"); h.state.room = snapshot(browser("two", "second"));
    } });
  controls.syncRemoteBrowserVideoRuntimeWithObjects();
  assert.equal(second.surfaceId, "second"); assert.equal(h.entries.has("late"), true);
  assert.equal(h.events.filter(([name]) => name === "detach").length, 1);
});

test("frame diagnostics tolerate unavailable frame callbacks", () => {
  const h = harness(); const { value, video } = h.entry(); Reflect.deleteProperty(video, "requestVideoFrameCallback");
  h.controls.startRemoteBrowserExternalVideoFrameDiagnostics(value); assert.equal(value.frameCount, 0);
});

test("frame diagnostics use current clock, preserve missing counts and reschedule with video receiver", t => {
  const h = harness(); const { value, frames } = h.entry(); t.mock.method(Date, "now", () => 9876);
  h.controls.startRemoteBrowserExternalVideoFrameDiagnostics(value); assert.equal(frames.length, 1);
  frames.shift()!(999, { presentedFrames: 5 }); assert.equal(value.frameCount, 1); assert.equal(value.lastFrameAtMs, 9876);
  assert.equal(value.presentedFrames, 5); assert.equal(frames.length, 1);
  frames.shift()!(1000, {}); assert.equal(value.presentedFrames, 5);
  frames.shift()!(1001, { presentedFrames: 0 }); assert.equal(value.presentedFrames, 0); assert.equal(value.frameCount, 3);
});

for (const replacement of [false, true]) {
  test(`frame callbacks stop after ${replacement ? "replacement" : "removal"} of their exact entry`, () => {
    const h = harness(); const { value, frames } = h.entry(); h.controls.startRemoteBrowserExternalVideoFrameDiagnostics(value);
    if (replacement) h.entry(); else h.entries.delete("one");
    frames.shift()!(0, { presentedFrames: 9 }); assert.equal(value.frameCount, 0); assert.equal(frames.length, 0);
  });
}

test("frame callbacks observe changed IDs and the removal of the scheduling method", () => {
  const h = harness(); const { value, video, frames } = h.entry(); h.controls.startRemoteBrowserExternalVideoFrameDiagnostics(value);
  h.entries.delete(value.objectId); value.objectId = "changed"; h.entries.set(value.objectId, value);
  Reflect.deleteProperty(video, "requestVideoFrameCallback"); frames.shift()!(0, {});
  assert.equal(value.frameCount, 1); assert.equal(frames.length, 0);
});

test("missing entries produce the unchanged complete diagnostic snapshot", () => {
  const h = harness();
  const expected = { externalVideoAttached: false, externalVideoObjectId: null, externalVideoTrackSid: null,
    externalVideoPaused: null, externalVideoReadyState: null, externalVideoCurrentTime: null, externalVideoWidth: 0,
    externalVideoHeight: 0, externalVideoMuted: null, externalVideoAutoplay: null, externalVideoPlayError: null,
    externalVideoFrameCount: 0, externalVideoLastFrameAtMs: 0, externalVideoPresentedFrames: 0 };
  assert.deepEqual(h.controls.createRemoteBrowserExternalVideoDebugSnapshot(null), expected);
  assert.deepEqual(h.controls.createRemoteBrowserExternalVideoDebugSnapshot(browser()), expected);
});

test("diagnostics preserve false, zero, empty strings, three-decimal time and current entry values", () => {
  const h = harness(); const { value, video } = h.entry(); value.trackSid = ""; value.playError = "";
  video.muted = false; video.autoplay = false; video.readyState = 0;
  assert.deepEqual(h.controls.createRemoteBrowserExternalVideoDebugSnapshot(browser()), {
    externalVideoAttached: true, externalVideoObjectId: "one", externalVideoTrackSid: "", externalVideoPaused: false,
    externalVideoReadyState: 0, externalVideoCurrentTime: 1.235, externalVideoWidth: 1280, externalVideoHeight: 720,
    externalVideoMuted: false, externalVideoAutoplay: false, externalVideoPlayError: "", externalVideoFrameCount: 0,
    externalVideoLastFrameAtMs: 0, externalVideoPresentedFrames: 0
  });
  video.currentTime = 2.2222; value.frameCount = 7;
  assert.equal(h.controls.createRemoteBrowserExternalVideoDebugSnapshot(browser()).externalVideoCurrentTime, 2.222);
  assert.equal(h.controls.createRemoteBrowserExternalVideoDebugSnapshot(browser()).externalVideoFrameCount, 7);
});
