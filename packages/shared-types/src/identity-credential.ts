// Node-only subpath. Never re-export this codec from the browser types entry.
import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface RoomIdentityScope { tenantId: string; roomId: string }
export interface RoomIdentityProof extends RoomIdentityScope {
  identityId: string;
  participantId: string;
  authEpoch: number;
}
export interface RoomIdentityCredential extends RoomIdentityProof {
  version: 2;
  purpose: "room-identity";
  issuedAtSeconds: number;
  expiresAtSeconds: number;
  nonce: string;
}

const maxLifetimeSeconds = 86_400;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
const epoch = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
const keys = ["version", "purpose", "tenantId", "roomId", "identityId", "participantId", "authEpoch", "issuedAtSeconds", "expiresAtSeconds", "nonce"];

function validProof(value: RoomIdentityProof): boolean {
  return identifier(value.tenantId) && identifier(value.roomId) && identifier(value.participantId)
    && typeof value.identityId === "string" && uuid.test(value.identityId) && epoch(value.authEpoch);
}

function validCredential(value: unknown): value is RoomIdentityCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as RoomIdentityCredential;
  return Object.keys(token).length === keys.length && keys.every(key => Object.hasOwn(token, key))
    && token.version === 2 && token.purpose === "room-identity" && validProof(token)
    && Number.isSafeInteger(token.issuedAtSeconds) && token.issuedAtSeconds >= 0
    && Number.isSafeInteger(token.expiresAtSeconds) && token.expiresAtSeconds > token.issuedAtSeconds
    && token.expiresAtSeconds - token.issuedAtSeconds <= maxLifetimeSeconds
    && typeof token.nonce === "string" && uuid.test(token.nonce);
}

export function createRoomIdentityCodec(secret: string) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("identity_secret_too_short");
  const derive = (purpose: string) => Buffer.from(hkdfSync("sha256", secret, "vrata.identity.v2", purpose, 32));
  const identityKey = derive("room-identity");
  const recoveryKey = derive("room-identity-recovery");
  const mac = (value: string) => createHmac("sha256", identityKey).update(value).digest();
  const recoveryHash = (scope: RoomIdentityScope, token: string) => createHmac("sha256", recoveryKey)
    .update(JSON.stringify([scope.tenantId, scope.roomId, token])).digest("hex");

  return {
    sign(proof: RoomIdentityProof, options: { nowSeconds?: number; lifetimeSeconds?: number } = {}): string {
      const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
      const credential: RoomIdentityCredential = {
        version: 2, purpose: "room-identity", tenantId: proof.tenantId, roomId: proof.roomId,
        identityId: proof.identityId, participantId: proof.participantId, authEpoch: proof.authEpoch,
        issuedAtSeconds: now, expiresAtSeconds: now + (options.lifetimeSeconds ?? 900), nonce: randomUUID()
      };
      if (!validCredential(credential)) throw new Error("invalid_identity_credential");
      const body = `ri2.${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;
      return `${body}.${mac(body).toString("base64url")}`;
    },
    verify(token: unknown, scope: RoomIdentityScope, nowSeconds = Math.floor(Date.now() / 1000)): RoomIdentityCredential | null {
      if (!identifier(scope.tenantId) || !identifier(scope.roomId) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0
        || typeof token !== "string" || token.length > 4096) return null;
      const match = /^ri2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return null;
      const signature = Buffer.from(match[2], "base64url");
      if (signature.length !== 32 || signature.toString("base64url") !== match[2]
        || !timingSafeEqual(signature, mac(`ri2.${match[1]}`))) return null;
      try {
        const bytes = Buffer.from(match[1], "base64url");
        if (bytes.toString("base64url") !== match[1]) return null;
        const payload: unknown = JSON.parse(bytes.toString("utf8"));
        if (!validCredential(payload) || payload.tenantId !== scope.tenantId || payload.roomId !== scope.roomId
          || payload.expiresAtSeconds <= nowSeconds || payload.issuedAtSeconds > nowSeconds + 30) return null;
        return payload;
      } catch { return null; }
    },
    createRecovery(scope: RoomIdentityScope): { recoveryId: string; credential: string; secretHash: string } {
      if (!identifier(scope.tenantId) || !identifier(scope.roomId)) throw new Error("invalid_identity_scope");
      const recoveryId = randomUUID();
      const credential = `rr2.${recoveryId}.${randomBytes(32).toString("base64url")}`;
      return { recoveryId, credential, secretHash: recoveryHash(scope, credential) };
    },
    parseRecovery(token: unknown, scope: RoomIdentityScope): { recoveryId: string; secretHash: string } | null {
      if (!identifier(scope.tenantId) || !identifier(scope.roomId) || typeof token !== "string" || token.length > 128) return null;
      const match = /^rr2\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match || !uuid.test(match[1]) || Buffer.from(match[2], "base64url").toString("base64url") !== match[2]) return null;
      return { recoveryId: match[1], secretHash: recoveryHash(scope, token) };
    }
  };
}
