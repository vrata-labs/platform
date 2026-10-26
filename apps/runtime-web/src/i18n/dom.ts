import { currentLocale, isRuntimeLocale, LOCALE_STORAGE_KEY, onLocaleChange, setLocale, t, type MessageKey, type RuntimeLocale } from "./i18n.js";

const ATTRIBUTES: Array<[string, (element: HTMLElement, text: string) => void]> = [
  ["data-i18n", (element, text) => { element.textContent = text; }],
  ["data-i18n-placeholder", (element, text) => { element.setAttribute("placeholder", text); }],
  ["data-i18n-aria-label", (element, text) => { element.setAttribute("aria-label", text); }],
  ["data-i18n-title", (element, text) => { element.setAttribute("title", text); }]
];

/** Renders the static texts marked with data-i18n* attributes in the current language. */
export function translateStaticText(document: Document): void {
  document.documentElement.lang = currentLocale();
  document.title = t("document.title");
  for (const [attribute, apply] of ATTRIBUTES) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(`[${attribute}]`))) {
      apply(element, t(element.getAttribute(attribute) as MessageKey));
    }
  }
}

/**
 * A language switch: changes the texts in place, so the origin, the address and the room session stay as they are.
 * The choice is kept in the tab only.
 */
export function bindLanguageSwitch(select: HTMLSelectElement, storage: () => Pick<Storage, "setItem">): void {
  select.value = currentLocale();
  onLocaleChange((locale) => { select.value = locale; });
  select.addEventListener("change", () => {
    const next: RuntimeLocale | null = isRuntimeLocale(select.value) ? select.value : null;
    if (!next) return;
    try { storage().setItem(LOCALE_STORAGE_KEY, next); } catch { /* the choice lasts for this page only */ }
    setLocale(next);
  });
}
