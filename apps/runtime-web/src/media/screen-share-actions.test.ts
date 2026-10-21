import assert from "node:assert/strict";
import test from "node:test";
import type { Room } from "livekit-client";
import type { SurfaceCommandResult } from "../room-state-client.js";
import { createScreenShareActions, type ScreenShareActionsContext } from "./screen-share-actions.js";

function fixture() {
  const events: string[] = [];
  class Track extends EventTarget {
    readyState = "live";
    constructor(readonly kind: string, readonly id: string) { super(); }
    stop() { this.readyState = "ended"; events.push(`stop:${this.id}`); }
    end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  }
  const video = new Track("video", "screen-video"), audio = new Track("audio", "screen-audio"), microphone = new Track("audio", "microphone");
  const stream = { getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio] } as unknown as MediaStream;
  const result = (values: Partial<SurfaceCommandResult> = {}): SurfaceCommandResult => ({ accepted: true, permission: "screen-share.start", role: "host", ...values });
  const hooks = {
    step: async (_name: string): Promise<void> => {},
    active: true, connected: true, mock: false, audio: true
  };
  let revision = 0;
  const room = { localParticipant: {
    async publishTrack(track: MediaStreamTrack) { events.push(`publish:${track.id}`); await hooks.step(`publish:${track.kind}`); return { trackSid: `${track.id}-sid` }; },
    async unpublishTrack(track: MediaStreamTrack) { events.push(`unpublish:${track.id}`); }
  } } as unknown as Room;
  const context: ScreenShareActionsContext = {
    participantId: () => "presenter", connected: () => hooks.connected, mock: () => hooks.mock,
    debugState: { screenShareState: "idle", access: { canStartScreenShare: true, lastDeniedPermission: null },
      screenShare: { active: false, localPublishing: false, publishedTrackSid: null, selectedSurfaceId: null, mediaAudioEnabled: false, errorCode: null } },
    canStart: surfaceId => surfaceId === "pinned-main", mediaAudioEnabled: () => hooks.audio,
    commands: {
      async createScreenShareObjectOnSurface(surfaceId) { assert.equal(surfaceId, "pinned-main"); events.push("create"); await hooks.step("create"); return result({ objectId: "owned-screen", revision }); },
      async patchScreenShareObject(objectId, surfaceId, expectedRevision, patch) {
        assert.equal(objectId, "owned-screen"); assert.equal(surfaceId, "pinned-main"); events.push(patch.type);
        await hooks.step(patch.type); return result({ revision: ++revision });
      },
      async stopScreenShareObject(objectId, surfaceId) { assert.equal(objectId, "owned-screen"); assert.equal(surfaceId, "pinned-main"); events.push("stop-object"); return result(); }
    },
    async ensureMediaRoom() { events.push("ensure-room"); await hooks.step("ensure-room"); return room; },
    attach(_stream, input) { assert.equal(_stream, stream); assert.equal(input.surfaceId, "pinned-main"); events.push("attach"); },
    attachMock: () => { events.push("attach-mock"); }, bindEnded: () => { events.push("bind-ended"); },
    async cleanup(inputRoom, _objectId, tracks) { events.push("cleanup"); for (const track of tracks) await inputRoom?.localParticipant.unpublishTrack(track); },
    errorCode: () => "display_capture_failed", setStatus: message => { events.push(`status:${message}`); },
    syncControls: () => { events.push("sync"); }, report: () => { events.push("report"); }, started: () => { events.push("started"); }
  };
  const actions = createScreenShareActions(context);
  const start = () => actions.start({ surfaceId: "pinned-main", stream, assertActive: () => { if (!hooks.active) throw new Error("stale-generation"); } });
  return { events, hooks, context, video, audio, microphone, stream, start };
}

test("prepared capture publishes exactly its own tracks without touching the microphone", async () => {
  const f = fixture(); assert.equal(await f.start(), true);
  assert.deepEqual(f.events, ["create", "started", "mark-selecting", "ensure-room", "mark-publishing", "publish:screen-video", "publish:screen-audio",
    "attach", "bind-ended", "mark-active", "sync", "status:Sharing screen", "report"]);
  assert.equal(f.context.debugState.screenShare.publishedTrackSid, "screen-video-sid");
  assert.equal(f.microphone.readyState, "live");
});

for (const boundary of ["create", "mark-selecting", "ensure-room", "mark-publishing", "publish:video", "publish:audio", "mark-active"]) {
  for (const reason of ["revoke", "ended"] as const) {
    test(`${reason} during ${boundary} rejects late result and cleans only owned publication`, async () => {
      const f = fixture();
      f.hooks.step = async name => { if (name === boundary) { if (reason === "revoke") f.hooks.active = false; else f.video.end(); } };
      await assert.rejects(f.start(), reason === "revoke" ? /stale-generation/ : /screen_share_video_track_missing/);
      assert.equal(f.events.filter(event => event === "stop-object").length, 1);
      assert.equal(f.events.filter(event => event === "cleanup").length, 1);
      assert.ok(!f.events.includes("report"));
      if (!["publish:video", "publish:audio", "mark-active"].includes(boundary)) assert.ok(!f.events.some(event => event.startsWith("publish:")));
      if (["publish:video", "publish:audio", "mark-active"].includes(boundary)) assert.ok(f.events.includes("unpublish:screen-video"));
      assert.ok(!f.events.some(event => event.includes("microphone"))); assert.equal(f.microphone.readyState, "live");
    });
  }
}

test("failed audio publication unpublishes the acknowledged video even before attach", async () => {
  const f = fixture(); f.hooks.step = async name => { if (name === "publish:audio") throw new Error("audio-failed"); };
  await assert.rejects(f.start(), /audio-failed/);
  assert.ok(f.events.includes("unpublish:screen-video")); assert.ok(!f.events.includes("attach"));
  assert.equal(f.video.readyState, "ended"); assert.equal(f.audio.readyState, "ended"); assert.equal(f.microphone.readyState, "live");
});

test("ended capture is refused before creating a room object", async () => {
  const f = fixture(); f.video.end(); await assert.rejects(f.start(), /screen_share_video_track_missing/);
  assert.deepEqual(f.events, ["sync"]);
});

test("mock path uses the passed stream and the same publication state ordering", async () => {
  const f = fixture(); f.hooks.mock = true; assert.equal(await f.start(), true);
  assert.ok(f.events.includes("attach-mock")); assert.ok(!f.events.includes("ensure-room"));
  assert.match(f.context.debugState.screenShare.publishedTrackSid!, /^mock-screen-share:presenter:owned-screen:/);
});
