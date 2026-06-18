import type { RoomMediaObjectsState } from "@vrata/shared-types";

export function shouldPublishMediaSurfaceAudio(mediaObjects: RoomMediaObjectsState | null | undefined, surfaceId: string): boolean {
  return mediaObjects?.surfaces[surfaceId]?.mediaAudioEnabled === true;
}

export function isScreenShareAudioSource(source: unknown): boolean {
  return source === "screen_share_audio" || source === "screenshare_audio" || source === "screenShareAudio";
}
