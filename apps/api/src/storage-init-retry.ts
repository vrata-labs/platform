const POSTGRES_INIT_MAX_ATTEMPTS = 12;
const POSTGRES_INIT_RETRY_DELAY_MS = 1000;
const RETRYABLE_POSTGRES_INIT_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);

type InitializableStorage = { init(): Promise<void> };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === "string") return maybeCode;
  const maybeCause = (error as { cause?: unknown }).cause;
  if (!maybeCause || typeof maybeCause !== "object") return undefined;
  const maybeCauseCode = (maybeCause as { code?: unknown }).code;
  return typeof maybeCauseCode === "string" ? maybeCauseCode : undefined;
}

function isRetryablePostgresInitError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && RETRYABLE_POSTGRES_INIT_ERROR_CODES.has(code)) return true;
  return error instanceof Error && /connect (ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)/.test(error.message);
}

export async function initPostgresStorageWithRetry(
  storage: InitializableStorage,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    onRetry?: (error: unknown, attempt: number, maxAttempts: number, retryDelayMs: number) => void;
    wait?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? POSTGRES_INIT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? POSTGRES_INIT_RETRY_DELAY_MS));
  const wait = options.wait ?? delay;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await storage.init();
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryablePostgresInitError(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt, maxAttempts, retryDelayMs);
      await wait(retryDelayMs);
    }
  }
}
