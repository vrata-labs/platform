import type { IncomingMessage } from "node:http";

export function getRequestHost(request?: IncomingMessage): string | undefined {
  const forwarded = request?.headers["x-forwarded-host"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]?.trim();
  }
  const host = request?.headers.host;
  return typeof host === "string" && host.trim().length > 0 ? host.trim() : undefined;
}

export function getRequestProto(request?: IncomingMessage): "http" | "https" {
  const forwarded = request?.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    const proto = forwarded.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") {
      return "https";
    }
  }
  return "http";
}

export function getDefaultRoomStateUrl(request?: IncomingMessage): string {
  const host = getRequestHost(request);
  const proto = getRequestProto(request);
  const configuredRoomStateUrl = process.env.ROOM_STATE_PUBLIC_URL;
  if (configuredRoomStateUrl) {
    if (proto !== "https" || !configuredRoomStateUrl.startsWith("ws://") || !host) {
      return configuredRoomStateUrl;
    }
  }

  if (!host) {
    return configuredRoomStateUrl ?? "ws://127.0.0.1:2567";
  }

  const protocol = proto === "https" ? "wss" : "ws";
  const hostname = host.split(":")[0] ?? host;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}://${hostname}:2567`;
  }
  if (hostname.endsWith(".sslip.io")) {
    return `${protocol}://state.${hostname}`;
  }
  return `${protocol}://state-${hostname}`;
}

export function getDefaultLivekitUrl(request?: IncomingMessage): string {
  const host = getRequestHost(request);
  const proto = getRequestProto(request);
  const configuredLivekitUrl = process.env.LIVEKIT_URL;

  if (configuredLivekitUrl) {
    if (proto !== "https" || !configuredLivekitUrl.startsWith("ws://") || !host) {
      return configuredLivekitUrl;
    }
  }

  if (!host) {
    return configuredLivekitUrl ?? "ws://localhost:7880";
  }

  const protocol = proto === "https" ? "wss" : "ws";
  const hostname = host.split(":")[0] ?? host;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}://${hostname}:7880`;
  }
  if (hostname.endsWith(".sslip.io")) {
    return `${protocol}://livekit.${hostname}`;
  }
  return `${protocol}://livekit-${hostname}`;
}

export function getConfiguredPublicLivekitUrl(): string | null {
  const configured = process.env.LIVEKIT_PUBLIC_URL?.trim() || process.env.VRATA_LIVEKIT_DOMAIN?.trim() || process.env.NOAH_LIVEKIT_DOMAIN?.trim();
  if (!configured) {
    return null;
  }
  try {
    const url = new URL(configured.includes("://") ? configured : `wss://${configured}`);
    url.protocol = "wss:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getDefaultRemoteBrowserFrameStreamUrl(request?: IncomingMessage): string {
  const configured = process.env.REMOTE_BROWSER_PUBLIC_URL;
  if (configured) {
    const configuredUrl = new URL("/frames", configured);
    if (configuredUrl.protocol === "https:") {
      configuredUrl.protocol = "wss:";
    } else if (configuredUrl.protocol === "http:") {
      configuredUrl.protocol = "ws:";
    }
    return configuredUrl.toString();
  }
  const host = getRequestHost(request);
  const proto = getRequestProto(request);
  if (!host) {
    return "ws://localhost:4010/frames";
  }
  const protocol = proto === "https" ? "wss" : "ws";
  const hostname = host.split(":")[0] ?? host;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${protocol}://${hostname}:4010/frames`;
  }
  if (hostname.endsWith(".sslip.io")) {
    return `${protocol}://browser.${hostname}/frames`;
  }
  return `${protocol}://browser-${hostname}/frames`;
}
