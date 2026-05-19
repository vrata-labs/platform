import test from "node:test";
import assert from "node:assert/strict";

import {
  REMOTE_BROWSER_OBJECT_TYPE,
  type MediaObjectInstance,
  type MediaSurface,
  type RemoteBrowserObjectState,
  type RoomMediaObjectsState
} from "@noah/shared-types";

import {
  remoteBrowserObjectForMediaTrack,
  remoteBrowserObjectNeedsLiveKitRoom
} from "./media-object-state.js";

function createRemoteBrowserObject(state: Partial<RemoteBrowserObjectState> = {}): MediaObjectInstance<RemoteBrowserObjectState> {
  return {
    objectId: "browser-1",
    type: REMOTE_BROWSER_OBJECT_TYPE,
    roomId: "room-1",
    surfaceId: "debug-main",
    ownerParticipantId: "host-1",
    state: {
      status: "idle",
      ownerParticipantId: "host-1",
      surfaceId: "debug-main",
      lastInputEventId: null,
      ...state
    },
    status: "active",
    revision: 1,
    createdAtMs: 0,
    updatedAtMs: 0
  };
}

function createSurface(activeObjectId = "browser-1"): MediaSurface {
  return {
    surfaceId: "debug-main",
    roomId: "room-1",
    widthPx: 1280,
    heightPx: 720,
    inputEnabled: true,
    mediaAudioEnabled: true,
    visible: true,
    allowedObjectTypes: [REMOTE_BROWSER_OBJECT_TYPE],
    activeObjectId,
    lockedByParticipantId: null
  };
}

function createMediaObjects(object: MediaObjectInstance<RemoteBrowserObjectState>): RoomMediaObjectsState {
  return {
    surfaces: {
      [object.surfaceId]: createSurface(object.objectId)
    },
    objects: {
      [object.objectId]: object
    }
  };
}

test("remote browser requests LiveKit room for active non-mock tracks", () => {
  assert.equal(remoteBrowserObjectNeedsLiveKitRoom(null), false);
  assert.equal(remoteBrowserObjectNeedsLiveKitRoom(createRemoteBrowserObject({ status: "idle" })), false);
  assert.equal(remoteBrowserObjectNeedsLiveKitRoom(createRemoteBrowserObject({ status: "failed", mediaParticipantId: "remote-browser:browser-1" })), false);
  assert.equal(remoteBrowserObjectNeedsLiveKitRoom(createRemoteBrowserObject({ status: "publishing", mediaParticipantId: "remote-browser:browser-1" })), false);
  assert.equal(remoteBrowserObjectNeedsLiveKitRoom(createRemoteBrowserObject({ status: "active", mediaParticipantId: "remote-browser:browser-1", mediaTrackSid: "mock-remote-browser-video:browser-1" })), false);
  assert.equal(remoteBrowserObjectNeedsLiveKitRoom(createRemoteBrowserObject({ status: "active", mediaParticipantId: "remote-browser:browser-1", mediaTrackSid: "video-1" })), true);
});

test("remote browser media track resolver prefers exact track sid", () => {
  const object = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:browser-1",
    mediaTrackSid: "video-1",
    audioTrackSid: "audio-1"
  });

  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "remote-browser:browser-1", "video-1", "video")?.objectId, "browser-1");
  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "remote-browser:browser-1", "audio-1", "audio")?.objectId, "browser-1");
  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "other-participant", "video-1", "video"), null);
});

test("remote browser media track resolver falls back to scoped participant identity", () => {
  const object = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:browser-1",
    mediaTrackSid: "published-video-track-id",
    audioTrackSid: "published-audio-track-id"
  });

  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "remote-browser:browser-1", "livekit-video-sid", "video")?.objectId, "browser-1");
  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "remote-browser:browser-1", "livekit-audio-sid", "audio")?.objectId, "browser-1");
});
