import { createHmac, timingSafeEqual } from "node:crypto";

import { getRoomPermissions, isRoomPermission, isRoomRole, type RoomPermission, type RoomRole } from "./access.js";

export type RoomSessionRoleSource = "default" | "dev-query" | "trusted";

export interface RoomSessionTokenPayload {
  tenantId: string;
  roomId: string;
  participantId: string;
  displayName: string;
  role: RoomRole;
  roleSource?: RoomSessionRoleSource;
  permissions: RoomPermission[];
  sessionId: string;
  iat: number;
  exp: number;
  jti: string;
}

export type RoomSessionTokenErrorCode =
  | "missing_token"
  | "malformed_token"
  | "invalid_signature"
  | "invalid_payload"
  | "expired_token"
  | "room_mismatch"
  | "tenant_mismatch"
  | "participant_mismatch";

export type RoomSessionTokenVerificationResult =
  | { ok: true; payload: RoomSessionTokenPayload }
  | { ok: false; code: RoomSessionTokenErrorCode };

export interface RoomSessionTokenVerificationOptions {
  nowSeconds?: number;
  roomId?: string;
  tenantId?: string;
  participantId?: string;
}

function isObjectRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRoomSessionRoleSource(input: unknown): input is RoomSessionRoleSource {
  return input === "default" || input === "dev-query" || input === "trusted";
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function normalizeRoomSessionPermissions(role: RoomRole, input: unknown): RoomPermission[] {
  const permissions = new Set<RoomPermission>(getRoomPermissions(role));
  if (Array.isArray(input)) {
    for (const item of input) {
      if (isRoomPermission(item)) {
        permissions.add(item);
      }
    }
  }
  return [...permissions];
}

export function parseRoomSessionTokenPayload(input: unknown): RoomSessionTokenPayload | null {
  if (!isObjectRecord(input)) {
    return null;
  }
  if (typeof input.tenantId !== "string"
    || typeof input.roomId !== "string"
    || typeof input.participantId !== "string"
    || typeof input.displayName !== "string"
    || !isRoomRole(input.role)
    || typeof input.sessionId !== "string"
    || typeof input.iat !== "number"
    || typeof input.exp !== "number"
    || typeof input.jti !== "string") {
    return null;
  }
  if (!input.tenantId || !input.roomId || !input.participantId || !input.sessionId || !input.jti) {
    return null;
  }
  return {
    tenantId: input.tenantId,
    roomId: input.roomId,
    participantId: input.participantId,
    displayName: input.displayName,
    role: input.role,
    roleSource: isRoomSessionRoleSource(input.roleSource) ? input.roleSource : "default",
    permissions: normalizeRoomSessionPermissions(input.role, input.permissions),
    sessionId: input.sessionId,
    iat: input.iat,
    exp: input.exp,
    jti: input.jti
  };
}

export function signRoomSessionToken(payload: RoomSessionTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    permissions: normalizeRoomSessionPermissions(payload.role, payload.permissions)
  }), "utf8").toString("base64url");
  return `${body}.${signBody(body, secret)}`;
}

export function verifyRoomSessionToken(
  token: string | null | undefined,
  secret: string,
  options: RoomSessionTokenVerificationOptions = {}
): RoomSessionTokenVerificationResult {
  if (!token) {
    return { ok: false, code: "missing_token" };
  }
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    return { ok: false, code: "malformed_token" };
  }
  if (!safeEqual(signBody(body, secret), signature)) {
    return { ok: false, code: "invalid_signature" };
  }
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "invalid_payload" };
  }
  const payload = parseRoomSessionTokenPayload(rawPayload);
  if (!payload) {
    return { ok: false, code: "invalid_payload" };
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSeconds) {
    return { ok: false, code: "expired_token" };
  }
  if (options.roomId !== undefined && payload.roomId !== options.roomId) {
    return { ok: false, code: "room_mismatch" };
  }
  if (options.tenantId !== undefined && payload.tenantId !== options.tenantId) {
    return { ok: false, code: "tenant_mismatch" };
  }
  if (options.participantId !== undefined && payload.participantId !== options.participantId) {
    return { ok: false, code: "participant_mismatch" };
  }
  return { ok: true, payload };
}
