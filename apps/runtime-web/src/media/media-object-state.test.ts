import test from "node:test";
import assert from "node:assert/strict";

import {
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  type MediaObjectInstance,
  type MediaSurface,
  type RemoteBrowserObjectState,
  type RoomMediaObjectsState,
  type ScreenShareObjectState
} from "@vrata/shared-types";

import {
  findPhysicalRemoteBrowserObjectNeedingLiveKitRoom,
  physicalRemoteBrowserObjectForMediaTrack,
  physicalScreenShareObjectForMediaTrack,
  remoteBrowserObjectForMediaTrack,
  remoteBrowserObjectNeedsLiveKitRoom,
  screenShareObjectForMediaTrack
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

function createScreenShareObject(): MediaObjectInstance<ScreenShareObjectState> {
  return {
    objectId: "screen-share-1",
    type: SCREEN_SHARE_OBJECT_TYPE,
    roomId: "room-1",
    surfaceId: "debug-main",
    ownerParticipantId: "presenter-1",
    state: {
      status: "active",
      ownerParticipantId: "presenter-1",
      surfaceId: "debug-main",
      mediaTrackSid: "screen-video-1"
    },
    status: "active",
    revision: 1,
    createdAtMs: 0,
    updatedAtMs: 0
  };
}

function createScreenShareMediaObjects(object: MediaObjectInstance<ScreenShareObjectState>): RoomMediaObjectsState {
  return {
    surfaces: {
      [object.surfaceId]: {
        ...createSurface(object.objectId),
        allowedObjectTypes: [SCREEN_SHARE_OBJECT_TYPE]
      }
    },
    objects: { [object.objectId]: object }
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

test("remote browser media track resolver fails closed on stale SID and falls back only before SID is authoritative", () => {
  const object = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:browser-1",
    mediaTrackSid: "published-video-track-id",
    audioTrackSid: "published-audio-track-id"
  });

  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "remote-browser:browser-1", "livekit-video-sid", "video"), null);
  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(object), "remote-browser:browser-1", "livekit-audio-sid", "audio"), null);

  const publicationBeforeState = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:browser-1",
    mediaTrackSid: undefined,
    audioTrackSid: undefined
  });
  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(publicationBeforeState), "remote-browser:browser-1", "livekit-video-sid", "video")?.objectId, "browser-1");
  assert.equal(remoteBrowserObjectForMediaTrack(createMediaObjects(publicationBeforeState), "remote-browser:browser-1", "livekit-audio-sid", "audio")?.objectId, "browser-1");
});

test("remote browser resolver does not let a pending object hide a stale authoritative SID in either ordering", () => {
  const authoritative = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:shared",
    mediaTrackSid: "new-video-sid"
  });
  const pending = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:shared",
    mediaTrackSid: undefined
  });
  pending.objectId = "browser-pending";
  pending.surfaceId = "surface-pending";
  pending.state.surfaceId = "surface-pending";
  const mediaObjects = (objects: Array<MediaObjectInstance<RemoteBrowserObjectState>>): RoomMediaObjectsState => ({
    surfaces: Object.fromEntries(objects.map((object) => [object.surfaceId, { ...createSurface(object.objectId), surfaceId: object.surfaceId }])),
    objects: Object.fromEntries(objects.map((object) => [object.objectId, object]))
  });

  for (const objects of [[pending, authoritative], [authoritative, pending]]) {
    assert.equal(remoteBrowserObjectForMediaTrack(mediaObjects(objects), "remote-browser:shared", "stale-video-sid", "video"), null);
    assert.equal(remoteBrowserObjectForMediaTrack(mediaObjects(objects), "remote-browser:shared", "new-video-sid", "video")?.objectId, "browser-1");
  }
});

test("screen-share track remains unresolved until room state arrives, then resolves only to a physical surface", () => {
  const physicalSurfaceIds = new Set(["debug-main"]);
  const object = createScreenShareObject();

  assert.equal(physicalScreenShareObjectForMediaTrack(null, physicalSurfaceIds, "presenter-1", "screen-video-1", "video"), null);
  assert.equal(
    physicalScreenShareObjectForMediaTrack(createScreenShareMediaObjects(object), physicalSurfaceIds, "presenter-1", "screen-video-1", "video")?.objectId,
    "screen-share-1"
  );
  assert.equal(physicalScreenShareObjectForMediaTrack(createScreenShareMediaObjects(object), new Set(), "presenter-1", "screen-video-1", "video"), null);
});

