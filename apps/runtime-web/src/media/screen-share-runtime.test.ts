import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import type { Room, Track } from "livekit-client";
import { SCREEN_SHARE_OBJECT_TYPE, type MediaObjectInstance, type RoomMediaObjectsState, type ScreenShareObjectState } from "@vrata/shared-types";

import { createMediaSurfaceView, DEFAULT_RUNTIME_MEDIA_SURFACES } from "./media-surface-view.js";
import { createScreenShareRuntime, resolveScreenShareSubscriptionCount, type ScreenShareRuntimeContext, type ScreenShareRuntimeEntry } from "./screen-share-runtime.js";

type ShareObject = MediaObjectInstance<ScreenShareObjectState>;
test("real share metadata cannot claim a subscription before a track is attached", () => {
  const state = share().state;
  assert.equal(resolveScreenShareSubscriptionCount(0, state, "viewer"), 0);
  assert.equal(resolveScreenShareSubscriptionCount(2, state, "viewer"), 2);
  assert.equal(resolveScreenShareSubscriptionCount(0, null, "viewer"), 0);
  const mock = { ...state, mediaTrackSid: "mock-screen-share:owner:stream" };
  assert.equal(resolveScreenShareSubscriptionCount(0, mock, "viewer"), 1);
  assert.equal(resolveScreenShareSubscriptionCount(0, mock, "owner"), 0);
});

function share(objectId = "one", surfaceId = "first"): ShareObject {
  return { objectId, surfaceId, type: SCREEN_SHARE_OBJECT_TYPE, roomId: "room", ownerParticipantId: "owner",
    status: "active", revision: 1, createdAtMs: 0, updatedAtMs: 0,
    state: { status: "active", surfaceId, ownerParticipantId: "owner", mediaTrackSid: "video" } } as ShareObject;
}
function snapshot(...objects: ShareObject[]): RoomMediaObjectsState {
  return { objects: Object.fromEntries(objects.map(object => [object.objectId, object])),
    surfaces: Object.fromEntries(objects.map(object => [object.surfaceId, { surfaceId: object.surfaceId, activeObjectId: object.objectId }])) } as RoomMediaObjectsState;
}
function harness() {
  const events: unknown[][] = [];
  const entries = new Map<string, ScreenShareRuntimeEntry>();
  const retained = new Set<THREE.Texture>();
  const surfaces = new Map(["first", "second"].map(surfaceId => [surfaceId,
    createMediaSurfaceView({ ...DEFAULT_RUNTIME_MEDIA_SURFACES[0], surfaceId })]));
  const state: { room: RoomMediaObjectsState | null; livekit: Room | null } = { room: null, livekit: null };
  const reads = { room: 0, livekit: 0 };
  const debug = { screenShareState: "sharing", screenShare: { remoteSubscribedTrackCount: -1 } };
  const context: ScreenShareRuntimeContext = {
    screenShareRuntimeByObjectId: entries, retainedDisplayTextures: retained, mediaSurfaceViews: surfaces, debugState: debug,
    get roomMediaObjects() { reads.room += 1; return state.room; },
    get livekitRoom() { reads.livekit += 1; return state.livekit; },
    getMediaSurfaceView: function (id) { assert.equal(this, undefined); events.push(["view", id]); return surfaces.get(id)!; },
    applySurfaceTexture: function (id, texture) {
      assert.equal(this, undefined); events.push(["apply", id, texture, [...retained]]);
      (surfaces.get(id)!.object.material as THREE.MeshBasicMaterial).map = texture;
    },
    reconcileMediaRoomIdleDisconnect: function (room, reason) { assert.equal(this, undefined); events.push(["idle", room, reason]); }
  };
  const controls = createScreenShareRuntime(context);
  function entry(objectId = "one", options: Partial<ScreenShareRuntimeEntry> = {}): ScreenShareRuntimeEntry {
    const video = { remove() { assert.equal(this, video); events.push(["element.remove", objectId]); } };
    const track = { detach() {
      assert.equal(this, track); events.push(["detach", objectId]);
      return [0, 1].map(index => ({ remove() { events.push(["attached.remove", index]); } }));
    } };
    const texture = new THREE.Texture();
    texture.addEventListener("dispose", () => events.push(["dispose", objectId]));
    const value: ScreenShareRuntimeEntry = { objectId, surfaceId: "first", ownerParticipantId: "owner", mediaTrackSid: "video",
      remote: true, track: track as unknown as Track, element: video as unknown as HTMLVideoElement,
      texture, stream: null, publishedTracks: [], stopping: false, ...options };
    entries.set(objectId, value);
    return value;
  }
  function mediaTrack(id: string, readyState: MediaStreamTrackState = "live"): MediaStreamTrack {
    const track = { id, readyState, stop() { assert.equal(this, track); events.push(["stop", id]); } };
    return track as unknown as MediaStreamTrack;
  }
  return { controls, context, entries, retained, surfaces, state, reads, debug, events, entry, mediaTrack };
}

