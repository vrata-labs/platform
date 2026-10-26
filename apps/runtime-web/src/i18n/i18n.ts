import { EN, RU, type MessageKey } from "./messages.js";

export type RuntimeLocale = "ru" | "en";
export type { MessageKey } from "./messages.js";

export const RUNTIME_LOCALES: readonly RuntimeLocale[] = ["ru", "en"];
// The tab keeps the language the participant chose; the portal keeps its own in the vrata-locale cookie of APP_HOST.
export const LOCALE_STORAGE_KEY = "vrata.locale";
export const PORTAL_LOCALE_COOKIE = "vrata-locale";

const DICTIONARIES: Record<RuntimeLocale, Record<MessageKey, string>> = { en: EN, ru: RU };

export function isRuntimeLocale(value: unknown): value is RuntimeLocale {
  return value === "ru" || value === "en";
}

function fromLanguageTag(tag: string | null | undefined): RuntimeLocale | null {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return isRuntimeLocale(primary) ? primary : null;
}

export function readLocaleCookie(cookie: string): RuntimeLocale | null {
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === PORTAL_LOCALE_COOKIE) return fromLanguageTag(decodeURIComponent(value.join("=")));
  }
  return null;
}

/**
 * The language of the room UI: the one chosen in this tab, then ?lang=, then the portal's cookie, then the browser.
 * The grant's returnContext locale is the inviter's, so an invited guest's own browser wins over it.
 */
export function resolveRuntimeLocale(input: { stored: string | null; query: string | null; cookie: string; languages: readonly string[] }): RuntimeLocale {
  return fromLanguageTag(input.stored) ?? fromLanguageTag(input.query) ?? readLocaleCookie(input.cookie)
    ?? input.languages.map(fromLanguageTag).find(isRuntimeLocale) ?? "en";
}

let current: RuntimeLocale = "en";
const listeners = new Set<(locale: RuntimeLocale) => void>();

export function currentLocale(): RuntimeLocale {
  return current;
}

export function t(key: MessageKey, params: Record<string, string | number> = {}, locale: RuntimeLocale = current): string {
  return DICTIONARIES[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match);
}

export function setLocale(locale: RuntimeLocale): void {
  if (locale === current) return;
  current = locale;
  for (const listener of listeners) listener(locale);
}

export function onLocaleChange(listener: (locale: RuntimeLocale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Text whose language follows a later switch: a status line keeps the key, not the rendered string. */
export interface LocalizedText {
  key: MessageKey;
  params?: Record<string, string | number>;
}

export function renderText(text: string | LocalizedText): string {
  return typeof text === "string" ? text : t(text.key, text.params);
}
