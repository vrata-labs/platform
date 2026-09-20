import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Room, Track } from "livekit-client";
import type { RoomMediaObjectsState } from "@vrata/shared-types";
import { createMediaSurfaceAudioRuntime, type MediaSurfaceAudioNode } from "./media-surface-audio-runtime.js";

type Context = Parameters<typeof createMediaSurfaceAudioRuntime>[0];

function replaceGlobal(t: TestContext, name: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function harness(t: TestContext) {
  const events: string[] = [];
  const failures = new Map<string, unknown>();
  const step = (event: string) => {
    events.push(event);
    if (failures.has(event)) throw failures.get(event);
  };
  const nodes = new Map<string, MediaSurfaceAudioNode>();
  const views = new Map<string, unknown>([["screen", {}], ["board", {}]]);
  const state = {
    roomMediaObjects: { surfaces: { screen: {}, board: {} } } as unknown as RoomMediaObjectsState | null,
    livekitRoom: {} as Room | null
  };
  const reconciled: Array<{ room: Room | null; reason: string }> = [];
  const reads = { snapshot: 0, room: 0 };
  let onSync = () => {};
  const body = {
    appendChild(element: unknown) { assert.equal(this, body); step("append"); return element; }
  };
  replaceGlobal(t, "document", { body });
  class Stream {
    constructor(public tracks: MediaStreamTrack[]) { step("stream"); }
  }
  replaceGlobal(t, "MediaStream", Stream);
  const sampleBuffer = new Uint8Array([1, 2, 3]);
  const analyser = {
    disconnect() { assert.equal(this, analyser); step("analyser.disconnect"); }
  } as unknown as AnalyserNode;
  const source = {
    connect(target: AnalyserNode) { assert.equal(this, source); assert.equal(target, analyser); step("source.connect"); },
    disconnect() { assert.equal(this, source); step("source.disconnect"); }
  } as unknown as MediaStreamAudioSourceNode;
  let streamTracks: MediaStreamTrack[] | null = null;
  const audioContext = {
    createMediaStreamSource(stream: Stream) {
      assert.equal(this, audioContext);
      streamTracks = stream.tracks;
      step("source");
      return source;
    }
  } as unknown as AudioContext;
  const context: Context = {
    mediaSurfaceViews: views,
    mediaSurfaceAudioNodes: nodes,
    get roomMediaObjects() { reads.snapshot++; return state.roomMediaObjects; },
    get livekitRoom() { reads.room++; return state.livekitRoom; },
    getTrackNodeId(track, fallback) {
      assert.equal(this, undefined);
      step(`id:${fallback}`);
      const value = track as Track & { sid?: string; mediaStreamTrack?: MediaStreamTrack };
      return value.sid ?? value.mediaStreamTrack?.id ?? fallback;
    },
    ensureAudioContext() { assert.equal(this, undefined); step("context"); return audioContext; },
    createAudioAnalyser(value) { assert.equal(this, undefined); assert.equal(value, audioContext); step("analyser"); return { analyser, sampleBuffer }; },
    resumeAudioContext() { assert.equal(this, undefined); step("resume"); return Promise.resolve(); },
    reconcileMediaRoomIdleDisconnect(room, reason) {
      assert.equal(this, undefined); step(`idle:${reason}`); reconciled.push({ room, reason });
    },
    syncSurfaceAudioControl() { assert.equal(this, undefined); step("sync"); onSync(); }
  };
  const runtime = createMediaSurfaceAudioRuntime(context);
  function track(id: string | undefined = "track-1", withStream = true) {
    const mediaStreamTrack = withStream ? { id: "raw-track" } as MediaStreamTrack : undefined;
    const element = {
      autoplay: false, playsInline: false, style: { display: "initial" },
      play() {
        assert.equal(this, element); step("play");
        return failures.has("play.reject") ? Promise.reject(failures.get("play.reject")) : Promise.resolve();
      },
      remove() { assert.equal(this, element); step("remove"); }
    } as unknown as HTMLMediaElement;
    const result = {
      sid: id, mediaStreamTrack,
      attach() { assert.equal(this, result); step("attach"); return element; },
      detach() { step("track.detach"); return [element]; }
    } as unknown as Track;
    return { value: result, element, mediaStreamTrack };
  }
  return { runtime, context, state, events, failures, nodes, views, reads, reconciled, analyser, source, sampleBuffer,
    track, get streamTracks() { return streamTracks; }, set onSync(value: () => void) { onSync = value; } };
}

const activeReason = "media_surface_audio_consumer_active";
const detachedReason = "media_surface_audio_consumer_detached_idle";
const connectEvents = ["id:screen:screen-share-audio", "attach", "append", "play", "context", "analyser", "stream", "source", "resume", "source.connect", `idle:${activeReason}`, "sync"];
const disconnectEvents = ["remove", "source.disconnect", "analyser.disconnect", "sync", `idle:${detachedReason}`];

test("construction is inert and keeps the original callable API", t => {
  const h = harness(t);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.reads, { snapshot: 0, room: 0 });
  assert.deepEqual(Object.keys(h.runtime), ["connectMediaSurfaceAudioTrack", "disconnectMediaSurfaceAudioTrack", "disconnectMediaSurfaceAudioTrackByTrack"]);
  for (const [name, fn] of Object.entries(h.runtime)) assert.equal(fn.name, name);
  assert.equal(h.runtime.connectMediaSurfaceAudioTrack.length, 2);
  assert.equal(h.runtime.disconnectMediaSurfaceAudioTrack.length, 1);
  assert.equal(h.runtime.disconnectMediaSurfaceAudioTrackByTrack.length, 1);
});

