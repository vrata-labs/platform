import { AccessToken } from "livekit-server-sdk";

export const MEDIA_TOKEN_DEFAULT_TTL_SECONDS = 900;
export const MEDIA_TOKEN_MAX_TTL_SECONDS = 86_400;

/** Exactly the user media video grant; publish sources are not narrowed here. */
export interface MediaCredentialGrant {
  readonly room: string;
  readonly roomJoin: true;
  readonly canPublish: boolean;
  readonly canSubscribe: true;
}

/** Request-independent primitives captured before signing; nothing retains the request, its body, env or context. */
export interface MediaCredentialPlan {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly identity: string;
  readonly name: string;
  readonly grant: MediaCredentialGrant;
  readonly ttlSeconds: number;
  /** The original proof's expiry: no media credential outlives it. */
  readonly proofExpiresAtSeconds: number;
  readonly livekitUrl: string;
}

/** A signed JWT and its absolute expiry, released only through `releaseMediaCredential`. */
export interface PreparedMediaCredential {
  readonly token: string;
  readonly expiresAtSeconds: number;
}

export interface MediaCredentialReply {
  readonly token: string;
  readonly expiresInSeconds: number;
  readonly livekitUrl: string;
}

export type MediaCredentialOutcome =
  | { readonly kind: "reply"; readonly reply: MediaCredentialReply }
  | { readonly kind: "proof_expired" }
  | { readonly kind: "preparation_expired" };

const CLAIMS = ["exp", "iss", "nbf", "sub", "video"];
const NAMED_CLAIMS = ["exp", "iss", "name", "nbf", "sub", "video"];
const GRANT = ["canPublish", "canSubscribe", "room", "roomJoin"];
const PROOF_EXPIRED: MediaCredentialOutcome = Object.freeze({ kind: "proof_expired" });
const PREPARATION_EXPIRED: MediaCredentialOutcome = Object.freeze({ kind: "preparation_expired" });

/** Unset is the default; anything else must be a canonical decimal in 1..86400. Null when invalid; the raw value is never echoed. */
export function resolveMediaTokenTtlSeconds(raw: string | undefined): number | null {
  if (raw === undefined) return MEDIA_TOKEN_DEFAULT_TTL_SECONDS;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const ttlSeconds = Number(raw);
  return Number.isSafeInteger(ttlSeconds) && ttlSeconds <= MEDIA_TOKEN_MAX_TTL_SECONDS ? ttlSeconds : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A frozen copy of exactly the plan primitives and the four grant fields; throws on anything malformed. */
export function captureMediaCredentialPlan(input: MediaCredentialPlan): MediaCredentialPlan {
  const { apiKey, apiSecret, identity, name, grant, ttlSeconds, proofExpiresAtSeconds, livekitUrl } = input;
  const { room, roomJoin, canPublish, canSubscribe } = grant;
  if (!nonEmpty(apiKey) || !nonEmpty(apiSecret) || !nonEmpty(identity) || typeof name !== "string" || typeof livekitUrl !== "string"
    || !nonEmpty(room) || roomJoin !== true || typeof canPublish !== "boolean" || canSubscribe !== true
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MEDIA_TOKEN_MAX_TTL_SECONDS
    || !Number.isSafeInteger(proofExpiresAtSeconds) || proofExpiresAtSeconds < 1) throw new Error("invalid_media_credential_plan");
  return Object.freeze({ apiKey, apiSecret, identity, name, grant: Object.freeze({ room, roomJoin, canPublish, canSubscribe }),
    ttlSeconds, proofExpiresAtSeconds, livekitUrl });
}

function clockSeconds(nowMs: number): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) throw new Error("invalid_media_credential_clock");
  return nowSeconds;
}

function signedClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const exactKeys = (value: object, keys: readonly string[]) => Object.keys(value).sort().join() === keys.join();

/** The SDK's signed payload must carry exactly the planned semantics. A fixed message: never the key, a claim or the token. */
function assertSignedClaims(token: string, plan: MediaCredentialPlan, expiresAtSeconds: number): void {
  const claims = signedClaims(token);
  const video = claims?.video;
  const named = plan.name.length > 0;
  if (!claims || !exactKeys(claims, named ? NAMED_CLAIMS : CLAIMS) || claims.sub !== plan.identity || named && claims.name !== plan.name
    || claims.iss !== plan.apiKey || claims.nbf !== 0 || claims.exp !== expiresAtSeconds
    || typeof video !== "object" || video === null || Array.isArray(video) || !exactKeys(video, GRANT)) {
    throw new Error("media_credential_claims_mismatch");
  }
  const signed = video as Record<string, unknown>;
  if (signed.room !== plan.grant.room || signed.roomJoin !== true || signed.canPublish !== plan.grant.canPublish
    || signed.canSubscribe !== true) throw new Error("media_credential_claims_mismatch");
}

/** One clock reading fixes the absolute expiry: the configured lifetime, capped by the original proof; nothing is signed once
 * that proof has lapsed. The SDK turns a numeric constructor ttl into a relative "Ns" span while its signer passes a numeric
 * public field through as the NumericDate, so the absolute expiry is assigned after construction. Await outside every fence. */
export async function signMediaCredential(plan: MediaCredentialPlan, nowMs: number): Promise<PreparedMediaCredential | null> {
  const nowSeconds = clockSeconds(nowMs);
  const expiresAtSeconds = Math.min(nowSeconds + plan.ttlSeconds, plan.proofExpiresAtSeconds);
  if (expiresAtSeconds <= nowSeconds) return null;
  const accessToken = new AccessToken(plan.apiKey, plan.apiSecret, { identity: plan.identity, name: plan.name });
  accessToken.ttl = expiresAtSeconds;
  accessToken.addGrant({ ...plan.grant });
  const token = await accessToken.toJwt();
  assertSignedClaims(token, plan, expiresAtSeconds);
  return Object.freeze({ token, expiresAtSeconds });
}

/** Pure and synchronous on the release's one clock reading: the original proof's lapse first, then the prepared JWT's. A live
 * proof never re-signs here; the reported lifetime is the exact remainder with no minimum. */
export function releaseMediaCredential(plan: MediaCredentialPlan, prepared: PreparedMediaCredential, nowMs: number): MediaCredentialOutcome {
  const nowSeconds = clockSeconds(nowMs);
  if (plan.proofExpiresAtSeconds <= nowSeconds) return PROOF_EXPIRED;
  if (prepared.expiresAtSeconds <= nowSeconds) return PREPARATION_EXPIRED;
  return { kind: "reply", reply: { token: prepared.token, expiresInSeconds: prepared.expiresAtSeconds - nowSeconds, livekitUrl: plan.livekitUrl } };
}
