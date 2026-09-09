import { isEnabledEnvValue } from "./feature-flags.js";

function parseBooleanEnv(value: string | undefined): boolean | null {
  return isEnabledEnvValue(value);
}

function isLoopbackLivekitHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function isInsecureLoopbackLivekitUrlAllowed(livekitUrl: string, env: NodeJS.ProcessEnv): boolean {
  if (parseBooleanEnv(env.VRATA_ALLOW_INSECURE_PRODUCTION_URLS) !== true) {
    return false;
  }
  try {
    const parsed = new URL(livekitUrl);
    return parsed.protocol === "ws:" && isLoopbackLivekitHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function getLivekitCredentials(env: NodeJS.ProcessEnv = process.env): { apiKey: string; apiSecret: string } {
  return {
    apiKey: env.LIVEKIT_API_KEY ?? "devkey",
    apiSecret: env.LIVEKIT_API_SECRET ?? "secret"
  };
}

function hasDevLivekitCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const { apiKey, apiSecret } = getLivekitCredentials(env);
  return apiKey === "devkey" || apiSecret === "secret" || apiSecret === "devsecret";
}

export function getMediaTokenConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production") {
    return null;
  }
  const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter((name) => !env[name] || env[name]?.trim().length === 0);
  if (missing.length > 0) {
    return `missing_required_livekit_env:${missing.join(",")}`;
  }
  const livekitUrl = env.LIVEKIT_URL ?? "";
  if (!livekitUrl.startsWith("wss://") && !isInsecureLoopbackLivekitUrlAllowed(livekitUrl, env)) {
    return "livekit_url_must_use_wss";
  }
  if (hasDevLivekitCredentials(env)) {
    return "livekit_dev_credentials_forbidden";
  }
  return null;
}

function parsePortEnv(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && String(parsed) === normalized && parsed > 0 && parsed <= 65535 ? parsed : null;
}

export function getLivekitDeploymentDiagnostics(env: NodeJS.ProcessEnv = process.env) {
  const livekitUrl = env.LIVEKIT_URL?.trim() ?? "";
  let livekitUrlProtocol: string | null = null;
  let livekitUrlHost: string | null = null;
  if (livekitUrl) {
    try {
      const parsed = new URL(livekitUrl);
      livekitUrlProtocol = parsed.protocol.replace(/:$/, "");
      livekitUrlHost = parsed.host;
    } catch {
      livekitUrlProtocol = "invalid";
    }
  }

  return {
    configured: Boolean(livekitUrl && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
    signalingTls: livekitUrl.startsWith("wss://"),
    urlProtocol: livekitUrlProtocol,
    urlHost: livekitUrlHost,
    turn: {
      enabled: parseBooleanEnv(env.LIVEKIT_TURN_ENABLED) === true,
      domain: env.LIVEKIT_TURN_DOMAIN?.trim() || null,
      tlsPort: parsePortEnv(env.LIVEKIT_TURN_TLS_PORT),
      udpPort: parsePortEnv(env.LIVEKIT_TURN_UDP_PORT),
      externalTls: parseBooleanEnv(env.LIVEKIT_TURN_EXTERNAL_TLS) === true,
      relayRange: env.LIVEKIT_TURN_RELAY_RANGE_START && env.LIVEKIT_TURN_RELAY_RANGE_END
        ? {
          start: parsePortEnv(env.LIVEKIT_TURN_RELAY_RANGE_START),
          end: parsePortEnv(env.LIVEKIT_TURN_RELAY_RANGE_END)
        }
        : null
    }
  };
}