test("screen-share resolver routes distinct audio SID without weakening stale video rejection", () => {
  const authoritative = createScreenShareObject();
  const mediaObjects = createScreenShareMediaObjects(authoritative);
  assert.equal(screenShareObjectForMediaTrack(mediaObjects, "presenter-1", "old-screen-video", "video"), null);
  assert.equal(screenShareObjectForMediaTrack(mediaObjects, "presenter-1", "screen-video-1", "video")?.objectId, "screen-share-1");
  assert.equal(screenShareObjectForMediaTrack(mediaObjects, "presenter-1", "screen-audio-1", "audio")?.objectId, "screen-share-1");

  const publicationBeforeState = createScreenShareObject();
  delete publicationBeforeState.state.mediaTrackSid;
  assert.equal(screenShareObjectForMediaTrack(createScreenShareMediaObjects(publicationBeforeState), "presenter-1", "new-screen-video", "video")?.objectId, "screen-share-1");
});

test("screen-share resolver does not let a pending object hide a stale authoritative SID in either ordering", () => {
  const authoritative = createScreenShareObject();
  const pending = createScreenShareObject();
  pending.objectId = "screen-share-pending";
  pending.surfaceId = "surface-pending";
  pending.state.surfaceId = "surface-pending";
  delete pending.state.mediaTrackSid;
  const mediaObjects = (objects: Array<MediaObjectInstance<ScreenShareObjectState>>): RoomMediaObjectsState => ({
    surfaces: Object.fromEntries(objects.map((object) => [object.surfaceId, {
      ...createSurface(object.objectId),
      surfaceId: object.surfaceId,
      allowedObjectTypes: [SCREEN_SHARE_OBJECT_TYPE]
    }])),
    objects: Object.fromEntries(objects.map((object) => [object.objectId, object]))
  });

  for (const objects of [[pending, authoritative], [authoritative, pending]]) {
    assert.equal(screenShareObjectForMediaTrack(mediaObjects(objects), "presenter-1", "old-screen-video", "video"), null);
    assert.equal(screenShareObjectForMediaTrack(mediaObjects(objects), "presenter-1", "screen-video-1", "video")?.objectId, "screen-share-1");
  }
});

test("screen-share audio publication name selects its active object despite owner ambiguity", () => {
  const first = createScreenShareObject();
  const second = createScreenShareObject();
  second.objectId = "screen-share-2";
  second.surfaceId = "surface-2";
  second.state.surfaceId = "surface-2";
  second.state.mediaTrackSid = "screen-video-2";
  const mediaObjects: RoomMediaObjectsState = {
    surfaces: {
      "debug-main": createScreenShareMediaObjects(first).surfaces["debug-main"]!,
      "surface-2": { ...createSurface(second.objectId), surfaceId: second.surfaceId, allowedObjectTypes: [SCREEN_SHARE_OBJECT_TYPE] }
    },
    objects: { [first.objectId]: first, [second.objectId]: second }
  };

  assert.equal(screenShareObjectForMediaTrack(mediaObjects, "presenter-1", "screen-audio-2", "audio"), null);
  assert.equal(
    screenShareObjectForMediaTrack(mediaObjects, "presenter-1", "screen-audio-2", "audio", "screen-share:screen-share-2:audio")?.objectId,
    "screen-share-2"
  );
});

test("remote-browser LiveKit consumers ignore logical-only surfaces", () => {
  const object = createRemoteBrowserObject({
    status: "active",
    mediaParticipantId: "remote-browser:browser-1",
    mediaTrackSid: "video-1",
    audioTrackSid: "audio-1"
  });
  const mediaObjects = createMediaObjects(object);

  assert.equal(findPhysicalRemoteBrowserObjectNeedingLiveKitRoom(mediaObjects, new Set()), null);
  assert.equal(physicalRemoteBrowserObjectForMediaTrack(mediaObjects, new Set(), "remote-browser:browser-1", "video-1", "video"), null);
  assert.equal(findPhysicalRemoteBrowserObjectNeedingLiveKitRoom(mediaObjects, new Set(["debug-main"]))?.objectId, "browser-1");
  assert.equal(physicalRemoteBrowserObjectForMediaTrack(mediaObjects, new Set(["debug-main"]), "remote-browser:browser-1", "video-1", "video")?.objectId, "browser-1");
});
