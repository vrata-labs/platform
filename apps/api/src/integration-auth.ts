import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const INTEGRATION_CONTRACT = "platform-integration-v1";
export const INTEGRATION_AUDIENCE = "platform-integration-v1";
export const INTEGRATION_SCOPES = ["upsertTenant", "createRoom", "getRoom", "updateRoomAccess", "getOperation", "findOperation"] as const;
export type IntegrationScope = typeof INTEGRATION_SCOPES[number];

export const INTEGRATION_ASSERTION_MAX_LIFETIME_SECONDS = 60;
export const INTEGRATION_CLOCK_SKEW_SECONDS = 15;

const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ISSUER_PATTERN = /^portal:(stage|prod)$/;
const JTI_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface IntegrationKey {
  kid: string;
  issuer: string;
  scopes: ReadonlySet<IntegrationScope>;
  publicKey: KeyObject;
}

export type IntegrationKeyring = ReadonlyMap<string, IntegrationKey>;

export interface IntegrationPrincipal {
  principal: string;
  kid: string;
  scopes: ReadonlySet<IntegrationScope>;
  jti: string;
  replayUntilSeconds: number;
}

export type IntegrationAssertionResult =
  | { ok: true; value: IntegrationPrincipal }
  | { ok: false; reason: string };

function isScope(value: unknown): value is IntegrationScope {
  return typeof value === "string" && (INTEGRATION_SCOPES as readonly string[]).includes(value);
}

// VRATA_INTEGRATION_KEYS is a JSON array of public keys only:
// [{ "kid": "...", "issuer": "portal:stage", "scopes": ["createRoom"], "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "..." } }]
export function parseIntegrationKeys(raw: string | undefined): IntegrationKeyring {
  const keyring = new Map<string, IntegrationKey>();
  if (raw === undefined || raw.trim() === "") return keyring;
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("invalid_integration_keys:json");
  }
  if (!Array.isArray(entries)) throw new Error("invalid_integration_keys:not_array");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("invalid_integration_keys:entry");
    const { kid, issuer, scopes, publicKey } = entry as Record<string, unknown>;
    if (typeof kid !== "string" || !KID_PATTERN.test(kid)) throw new Error("invalid_integration_keys:kid");
    if (keyring.has(kid)) throw new Error(`invalid_integration_keys:duplicate_kid:${kid}`);
    if (typeof issuer !== "string" || !ISSUER_PATTERN.test(issuer)) throw new Error(`invalid_integration_keys:issuer:${kid}`);
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) throw new Error(`invalid_integration_keys:scopes:${kid}`);
    if (!publicKey || typeof publicKey !== "object") throw new Error(`invalid_integration_keys:public_key:${kid}`);
    const jwk = publicKey as Record<string, unknown>;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error(`invalid_integration_keys:public_key:${kid}`);
    if ("d" in jwk) throw new Error(`invalid_integration_keys:private_key_material:${kid}`);
    let keyObject: KeyObject;
    try {
      keyObject = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    } catch {
      throw new Error(`invalid_integration_keys:public_key:${kid}`);
    }
    if (keyObject.asymmetricKeyType !== "ed25519") throw new Error(`invalid_integration_keys:public_key:${kid}`);
    keyring.set(kid, { kid, issuer, scopes: new Set(scopes), publicKey: keyObject });
  }
  return keyring;
}

let cachedKeyring: { raw: string | undefined; keyring: IntegrationKeyring } | null = null;

export function loadIntegrationKeyring(env: NodeJS.ProcessEnv = process.env): IntegrationKeyring {
  const raw = env.VRATA_INTEGRATION_KEYS;
  if (cachedKeyring && cachedKeyring.raw === raw) return cachedKeyring.keyring;
  const keyring = parseIntegrationKeys(raw);
  cachedKeyring = { raw, keyring };
  return keyring;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseScopeClaim(value: unknown): string[] | null {
  if (typeof value === "string") return value.split(" ").filter(Boolean);
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value as string[];
  return null;
}

// Verifies the signature first and reads claims only from a verified payload.
export function verifyIntegrationAssertion(token: string | null, keyring: IntegrationKeyring, nowSeconds = Math.floor(Date.now() / 1000)): IntegrationAssertionResult {
  if (!token) return { ok: false, reason: "missing_assertion" };
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(part => BASE64URL_PATTERN.test(part))) return { ok: false, reason: "malformed_assertion" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJsonSegment(encodedHeader);
  if (!header || header.alg !== "EdDSA" || typeof header.kid !== "string" || "crit" in header) return { ok: false, reason: "unsupported_header" };
  const key = keyring.get(header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.byteLength !== 64 || !verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key.publicKey, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }
  const claims = decodeJsonSegment(encodedPayload);
  if (!claims) return { ok: false, reason: "malformed_claims" };
  if (claims.iss !== key.issuer) return { ok: false, reason: "issuer_mismatch" };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(INTEGRATION_AUDIENCE)) return { ok: false, reason: "audience_mismatch" };
  const { iat, exp, jti } = claims;
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isInteger(iat) || !Number.isInteger(exp)) return { ok: false, reason: "invalid_lifetime" };
  if (exp <= iat || exp - iat > INTEGRATION_ASSERTION_MAX_LIFETIME_SECONDS) return { ok: false, reason: "invalid_lifetime" };
  if (iat > nowSeconds + INTEGRATION_CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
  if (exp + INTEGRATION_CLOCK_SKEW_SECONDS <= nowSeconds) return { ok: false, reason: "expired" };
  if (typeof jti !== "string" || !JTI_PATTERN.test(jti)) return { ok: false, reason: "invalid_jti" };
  const requested = parseScopeClaim(claims.scope);
  if (!requested) return { ok: false, reason: "invalid_scope" };
  const scopes = new Set(requested.filter((scope): scope is IntegrationScope => isScope(scope) && key.scopes.has(scope)));
  return { ok: true, value: { principal: key.issuer, kid: key.kid, scopes, jti, replayUntilSeconds: exp + INTEGRATION_CLOCK_SKEW_SECONDS } };
}
