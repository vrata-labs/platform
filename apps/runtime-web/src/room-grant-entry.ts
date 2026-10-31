import { RuntimeAccessError } from "./index.js";

const GRANT_CODE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
// Failures after which the same code can still work; any other refusal spends it for this tab.
const RETRYABLE = new Set(["rate_limited", "dependency_unavailable", "grant_exchange_failed"]);

export interface PendingGrantStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A portal entry link carries a one-time code in the fragment (#grant=…). It leaves the address bar at once,
 * so it is not kept in history or shared by copying the URL, and waits in the tab until the exchange,
 * which runs after the guest has chosen a display name.
 */
async function codeDigest(code: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  return [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function takeRoomGrant(location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "replaceState" | "state">,
  storage: PendingGrantStorage, roomId: string) {
  const key = `vrata.grant.${encodeURIComponent(roomId)}`;
  // Digest of the code this tab already exchanged: opening the same link again must not spend another use.
  const spentKey = `${key}.spent`;
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const fromAddress = fragment.get("grant");
  if (fromAddress !== null) {
    fragment.delete("grant");
    const rest = fragment.toString();
    history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  }
  let code: string | null = fromAddress !== null && GRANT_CODE_PATTERN.test(fromAddress) ? fromAddress : null;
  try {
    if (code) storage.setItem(key, code);
    else {
      const stored = storage.getItem(key);
      code = stored && GRANT_CODE_PATTERN.test(stored) ? stored : null;
    }
  } catch { /* A storage-denied tab keeps the code for this page only. */ }
  return {
    code: () => code,
    clear() {
      code = null;
      try { storage.removeItem(key); } catch { /* ignored */ }
    },
    /** Whether a refusal leaves the code usable for another attempt. */
    retryable: (reason: string) => RETRYABLE.has(reason),
    async markSpent(value: string) {
      try { storage.setItem(spentKey, await codeDigest(value)); } catch { /* the tab may still exchange it again */ }
    },
    async wasSpent(value: string) {
      try { return storage.getItem(spentKey) === await codeDigest(value); } catch { return false; }
    }
  };
}

export interface RoomGrantExchange {
  roomId: string;
  participantId: string;
  identityCredential: string;
  cutoff: string;
  /** The way back the platform made of the grant's returnContext; checked by the room-return module before use. */
  returnUrls?: unknown;
}

/** Trades the code for a room identity; the normal v2 admission then renews it like any other. */
export async function exchangeRoomGrant(apiBaseUrl: string, roomId: string, code: string, displayName: string | null,
  fetchImpl: typeof fetch = fetch): Promise<RoomGrantExchange> {
  const name = displayName?.trim().slice(0, 40);
  const response = await fetchImpl(new URL("/api/room-grants/exchange", apiBaseUrl), {
    method: "POST",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId, code, ...(name ? { displayName: name } : {}) })
  });
  const payload = await response.json().catch(() => ({})) as { error?: { code?: unknown; requestId?: unknown } } & Partial<RoomGrantExchange>;
  if (!response.ok) {
    const reason = typeof payload.error?.code === "string" ? payload.error.code : "grant_exchange_failed";
    throw new RuntimeAccessError(response.status, reason, undefined, typeof payload.error?.requestId === "string" ? payload.error.requestId : undefined);
  }
  if (typeof payload.identityCredential !== "string" || typeof payload.participantId !== "string" || payload.roomId !== roomId) {
    throw new RuntimeAccessError(502, "grant_exchange_failed");
  }
  return payload as RoomGrantExchange;
}
