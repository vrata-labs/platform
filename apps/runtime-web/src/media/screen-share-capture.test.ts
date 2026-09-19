import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Track, type Room } from "livekit-client";

import { captureAndPublishScreenShareStream, createMockShareStream } from "./screen-share-capture.js";

type Publication = { trackSid?: string; sid?: string };
type PublishOptions = { name?: string; source?: Track.Source | string };

function replaceProperty(t: TestContext, target: object, key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  });
}

function captureHarness(t: TestContext) {
  const events: string[] = [];
  const stopped: string[] = [];
  const track = (id: string, kind: "video" | "audio", readyState = "live") => ({
    id, kind, readyState,
    stop() { stopped.push(id); events.push(`stop:${id}`); }
  }) as unknown as MediaStreamTrack;
  const video = track("video-1", "video");
  const audio = track("audio-1", "audio");
  const videoTracks = [track("ended-video", "video", "ended"), video, track("video-2", "video")];
  const audioTracks = [track("ended-audio", "audio", "ended"), audio, track("audio-2", "audio")];
  const stream = {
    getVideoTracks() { events.push("video-tracks"); return videoTracks; },
    getAudioTracks() { events.push("audio-tracks"); return audioTracks; },
    getTracks() { events.push("all-tracks"); return [...videoTracks, ...audioTracks]; }
  } as unknown as MediaStream;
  const captures: DisplayMediaStreamOptions[] = [];
  const mediaDevices = {
    async getDisplayMedia(options: DisplayMediaStreamOptions) {
      assert.equal(this, mediaDevices);
      events.push("capture");
      captures.push(options);
      return stream;
    }
  };
  replaceProperty(t, globalThis, "navigator", { mediaDevices });
  const publications: Array<{ track: MediaStreamTrack; options: PublishOptions | undefined }> = [];
  const behavior = {
    publish: async (value: MediaStreamTrack): Promise<Publication> => ({ trackSid: `published-${value.id}` })
  };
  const localParticipant = {
    async publishTrack(value: MediaStreamTrack, options?: PublishOptions): Promise<Publication> {
      assert.equal(this, localParticipant);
      events.push(`publish:${value.id}`);
      publications.push({ track: value, options });
      return behavior.publish(value);
    }
  };
  const room = { localParticipant } as unknown as Room;
  return {
    events, stopped, track, video, audio, videoTracks, audioTracks, stream,
    captures, mediaDevices, publications, behavior, room,
    capture: (mediaAudioEnabled = false, objectId = "screen-1") =>
      captureAndPublishScreenShareStream(room, { mediaAudioEnabled, objectId })
  };
}

for (const navigatorValue of [{}, { mediaDevices: {} }]) {
  test(`capture rejects unsupported browser: ${JSON.stringify(navigatorValue)}`, async (t) => {
    const h = captureHarness(t);
    Object.assign(globalThis, { navigator: navigatorValue });
    await assert.rejects(h.capture(), {
      name: "NotSupportedError", message: "screen_share_unsupported:getDisplayMedia missing"
    });
    assert.deepEqual(h.events, []);
  });
}

test("capture preserves getDisplayMedia rejection and does not publish", async (t) => {
  const h = captureHarness(t);
  const error = new Error("permission denied");
  t.mock.method(h.mediaDevices, "getDisplayMedia", async () => { throw error; });
  await assert.rejects(h.capture(), (actual) => actual === error);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.publications, []);
});

for (const empty of [true, false]) {
  test(`missing live video stops every acquired track in order: empty=${empty}`, async (t) => {
    const h = captureHarness(t);
    h.videoTracks.splice(0, h.videoTracks.length, ...(empty ? [] : [h.track("ended", "video", "ended")]));
    await assert.rejects(h.capture(true), { name: "NotFoundError", message: "screen_share_video_track_missing" });
    assert.deepEqual(h.stopped, [...h.videoTracks, ...h.audioTracks].map((track) => track.id));
    assert.deepEqual(h.publications, []);
    assert.ok(!h.events.includes("audio-tracks"));
  });
}

test("video-only capture publishes the first live video with the original options and identities", async (t) => {
  const h = captureHarness(t);
  const result = await h.capture(false, "object:with/slash");
  assert.deepEqual(h.captures, [{ video: true, audio: false }]);
  assert.equal(result.stream, h.stream);
  assert.equal(result.publishedTracks[0], h.video);
  assert.deepEqual(result.publishedTracks, [h.video]);
  assert.equal(result.mediaTrackSid, "published-video-1");
  assert.deepEqual(h.publications, [{
    track: h.video, options: { name: "screen-share:object:with/slash:video", source: Track.Source.ScreenShare }
  }]);
  // The existing implementation enumerates audio even when publication is disabled.
  assert.deepEqual(h.events, ["capture", "video-tracks", "publish:video-1", "audio-tracks"]);
  assert.deepEqual(h.stopped, []);
});

