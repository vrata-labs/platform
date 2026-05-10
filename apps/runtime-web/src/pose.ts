export interface TransformLike {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
}

export interface NormalizedPoseTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export function normalizePoseTransform(input: TransformLike | null | undefined, fallback: TransformLike = {}): NormalizedPoseTransform {
  return {
    x: input?.x ?? fallback.x ?? 0,
    y: input?.y ?? fallback.y ?? 0,
    z: input?.z ?? fallback.z ?? 0,
    yaw: input?.yaw ?? fallback.yaw ?? 0,
    pitch: input?.pitch ?? fallback.pitch ?? 0,
    roll: input?.roll ?? fallback.roll ?? 0
  };
}

export function isStaleSeq(currentSeq: number | null | undefined, nextSeq: number | null | undefined): boolean {
  return typeof currentSeq === "number" && typeof nextSeq === "number" && nextSeq < currentSeq;
}
