import { lookup, Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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

export function isRemoteBrowserOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return allowedOrigins.includes(origin);
  }

  return allowedOrigins.some((allowedOrigin) => {
    if (allowedOrigin === originUrl.origin) {
      return true;
    }
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(allowedOrigin);
    } catch {
      return false;
    }
    if (!allowedUrl.hostname.startsWith("*.")) {
      return false;
    }
    const suffix = allowedUrl.hostname.slice(2).toLowerCase();
    const hostname = originUrl.hostname.toLowerCase();
    return allowedUrl.protocol === originUrl.protocol
      && allowedUrl.port === originUrl.port
      && hostname !== suffix
      && hostname.endsWith(`.${suffix}`);
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
  if (!isRemoteBrowserOriginAllowed(url.origin, policy.allowedOrigins)) {
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

const specialIpv4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"
];
const specialIpv6 = ["2001::/23", "2001:db8::/32", "2002::/16", "3ffe::/16", "3fff::/20"];

function subnetList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix, extra] = cidr.split("/");
    const family = address && isIP(address);
    if (!family || !prefix || !/^\d{1,3}$/.test(prefix) || extra !== undefined) {
      throw new Error("invalid_public_https_cidr");
    }
    list.addSubnet(address, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

export function createPublicHttpsAddressPolicy(deploymentCidrs: string[]) {
  const blocked = subnetList([...specialIpv4, ...specialIpv6, ...deploymentCidrs]);
  const globalIpv6 = subnetList(["2000::/3"]);
  return (address: string): boolean => {
    switch (isIP(address)) {
      case 4: return !blocked.check(address);
      case 6: return globalIpv6.check(address, "ipv6") && !blocked.check(address, "ipv6");
      default: return false;
    }
  };
}

export interface PublicHttpsTarget {
  hostname: string;
  authority: string;
}

export function parsePublicHttpsTarget(input: string): PublicHttpsTarget | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isIP(hostname)) {
    const labels = hostname.split(".");
    const valid = labels.length >= 2 && hostname.length <= 253 && labels.every(
      label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    );
    if (!valid || /(?:^|\.)(localhost|local|internal|onion|home\.arpa)$/.test(hostname)) return;
  }
  return { hostname, authority: url.hostname };
}

export function createPublicHttpsResolver(addressAllowed: (address: string) => boolean) {
  return async (hostname: string, signal: AbortSignal): Promise<string[]> => {
    if (signal.aborted) throw new Error("dns_failed");
    if (isIP(hostname)) return addressAllowed(hostname) ? [hostname] : [];

    // An empty family is valid. NXDOMAIN, timeout, SERVFAIL and other
    // indeterminate answers fail the entire lookup even if the other family worked.
    const resolver = new Resolver({ timeout: 1200, tries: 2 });
    const cancel = () => resolver.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    const records = (answer: Promise<string[]>) => answer.catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENODATA") return [];
      throw new Error("dns_failed");
    });
    try {
      const [ipv4, ipv6] = await Promise.all([
        records(resolver.resolve4(`${hostname}.`)), records(resolver.resolve6(`${hostname}.`))
      ]);
      const addresses = [...new Set([...ipv4, ...ipv6])];
      if (!addresses.length) throw new Error("dns_failed");
      return addresses.every(addressAllowed) ? addresses : [];
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  };
}
