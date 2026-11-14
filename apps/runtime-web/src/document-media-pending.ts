import type {
  ImageViewerPatch,
  ImageViewerState,
  MediaObjectInstance,
  VideoPlayerPatch,
  VideoPlayerState
} from "@vrata/shared-types";

export type DocumentMediaControlPatch = ImageViewerPatch | VideoPlayerPatch;

// Room-state normally delivers the new revision before the command result. If it
// is late, the requested value stays on screen for this long after acceptance;
// then the room-state value is shown again, so a lost update cannot stick.
export const DOCUMENT_MEDIA_CONFIRMATION_GRACE_MS = 5000;

interface PendingDocumentMediaPatch {
  readonly objectId: string;
  readonly baseRevision: number;
  readonly patch: DocumentMediaControlPatch;
  readonly requestedAtMs: number;
  acceptedAtMs: number | null;
}

type ObjectIdentity = Pick<MediaObjectInstance, "objectId" | "revision">;

// Mirrors the room-state reducer for the displayed value only. Room-state stays
// the source of truth: its revision replaces this projection.
function resolveVideoPositionMs(state: VideoPlayerState, serverNowMs: number): number {
  const durationMs = Math.max(0, state.durationMs);
  if (durationMs === 0) return 0;
  const elapsedMs = state.playbackState === "playing" && state.anchorServerTimeMs !== null
    ? Math.max(0, serverNowMs - state.anchorServerTimeMs)
    : 0;
  const positionMs = Math.max(0, state.positionMs + elapsedMs);
  return state.loop ? positionMs % durationMs : Math.min(positionMs, durationMs);
}

function projectVideoPlayerState(state: VideoPlayerState, patch: VideoPlayerPatch, requestedServerMs: number): VideoPlayerState {
  const playingAnchor = state.playbackState === "playing" ? requestedServerMs : null;
  switch (patch.type) {
    case "play": {
      const positionMs = resolveVideoPositionMs(state, requestedServerMs);
      return { ...state, playbackState: "playing", positionMs: !state.loop && positionMs >= state.durationMs ? 0 : positionMs, anchorServerTimeMs: requestedServerMs };
    }
    case "pause":
      return { ...state, playbackState: "paused", positionMs: resolveVideoPositionMs(state, requestedServerMs), anchorServerTimeMs: null };
    case "seek":
      return { ...state, positionMs: patch.positionMs, anchorServerTimeMs: playingAnchor };
    case "set-loop":
      return { ...state, loop: patch.loop, positionMs: resolveVideoPositionMs(state, requestedServerMs), anchorServerTimeMs: playingAnchor };
    case "set-fit-mode":
      return { ...state, fitMode: patch.fitMode };
    default:
      return state;
  }
}

// The presenter's media control request that room-state has not confirmed yet.
// Controls show the requested value instead of snapping back to the previous one.
export function createDocumentMediaPendingPatch(now: () => number = () => Date.now()) {
  let pending: PendingDocumentMediaPatch | null = null;

  function pendingFor(object: ObjectIdentity): PendingDocumentMediaPatch | null {
    if (!pending || pending.objectId !== object.objectId || object.revision > pending.baseRevision) return null;
    if (pending.acceptedAtMs !== null && now() - pending.acceptedAtMs > DOCUMENT_MEDIA_CONFIRMATION_GRACE_MS) return null;
    return pending;
  }

  return {
    begin(object: ObjectIdentity, patch: DocumentMediaControlPatch): void {
      pending = { objectId: object.objectId, baseRevision: object.revision, patch, requestedAtMs: now(), acceptedAtMs: null };
    },
    accept(): void {
      if (pending) pending.acceptedAtMs = now();
    },
    discard(): void {
      pending = null;
    },
    // True while the object still has the revision the request was based on.
    awaits(object: ObjectIdentity): boolean {
      return pendingFor(object) !== null;
    },
    videoState(object: MediaObjectInstance<VideoPlayerState>, serverOffsetMs: number): VideoPlayerState {
      const entry = pendingFor(object);
      return entry ? projectVideoPlayerState(object.state, entry.patch as VideoPlayerPatch, entry.requestedAtMs + serverOffsetMs) : object.state;
    },
    imageState(object: MediaObjectInstance<ImageViewerState>): ImageViewerState {
      const entry = pendingFor(object);
      return entry?.patch.type === "set-fit-mode" ? { ...object.state, fitMode: entry.patch.fitMode } : object.state;
    }
  };
}

export type DocumentMediaPendingPatch = ReturnType<typeof createDocumentMediaPendingPatch>;
