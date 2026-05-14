import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type RemoteBrowserUrlErrorCode = "invalid_url" | "scheme_not_allowed" | "origin_not_allowed" | "private_address" | "dns_failed";

export interface RemoteBrowserUrlPolicy {
  allowedOrigins: string[];
  allowPrivateAllowedOrigins: boolean;
}

export interface RemoteBrowserUrlValidationResult {
  allowed: boolean;
  normalizedUrl?: string;
  errorCode?: RemoteBrowserUrlErrorCode;
  resolvedAddresses?: string[];
}

export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? "http://127.0.0.1:4000,http://localhost:4000")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return item.replace(/\/$/, "");
      }
    });
}

export function createRemoteBrowserUrlPolicy(env: NodeJS.ProcessEnv = process.env): RemoteBrowserUrlPolicy {
  return {
    allowedOrigins: parseAllowedOrigins(env.REMOTE_BROWSER_ALLOWED_ORIGINS),
    allowPrivateAllowedOrigins: env.REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS !== "false" && env.NODE_ENV !== "production"
  };
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1"
      || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("64:ff9b:1:")
      || normalized.startsWith("fe80:")
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized === "::";
  }
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

export async function validateRemoteBrowserUrl(input: string, policy: RemoteBrowserUrlPolicy): Promise<RemoteBrowserUrlValidationResult> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { allowed: false, errorCode: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, errorCode: "scheme_not_allowed" };
  }
  if (!policy.allowedOrigins.includes(url.origin)) {
    return { allowed: false, errorCode: "origin_not_allowed" };
  }
  if (policy.allowPrivateAllowedOrigins && (isLocalHostname(url.hostname) || (isIP(url.hostname) && isPrivateAddress(url.hostname)))) {
    return { allowed: true, normalizedUrl: url.toString(), resolvedAddresses: [url.hostname] };
  }
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    return { allowed: false, errorCode: "private_address", resolvedAddresses: [url.hostname] };
  }
  let resolvedAddresses: string[];
  try {
    resolvedAddresses = (await lookup(url.hostname, { all: true })).map((entry) => entry.address);
  } catch {
    return { allowed: false, errorCode: "dns_failed" };
  }
  if (resolvedAddresses.some(isPrivateAddress)) {
    return { allowed: false, errorCode: "private_address", resolvedAddresses };
  }
  return { allowed: true, normalizedUrl: url.toString(), resolvedAddresses };
}
