import type { CompactPoseFrame } from "./avatar-types.js";

export interface AvatarPoseBuffer {
  frames: CompactPoseFrame[];
  maxSize: number;
  ttlMs: number;
  lastSeq: number | null;
  droppedStaleCount: number;
  droppedReorderCount: number;
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
    droppedReorderCount: 0
  };
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
  buffer.lastSeq = frame.seq;
  buffer.frames.push(frame);
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
  let previous: CompactPoseFrame | null = null;
  let next: CompactPoseFrame | null = null;
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
