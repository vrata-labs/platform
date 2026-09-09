const sensitiveKeyPattern = /(authorization|cookie|password|secret|token|invite)/i;
const REDACTED_VALUE = "[redacted]";

function redactString(value: string): string {
  if (value.length > 80 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return REDACTED_VALUE;
  }
  if (!/[?&](authorization|password|secret|token|invite)=/i.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveKeyPattern.test(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }
    return url.toString();
  } catch (_error) {
    return value.replace(/([?&][^=]*(?:authorization|password|secret|token|invite)[^=]*=)[^&]+/gi, `$1${REDACTED_VALUE}`);
  }
}

export function redactSecrets(value: unknown, key = ""): unknown {
  if (sensitiveKeyPattern.test(key)) {
    return REDACTED_VALUE;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]));
  }
  return value;
}
