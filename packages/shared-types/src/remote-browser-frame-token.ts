// Node-only subpath. Never re-export this codec from the browser types entry.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface RemoteBrowserFrameTokenPayload {
  readonly v: 2;
  readonly roomId: string;
  readonly objectId: string;
  readonly executorSessionId: string;
  readonly executorInstanceId: string;
  readonly frameStreamId: string;
  readonly exp: number;
}

export type RemoteBrowserFrameBinding = Omit<RemoteBrowserFrameTokenPayload, "v" | "exp">;

export interface RemoteBrowserFrameTokenDecodeOptions {
  nowSeconds?: number;
}

export const FRAME_TOKEN_MAX_TTL_SECONDS = 600;
export const FRAME_TOKEN_CLOCK_SKEW_SECONDS = 30;
export const FRAME_TOKEN_MAX_BYTES = 8192;

export class InvalidRemoteBrowserFrameTokenError extends Error {
  constructor() {
    super("remote_browser_frame_token_invalid");
    this.name = "InvalidRemoteBrowserFrameTokenError";
  }
}

export class RemoteBrowserFrameTokenConfigError extends Error {
  constructor() {
    super("remote_browser_frame_token_config_invalid");
    this.name = "RemoteBrowserFrameTokenConfigError";
  }
}

// The domain prefix keeps v2 MACs disjoint from the legacy HMAC(body) frame token.
const macDomain = "vrata.frame.v2\n";
const claimKeys = ["v", "roomId", "objectId", "executorSessionId", "executorInstanceId", "frameStreamId", "exp"];
const maxScopeIdLength = 200;
// Session and frame stream ids derive from objectId (<= 222 chars); only the instance suffix is free-form.
const maxCompositeIdLength = 512;
const maxLeadSeconds = FRAME_TOKEN_MAX_TTL_SECONDS + FRAME_TOKEN_CLOCK_SKEW_SECONDS;
const tokenPattern = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
// Unicode mode reads valid pairs as one astral code point, so only unpaired surrogates match. JSON.stringify
// escapes those to six bytes each, which would let in-limit ids encode past FRAME_TOKEN_MAX_BYTES.
const unpairedSurrogate = /\p{Cs}/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isScopeId = (value: unknown, maxLength: number): value is string => typeof value === "string" && value.length > 0
  && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value) && !unpairedSurrogate.test(value);
const isExpiry = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number.isSafeInteger(Number(value) * 1000);

function requireSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.trim().length === 0) throw new RemoteBrowserFrameTokenConfigError();
  return secret;
}

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(macDomain).update(body).digest();
}

/** Shared by token producer, token consumer, and API body validation. Does not enforce exact keys. */
export function isRemoteBrowserFrameBinding(input: unknown): input is RemoteBrowserFrameBinding {
  if (!isRecord(input)) return false;
  const { roomId, objectId, executorSessionId, executorInstanceId, frameStreamId } = input;
  if (!isScopeId(roomId, maxScopeIdLength) || !isScopeId(objectId, maxScopeIdLength)) return false;
  const sessionId = `remote-browser:${objectId}`;
  const instancePrefix = `${sessionId}:instance:`;
  return executorSessionId === sessionId
    && frameStreamId === `${sessionId}:frames`
    && isScopeId(executorInstanceId, maxCompositeIdLength)
    && executorInstanceId.startsWith(instancePrefix)
    && executorInstanceId.length > instancePrefix.length;
}

function readClaims(value: unknown): RemoteBrowserFrameTokenPayload | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== claimKeys.length || !claimKeys.every(key => keys.includes(key))) return null;
  const exp = value.exp;
  if (value.v !== 2 || !isExpiry(exp) || !isRemoteBrowserFrameBinding(value)) return null;
  const claims: RemoteBrowserFrameTokenPayload = {
    v: 2,
    roomId: value.roomId,
    objectId: value.objectId,
    executorSessionId: value.executorSessionId,
    executorInstanceId: value.executorInstanceId,
    frameStreamId: value.frameStreamId,
    exp
  };
  return Object.freeze(claims);
}

/** Pure: no clock is read, so expiry policy belongs to the caller and the decoder. */
export function encodeRemoteBrowserFrameToken(payload: RemoteBrowserFrameTokenPayload, secret: string): string {
  const key = requireSecret(secret);
  const claims = readClaims(payload);
  if (!claims) throw new InvalidRemoteBrowserFrameTokenError();
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const token = `${body}.${mac(key, body).toString("base64url")}`;
  // Base64url is ASCII, so length is bytes: never emit a token the decoder would refuse.
  if (token.length > FRAME_TOKEN_MAX_BYTES) throw new InvalidRemoteBrowserFrameTokenError();
  return token;
}

export function decodeRemoteBrowserFrameToken(
  token: string | null | undefined,
  secret: string,
  options: RemoteBrowserFrameTokenDecodeOptions = {}
): RemoteBrowserFrameTokenPayload | null {
  const key = requireSecret(secret);
  const clock = options?.nowSeconds ?? Date.now() / 1000;
  const nowSeconds = typeof clock === "number" ? Math.floor(clock) : Number.NaN;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0 || !isExpiry(nowSeconds + maxLeadSeconds)) return null;
  // The pattern admits ASCII only, so string length equals byte length here.
  if (typeof token !== "string" || token.length > FRAME_TOKEN_MAX_BYTES) return null;
  const match = tokenPattern.exec(token);
  if (!match) return null;
  const signature = Buffer.from(match[2], "base64url");
  const bodyBytes = Buffer.from(match[1], "base64url");
  if (signature.length !== 32 || signature.toString("base64url") !== match[2]
    || bodyBytes.toString("base64url") !== match[1]
    || !timingSafeEqual(signature, mac(key, match[1]))) return null;
  let claims: RemoteBrowserFrameTokenPayload | null;
  try {
    claims = readClaims(JSON.parse(bodyBytes.toString("utf8")));
  } catch {
    return null;
  }
  if (!claims || claims.exp <= nowSeconds || claims.exp > nowSeconds + maxLeadSeconds) return null;
  return claims;
}
