export interface ReconnectPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export function createReconnectPolicy(overrides?: Partial<ReconnectPolicy>): ReconnectPolicy {
  return {
    maxRetries: overrides?.maxRetries ?? 3,
    baseDelayMs: overrides?.baseDelayMs ?? 1000,
    maxDelayMs: overrides?.maxDelayMs ?? 8000
  };
}

export function getReconnectDelayMs(attempt: number, policy: ReconnectPolicy): number {
  const expDelay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(expDelay, policy.maxDelayMs);
}

export function canRetry(attempt: number, policy: ReconnectPolicy): boolean {
  return attempt < policy.maxRetries;
}
