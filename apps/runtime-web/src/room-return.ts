import type { RuntimeLocale } from "./i18n/i18n.js";

export type RoomReturnUrls = Record<RuntimeLocale, string>;

interface ReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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
    /** A new exchange replaces the way back; one without it leaves none, not the previous one. */
    remember(value: unknown) {
      urls = parseRoomReturnUrls(value);
      try {
        if (urls) storage.setItem(key, JSON.stringify(urls));
        else storage.removeItem(key);
      } catch { /* kept for this page only */ }
    },
    urlFor: (locale: RuntimeLocale): string | null => urls?.[locale] ?? null
  };
}

export type LeaveSpaceStep = "end_xr" | "remove_presence" | "stop_session" | "navigate" | "show_left";

/**
 * Leaving the space, in order: out of XR first (the page cannot navigate from an immersive session), then the presence
 * goes while the session token is still valid, then media and room-state stop, and only then the page goes back.
 * A session the room already stopped (paused, removed, ended) has nothing left to remove or stop.
 */
export function planLeaveSpace(input: { xrPresenting: boolean; sessionActive: boolean; admitted: boolean; returnUrl: string | null }): LeaveSpaceStep[] {
  return [
    ...(input.xrPresenting ? ["end_xr" as const] : []),
    ...(input.sessionActive && input.admitted ? ["remove_presence" as const] : []),
    ...(input.sessionActive ? ["stop_session" as const] : []),
    input.returnUrl ? "navigate" : "show_left"
  ];
}
