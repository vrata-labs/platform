export interface MotionSample {
  x: number;
  z: number;
  capturedAtMs: number;
}

export interface MotionTrack {
  samples: MotionSample[];
}

export function createMotionTrack(): MotionTrack {
  return { samples: [] };
}

export function pushMotionSample(track: MotionTrack, sample: MotionSample, maxSamples = 20): MotionTrack {
  const samples = [...track.samples, sample].sort((left, right) => left.capturedAtMs - right.capturedAtMs);
  while (samples.length > maxSamples) {
    samples.shift();
  }
  return { samples };
}

export function sampleMotion(track: MotionTrack, targetTimeMs: number): MotionSample | null {
  if (track.samples.length === 0) {
    return null;
  }

  if (track.samples.length === 1) {
    return track.samples[0] ?? null;
  }

  let previous = track.samples[0]!;
  let next = track.samples[track.samples.length - 1]!;

  for (let index = 1; index < track.samples.length; index += 1) {
    const candidate = track.samples[index]!;
    if (candidate.capturedAtMs >= targetTimeMs) {
      next = candidate;
      break;
    }
    previous = candidate;
  }

  if (next.capturedAtMs <= previous.capturedAtMs || targetTimeMs <= previous.capturedAtMs) {
    return previous;
  }

  if (targetTimeMs >= next.capturedAtMs) {
    return next;
  }

  const span = next.capturedAtMs - previous.capturedAtMs;
  const alpha = (targetTimeMs - previous.capturedAtMs) / span;

  return {
    x: previous.x + (next.x - previous.x) * alpha,
    z: previous.z + (next.z - previous.z) * alpha,
    capturedAtMs: targetTimeMs
  };
}
