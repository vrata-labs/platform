export interface RemoteBrowserServicePolicy {
  enabled: boolean;
  maxSessions: number;
  sessionTtlMs: number;
  viewport: { width: number; height: number };
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

export function resolveRemoteBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.REMOTE_BROWSER_ENABLED?.trim().toLowerCase();
  if (configured) return ["1", "true", "yes", "on"].includes(configured);
  return env.NODE_ENV !== "production";
}

export function resolveRemoteBrowserServicePolicy(env: NodeJS.ProcessEnv = process.env): RemoteBrowserServicePolicy {
  return {
    enabled: resolveRemoteBrowserEnabled(env),
    maxSessions: boundedInteger(env.REMOTE_BROWSER_MAX_SESSIONS, env.NODE_ENV === "production" ? 2 : 4, 1, 16),
    sessionTtlMs: boundedInteger(env.REMOTE_BROWSER_SESSION_TTL_SECONDS, 900, 30, 3600) * 1000,
    viewport: {
      width: boundedInteger(env.REMOTE_BROWSER_VIEWPORT_WIDTH, 1280, 320, 1920),
      height: boundedInteger(env.REMOTE_BROWSER_VIEWPORT_HEIGHT, 720, 180, 1080)
    }
  };
}

export function validateRemoteBrowserSessionIdentity(input: { sessionId: string; executorInstanceId: string; mediaParticipantId: string; objectId: string; frameStreamId?: string }): boolean {
  const expectedSessionId = `remote-browser:${input.objectId}`;
  return input.sessionId === expectedSessionId
    && input.mediaParticipantId === expectedSessionId
    && input.executorInstanceId.startsWith(`${expectedSessionId}:instance:`)
    && input.executorInstanceId.length > `${expectedSessionId}:instance:`.length
    && (!input.frameStreamId || input.frameStreamId === `${expectedSessionId}:frames`);
}

export function resolveRemoteBrowserFrameTokenSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.REMOTE_BROWSER_TOKEN_SECRET?.trim();
  if (secret) return secret;
  return env.NODE_ENV === "production" ? null : "dev-remote-browser-secret";
}

export function canStartRemoteBrowserSession(activeSessions: number, replacesExistingSession: boolean, maxSessions: number): boolean {
  return replacesExistingSession || activeSessions < maxSessions;
}

export function scheduleRemoteBrowserSessionExpiry(ttlMs: number, onExpire: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onExpire, ttlMs);
  timer.unref?.();
  return timer;
}
