import type { AvatarReliableState } from "./avatar-types.js";

export function isAvatarReliableState(input: unknown): input is AvatarReliableState {
  if (!input || typeof input !== "object") {
    return false;
  }
  const payload = input as Record<string, unknown>;
  return typeof payload.participantId === "string"
    && typeof payload.avatarId === "string"
    && payload.recipeVersion === 1
    && typeof payload.inputMode === "string"
    && typeof payload.seated === "boolean"
    && typeof payload.muted === "boolean"
    && typeof payload.audioActive === "boolean"
    && typeof payload.updatedAt === "string";
}

export function parseAvatarReliableState(input: unknown): AvatarReliableState {
  if (!isAvatarReliableState(input)) {
    throw new Error("invalid_avatar_reliable_state");
  }
  return input;
}