test("missing physical surface returns before reading room state or track identity", t => {
  const h = harness(t);
  h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "missing");
  assert.deepEqual(h.events, []);
  assert.equal(h.reads.snapshot, 0);
});

for (const mode of ["null", "missing"] as const) {
  test(`missing logical surface (${mode}) does not attach a track`, t => {
    const h = harness(t);
    h.state.roomMediaObjects = mode === "null" ? null : { surfaces: {} } as RoomMediaObjectsState;
    h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
    assert.equal(h.reads.snapshot, 1);
    assert.deepEqual(h.events, []);
  });
}

test("captured functions observe replacement snapshots and mutated physical maps", t => {
  const h = harness(t), track = h.track();
  const { connectMediaSurfaceAudioTrack: connect } = h.runtime;
  h.views.delete("screen"); connect(track.value, "screen");
  h.views.set("screen", {}); h.state.roomMediaObjects = null; connect(track.value, "screen");
  assert.equal(h.nodes.size, 0);
  h.state.roomMediaObjects = { surfaces: { screen: {} } } as unknown as RoomMediaObjectsState;
  connect(track.value, "screen");
  assert.equal(h.nodes.get("screen")?.element, track.element);
});

test("connection preserves element playback, graph order, receivers and resource identity", t => {
  const h = harness(t), track = h.track();
  assert.equal(h.runtime.connectMediaSurfaceAudioTrack(track.value, "screen"), undefined);
  assert.deepEqual(h.events, connectEvents);
  assert.equal(track.element.autoplay, true);
  assert.equal((track.element as HTMLVideoElement).playsInline, true);
  assert.equal(track.element.style.display, "none");
  assert.deepEqual(h.nodes.get("screen"), { surfaceId: "screen", element: track.element, source: h.source,
    analyser: h.analyser, sampleBuffer: h.sampleBuffer, trackId: "track-1" });
  assert.deepEqual(h.streamTracks, [track.mediaStreamTrack]);
  assert.equal(h.nodes.get("screen")?.sampleBuffer, h.sampleBuffer);
  assert.deepEqual(h.reconciled, [{ room: h.state.livekitRoom, reason: activeReason }]);
});

test("tracks without a raw stream still play through an element without a WebAudio graph", t => {
  const h = harness(t), track = h.track("element-only", false);
  h.runtime.connectMediaSurfaceAudioTrack(track.value, "screen");
  assert.deepEqual(h.events, ["id:screen:screen-share-audio", "attach", "append", "play", `idle:${activeReason}`, "sync"]);
  const node = h.nodes.get("screen")!;
  assert.equal(node.source, null); assert.equal(node.analyser, null); assert.equal(node.sampleBuffer, null);
});

test("a rejected playback promise is swallowed without suppressing graph registration", async t => {
  const h = harness(t);
  h.failures.set("play.reject", new Error("autoplay denied"));
  h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.nodes.size, 1);
  assert.deepEqual(h.events, connectEvents);
});

test("same track ID keeps the existing node even when supplied through a different track", t => {
  const h = harness(t);
  h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
  const node = h.nodes.get("screen"); h.events.length = 0;
  h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
  assert.equal(h.nodes.get("screen"), node);
  assert.deepEqual(h.events, ["id:screen:screen-share-audio"]);
});

test("replacement disconnects the previous graph before attaching and registering the next", t => {
  const h = harness(t);
  h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen"); h.events.length = 0;
  const next = h.track("next"); h.runtime.connectMediaSurfaceAudioTrack(next.value, "screen");
  assert.deepEqual(h.events, [connectEvents[0], ...disconnectEvents, ...connectEvents.slice(1)]);
  assert.equal(h.nodes.get("screen")?.element, next.element);
});

