// Node-only, never re-export from the browser package root. The signed session
// proves identity continuity, not a role or an enduring permission grant.
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import type { RoomIdentityProof, RoomIdentityScope } from "./identity-credential.js";

export interface RoomSessionV2Claims extends RoomIdentityProof {
  version: 2;
  purpose: "room-session";
  sessionId: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
  nonce: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keys = ["version", "purpose", "tenantId", "roomId", "identityId", "participantId", "authEpoch", "sessionId", "issuedAtSeconds", "expiresAtSeconds", "nonce"];
const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);

function valid(value: unknown): value is RoomSessionV2Claims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as RoomSessionV2Claims;
  return Object.keys(claims).length === keys.length && keys.every(key => Object.hasOwn(claims, key))
    && claims.version === 2 && claims.purpose === "room-session"
    && validId(claims.tenantId) && validId(claims.roomId) && validId(claims.participantId)
    && uuid.test(claims.identityId) && uuid.test(claims.sessionId) && uuid.test(claims.nonce)
    && Number.isInteger(claims.authEpoch) && claims.authEpoch >= 1 && claims.authEpoch <= 2_147_483_647
    && Number.isSafeInteger(claims.issuedAtSeconds) && claims.issuedAtSeconds >= 0
    && Number.isSafeInteger(claims.expiresAtSeconds) && claims.expiresAtSeconds > claims.issuedAtSeconds
    && claims.expiresAtSeconds - claims.issuedAtSeconds <= 86_400;
}

export function createRoomSessionV2Codec(secret: string) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("identity_secret_too_short");
  const key = Buffer.from(hkdfSync("sha256", secret, "vrata.identity.v2", "room-session", 32));
  const mac = (body: string) => createHmac("sha256", key).update(body).digest();
  return {
    sign(proof: RoomIdentityProof, options: { nowSeconds?: number; lifetimeSeconds?: number; sessionId?: string } = {}): string {
      const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
      const claims: RoomSessionV2Claims = {
        version: 2, purpose: "room-session", tenantId: proof.tenantId, roomId: proof.roomId,
        identityId: proof.identityId, participantId: proof.participantId, authEpoch: proof.authEpoch,
        sessionId: options.sessionId ?? randomUUID(), issuedAtSeconds: now,
        expiresAtSeconds: now + (options.lifetimeSeconds ?? 900), nonce: randomUUID()
      };
      if (!valid(claims)) throw new Error("invalid_room_session_v2");
      const body = `rs2.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      return `${body}.${mac(body).toString("base64url")}`;
    },
    verify(token: unknown, scope: RoomIdentityScope, nowSeconds = Math.floor(Date.now() / 1000)): RoomSessionV2Claims | null {
      if (!validId(scope.tenantId) || !validId(scope.roomId) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0
        || typeof token !== "string" || token.length > 4096) return null;
      const match = /^rs2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return null;
      const signature = Buffer.from(match[2], "base64url");
      if (signature.length !== 32 || signature.toString("base64url") !== match[2]
        || !timingSafeEqual(signature, mac(`rs2.${match[1]}`))) return null;
      try {
        const bytes = Buffer.from(match[1], "base64url");
        if (bytes.toString("base64url") !== match[1]) return null;
        const claims: unknown = JSON.parse(bytes.toString("utf8"));
        if (!valid(claims) || claims.tenantId !== scope.tenantId || claims.roomId !== scope.roomId
          || claims.expiresAtSeconds <= nowSeconds || claims.issuedAtSeconds > nowSeconds + 30) return null;
        return claims;
      } catch { return null; }
    }
  };
}