test("construction is inert and exposes the existing callable names and arities", () => {
  const h = harness();
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.reads, { room: 0, livekit: 0 });
  const arities = { screenShareEntries: 0, hasLocalScreenSharePublishing: 0, remoteScreenShareTrackCount: 0,
    localScreenShareEntryForSurface: 1, anyLocalScreenShareEntry: 0, screenShareEntryForTrack: 1,
    screenShareEntryForObject: 1, createScreenShareVideoTexture: 1, moveScreenShareEntryToSurface: 2,
    registerScreenShareEntry: 1, detachScreenShareEntry: 1, unpublishScreenShareEntry: 1,
    isActiveScreenShareObject: 1, syncScreenShareRuntimeWithObjects: 0 };
  assert.deepEqual(Object.keys(h.controls), Object.keys(arities));
  for (const [name, arity] of Object.entries(arities)) {
    const fn = h.controls[name as keyof typeof arities];
    assert.equal(fn.name, name); assert.equal(fn.length, arity);
  }
});

test("queries observe the live registry, preserve insertion order, identities and duplicate references", () => {
  const h = harness();
  assert.equal(h.controls.hasLocalScreenSharePublishing(), false);
  assert.equal(h.controls.anyLocalScreenShareEntry(), null);
  const remote = h.entry(); const local = h.entry("local", { remote: false, stopping: true });
  const later = h.entry("later", { remote: false });
  h.entries.set("alias", remote);
  assert.deepEqual(h.controls.screenShareEntries(), [remote, local, later, remote]);
  assert.notEqual(h.controls.screenShareEntries(), h.controls.screenShareEntries());
  assert.equal(h.controls.hasLocalScreenSharePublishing(), true);
  assert.equal(h.controls.anyLocalScreenShareEntry(), local);
  assert.equal(h.controls.localScreenShareEntryForSurface("first"), local);
  assert.equal(h.controls.localScreenShareEntryForSurface("missing"), null);
  assert.equal(h.controls.screenShareEntryForTrack({ ...remote.track } as Track), null);
  local.track = remote.track;
  assert.equal(h.controls.screenShareEntryForTrack(remote.track!), remote);
  h.entries.delete("one");
  assert.equal(h.controls.screenShareEntryForTrack(remote.track!), local);
  for (const id of [undefined, null, "", "missing"]) assert.equal(h.controls.screenShareEntryForObject(id), null);
  h.entries.set("", local); assert.equal(h.controls.screenShareEntryForObject(""), null);
  assert.equal(h.controls.screenShareEntryForObject("local"), local);
  h.entries.set("local", later); assert.equal(h.controls.screenShareEntryForObject("local"), later);
});

for (const remote of [false, true]) for (const hasTrack of [false, true]) for (const hasElement of [false, true]) {
  test(`remote count retains truthiness rules: remote=${remote}, track=${hasTrack}, element=${hasElement}`, () => {
    const h = harness(); const entry = h.entry("one", { remote, stopping: true });
    if (!hasTrack) entry.track = null;
    if (!hasElement) entry.element = null;
    assert.equal(h.controls.remoteScreenShareTrackCount(), remote && (hasTrack || hasElement) ? 1 : 0);
  });
}

test("video texture retains its element and sRGB color space", () => {
  const h = harness(); const entry = h.entry();
  const texture = h.controls.createScreenShareVideoTexture(entry.element!);
  assert.ok(texture instanceof THREE.VideoTexture);
  assert.equal(texture.image, entry.element); assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  texture.dispose();
});

test("same-surface moves do nothing and textureless moves only change the surface ID", () => {
  const h = harness(); const entry = h.entry();
  h.controls.moveScreenShareEntryToSurface(entry, "first"); assert.deepEqual(h.events, []);
  entry.texture = null; h.controls.moveScreenShareEntryToSurface(entry, "second");
  assert.equal(entry.surfaceId, "second"); assert.deepEqual(h.events, []);
});

