import type { Room, Track } from "livekit-client";
import type { RoomMediaObjectsState } from "@vrata/shared-types";

export interface MediaSurfaceAudioNode {
  surfaceId: string;
  element: HTMLMediaElement;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  sampleBuffer: Uint8Array | null;
  trackId: string;
}

interface MediaSurfaceAudioRuntimeContext {
  readonly roomMediaObjects: RoomMediaObjectsState | null;
  readonly livekitRoom: Room | null;
  mediaSurfaceViews: ReadonlyMap<string, unknown>;
  mediaSurfaceAudioNodes: Map<string, MediaSurfaceAudioNode>;
  getTrackNodeId: (track: Track, fallback: string) => string;
  ensureAudioContext: () => AudioContext;
  createAudioAnalyser: (context: AudioContext) => { analyser: AnalyserNode; sampleBuffer: Uint8Array };
  resumeAudioContext: () => Promise<void>;
  reconcileMediaRoomIdleDisconnect: (room: Room | null, diagnosticsReason: string) => void;
  syncSurfaceAudioControl: () => void;
}

export function createMediaSurfaceAudioRuntime(bindings: MediaSurfaceAudioRuntimeContext) {
  const {
    mediaSurfaceViews,
    mediaSurfaceAudioNodes,
    getTrackNodeId,
    ensureAudioContext,
    createAudioAnalyser,
    resumeAudioContext,
    reconcileMediaRoomIdleDisconnect,
    syncSurfaceAudioControl
  } = bindings;

  function connectMediaSurfaceAudioTrack(track: Track, surfaceId: string): void {
    if (!mediaSurfaceViews.has(surfaceId) || !bindings.roomMediaObjects?.surfaces[surfaceId]) {
      return;
    }
    const trackId = getTrackNodeId(track, `${surfaceId}:screen-share-audio`);
    const existing = mediaSurfaceAudioNodes.get(surfaceId);
    if (existing?.trackId === trackId) {
      return;
    }
    if (existing) {
      disconnectMediaSurfaceAudioTrack(surfaceId);
    }
    const element = track.attach() as HTMLMediaElement & { playsInline?: boolean };
    element.autoplay = true;
    element.playsInline = true;
    element.style.display = "none";
    document.body.appendChild(element);
    void element.play().catch(() => undefined);
    const mediaStreamTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
    const context = mediaStreamTrack ? ensureAudioContext() : null;
    const analyserSetup = context ? createAudioAnalyser(context) : null;
    const source = context && mediaStreamTrack ? context.createMediaStreamSource(new MediaStream([mediaStreamTrack])) : null;
    if (source && analyserSetup) {
      void resumeAudioContext();
      source.connect(analyserSetup.analyser);
    }
    mediaSurfaceAudioNodes.set(surfaceId, {
      surfaceId,
      element,
      source,
      analyser: analyserSetup?.analyser ?? null,
      sampleBuffer: analyserSetup?.sampleBuffer ?? null,
      trackId
    });
    reconcileMediaRoomIdleDisconnect(bindings.livekitRoom, "media_surface_audio_consumer_active");
    syncSurfaceAudioControl();
  }

  function disconnectMediaSurfaceAudioTrack(surfaceId: string): void {
    const node = mediaSurfaceAudioNodes.get(surfaceId);
    if (!node) {
      return;
    }
    node.element.remove();
    node.source?.disconnect();
    node.analyser?.disconnect();
    mediaSurfaceAudioNodes.delete(surfaceId);
    syncSurfaceAudioControl();
    reconcileMediaRoomIdleDisconnect(bindings.livekitRoom, "media_surface_audio_consumer_detached_idle");
  }

  function disconnectMediaSurfaceAudioTrackByTrack(track: Track): void {
    const trackId = getTrackNodeId(track, "");
    for (const [surfaceId, node] of mediaSurfaceAudioNodes.entries()) {
      if (!trackId || node.trackId === trackId) {
        disconnectMediaSurfaceAudioTrack(surfaceId);
      }
    }
  }

  return {
    connectMediaSurfaceAudioTrack,
    disconnectMediaSurfaceAudioTrack,
    disconnectMediaSurfaceAudioTrackByTrack
  };
}
