import { createRoomSessionV2Codec, type RoomSessionV2Claims } from "@vrata/shared-types/room-session-v2";
import type { RoomIdentityScope } from "./contracts.js";

/** Classification only, never authentication. The decoded deadline is a hint
 * to the existing codec: MAC, exact shape, scope and lifetime still get checked. */
export function verifyExpiredSession(token: unknown, secret: string, scope: RoomIdentityScope,
  nowSeconds: number): RoomSessionV2Claims | null {
  if (typeof token !== "string" || token.length > 4096 || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return null;
  const match = /^rs2\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match) return null;
  try {
    const deadline: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"))?.expiresAtSeconds;
    if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 1 || deadline > nowSeconds) return null;
    return createRoomSessionV2Codec(secret).verify(token, scope, deadline - 1);
  } catch { return null; }
}