for (const failure of ["attach", "append", "play", "context", "analyser", "stream", "source", "resume", "source.connect"]) {
  test(`connection failure at ${failure} preserves exception identity and existing partial effects`, t => {
    const h = harness(t), error = { failure };
    h.failures.set(failure, error);
    assert.throws(() => h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen"), thrown => thrown === error);
    assert.deepEqual(h.events, connectEvents.slice(0, connectEvents.indexOf(failure) + 1));
    assert.equal(h.nodes.size, 0);
  });
}

test("idle callback failure leaves the connected node registered and prevents UI sync", t => {
  const h = harness(t), error = new Error("idle");
  h.failures.set(`idle:${activeReason}`, error);
  assert.throws(() => h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen"), thrown => thrown === error);
  assert.equal(h.nodes.size, 1);
  assert.deepEqual(h.events, connectEvents.slice(0, -1));
});

test("UI callback failure leaves a connection registered after idle reconciliation", t => {
  const h = harness(t), error = new Error("sync"); h.failures.set("sync", error);
  assert.throws(() => h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen"), thrown => thrown === error);
  assert.equal(h.nodes.size, 1); assert.equal(h.reconciled.length, 1);
});

test("disconnect of an unknown surface has no side effects", t => {
  const h = harness(t); h.runtime.disconnectMediaSurfaceAudioTrack("missing");
  assert.deepEqual(h.events, []); assert.equal(h.reads.room, 0);
});

test("disconnect preserves cleanup order without detaching or stopping the underlying track", t => {
  const h = harness(t); h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen"); h.events.length = 0;
  h.onSync = () => assert.equal(h.nodes.size, 0);
  assert.equal(h.runtime.disconnectMediaSurfaceAudioTrack("screen"), undefined);
  assert.deepEqual(h.events, disconnectEvents); assert.equal(h.nodes.size, 0);
});

test("disconnect tolerates an element-only node and absent room", t => {
  const h = harness(t); h.runtime.connectMediaSurfaceAudioTrack(h.track("no-stream", false).value, "screen");
  h.events.length = 0; h.state.livekitRoom = null;
  h.runtime.disconnectMediaSurfaceAudioTrack("screen");
  assert.deepEqual(h.events, ["remove", "sync", `idle:${detachedReason}`]);
  assert.equal(h.reconciled.at(-1)?.room, null);
});

for (const failure of ["remove", "source.disconnect", "analyser.disconnect", "sync", `idle:${detachedReason}`]) {
  test(`disconnect failure at ${failure} preserves exception identity and registry timing`, t => {
    const h = harness(t); h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
    const node = h.nodes.get("screen"), error = { failure }; h.events.length = 0; h.failures.set(failure, error);
    assert.throws(() => h.runtime.disconnectMediaSurfaceAudioTrack("screen"), thrown => thrown === error);
    assert.deepEqual(h.events, disconnectEvents.slice(0, disconnectEvents.indexOf(failure) + 1));
    assert.equal(h.nodes.get("screen"), disconnectEvents.indexOf(failure) < 3 ? node : undefined);
  });
}

test("disconnect reads the latest room after the UI callback instead of capturing it at creation", t => {
  const h = harness(t); h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
  const next = {} as Room; h.onSync = () => { h.state.livekitRoom = next; };
  h.runtime.disconnectMediaSurfaceAudioTrack("screen");
  assert.equal(h.reconciled.at(-1)?.room, next);
});

test("disconnect by track removes all matching IDs in map order and leaves unrelated nodes", t => {
  const h = harness(t);
  for (const [surface, id] of [["screen", "same"], ["board", "other"], ["aux", "same"]]) {
    h.views.set(surface!, {}); (h.state.roomMediaObjects!.surfaces as Record<string, unknown>)[surface!] = {};
    h.runtime.connectMediaSurfaceAudioTrack(h.track(id, false).value, surface!);
  }
  const before = h.nodes.get("board"); h.events.length = 0;
  h.runtime.disconnectMediaSurfaceAudioTrackByTrack(h.track("same").value);
  assert.deepEqual([...h.nodes.keys()], ["board"]); assert.equal(h.nodes.get("board"), before);
  assert.deepEqual(h.events, ["id:", "remove", "sync", `idle:${detachedReason}`, "remove", "sync", `idle:${detachedReason}`]);
});

test("an empty track ID disconnects every surface and observes entries inserted during iteration", t => {
  const h = harness(t); h.runtime.connectMediaSurfaceAudioTrack(h.track("first", false).value, "screen");
  const copy = { ...h.nodes.get("screen")!, surfaceId: "board", trackId: "inserted" };
  let inserted = false; h.onSync = () => { if (!inserted) { inserted = true; h.nodes.set("board", copy); } };
  h.events.length = 0; h.runtime.disconnectMediaSurfaceAudioTrackByTrack(h.track("", false).value);
  assert.equal(h.nodes.size, 0);
  assert.deepEqual(h.events, ["id:", "remove", "sync", `idle:${detachedReason}`, "remove", "sync", `idle:${detachedReason}`]);
});

test("an unmatched track ID leaves all resources unchanged", t => {
  const h = harness(t); h.runtime.connectMediaSurfaceAudioTrack(h.track().value, "screen");
  const node = h.nodes.get("screen"); h.events.length = 0;
  h.runtime.disconnectMediaSurfaceAudioTrackByTrack(h.track("absent").value);
  assert.equal(h.nodes.get("screen"), node); assert.deepEqual(h.events, ["id:"]);
});
