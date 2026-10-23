import { createHmac, hkdfSync, randomBytes } from "node:crypto";

// One-time room entry codes of the portal integration (contract section 7). The code has 256 bits of entropy,
// travels only in the URL fragment and is stored as an HMAC under its own key domain of STATE_TOKEN_SECRET.
const GRANT_CODE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export function createGrantCode(): string {
  return randomBytes(32).toString("base64url");
}

export function isGrantCode(value: unknown): value is string {
  return typeof value === "string" && GRANT_CODE_PATTERN.test(value);
}

const keys = new Map<string, Buffer>();

export function grantCodeHash(secret: string, code: string): string {
  let key = keys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "vrata.integration.v1", "room-grant", 32));
    keys.set(secret, key);
  }
  return createHmac("sha256", key).update(code).digest("hex");
}

// The entry URL is built from the public runtime origin, never from the internal request host of the portal worker.
export function grantEntryUrl(runtimeBaseUrl: string | undefined, roomId: string, code: string): string | null {
  if (!runtimeBaseUrl) return null;
  let base: URL;
  try {
    base = new URL(runtimeBaseUrl);
  } catch {
    return null;
  }
  // Plain http only for a loopback runtime of a local test deployment.
  const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password) return null;
  return `${new URL(`/rooms/${roomId}`, base.origin).toString()}#grant=${code}`;
}