for (const alreadyRetained of [false, true]) {
  test(`moving an attached texture preserves temporary retention, including pre-retained=${alreadyRetained}`, () => {
    const h = harness(); const entry = h.entry(); const texture = entry.texture!;
    (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = texture;
    if (alreadyRetained) h.retained.add(texture);
    h.controls.moveScreenShareEntryToSurface(entry, "second");
    assert.deepEqual(h.events, [["view", "first"], ["apply", "first", null, [texture]], ["apply", "second", texture, []]]);
    assert.equal(entry.surfaceId, "second"); assert.equal(h.retained.has(texture), false);
  });
}

for (const materialKind of ["other-map", "standard", "array"] as const) {
  test(`moving never clears a ${materialKind} source material`, () => {
    const h = harness(); const entry = h.entry();
    (h.surfaces.get("first")!.object as THREE.Mesh).material = materialKind === "standard" ? new THREE.MeshStandardMaterial({ map: entry.texture })
      : materialKind === "array" ? [new THREE.MeshBasicMaterial({ map: entry.texture })] : new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    h.controls.moveScreenShareEntryToSurface(entry, "second");
    assert.deepEqual(h.events, [["view", "first"], ["apply", "second", entry.texture, []]]);
  });
}

for (const failSurface of ["first", "second"]) {
  test(`a ${failSurface} texture-application failure preserves exception identity and partial move state`, () => {
    const h = harness(); const entry = h.entry(); const error = new Error("apply failed");
    (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = entry.texture;
    const apply = h.context.applySurfaceTexture;
    const controls = createScreenShareRuntime({ ...h.context, applySurfaceTexture: (id, texture) => {
      if (id === failSurface) throw error;
      apply(id, texture);
    } });
    assert.throws(() => controls.moveScreenShareEntryToSurface(entry, "second"), e => e === error);
    assert.equal(entry.surfaceId, "first"); assert.equal(h.retained.has(entry.texture!), failSurface === "first");
  });
}

test("registration replaces a different entry after cleanup but re-registering the same entry only reconciles idle state", () => {
  const h = harness(); const old = h.entry();
  const replacement = { ...old, texture: null, track: null, element: null, stopping: false };
  const room = {} as Room; h.state.livekit = room;
  assert.equal(h.controls.registerScreenShareEntry(replacement), replacement);
  assert.equal(old.stopping, true); assert.equal(h.entries.get("one"), replacement);
  assert.deepEqual(h.events.slice(-2), [["idle", room, "screen_share_consumer_detached_idle"], ["idle", room, "screen_share_consumer_active"]]);
  h.events.length = 0;
  assert.equal(h.controls.registerScreenShareEntry(replacement), replacement);
  assert.deepEqual(h.events, [["idle", room, "screen_share_consumer_active"]]);
});

test("detach preserves cleanup order, receivers, ended-track rules and diagnostic updates", () => {
  const h = harness(); const streamTrack = h.mediaTrack("stream", "ended"); const published = h.mediaTrack("published");
  const stream = { getTracks() { assert.equal(this, stream); h.events.push(["getTracks"]); return [streamTrack]; } };
  const entry = h.entry("one", { stream: stream as unknown as MediaStream, publishedTracks: [published, h.mediaTrack("ended", "ended")] });
  const room = {} as Room; h.state.livekit = room;
  h.controls.detachScreenShareEntry(entry);
  assert.deepEqual(h.events, [["detach", "one"], ["attached.remove", 0], ["attached.remove", 1], ["element.remove", "one"],
    ["view", "first"], ["dispose", "one"], ["getTracks"], ["stop", "stream"], ["stop", "published"],
    ["idle", room, "screen_share_consumer_detached_idle"]]);
  assert.equal(entry.stopping, true);
  for (const key of ["track", "element", "texture", "stream"] as const) assert.equal(entry[key], null);
  assert.deepEqual(entry.publishedTracks, []); assert.equal(h.entries.size, 0);
  assert.equal(h.debug.screenShareState, "idle"); assert.equal(h.debug.screenShare.remoteSubscribedTrackCount, 0);
});

for (const attached of [false, true]) for (const retained of [false, true]) {
  test(`detach clears matching maps or disposes unretained textures: attached=${attached}, retained=${retained}`, () => {
    const h = harness(); const entry = h.entry(); const texture = entry.texture!;
    if (attached) (h.surfaces.get("first")!.object.material as THREE.MeshBasicMaterial).map = texture;
    if (retained) h.retained.add(texture);
    h.controls.detachScreenShareEntry(entry);
    assert.equal(h.events.filter(([event]) => event === "apply").length, attached ? 1 : 0);
    assert.equal(h.events.filter(([event]) => event === "dispose").length, !attached && !retained ? 1 : 0);
    assert.equal(entry.texture, null); assert.equal(h.retained.has(texture), retained);
  });
}

for (const remaining of ["local", "remote", "empty", "stopped"] as const) {
  test(`detach preserves screen-share state for remaining ${remaining}`, () => {
    const h = harness(); const entry = h.entry();
    if (remaining === "local") h.entry("remaining", { remote: false, stopping: true, element: null, track: null });
    if (remaining === "remote") h.entry("remaining", { track: null });
    if (remaining === "empty") h.entry("remaining", { track: null, element: null });
    if (remaining === "stopped") h.debug.screenShareState = "stopped";
    h.controls.detachScreenShareEntry(entry);
    assert.equal(h.debug.screenShareState, remaining === "empty" ? "idle" : remaining === "stopped" ? "stopped" : "sharing");
    assert.equal(h.debug.screenShare.remoteSubscribedTrackCount, remaining === "remote" ? 1 : 0);
  });
}

test("detach tolerates absent resources and still deletes a replacement with the same object ID", () => {
  const h = harness(); const old = h.entry("one", { track: null, element: null, texture: null });
  h.entry(); h.controls.detachScreenShareEntry(old);
  assert.equal(h.entries.size, 0);
  assert.deepEqual(h.events, [["idle", null, "screen_share_consumer_detached_idle"]]);
});

test("a track detach exception stops cleanup without replacing the registered entry", () => {
  const h = harness(); const old = h.entry(); const error = new Error("detach failed");
  old.track = { detach() { throw error; } } as unknown as Track;
  assert.throws(() => h.controls.registerScreenShareEntry({ ...old }), e => e === error);
  assert.equal(old.stopping, true); assert.equal(h.entries.get("one"), old);
  assert.ok(old.texture); assert.ok(old.element); assert.deepEqual(h.events, []);
});

test("a texture disposal exception leaves later cleanup and registry state untouched", () => {
  const h = harness(); const entry = h.entry(); const texture = entry.texture!; const error = new Error("dispose failed");
  texture.addEventListener("dispose", () => { throw error; });
  entry.publishedTracks = [h.mediaTrack("later")];
  assert.throws(() => h.controls.detachScreenShareEntry(entry), e => e === error);
  assert.equal(entry.track, null); assert.equal(entry.element, null); assert.equal(entry.texture, texture);
  assert.equal(entry.publishedTracks.length, 1); assert.equal(h.entries.get("one"), entry);
  assert.equal(h.debug.screenShare.remoteSubscribedTrackCount, -1);
  assert.equal(h.events.some(([event]) => event === "stop" || event === "idle"), false);
});

test("unpublish is inert without a room or supported participant method", async () => {
  const h = harness(); const entry = h.entry(); entry.publishedTracks = [h.mediaTrack("one")];
  for (const room of [null, {} as Room, { localParticipant: {} } as Room]) {
    h.state.livekit = room; await h.controls.unpublishScreenShareEntry(entry);
  }
  assert.deepEqual(h.events, []); assert.equal(entry.stopping, false); assert.equal(entry.publishedTracks.length, 1);
});

test("unpublish observes the current participant, starts every call, waits for all and swallows promise rejections", async () => {
  const h = harness(); const entry = h.entry(); const first = h.mediaTrack("first"); const second = h.mediaTrack("second", "ended");
  entry.publishedTracks = [first, second];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const participant = { unpublishTrack(track: MediaStreamTrack, stop?: boolean) {
    assert.equal(this, participant); h.events.push(["unpublish", track, stop]);
    return track === first ? pending : Promise.reject(new Error("rejected"));
  } };
  h.state.livekit = { localParticipant: participant } as unknown as Room;
  let finished = false;
  const operation = h.controls.unpublishScreenShareEntry(entry).then(() => { finished = true; });
  assert.deepEqual(h.events, [["unpublish", first, true], ["unpublish", second, true]]);
  await Promise.resolve(); assert.equal(finished, false);
  h.state.livekit = null; release(); await operation;
  assert.equal(finished, true); assert.deepEqual(entry.publishedTracks, [first, second]); assert.equal(entry.stopping, false);
});

test("unpublish preserves a synchronous method exception and does not invoke later tracks", async () => {
  const h = harness(); const entry = h.entry(); const error = new Error("synchronous failure"); let calls = 0;
  entry.publishedTracks = [h.mediaTrack("first"), h.mediaTrack("second")];
  h.state.livekit = { localParticipant: { unpublishTrack() { calls += 1; throw error; } } } as unknown as Room;
  await assert.rejects(h.controls.unpublishScreenShareEntry(entry), e => e === error);
  assert.equal(calls, 1); assert.equal(h.entries.get("one"), entry);
});

test("active-object check reads replacement snapshots but does not add outer-status, owner or physical-surface validation", () => {
  const h = harness(); const object = share();
  assert.equal(h.controls.isActiveScreenShareObject(object), false);
  h.state.room = snapshot(object); assert.equal(h.controls.isActiveScreenShareObject(object), true);
  object.status = "stopped"; object.state.ownerParticipantId = "another"; h.surfaces.clear();
  assert.equal(h.controls.isActiveScreenShareObject(object), true);
  object.state.status = "publishing"; assert.equal(h.controls.isActiveScreenShareObject(object), false);
  object.state.status = "active"; h.state.room = snapshot(share("replacement"));
  assert.equal(h.controls.isActiveScreenShareObject(object), false);
  for (const value of [null, undefined]) assert.equal(h.controls.isActiveScreenShareObject(value), false);
});

test("reconciliation with no room is an exact no-op", () => {
  const h = harness(); const entry = h.entry(); h.controls.syncScreenShareRuntimeWithObjects();
  assert.equal(h.entries.get("one"), entry); assert.deepEqual(h.events, []);
});

for (const status of ["idle", "selecting", "publishing", "active", "stopping"] as const) {
  test(`reconciliation retains a current ${status} object with no track SID and ignores outer status`, () => {
    const h = harness(); const entry = h.entry(); const object = share();
    object.status = "stopped"; object.state.status = status; delete object.state.mediaTrackSid;
    object.ownerParticipantId = "new-owner"; h.state.room = snapshot(object);
    h.controls.syncScreenShareRuntimeWithObjects();
    assert.equal(h.entries.get("one"), entry); assert.equal(entry.ownerParticipantId, "new-owner");
    assert.equal(entry.mediaTrackSid, "video"); assert.equal(entry.stopping, false); assert.deepEqual(h.events, []);
  });
}

for (const invalid of ["missing", "stopped", "failed", "wrong-type", "unbound", "missing-view", "wrong-track"] as const) {
  test(`reconciliation detaches ${invalid} objects without a valid fallback`, () => {
    const h = harness(); const entry = h.entry(); const object = share(); h.state.room = snapshot(object);
    if (invalid === "missing") delete h.state.room.objects.one;
    if (invalid === "stopped" || invalid === "failed") object.state.status = invalid;
    if (invalid === "wrong-type") object.type = "other";
    if (invalid === "unbound") h.state.room.surfaces.first!.activeObjectId = null;
    if (invalid === "missing-view") h.surfaces.delete("first");
    if (invalid === "wrong-track") object.state.mediaTrackSid = "other";
    // A missing physical view still uses the existing fallback-view callback during cleanup.
    if (invalid === "missing-view") entry.texture = null;
    h.controls.syncScreenShareRuntimeWithObjects();
    assert.equal(h.entries.size, 0); assert.equal(entry.stopping, true);
  });
}

test("fallback matches owner/track, rekeys the same entry and moves its texture to the new surface", () => {
  const h = harness(); const entry = h.entry(); const texture = entry.texture!; const object = share("replacement", "second");
  object.ownerParticipantId = "outer-owner"; h.state.room = snapshot(object);
  h.controls.syncScreenShareRuntimeWithObjects();
  assert.equal(h.entries.has("one"), false); assert.equal(h.entries.get("replacement"), entry);
  assert.equal(entry.objectId, "replacement"); assert.equal(entry.ownerParticipantId, "outer-owner");
  assert.equal(entry.surfaceId, "second"); assert.equal(entry.texture, texture);
  assert.deepEqual(h.events, [["view", "first"], ["apply", "second", texture, []]]);
});

test("fallback does not accept a different owner or an object without a physical view", () => {
  for (const kind of ["owner", "view"] as const) {
    const h = harness(); const entry = h.entry(); const object = share("replacement", "second");
    if (kind === "owner") object.state.ownerParticipantId = "different";
    else h.surfaces.delete("second");
    h.state.room = snapshot(object); h.controls.syncScreenShareRuntimeWithObjects();
    assert.equal(h.entries.size, 0); assert.equal(entry.stopping, true);
  }
});

test("reconciliation traverses an entry snapshot, not entries inserted by cleanup callbacks", () => {
  const h = harness(); h.entry(); h.state.room = snapshot();
  const controls = createScreenShareRuntime({ ...h.context, reconcileMediaRoomIdleDisconnect: () => { h.entry("inserted"); } });
  controls.syncScreenShareRuntimeWithObjects();
  assert.equal(h.entries.has("one"), false); assert.equal(h.entries.get("inserted")?.stopping, false);
});
