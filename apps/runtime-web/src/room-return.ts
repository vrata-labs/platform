import type { RuntimeLocale } from "./i18n/i18n.js";

export type RoomReturnUrls = Record<RuntimeLocale, string>;

interface ReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The way back the platform gave in the grant exchange; anything but two https addresses is no way back. */
export function parseRoomReturnUrls(value: unknown): RoomReturnUrls | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { ru, en } = value as Record<string, unknown>;
  const urls = { ru: httpsUrl(ru), en: httpsUrl(en) };
  return urls.ru && urls.en ? { ru: urls.ru, en: urls.en } : null;
}

/**
 * The tab keeps the way back next to the room identity: a reload or Back enters with the identity, not with the
 * spent grant, and must still know where "Leave the space" goes.
 */
export function createRoomReturnTab(storage: ReturnStorage, roomId: string) {
  const key = `vrata.return.${encodeURIComponent(roomId)}`;
  let urls: RoomReturnUrls | null = null;
  try { urls = parseRoomReturnUrls(JSON.parse(storage.getItem(key) ?? "null")); } catch { urls = null; }
  return {
    remember(value: unknown) {
      const parsed = parseRoomReturnUrls(value);
      if (!parsed) return;
      urls = parsed;
      try { storage.setItem(key, JSON.stringify(parsed)); } catch { /* kept for this page only */ }
    },
    urlFor: (locale: RuntimeLocale): string | null => urls?.[locale] ?? null
  };
}

export type LeaveSpaceStep = "end_xr" | "remove_presence" | "stop_session" | "navigate" | "show_left";

/**
 * Leaving the space, in order: out of XR first (the page cannot navigate from an immersive session), then the presence
 * goes while the session token is still valid, then media and room-state stop, and only then the page goes back.
 */
export function planLeaveSpace(input: { xrPresenting: boolean; admitted: boolean; returnUrl: string | null }): LeaveSpaceStep[] {
  return [
    ...(input.xrPresenting ? ["end_xr" as const] : []),
    ...(input.admitted ? ["remove_presence" as const] : []),
    "stop_session",
    input.returnUrl ? "navigate" : "show_left"
  ];
}
