import type { CompactPoseFrame } from "./avatar-types.js";

interface BufferedPoseFrame extends CompactPoseFrame {
  sourceSentAtMs: number;
}

export interface AvatarPoseBuffer {
  frames: BufferedPoseFrame[];
  maxSize: number;
  ttlMs: number;
  lastSeq: number | null;
  droppedStaleCount: number;
  droppedReorderCount: number;
  recentArrivalIntervalsMs: number[];
  recentSentIntervalsMs: number[];
  lastReceivedAtMs: number | null;
  recommendedPlaybackDelayMs: number;
}

export interface AvatarPoseBufferPushResult {
  accepted: boolean;
  reason: "accepted" | "stale" | "reorder";
}

export function createAvatarPoseBuffer(input: { maxSize?: number; ttlMs?: number } = {}): AvatarPoseBuffer {
  return {
    frames: [],
    maxSize: input.maxSize ?? 32,
    ttlMs: input.ttlMs ?? 2_000,
    lastSeq: null,
    droppedStaleCount: 0,
    droppedReorderCount: 0,
    recentArrivalIntervalsMs: [],
    recentSentIntervalsMs: [],
    lastReceivedAtMs: null,
    recommendedPlaybackDelayMs: 100
  };
}

function pushWindowedValue(target: number[], value: number, maxSize = 8): void {
  target.push(value);
  if (target.length > maxSize) {
    target.splice(0, target.length - maxSize);
  }
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function pushAvatarPoseFrame(buffer: AvatarPoseBuffer, frame: CompactPoseFrame, nowMs = Date.now()): AvatarPoseBufferPushResult {
  pruneAvatarPoseBuffer(buffer, nowMs);
  if (buffer.lastSeq !== null && frame.seq < buffer.lastSeq) {
    buffer.droppedReorderCount += 1;
    return { accepted: false, reason: "reorder" };
  }
  if (buffer.lastSeq !== null && frame.seq === buffer.lastSeq) {
    buffer.droppedStaleCount += 1;
    return { accepted: false, reason: "stale" };
  }
  if (buffer.lastReceivedAtMs !== null) {
    pushWindowedValue(buffer.recentArrivalIntervalsMs, Math.max(0, nowMs - buffer.lastReceivedAtMs));
  }
  const lastFrame = buffer.frames[buffer.frames.length - 1] ?? null;
  if (lastFrame) {
    pushWindowedValue(buffer.recentSentIntervalsMs, Math.max(0, frame.sentAtMs - lastFrame.sourceSentAtMs));
  }
  const arrivalIntervalMs = average(buffer.recentArrivalIntervalsMs);
  const sentIntervalMs = average(buffer.recentSentIntervalsMs);
  const jitterMs = Math.abs(arrivalIntervalMs - sentIntervalMs);
  buffer.recommendedPlaybackDelayMs = Math.round(Math.min(140, Math.max(100, 100 + jitterMs * 2)));
  buffer.lastSeq = frame.seq;
  buffer.lastReceivedAtMs = nowMs;
  const normalizedTimelineMs = lastFrame
    ? lastFrame.sentAtMs + Math.max(1, frame.sentAtMs - lastFrame.sourceSentAtMs)
    : nowMs;
  buffer.frames.push({
    ...frame,
    sentAtMs: normalizedTimelineMs,
    sourceSentAtMs: frame.sentAtMs
  });
  if (buffer.frames.length > buffer.maxSize) {
    buffer.frames.splice(0, buffer.frames.length - buffer.maxSize);
  }
  pruneAvatarPoseBuffer(buffer, nowMs);
  return { accepted: true, reason: "accepted" };
}

export function pruneAvatarPoseBuffer(buffer: AvatarPoseBuffer, nowMs = Date.now()): void {
  const minSentAtMs = nowMs - buffer.ttlMs;
  while (buffer.frames.length > 0 && buffer.frames[0]!.sentAtMs < minSentAtMs) {
    buffer.frames.shift();
  }
  if (buffer.frames.length > buffer.maxSize) {
    buffer.frames.splice(0, buffer.frames.length - buffer.maxSize);
  }
}

export function sampleAvatarPoseBuffer(buffer: AvatarPoseBuffer, renderAtMs: number): {
  previous: CompactPoseFrame | null;
  next: CompactPoseFrame | null;
  latest: CompactPoseFrame | null;
} {
  let previous: BufferedPoseFrame | null = null;
  let next: BufferedPoseFrame | null = null;
  for (const frame of buffer.frames) {
    if (frame.sentAtMs <= renderAtMs) {
      previous = frame;
      continue;
    }
    next = frame;
    break;
  }
  return {
    previous,
    next,
    latest: buffer.frames[buffer.frames.length - 1] ?? null
  };
}
