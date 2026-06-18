import type { CompactPoseFrame } from "./avatar-types.js";

export function isCompactPoseFrame(input: unknown): input is CompactPoseFrame {
  if (!input || typeof input !== "object") {
    return false;
  }
  const payload = input as Record<string, unknown>;
  const root = payload.root as Record<string, unknown> | undefined;
  const locomotion = payload.locomotion as Record<string, unknown> | undefined;
  return typeof payload.seq === "number"
    && typeof payload.sentAtMs === "number"
    && typeof payload.flags === "number"
    && Boolean(root)
    && typeof root?.x === "number"
    && typeof root?.y === "number"
    && typeof root?.z === "number"
    && typeof root?.yaw === "number"
    && Boolean(locomotion)
    && typeof locomotion?.mode === "number"
    && typeof locomotion?.speed === "number"
    && typeof locomotion?.angularVelocity === "number";
}

export function parseCompactPoseFrame(input: unknown): CompactPoseFrame {
  if (!isCompactPoseFrame(input)) {
    throw new Error("invalid_compact_pose_frame");
  }
  return input;
}
