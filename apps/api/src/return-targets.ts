// Where "Leave the space" takes a participant who entered by a portal grant (contract section 7, item 4).
// VRATA_RETURN_TARGETS is the portal's: a JSON object from a returnContext kind to { ru, en } https templates,
// where {id} stands for the returnContext id and may appear in the path only, plus "fallback" { ru, en } for a
// grant without a known kind. The platform fills the templates itself, so a grant never carries a URL and the
// runtime never builds one: there is no open redirect. Unset means the runtime shows no way back.
export type ReturnLocale = "ru" | "en";
export type ReturnUrls = Record<ReturnLocale, string>;
export type ReturnTargets = ReadonlyMap<string, ReturnUrls>;

export const RETURN_CONTEXT_KINDS = ["catalog-entry", "space", "workspace", "order", "preview"];
export const RETURN_CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LOCALES: readonly ReturnLocale[] = ["ru", "en"];

function fill(template: string, id: string): URL {
  return new URL(template.replace("{id}", id));
}

function parseTemplate(template: unknown, key: string, locale: string): string {
  const where = `${key}:${locale}`;
  if (typeof template !== "string" || template.length > 512) throw new Error(`invalid_return_targets:template:${where}`);
  const ids = template.split("{id}").length - 1;
  if (ids > (key === "fallback" ? 0 : 1)) throw new Error(`invalid_return_targets:id:${where}`);
  let first: URL;
  let second: URL;
  try {
    [first, second] = [fill(template, "a"), fill(template, "b")];
  } catch {
    throw new Error(`invalid_return_targets:url:${where}`);
  }
  if (first.protocol !== "https:" || first.username || first.password) throw new Error(`invalid_return_targets:url:${where}`);
  // The id may only change the path: never the host, the query or the fragment.
  if (first.origin !== second.origin || first.search !== second.search || first.hash !== second.hash) throw new Error(`invalid_return_targets:id:${where}`);
  return template;
}

export function parseReturnTargets(raw: string | undefined): ReturnTargets {
  const targets = new Map<string, ReturnUrls>();
  if (raw === undefined || raw.trim() === "") return targets;
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("invalid_return_targets:json");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid_return_targets:not_object");
  for (const [key, entry] of Object.entries(config)) {
    if (key !== "fallback" && !RETURN_CONTEXT_KINDS.includes(key)) throw new Error(`invalid_return_targets:kind:${key}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== "en,ru") {
      throw new Error(`invalid_return_targets:locales:${key}`);
    }
    const locales = entry as Record<string, unknown>;
    targets.set(key, { ru: parseTemplate(locales.ru, key, "ru"), en: parseTemplate(locales.en, key, "en") });
  }
  return targets;
}

let cached: { raw: string | undefined; targets: ReturnTargets } | null = null;

export function loadReturnTargets(env: NodeJS.ProcessEnv = process.env): ReturnTargets {
  const raw = env.VRATA_RETURN_TARGETS;
  if (!cached || cached.raw !== raw) cached = { raw, targets: parseReturnTargets(raw) };
  return cached.targets;
}

/** The way back for a grant's stored returnContext, in both languages; the fallback when its kind is not configured. */
export function resolveReturnUrls(targets: ReturnTargets, context: unknown): ReturnUrls | null {
  const { kind, id } = context && typeof context === "object" ? context as Record<string, unknown> : {};
  const templates = typeof kind === "string" && typeof id === "string" && RETURN_CONTEXT_ID_PATTERN.test(id) ? targets.get(kind) : undefined;
  if (templates) {
    const urls = {} as ReturnUrls;
    for (const locale of LOCALES) urls[locale] = fill(templates[locale], id as string).toString();
    return urls;
  }
  const fallback = targets.get("fallback");
  return fallback ? { ru: new URL(fallback.ru).toString(), en: new URL(fallback.en).toString() } : null;
}