test("audio-enabled capture publishes the first live audio after video", async (t) => {
  const h = captureHarness(t);
  const result = await h.capture(true);
  assert.deepEqual(h.captures, [{ video: true, audio: true }]);
  assert.deepEqual(result.publishedTracks, [h.video, h.audio]);
  assert.equal(result.mediaTrackSid, "published-video-1");
  assert.deepEqual(h.publications, [
    { track: h.video, options: { name: "screen-share:screen-1:video", source: Track.Source.ScreenShare } },
    { track: h.audio, options: { name: "screen-share:screen-1:audio", source: Track.Source.ScreenShareAudio } }
  ]);
  assert.deepEqual(h.stopped, []);
});

test("audio-enabled capture succeeds without live audio", async (t) => {
  const h = captureHarness(t);
  h.audioTracks.splice(0, h.audioTracks.length, h.track("ended", "audio", "ended"));
  const result = await h.capture(true);
  assert.deepEqual(result.publishedTracks, [h.video]);
  assert.equal(h.publications.length, 1);
  assert.deepEqual(h.stopped, []);
});

test("capture awaits video publication before enumerating or publishing audio", async (t) => {
  const h = captureHarness(t);
  let resolveVideo!: (value: Publication) => void;
  let videoStarted!: () => void;
  const started = new Promise<void>((resolve) => { videoStarted = resolve; });
  const pendingVideo = new Promise<Publication>((resolve) => { resolveVideo = resolve; });
  h.behavior.publish = (track) => {
    if (track === h.video) { videoStarted(); return pendingVideo; }
    return Promise.resolve({ trackSid: "audio-sid" });
  };
  const pending = h.capture(true);
  await started;
  assert.deepEqual(h.events, ["capture", "video-tracks", "publish:video-1"]);
  resolveVideo({ trackSid: "video-sid" });
  const result = await pending;
  assert.equal(result.mediaTrackSid, "video-sid");
  assert.deepEqual(h.events, ["capture", "video-tracks", "publish:video-1", "audio-tracks", "publish:audio-1"]);
});

const identifiers: Array<{ publication: Publication; expected: string }> = [
  { publication: { trackSid: "primary", sid: "secondary" }, expected: "primary" },
  { publication: { sid: "secondary" }, expected: "secondary" },
  { publication: {}, expected: "video-1" },
  { publication: { trackSid: "", sid: "secondary" }, expected: "" },
  { publication: { sid: "" }, expected: "" },
  { publication: { trackSid: null, sid: "secondary" } as unknown as Publication, expected: "secondary" }
];
for (const { publication, expected } of identifiers) {
  test(`video publication identifier uses nullish precedence: ${JSON.stringify(publication)}`, async (t) => {
    const h = captureHarness(t);
    h.behavior.publish = async () => publication;
    assert.equal((await h.capture()).mediaTrackSid, expected);
  });
}

for (const kind of ["video", "audio"] as const) {
  test(`${kind} publication failure stops all tracks and rethrows the same error`, async (t) => {
    const h = captureHarness(t);
    const error = new Error(`${kind} failed`);
    h.behavior.publish = async (track) => {
      if (track.kind === kind) throw error;
      return { trackSid: "video-sid" };
    };
    await assert.rejects(h.capture(true), (actual) => actual === error);
    assert.deepEqual(h.stopped, [...h.videoTracks, ...h.audioTracks].map((track) => track.id));
    assert.equal(h.publications.length, kind === "video" ? 1 : 2);
    assert.equal(h.events.includes("audio-tracks"), kind === "audio");
  });
}

for (const method of ["getVideoTracks", "getAudioTracks"] as const) {
  test(`${method} failure retains the original cleanup boundary`, async (t) => {
    const h = captureHarness(t);
    const error = new Error("enumeration failed");
    t.mock.method(h.stream, method, () => { throw error; });
    await assert.rejects(h.capture(), (actual) => actual === error);
    assert.deepEqual(h.stopped, method === "getAudioTracks"
      ? [...h.videoTracks, ...h.audioTracks].map((track) => track.id) : []);
  });
}

test("a stop exception interrupts cleanup and remains the rejection reason", async (t) => {
  const h = captureHarness(t);
  const stopError = new Error("stop failed");
  h.behavior.publish = async () => { throw new Error("publish failed"); };
  t.mock.method(h.videoTracks[0]!, "stop", () => { throw stopError; });
  await assert.rejects(h.capture(), (actual) => actual === stopError);
  assert.deepEqual(h.stopped, []);
  assert.equal(h.publications.length, 1);
});

for (const source of [undefined, ""] as const) {
  test(`audio publication preserves nullish source fallback: ${String(source)}`, async (t) => {
    const h = captureHarness(t);
    replaceProperty(t, Track.Source, "ScreenShareAudio", source);
    await h.capture(true);
    assert.equal(h.publications[1]!.options?.source, source ?? "screen_share_audio");
  });
}

