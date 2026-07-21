import type { VideoPlayerState } from "@vrata/shared-types";

export function resolveVideoTargetSeconds(state: VideoPlayerState, serverNowMs: number): number {
  if (state.durationMs <= 0) return 0;
  const elapsed = state.playbackState === "playing" && state.anchorServerTimeMs !== null
    ? Math.max(0, serverNowMs - state.anchorServerTimeMs)
    : 0;
  const position = state.positionMs + elapsed;
  return (state.loop ? position % state.durationMs : Math.min(position, state.durationMs)) / 1000;
}

export function planVideoPlaybackCorrection(actualSeconds: number, targetSeconds: number, paused: boolean): { mode: "none" | "rate" | "seek"; playbackRate: number; seekToSeconds: number | null; driftMs: number } {
  const driftMs = (targetSeconds - actualSeconds) * 1000;
  const absolute = Math.abs(driftMs);
  if ((paused && absolute > 50) || absolute > 750) return { mode: "seek", playbackRate: 1, seekToSeconds: targetSeconds, driftMs };
  if (!paused && absolute > 80) return { mode: "rate", playbackRate: Math.max(0.95, Math.min(1.05, 1 + driftMs / 10_000)), seekToSeconds: null, driftMs };
  return { mode: "none", playbackRate: 1, seekToSeconds: null, driftMs };
}
