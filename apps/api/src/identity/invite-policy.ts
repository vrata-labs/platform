import type { RoomInviteRecord } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";

export function assertV2InviteInput(input: { role: RoomInviteRecord["role"]; expiresAt: string; tokenHash: string; waitingRoomEnabled: boolean }, now = Date.now): void {
  const lifetime = Date.parse(input.expiresAt) - now();
  if (!["guest", "member", "presenter", "host"].includes(input.role)
    || typeof input.waitingRoomEnabled !== "boolean"
    || typeof input.tokenHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.tokenHash)
    || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 30 * 24 * 60 * 60_000) {
    throw new IdentityStorageError("invalid_identity_input");
  }
}
