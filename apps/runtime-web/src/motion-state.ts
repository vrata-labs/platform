export interface MotionSample {
  x: number;
  z: number;
  yaw?: number;
  pitch?: number;
  capturedAtMs: number;
}

export interface MotionTrack {
  samples: MotionSample[];
}

export function createMotionTrack(): MotionTrack {
  return { samples: [] };
}

export function pushMotionSample(track: MotionTrack, sample: MotionSample, maxSamples = 20): MotionTrack {
  const samples = [...track.samples];
  const existingIndex = samples.findIndex((item) => item.capturedAtMs === sample.capturedAtMs);

  if (existingIndex >= 0) {
    samples[existingIndex] = sample;
  } else {
    samples.push(sample);
    samples.sort((left, right) => left.capturedAtMs - right.capturedAtMs);
  }

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

  const yaw = typeof previous.yaw === "number" && typeof next.yaw === "number"
    ? previous.yaw + Math.atan2(Math.sin(next.yaw - previous.yaw), Math.cos(next.yaw - previous.yaw)) * alpha
    : previous.yaw ?? next.yaw;
  const pitch = typeof previous.pitch === "number" && typeof next.pitch === "number"
    ? previous.pitch + (next.pitch - previous.pitch) * alpha
    : previous.pitch ?? next.pitch;

  return {
    x: previous.x + (next.x - previous.x) * alpha,
    z: previous.z + (next.z - previous.z) * alpha,
    ...(typeof yaw === "number" ? { yaw } : {}),
    ...(typeof pitch === "number" ? { pitch } : {}),
    capturedAtMs: targetTimeMs
  };
}
