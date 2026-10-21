import type { Room } from "livekit-client";
import type { ScreenShareErrorCode } from "@vrata/shared-types";
import type { MediaSurfaceCommandClient } from "./media-surface-commands.js";
import { captureAndPublishScreenShareStream } from "./screen-share-capture.js";
import { createFaultError } from "../runtime-errors.js";

type ScreenDebug = {
  screenShareState: string;
  access: { canStartScreenShare: boolean; lastDeniedPermission: string | null };
  screenShare: { active: boolean; localPublishing: boolean; publishedTrackSid: string | null; selectedSurfaceId: string | null;
    mediaAudioEnabled: boolean; errorCode: ScreenShareErrorCode | null };
};
export interface ScreenShareActionsContext {
  participantId(): string;
  debugState: ScreenDebug;
  connected(): boolean;
  canStart(surfaceId: string): boolean;
  mock(): boolean;
  mediaAudioEnabled(surfaceId: string): boolean;
  commands: Pick<MediaSurfaceCommandClient, "createScreenShareObjectOnSurface" | "patchScreenShareObject" | "stopScreenShareObject">;
  ensureMediaRoom(): Promise<Room>;
  attach(stream: MediaStream, input: { objectId: string; surfaceId: string; mediaTrackSid: string; publishedTracks: MediaStreamTrack[] }): void;
  attachMock(stream: MediaStream, objectId: string, surfaceId: string, mediaTrackSid: string): void;
  bindEnded(objectId: string, surfaceId: string, tracks: MediaStreamTrack[]): void;
  cleanup(room: Room | undefined, objectId: string, tracks: MediaStreamTrack[]): Promise<void>;
  errorCode(error: unknown): ScreenShareErrorCode;
  setStatus(message: string): void;
  syncControls(): void;
  report(note: string): void;
  started(): void;
}

/** Publication owner for a stream already selected during the user's click.
 * Confirmation and capture ownership are coordinated outside this module. */
export function createScreenShareActions(context: ScreenShareActionsContext) {
  async function start(input: { surfaceId: string; stream: MediaStream; assertActive(): void }): Promise<boolean> {
    const { surfaceId, stream } = input;
    let ended = false;
    const onEnded = () => { ended = true; };
    const videos = stream.getVideoTracks(); videos.forEach(track => track.addEventListener("ended", onEnded));
    const check = () => {
      input.assertActive();
      if (!context.debugState.access.canStartScreenShare) {
        context.debugState.access.lastDeniedPermission = "screen-share.start";
        throw createFaultError("NotAllowedError", "screen_share_forbidden");
      }
      if (!context.connected()) throw createFaultError("ConnectionError", "room_state_failed");
      if (ended || !videos.some(track => track.readyState === "live")) throw createFaultError("NotFoundError", "screen_share_video_track_missing");
    };
    let objectId: string | undefined, revision = 0, room: Room | undefined, publishedTracks: MediaStreamTrack[] = [];
    try {
      check();
      if (!context.canStart(surfaceId)) throw createFaultError("NotAllowedError", "screen_share_control_unavailable");
      const created = await context.commands.createScreenShareObjectOnSurface(surfaceId);
      if (!created.accepted || !created.objectId) throw new Error(`screen_share_create_rejected:${created.blockedReason ?? "unknown"}`);
      objectId = created.objectId; revision = created.revision ?? 0;
      check(); context.started();
      context.debugState.screenShare.selectedSurfaceId = surfaceId; context.debugState.screenShare.errorCode = null;
      const selecting = await context.commands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-selecting" });
      check(); if (!selecting.accepted) throw new Error(`screen_share_selecting_rejected:${selecting.blockedReason ?? "unknown"}`);
      revision = selecting.revision ?? revision;
      if (!context.mock()) { room = await context.ensureMediaRoom(); check(); }
      context.debugState.screenShareState = "starting";
      const publishing = await context.commands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-publishing" });
      check(); if (!publishing.accepted) throw new Error(`screen_share_publishing_rejected:${publishing.blockedReason ?? "unknown"}`);
      revision = publishing.revision ?? revision;
      const mediaAudioEnabled = context.mediaAudioEnabled(surfaceId);
      context.debugState.screenShare.mediaAudioEnabled = mediaAudioEnabled;
      let mediaTrackSid: string;
      if (context.mock()) {
        mediaTrackSid = `mock-screen-share:${context.participantId()}:${objectId}:${Date.now()}`;
        context.attachMock(stream, objectId, surfaceId, mediaTrackSid);
      } else {
        const published = await captureAndPublishScreenShareStream(room!, { objectId, mediaAudioEnabled, stream, assertActive: check });
        publishedTracks = published.publishedTracks; check(); mediaTrackSid = published.mediaTrackSid;
        context.attach(stream, { objectId, surfaceId, mediaTrackSid, publishedTracks });
        context.bindEnded(objectId, surfaceId, publishedTracks);
      }
      check();
      const active = await context.commands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-active", mediaTrackSid });
      check(); if (!active.accepted) throw new Error(`screen_share_active_rejected:${active.blockedReason ?? "unknown"}`);
      context.debugState.screenShareState = "sharing";
      context.debugState.screenShare.active = true; context.debugState.screenShare.localPublishing = true;
      context.debugState.screenShare.publishedTrackSid = mediaTrackSid;
      context.syncControls(); context.setStatus("Sharing screen");
      context.report(context.mock() ? "screenshare_mock_started" : "screenshare_started"); return true;
    } catch (error) {
      const errorCode = context.errorCode(error); context.debugState.screenShare.errorCode = errorCode;
      if (objectId) {
        await context.cleanup(room, objectId, publishedTracks).catch(() => undefined);
        await context.commands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-failed", errorCode }).catch(() => undefined);
        await context.commands.stopScreenShareObject(objectId, surfaceId).catch(() => undefined);
      }
      context.syncControls(); throw error;
    } finally { videos.forEach(track => track.removeEventListener("ended", onEnded)); }
  }
  return { start };
}