test("concurrent captures keep independent streams, identifiers and published-track arrays", async (t) => {
  const h = captureHarness(t);
  const secondVideo = h.track("other-video", "video");
  const secondStream = {
    getVideoTracks: () => [secondVideo], getAudioTracks: () => [], getTracks: () => [secondVideo]
  } as unknown as MediaStream;
  let captures = 0;
  t.mock.method(h.mediaDevices, "getDisplayMedia", async () => ++captures === 1 ? h.stream : secondStream);
  const [first, second] = await Promise.all([h.capture(true, "first"), h.capture(false, "second")]);
  assert.equal(first.stream, h.stream);
  assert.equal(second.stream, secondStream);
  assert.deepEqual(first.publishedTracks, [h.video, h.audio]);
  assert.deepEqual(second.publishedTracks, [secondVideo]);
  assert.notEqual(first.publishedTracks, second.publishedTracks);
  assert.equal(first.mediaTrackSid, "published-video-1");
  assert.equal(second.mediaTrackSid, "published-other-video");
});

function canvasHarness(t: TestContext, withContext = true) {
  const events: unknown[][] = [];
  const frames: FrameRequestCallback[] = [];
  const stream = {} as MediaStream;
  const context = {
    fillStyle: "", font: "",
    fillRect(...args: number[]) { events.push(["rect", this.fillStyle, ...args]); },
    fillText(...args: [string, number, number]) { events.push(["text", this.fillStyle, this.font, ...args]); }
  };
  const canvas = {
    width: 0, height: 0,
    getContext(kind: string) {
      assert.equal(this, canvas);
      events.push(["context", kind, this.width, this.height]);
      return withContext ? context : null;
    },
    captureStream(rate: number) {
      assert.equal(this, canvas);
      events.push(["stream", rate]);
      return stream;
    }
  };
  replaceProperty(t, globalThis, "document", {
    createElement(kind: string) { events.push(["create", kind]); return canvas; }
  });
  replaceProperty(t, globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    events.push(["frame"]);
    frames.push(callback);
    return frames.length;
  });
  t.mock.method(Date.prototype, "toLocaleTimeString", () => "12:34:56");
  return { events, frames, stream, context, canvas };
}

test("mock capture reports a missing 2D context before rendering or scheduling", (t) => {
  const h = canvasHarness(t, false);
  assert.throws(() => createMockShareStream(), { message: "mock_canvas_context_failed" });
  assert.deepEqual(h.events, [["create", "canvas"], ["context", "2d", 640, 360]]);
  assert.deepEqual(h.frames, []);
});

test("mock capture preserves canvas dimensions, drawing order, clock text and frame rate", (t) => {
  const h = canvasHarness(t);
  assert.equal(createMockShareStream(), h.stream);
  assert.deepEqual(h.events, [
    ["create", "canvas"], ["context", "2d", 640, 360],
    ["rect", "#13233b", 0, 0, 640, 360], ["rect", "#5fc8ff", 41, 110, 180, 90],
    ["text", "#ffffff", "28px sans-serif", "Mock Share", 220, 180],
    ["text", "#ffffff", "28px sans-serif", "12:34:56", 220, 220],
    ["frame"], ["stream", 24]
  ]);
});

test("mock animation increments and wraps its tick while scheduling one subsequent frame", (t) => {
  const h = canvasHarness(t);
  createMockShareStream();
  const positions = [42, ...Array.from({ length: 198 }, (_, index) => 40 + ((index + 3) % 200))];
  for (const x of positions) {
    const callback = h.frames.shift()!;
    h.events.length = 0;
    callback(0);
    assert.deepEqual(h.events[1], ["rect", "#5fc8ff", x, 110, 180, 90]);
    assert.equal(h.frames.length, 1);
  }
  assert.deepEqual(h.events[1], ["rect", "#5fc8ff", 40, 110, 180, 90]);
});

test("separate mock captures start with independent animation counters", (t) => {
  const h = canvasHarness(t);
  createMockShareStream();
  h.frames.shift()!(0);
  h.events.length = 0;
  createMockShareStream();
  assert.deepEqual(h.events[3], ["rect", "#5fc8ff", 41, 110, 180, 90]);
});

test("mock capture preserves captureStream failure after the first frame was scheduled", (t) => {
  const h = canvasHarness(t);
  const error = new Error("captureStream failed");
  t.mock.method(h.canvas, "captureStream", () => { throw error; });
  assert.throws(() => createMockShareStream(), (actual) => actual === error);
  assert.equal(h.frames.length, 1);
});

test("mock capture preserves drawing failure without scheduling or capturing", (t) => {
  const h = canvasHarness(t);
  const error = new Error("draw failed");
  t.mock.method(h.context, "fillRect", () => { throw error; });
  assert.throws(() => createMockShareStream(), (actual) => actual === error);
  assert.deepEqual(h.events, [["create", "canvas"], ["context", "2d", 640, 360]]);
  assert.deepEqual(h.frames, []);
});
