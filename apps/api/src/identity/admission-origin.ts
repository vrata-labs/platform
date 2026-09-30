import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** Caddy overwrites both private headers. Direct-port callers cannot choose
 * another peer by supplying X-Forwarded-For or an unsigned client address. */
export function identityAdmissionOriginHash(input: {
  peerAddress: string | undefined;
  proxyAddress: unknown;
  proxyToken: unknown;
  internalToken: string | null;
  signingSecret: string;
}): string {
  let peer = input.peerAddress || "unknown";
  if (typeof input.proxyAddress === "string" && isIP(input.proxyAddress) !== 0
    && typeof input.proxyToken === "string" && input.internalToken) {
    const provided = Buffer.from(input.proxyToken);
    const expected = Buffer.from(input.internalToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) peer = input.proxyAddress;
  }
  return createHmac("sha256", input.signingSecret).update(`room-identity-admission-v2:${peer.toLowerCase()}`).digest("hex");
}
