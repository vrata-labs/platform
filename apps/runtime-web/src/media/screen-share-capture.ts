import { Track, type Room } from "livekit-client";

import { createFaultError } from "../runtime-errors.js";

export function createMockShareStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("mock_canvas_context_failed");
  }

  let tick = 0;
  const render = () => {
    tick += 1;
    context.fillStyle = "#13233b";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#5fc8ff";
    context.fillRect(40 + (tick % 200), 110, 180, 90);
    context.fillStyle = "#ffffff";
    context.font = "28px sans-serif";
    context.fillText("Mock Share", 220, 180);
    context.fillText(new Date().toLocaleTimeString(), 220, 220);
    requestAnimationFrame(render);
  };
  render();
  return canvas.captureStream(24);
}

export async function captureAndPublishScreenShareStream(room: Room, input: {
  objectId: string;
  mediaAudioEnabled: boolean;
}): Promise<{ stream: MediaStream; publishedTracks: MediaStreamTrack[]; mediaTrackSid: string }> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw createFaultError("NotSupportedError", "screen_share_unsupported:getDisplayMedia missing");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: input.mediaAudioEnabled
  });
  const videoTrack = stream.getVideoTracks().find((track) => track.readyState === "live");
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw createFaultError("NotFoundError", "screen_share_video_track_missing");
  }
  const localParticipant = room.localParticipant as {
    publishTrack: (track: MediaStreamTrack, options?: { name?: string; source?: Track.Source | string }) => Promise<{ trackSid?: string; sid?: string }>;
  };
  const publishedTracks: MediaStreamTrack[] = [];
  try {
    const videoPublication = await localParticipant.publishTrack(videoTrack, {
      name: `screen-share:${input.objectId}:video`,
      source: Track.Source.ScreenShare
    });
    publishedTracks.push(videoTrack);
    const audioTrack = stream.getAudioTracks().find((track) => track.readyState === "live");
    if (input.mediaAudioEnabled && audioTrack) {
      await localParticipant.publishTrack(audioTrack, {
        name: `screen-share:${input.objectId}:audio`,
        source: (Track.Source as Record<string, Track.Source | string>).ScreenShareAudio ?? "screen_share_audio"
      });
      publishedTracks.push(audioTrack);
    }
    return {
      stream,
      publishedTracks,
      mediaTrackSid: videoPublication.trackSid ?? videoPublication.sid ?? videoTrack.id
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}
