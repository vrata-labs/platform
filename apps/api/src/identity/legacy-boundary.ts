import type { Storage } from "../storage-contracts.js";

export class IdentityBoundaryError extends Error {
  constructor(readonly status: 401 | 409 | 426 | 503, readonly reason: "identity_upgrade_required" | "identity_recovery_required" | "identity_authority_unavailable" | "identity_session_expired") {
    super(reason); this.name = "IdentityBoundaryError";
  }
}

/** Rollback bridge: it never mints or redeems v2 credentials. */
export function createLegacyIdentityBoundary(storagePromise: Promise<Storage>) {
  let observedMinimum = 1;
  const minimum = async () => {
    if (observedMinimum >= 2) return observedMinimum;
    try {
      const value = await (await storagePromise).identityProtocol.minimum();
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_identity_protocol");
      observedMinimum = Math.max(observedMinimum, value);
      return observedMinimum;
    } catch { throw new IdentityBoundaryError(503, "identity_authority_unavailable"); }
  };
  const assertCompatible = async (roomId?: string) => {
    if (await minimum() >= 2) throw new IdentityBoundaryError(409, "identity_upgrade_required");
    if (roomId !== undefined) {
      let bound: boolean;
      try { bound = await (await storagePromise).hasRoomIdentityAuthority(roomId); }
      catch { throw new IdentityBoundaryError(503, "identity_authority_unavailable"); }
      if (bound) throw new IdentityBoundaryError(409, "identity_upgrade_required");
    }
  };
  return { minimum, assertCompatible };
}

export function legacyBoundaryApplies(method: string, pathname: string): boolean {
  if (method === "OPTIONS" || !pathname.startsWith("/api/")) return false;
  if (method === "POST" && /^\/api\/rooms\/[^/]+\/identity-recovery$/.test(pathname)) return false;
  return !(method === "GET" && ["/api/templates", "/api/assets", "/api/tenants", "/api/internal/identity-policy"].includes(pathname))
    && !(method === "POST" && ["/api/internal/identity-session/verify", "/api/tokens/state", "/api/tokens/remote-browser-media", "/api/personal-room"].includes(pathname));
}

export function legacyBoundaryAllowsAdministrator(pathname: string): boolean {
  return !pathname.startsWith("/api/tokens/") && pathname !== "/api/personal-room";
}
