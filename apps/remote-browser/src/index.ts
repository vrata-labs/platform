import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import { WebSocketServer, type WebSocket } from "ws";
import type { RemoteBrowserErrorCode, RemoteBrowserExecutorInputState, RemoteBrowserMediaSourceRect, RemoteBrowserPatch, SurfaceInputEvent } from "@vrata/shared-types";

import { decodeRemoteBrowserFrameToken } from "./frame-token.js";
import { canStartRemoteBrowserSession, resolveRemoteBrowserFrameTokenSecret, resolveRemoteBrowserServicePolicy, scheduleRemoteBrowserSessionExpiry, validateRemoteBrowserSessionIdentity } from "./service-policy.js";
import { createRemoteBrowserUrlPolicy, validateRemoteBrowserUrl, type RemoteBrowserUrlPolicy } from "./url-policy.js";

interface RemoteBrowserSession {
  sessionId: string;
  executorInstanceId: string;
  frameStreamId?: string;
  mediaParticipantId: string;
  roomId: string;
  objectId: string;
  url: string;
  context: BrowserContext;
  page: Page;
  publisherPage: Page;
  clients: Set<WebSocket>;
  mediaClients: Set<WebSocket>;
  serviceAllowedOrigins: Set<string>;
  frameTimer: ReturnType<typeof setInterval>;
  frameCaptureInFlight: boolean;
  lastFrameAtMs: number;
  lastInputAtMs: number;
  lastInputFrameAtMs: number;
  publisherStarted: boolean;
  createdAtMs: number;
  expiresAtMs: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface RemoteBrowserMediaTokenResponse {
  token?: string;
  livekitUrl?: string;
  participantId?: string;
  expiresInSeconds?: number;
}

interface RemoteBrowserViewportPublishResult {
  videoTrackSid: string;
  audioTrackSid: string;
}

type RemoteBrowserSessionRef = Pick<RemoteBrowserSession, "sessionId" | "executorInstanceId" | "frameStreamId" | "roomId" | "objectId" | "mediaParticipantId">;

interface RemoteBrowserFrameCaptureDecisionInput {
  frameCaptureInFlight: boolean;
  writableClientCount: number;
  mediaClientCount: number;
  lastFrameAtMs: number;
  nowMs: number;
  mediaFrameIntervalMs: number;
  force?: boolean;
}

interface RemoteBrowserMediaOfferMessage {
  type?: string;
  offer?: RTCSessionDescriptionInit;
}

interface RemoteBrowserMediaAnswerResult {
  ok: boolean;
  answer?: RTCSessionDescriptionInit;
  hasVideo?: boolean;
  hasAudio?: boolean;
  trackKinds?: string[];
  sourceFrameUrl?: string;
  sourceRect?: RemoteBrowserMediaSourceRect;
  errorCode?: string;
}

const port = Number.parseInt(process.env.REMOTE_BROWSER_PORT ?? "4010", 10);
const viewport = resolveRemoteBrowserServicePolicy().viewport;
const require = createRequire(import.meta.url);

function resolveInternalHttpUrl(value: string | undefined, fallback: string): string {
  const resolved = value?.trim() || fallback;
  return resolved.replace(/\/$/, "");
}

function getInternalServiceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const scopedToken = env.REMOTE_BROWSER_INTERNAL_TOKEN?.trim();
  if (scopedToken) return scopedToken;
  if (env.NODE_ENV === "production") return null;
  const token = env.VRATA_INTERNAL_SERVICE_TOKEN?.trim() || env.NOAH_INTERNAL_SERVICE_TOKEN?.trim() || "";
  return token || null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthorizedInternalRequest(request: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = getInternalServiceToken(env);
  if (!token) {
    return env.NODE_ENV !== "production";
  }
  const provided = request.headers["x-vrata-internal-token"] ?? request.headers["x-noah-internal-token"];
  return typeof provided === "string" && safeEqual(provided, token);
}

export function resolveRemoteBrowserFrameIntervalMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "250", 10);
  return Math.max(250, Number.isFinite(parsed) ? parsed : 250);
}

export function resolveRemoteBrowserMediaFrameIntervalMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1000", 10);
  return Math.max(1000, Number.isFinite(parsed) ? parsed : 1000);
}

export function resolveRemoteBrowserFrameBackpressureBytes(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1000000", 10);
  return Math.max(0, Number.isFinite(parsed) ? parsed : 1000000);
}

export function shouldCaptureRemoteBrowserFrame(input: RemoteBrowserFrameCaptureDecisionInput): boolean {
  if (input.frameCaptureInFlight || input.writableClientCount <= 0) {
    return false;
  }
  if (input.force) {
    return true;
  }
  if (input.mediaClientCount <= 0 || input.lastFrameAtMs <= 0) {
    return true;
  }
  return input.nowMs - input.lastFrameAtMs >= input.mediaFrameIntervalMs;
}

const mediaOverlayPreserveMs = 3000;
const remoteBrowserPointerMoveSteps = 8;

export function remoteBrowserMouseMoveSteps(kind: SurfaceInputEvent["kind"]): number {
  return kind === "pointer-move" ? remoteBrowserPointerMoveSteps : 1;
}

export function shouldPreserveRemoteBrowserMediaOverlays(input: { lastInputAtMs: number; capturedAtMs: number; preserveMs?: number }): boolean {
  if (input.lastInputAtMs <= 0 || input.capturedAtMs < input.lastInputAtMs) {
    return false;
  }
  return input.capturedAtMs - input.lastInputAtMs <= (input.preserveMs ?? mediaOverlayPreserveMs);
}

const frameIntervalMs = resolveRemoteBrowserFrameIntervalMs(process.env.REMOTE_BROWSER_FRAME_INTERVAL_MS);
const mediaFrameIntervalMs = resolveRemoteBrowserMediaFrameIntervalMs(process.env.REMOTE_BROWSER_MEDIA_FRAME_INTERVAL_MS);
const frameBackpressureBytes = resolveRemoteBrowserFrameBackpressureBytes(process.env.REMOTE_BROWSER_FRAME_BACKPRESSURE_BYTES);
const mediaIceServers = resolveRemoteBrowserMediaIceServers(process.env.REMOTE_BROWSER_MEDIA_ICE_SERVERS);
const apiInternalUrl = resolveInternalHttpUrl(process.env.API_INTERNAL_URL ?? process.env.VRATA_API_INTERNAL_URL ?? process.env.NOAH_API_INTERNAL_URL, "http://127.0.0.1:4000");
const roomStateInternalUrl = resolveInternalHttpUrl(process.env.ROOM_STATE_INTERNAL_URL ?? process.env.VRATA_ROOM_STATE_INTERNAL_URL ?? process.env.NOAH_ROOM_STATE_INTERNAL_URL, "http://127.0.0.1:2567");
export const remoteBrowserCaptureTargetTitle = "Vrata Remote Browser";
export const remoteBrowserViewportPublisherTitle = "Vrata Capture Control";
export const remoteBrowserViewportPublisherButtonId = "vrata-remote-browser-start-capture";
export const remoteBrowserCurrentTabCaptureButtonId = "vrata-remote-browser-current-tab-capture";
const remoteBrowserCaptureTitleGuardKey = "__VRATA_REMOTE_BROWSER_CAPTURE_TITLE_GUARD__";
let activeListenPort = port;
const remoteBrowserScrollbarStyle = `
  html {
    scrollbar-gutter: stable !important;
    scrollbar-color: #64748b #e2e8f0 !important;
  }
  html::-webkit-scrollbar,
  body::-webkit-scrollbar,
  *::-webkit-scrollbar {
    width: 16px !important;
    height: 16px !important;
  }
  html::-webkit-scrollbar-thumb,
  body::-webkit-scrollbar-thumb,
  *::-webkit-scrollbar-thumb {
    background: #64748b !important;
    border: 3px solid #e2e8f0 !important;
    border-radius: 999px !important;
  }
  html::-webkit-scrollbar-track,
  body::-webkit-scrollbar-track,
  *::-webkit-scrollbar-track {
    background: #e2e8f0 !important;
  }
`;

export const remoteBrowserInitScript = (styleContent: string) => {
  type InputDebugState = {
    pointerMoveCount: number;
    mouseMoveCount: number;
    clickCount: number;
    lastType?: string;
    lastClientX?: number;
    lastClientY?: number;
    lastTarget?: string;
  };
  type InputDebugWindow = Window & { __VRATA_REMOTE_BROWSER_INPUT_DEBUG__?: InputDebugState };

  const installStyle = () => {
    const styleId = "vrata-remote-browser-scrollbar-style";
    if (document.getElementById(styleId)) {
      return;
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = styleContent;
    (document.head || document.documentElement).appendChild(style);
  };

  type FullscreenDocument = Document & {
    webkitFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
    msFullscreenElement?: Element | null;
  };
  type FullscreenDocumentPrototype = Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
    mozCancelFullScreen?: () => Promise<void> | void;
    msExitFullscreen?: () => Promise<void> | void;
  };

  const documentPrototype = Document.prototype as FullscreenDocumentPrototype;
  const nativeExitFullscreen = documentPrototype.exitFullscreen;
  const nativeWebkitExitFullscreen = documentPrototype.webkitExitFullscreen;
  const nativeMozCancelFullScreen = documentPrototype.mozCancelFullScreen;
  const nativeMsExitFullscreen = documentPrototype.msExitFullscreen;

  const noopFullscreen = () => Promise.resolve();
  const swallowPromise = (value: Promise<void> | void) => {
    if (value && typeof (value as Promise<void>).catch === "function") {
      (value as Promise<void>).catch(() => undefined);
    }
  };
  const getFullscreenElement = () => {
    const fullscreenDocument = document as FullscreenDocument;
    return fullscreenDocument.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? fullscreenDocument.mozFullScreenElement ?? fullscreenDocument.msFullscreenElement ?? null;
  };
  const exitFullscreen = () => {
    if (nativeExitFullscreen) {
      swallowPromise(nativeExitFullscreen.call(document));
      return;
    }
    if (nativeWebkitExitFullscreen) {
      swallowPromise(nativeWebkitExitFullscreen.call(document));
      return;
    }
    if (nativeMozCancelFullScreen) {
      swallowPromise(nativeMozCancelFullScreen.call(document));
      return;
    }
    if (nativeMsExitFullscreen) {
      swallowPromise(nativeMsExitFullscreen.call(document));
    }
  };
  const defineValue = (target: object, key: string, value: unknown) => {
    try {
      Object.defineProperty(target, key, { configurable: true, value });
    } catch {
      // Some browser-provided properties are non-configurable on specific pages.
    }
  };
  const defineGetter = (target: object, key: string, get: () => unknown) => {
    try {
      Object.defineProperty(target, key, { configurable: true, get });
    } catch {
      // Best-effort guard; playback should continue even if one property is locked.
    }
  };
  const targetLabel = (target: EventTarget | null): string | undefined => {
    if (!(target instanceof Element)) {
      return undefined;
    }
    const className = typeof target.className === "string" ? target.className.trim().replace(/\s+/g, ".") : "";
    return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${className ? `.${className.slice(0, 80)}` : ""}`;
  };
  const installInputDebug = () => {
    if (typeof window === "undefined") {
      return;
    }
    const inputWindow = window as InputDebugWindow;
    if (inputWindow.__VRATA_REMOTE_BROWSER_INPUT_DEBUG__) {
      return;
    }
    const state: InputDebugState = { pointerMoveCount: 0, mouseMoveCount: 0, clickCount: 0 };
    inputWindow.__VRATA_REMOTE_BROWSER_INPUT_DEBUG__ = state;
    const record = (event: MouseEvent | PointerEvent) => {
      if (event.type === "pointermove") {
        state.pointerMoveCount += 1;
      } else if (event.type === "mousemove") {
        state.mouseMoveCount += 1;
      } else if (event.type === "click") {
        state.clickCount += 1;
      }
      state.lastType = event.type;
      state.lastClientX = Math.round(event.clientX);
      state.lastClientY = Math.round(event.clientY);
      state.lastTarget = targetLabel(event.composedPath()[0] ?? event.target);
    };
    document.addEventListener("pointermove", record, true);
    document.addEventListener("mousemove", record, true);
    document.addEventListener("click", record, true);
  };

  defineValue(Element.prototype, "requestFullscreen", noopFullscreen);
  defineValue(Element.prototype, "webkitRequestFullscreen", noopFullscreen);
  defineValue(Element.prototype, "webkitRequestFullScreen", noopFullscreen);
  defineValue(Element.prototype, "mozRequestFullScreen", noopFullscreen);
  defineValue(Element.prototype, "msRequestFullscreen", noopFullscreen);
  defineGetter(Document.prototype, "fullscreenEnabled", () => false);
  defineGetter(Document.prototype, "webkitFullscreenEnabled", () => false);
  defineGetter(Document.prototype, "mozFullScreenEnabled", () => false);
  defineGetter(Document.prototype, "msFullscreenEnabled", () => false);
  defineValue(HTMLVideoElement.prototype, "webkitEnterFullscreen", () => undefined);
  defineValue(HTMLVideoElement.prototype, "webkitExitFullscreen", () => undefined);
  defineValue(HTMLVideoElement.prototype, "webkitSetPresentationMode", () => undefined);
  const onFullscreenChange = () => {
    if (getFullscreenElement()) {
      exitFullscreen();
    }
  };
  document.addEventListener("fullscreenchange", onFullscreenChange, true);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange, true);
  document.addEventListener("mozfullscreenchange", onFullscreenChange, true);
  document.addEventListener("MSFullscreenChange", onFullscreenChange, true);

  installStyle();
  installInputDebug();
  document.addEventListener("DOMContentLoaded", installStyle, { once: true });
  document.addEventListener("DOMContentLoaded", installInputDebug, { once: true });
};

let browserPromise: Promise<Browser> | null = null;
const sessions = new Map<string, RemoteBrowserSession>();
const pendingSessionIds = new Set<string>();
const closingSessions = new Set<RemoteBrowserSession>();
const urlPolicy = createRemoteBrowserUrlPolicy();
const requestIds = new WeakMap<IncomingMessage, string>();
const metrics = {
  requestsTotal: 0,
  requestFailuresTotal: 0,
  socketDisconnectsTotal: 0,
  sessionsStartedTotal: new Map<string, number>(),
  sessionsStoppedTotal: new Map<string, number>(),
  deniedTotal: new Map<string, number>(),
  ttlExpiredTotal: 0
};

export function remoteBrowserViewportPublisherHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${remoteBrowserViewportPublisherTitle}</title></head><body><button id="${remoteBrowserViewportPublisherButtonId}" type="button" style="position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;z-index:2147483647;">Start capture</button></body></html>`;
}

export function remoteBrowserCaptureTitleGuard(title: string): void {
  const pageWindow = window as Window & { [remoteBrowserCaptureTitleGuardKey]?: number };
  const existing = pageWindow[remoteBrowserCaptureTitleGuardKey];
  if (typeof existing === "number") {
    window.clearInterval(existing);
  }
  const applyTitle = () => {
    if (document.title !== title) {
      document.title = title;
    }
  };
  applyTitle();
  pageWindow[remoteBrowserCaptureTitleGuardKey] = window.setInterval(applyTitle, 100);
}

function getRemoteBrowserViewportPublisherUrl(): string {
  return `http://127.0.0.1:${activeListenPort}/internal/viewport-publisher`;
}

function getRemoteBrowserViewportPublisherOrigin(): string {
  return new URL(getRemoteBrowserViewportPublisherUrl()).origin;
}

export function createRemoteBrowserViewportCaptureOptions(size: { width: number; height: number } = viewport): DisplayMediaStreamOptions {
  return {
    video: {
      displaySurface: "browser",
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: size.width },
      height: { ideal: size.height }
    },
    audio: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "include"
  } as unknown as DisplayMediaStreamOptions;
}

export function createRemoteBrowserCurrentTabCaptureOptions(size: { width: number; height: number } = viewport): DisplayMediaStreamOptions {
  return {
    video: {
      displaySurface: "browser",
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: size.width },
      height: { ideal: size.height }
    },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    systemAudio: "include"
  } as unknown as DisplayMediaStreamOptions;
}

export function createRemoteBrowserAudioCaptureOptions(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 }
    }
  };
}

export function remoteBrowserServiceUrlOrigins(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:" && url.protocol !== "https:" && url.protocol !== "http:") {
    return [];
  }
  const origins = new Set<string>();
  for (const protocol of ["wss", "https", "ws", "http"]) {
    origins.add(`${protocol}://${url.host}`);
  }
  return [...origins];
}

export function shouldRequestPublicLivekitUrlForPage(pageUrl: string): boolean {
  try {
    return new URL(pageUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, statusCode: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function getHeaderString(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function requestId(request: IncomingMessage): string {
  const existing = requestIds.get(request);
  if (existing) {
    return existing;
  }
  const id = getHeaderString(request, "x-request-id")?.trim() || randomUUID();
  requestIds.set(request, id);
  return id;
}

function incrementCounter(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function formatMetricLine(name: string, value: number, labels?: Record<string, string>): string {
  const labelText = labels
    ? `{${Object.entries(labels).map(([key, item]) => `${key}="${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
    : "";
  return `${name}${labelText} ${value}`;
}

function remoteBrowserMetricsText(): string {
  let frameClients = 0;
  let mediaClients = 0;
  for (const session of sessions.values()) {
    frameClients += session.clients.size;
    mediaClients += session.mediaClients.size;
  }
  return `${[
    "# HELP vrata_remote_browser_requests_total Total remote-browser HTTP requests handled by this process.",
    "# TYPE vrata_remote_browser_requests_total counter",
    formatMetricLine("vrata_remote_browser_requests_total", metrics.requestsTotal),
    "# HELP vrata_remote_browser_request_failures_total Total unhandled remote-browser HTTP request failures.",
    "# TYPE vrata_remote_browser_request_failures_total counter",
    formatMetricLine("vrata_remote_browser_request_failures_total", metrics.requestFailuresTotal),
    "# HELP vrata_remote_browser_sessions Active remote-browser sessions.",
    "# TYPE vrata_remote_browser_sessions gauge",
    formatMetricLine("vrata_remote_browser_sessions", sessions.size),
    "# HELP vrata_remote_browser_sessions_active Active remote-browser sessions.",
    "# TYPE vrata_remote_browser_sessions_active gauge",
    formatMetricLine("vrata_remote_browser_sessions_active", sessions.size),
    "# HELP vrata_remote_browser_sessions_started_total Remote-browser session starts by result.",
    "# TYPE vrata_remote_browser_sessions_started_total counter",
    ...["success", "failed"].map((result) => formatMetricLine("vrata_remote_browser_sessions_started_total", metrics.sessionsStartedTotal.get(result) ?? 0, { result })),
    "# HELP vrata_remote_browser_sessions_stopped_total Remote-browser session cleanup by bounded reason.",
    "# TYPE vrata_remote_browser_sessions_stopped_total counter",
    ...["manual", "replaced", "expired", "shutdown"].map((reason) => formatMetricLine("vrata_remote_browser_sessions_stopped_total", metrics.sessionsStoppedTotal.get(reason) ?? 0, { reason })),
    "# HELP vrata_remote_browser_denied_total Remote-browser requests denied by bounded reason.",
    "# TYPE vrata_remote_browser_denied_total counter",
    ...["disabled", "forbidden", "invalid_binding", "session_limit", "start_in_progress", "url_policy", "token_config"].map((reason) => formatMetricLine("vrata_remote_browser_denied_total", metrics.deniedTotal.get(reason) ?? 0, { reason })),
    "# HELP vrata_remote_browser_ttl_expired_total Remote-browser sessions cleaned up after TTL expiry.",
    "# TYPE vrata_remote_browser_ttl_expired_total counter",
    formatMetricLine("vrata_remote_browser_ttl_expired_total", metrics.ttlExpiredTotal),
    "# HELP vrata_remote_browser_frame_clients Connected frame websocket clients.",
    "# TYPE vrata_remote_browser_frame_clients gauge",
    formatMetricLine("vrata_remote_browser_frame_clients", frameClients),
    "# HELP vrata_remote_browser_media_clients Connected media websocket clients.",
    "# TYPE vrata_remote_browser_media_clients gauge",
    formatMetricLine("vrata_remote_browser_media_clients", mediaClients),
    "# HELP vrata_remote_browser_disconnects_total Remote-browser websocket disconnects.",
    "# TYPE vrata_remote_browser_disconnects_total counter",
    formatMetricLine("vrata_remote_browser_disconnects_total", metrics.socketDisconnectsTotal)
  ].join("\n")}\n`;
}

function html(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function parseBody<T>(request: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 128) {
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch {
        resolve(null);
      }
    });
    request.on("error", reject);
  });
}

async function getBrowser(): Promise<Browser> {
  const executablePath =
    process.env.REMOTE_BROWSER_CHROMIUM_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    undefined;
  const headless = process.env.REMOTE_BROWSER_HEADLESS === "true" || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  browserPromise ??= chromium.launch({
    executablePath,
    headless,
    args: remoteBrowserChromiumArgs()
  });
  return browserPromise;
}

export function remoteBrowserChromiumArgs(size: { width: number; height: number } = viewport): string[] {
  return [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-usermedia-screen-capturing",
    "--use-fake-ui-for-media-stream",
    "--auto-accept-this-tab-capture",
    "--allow-http-screen-capture",
    "--alsa-input-device=pulse",
    "--alsa-output-device=pulse",
    `--auto-select-tab-capture-source-by-title=${remoteBrowserCaptureTargetTitle}`,
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--window-size=${size.width},${size.height}`
  ];
}

export function resolveRemoteBrowserMediaIceServers(value: string | undefined): RTCIceServer[] {
  const urls = (value ?? "stun:stun.l.google.com:19302")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return urls.length > 0 ? [{ urls }] : [];
}

let liveKitClientBundlePath: string | null = null;

function resolveLiveKitClientBundlePath(): string {
  if (liveKitClientBundlePath) {
    return liveKitClientBundlePath;
  }
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve("livekit-client/package.json"));
  } catch {
    let resolved = dirname(require.resolve("livekit-client"));
    while (resolved && !resolved.endsWith("livekit-client")) {
      const parent = dirname(resolved);
      if (parent === resolved) {
        break;
      }
      resolved = parent;
    }
    packageRoot = resolved;
  }
  const candidates = [
    "dist/livekit-client.umd.min.js",
    "dist/livekit-client.umd.js",
    "dist/livekit-client.esm.mjs"
  ].map((candidate) => join(packageRoot, candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("livekit_client_bundle_missing");
  }
  liveKitClientBundlePath = found;
  return found;
}

function remoteBrowserExecutorInputEventId(session: RemoteBrowserSessionRef, kind: string): string {
  return `${session.sessionId}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function getInternalHeaders(): Record<string, string> {
  const token = getInternalServiceToken();
  return {
    "content-type": "application/json",
    ...(token ? { "x-vrata-internal-token": token } : {})
  };
}

async function requestRemoteBrowserMediaToken(session: RemoteBrowserSession): Promise<Required<Pick<RemoteBrowserMediaTokenResponse, "token" | "livekitUrl">>> {
  const response = await fetch(`${apiInternalUrl}/api/tokens/remote-browser-media`, {
    method: "POST",
    headers: getInternalHeaders(),
    body: JSON.stringify({
      roomId: session.roomId,
      objectId: session.objectId,
      executorSessionId: session.sessionId,
      executorInstanceId: session.executorInstanceId,
      mediaParticipantId: session.mediaParticipantId,
      preferPublicLivekitUrl: shouldRequestPublicLivekitUrlForPage(session.page.url() || session.url)
    })
  });
  if (!response.ok) {
    throw new Error(`livekit_token_failed:${response.status}`);
  }
  const payload = await response.json() as RemoteBrowserMediaTokenResponse;
  if (!payload.token || !payload.livekitUrl) {
    throw new Error("livekit_token_failed:invalid_payload");
  }
  return { token: payload.token, livekitUrl: payload.livekitUrl };
}

async function prepareViewportPublisherPage(session: RemoteBrowserSession): Promise<void> {
  await session.page.evaluate(remoteBrowserCaptureTitleGuard, remoteBrowserCaptureTargetTitle).catch(() => undefined);
  try {
    await session.publisherPage.goto(getRemoteBrowserViewportPublisherUrl(), { waitUntil: "domcontentloaded", timeout: 5000 });
  } catch {
    await session.publisherPage.setContent(remoteBrowserViewportPublisherHtml(), { waitUntil: "domcontentloaded" });
  }
  await session.publisherPage.evaluate((title) => {
    document.title = title;
  }, remoteBrowserViewportPublisherTitle).catch(() => undefined);
}

async function waitForPagePaint(page: Page): Promise<void> {
  await page.bringToFront().catch(() => undefined);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  })).catch(() => undefined);
}

async function grantPageDisplayCapture(session: RemoteBrowserSession, page: Page, origin: string): Promise<void> {
  const cdp = await session.context.newCDPSession(page);
  try {
    const targetInfo = await cdp.send("Target.getTargetInfo").catch(() => null) as { targetInfo?: { browserContextId?: string } } | null;
    const browserContextId = targetInfo?.targetInfo?.browserContextId;
    await cdp.send("Browser.grantPermissions", {
      origin,
      permissions: ["displayCapture"],
      ...(browserContextId ? { browserContextId } : {})
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function grantViewportPublisherDisplayCapture(session: RemoteBrowserSession): Promise<void> {
  await grantPageDisplayCapture(session, session.publisherPage, getRemoteBrowserViewportPublisherOrigin());
}

async function grantCurrentTabDisplayCapture(session: RemoteBrowserSession): Promise<void> {
  await grantPageDisplayCapture(session, session.page, new URL(session.page.url()).origin);
}

async function patchRemoteBrowserExecutorState(session: RemoteBrowserSessionRef, patch: RemoteBrowserPatch): Promise<void> {
  const response = await fetch(`${roomStateInternalUrl}/api/internal/remote-browser/sessions/${encodeURIComponent(session.sessionId)}`, {
    method: "POST",
    headers: getInternalHeaders(),
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      roomId: session.roomId,
      surfaceId: "debug-main",
      objectId: session.objectId,
      executorInstanceId: session.executorInstanceId,
      frameStreamId: session.frameStreamId,
      patch
    })
  });
  if (!response.ok) {
    throw new Error(`room_state_callback_failed:${response.status}`);
  }
}

function remoteBrowserPublishErrorCode(error: unknown): RemoteBrowserErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("livekit_token_failed")) {
    return "livekit_token_failed";
  }
  if (message.includes("NotAllowedError") || message.includes("Permission denied")) {
    return "viewport_capture_denied";
  }
  if (message.includes("getDisplayMedia") || message.includes("NotSupportedError") || message.includes("livekit_client_bundle_missing")) {
    return "viewport_capture_unsupported";
  }
  if (message.includes("audio_track_missing")) {
    return "audio_track_missing";
  }
  if (message.includes("video_track_missing")) {
    return "video_track_missing";
  }
  if (message.includes("livekit_publish_failed")) {
    return "livekit_publish_failed";
  }
  return "viewport_capture_failed";
}

function remoteBrowserSessionErrorCode(error: unknown): RemoteBrowserErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("remote_browser_disabled")) {
    return "remote_browser_disabled";
  }
  if (message.includes("session_limit_exceeded")) {
    return "session_limit_exceeded";
  }
  if (message.includes("session_start_in_progress")) {
    return "session_start_in_progress";
  }
  if (message.includes("invalid_session_binding")) {
    return "invalid_session_binding";
  }
  if (message.includes("url_not_allowed")) {
    return "url_not_allowed";
  }
  if (message.includes("redirect_not_allowed")) {
    return "redirect_not_allowed";
  }
  if (message.includes("navigation_failed")) {
    return "navigation_failed";
  }
  return "executor_crashed";
}

function remoteBrowserErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

async function publishViewportFromCapturePage(input: { page: Page; livekitUrl: string; token: string; captureOptions: DisplayMediaStreamOptions; audioOptions: MediaStreamConstraints; buttonId: string; removeButtonAfterCapture?: boolean }): Promise<RemoteBrowserViewportPublishResult> {
  await input.page.evaluate(({ livekitUrl: targetLivekitUrl, token: targetToken, displayMediaOptions, audioMediaOptions, buttonId, removeButtonAfterCapture }) => {
    type PublishResult = { ok?: boolean; videoTrackSid?: string; audioTrackSid?: string; errorCode?: string; message?: string };
    type PublishState = {
      room?: { disconnect: () => void };
      stream?: MediaStream;
      streams?: MediaStream[];
    };
    const pageWindow = window as Window & {
      LivekitClient?: any;
      LiveKitClient?: any;
      livekitClient?: any;
      __VRATA_REMOTE_BROWSER_LIVEKIT__?: PublishState;
      __VRATA_REMOTE_BROWSER_PUBLISH_RESULT__?: PublishResult;
    };
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;
    pageWindow.__VRATA_REMOTE_BROWSER_PUBLISH_RESULT__ = undefined;
    const removeCaptureButton = () => {
      if (removeButtonAfterCapture) {
        document.getElementById(buttonId)?.remove();
      }
    };

    const publish = async (): Promise<PublishResult> => {
      const LiveKit = pageWindow.LivekitClient ?? pageWindow.LiveKitClient ?? pageWindow.livekitClient;
      if (!LiveKit?.Room || !LiveKit?.Track) {
        return { ok: false, errorCode: "livekit_publish_failed", message: "livekit_client_missing" };
      }
      if (!navigator.mediaDevices?.getDisplayMedia) {
        return { ok: false, errorCode: "viewport_capture_unsupported", message: "getDisplayMedia_missing" };
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        return { ok: false, errorCode: "audio_track_missing", message: "getUserMedia_missing" };
      }
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__?.room?.disconnect();
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__?.stream?.getTracks().forEach((track) => track.stop());
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__?.streams?.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      let displayStream: MediaStream | null = null;
      let audioStream: MediaStream | null = null;
      const stopStreams = () => {
        displayStream?.getTracks().forEach((track) => track.stop());
        audioStream?.getTracks().forEach((track) => track.stop());
      };
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions as DisplayMediaStreamOptions);
      } catch (error) {
        removeCaptureButton();
        return { ok: false, errorCode: error instanceof DOMException && error.name === "NotAllowedError" ? "viewport_capture_denied" : "viewport_capture_failed", message: error instanceof Error ? `${error.name}:${error.message}` : "capture_failed" };
      }
      if (!displayStream) {
        return { ok: false, errorCode: "viewport_capture_failed", message: "display_stream_missing" };
      }
      removeCaptureButton();
      try {
        audioStream = await navigator.mediaDevices.getUserMedia(audioMediaOptions as MediaStreamConstraints);
      } catch (error) {
        stopStreams();
        return { ok: false, errorCode: "audio_track_missing", message: error instanceof Error ? `getUserMedia:${error.name}:${error.message}` : "getUserMedia_failed" };
      }
      if (!audioStream) {
        stopStreams();
        return { ok: false, errorCode: "audio_track_missing", message: "audio_stream_missing" };
      }
      const videoTrack = displayStream.getVideoTracks().find((track) => track.readyState === "live");
      const audioTrack = audioStream.getAudioTracks().find((track) => track.readyState === "live");
      if (!videoTrack) {
        stopStreams();
        return { ok: false, errorCode: "video_track_missing", message: "video_track_missing" };
      }
      if (!audioTrack) {
        stopStreams();
        return { ok: false, errorCode: "audio_track_missing", message: "audio_track_missing" };
      }
      try {
        const room = new LiveKit.Room({ adaptiveStream: false, dynacast: false });
        await room.connect(targetLivekitUrl, targetToken, { autoSubscribe: false });
        const videoPublication = await room.localParticipant.publishTrack(videoTrack, {
          name: "remote-browser-viewport",
          source: LiveKit.Track.Source.ScreenShare
        });
        const audioPublication = await room.localParticipant.publishTrack(audioTrack, {
          name: "remote-browser-audio",
          source: LiveKit.Track.Source.ScreenShareAudio ?? "screen_share_audio"
        });
        pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__ = { room, streams: [displayStream, audioStream] };
        return {
          ok: true,
          videoTrackSid: videoPublication.trackSid ?? videoPublication.sid ?? videoTrack.id,
          audioTrackSid: audioPublication.trackSid ?? audioPublication.sid ?? audioTrack.id
        };
      } catch (error) {
        stopStreams();
        return { ok: false, errorCode: "livekit_publish_failed", message: error instanceof Error ? error.message : "publish_failed" };
      }
    };

    if (!button) {
      pageWindow.__VRATA_REMOTE_BROWSER_PUBLISH_RESULT__ = { ok: false, errorCode: "viewport_capture_failed", message: "publisher_button_missing" };
      return;
    }
    button.onclick = () => {
      void publish()
        .then((result) => {
          pageWindow.__VRATA_REMOTE_BROWSER_PUBLISH_RESULT__ = result;
        })
        .catch((error: unknown) => {
          pageWindow.__VRATA_REMOTE_BROWSER_PUBLISH_RESULT__ = { ok: false, errorCode: "viewport_capture_failed", message: error instanceof Error ? error.message : "publish_exception" };
        });
    };
  }, { livekitUrl: input.livekitUrl, token: input.token, displayMediaOptions: input.captureOptions, audioMediaOptions: input.audioOptions, buttonId: input.buttonId, removeButtonAfterCapture: input.removeButtonAfterCapture === true });
  await waitForPagePaint(input.page);
  await input.page.click(`#${input.buttonId}`, { timeout: 5000 });
  const resultHandle = await input.page.waitForFunction(() => {
    const pageWindow = window as Window & { __VRATA_REMOTE_BROWSER_PUBLISH_RESULT__?: unknown };
    return pageWindow.__VRATA_REMOTE_BROWSER_PUBLISH_RESULT__ ?? false;
  }, undefined, { timeout: 45000 });
  const result = await resultHandle.jsonValue() as { ok?: boolean; videoTrackSid?: string; audioTrackSid?: string; errorCode?: string; message?: string };
  await resultHandle.dispose();
  if (!result.ok || !result.videoTrackSid || !result.audioTrackSid) {
    throw new Error(`${result.errorCode ?? "livekit_publish_failed"}:${result.message ?? "unknown"}`);
  }
  return { videoTrackSid: result.videoTrackSid, audioTrackSid: result.audioTrackSid };
}

async function publishViewportFromPublisherPage(session: RemoteBrowserSession, livekitUrl: string, token: string): Promise<RemoteBrowserViewportPublishResult> {
  await prepareViewportPublisherPage(session);
  await waitForPagePaint(session.page);
  await grantViewportPublisherDisplayCapture(session);
  await session.publisherPage.addScriptTag({ path: resolveLiveKitClientBundlePath() });
  const result = await publishViewportFromCapturePage({
    page: session.publisherPage,
    livekitUrl,
    token,
    captureOptions: createRemoteBrowserViewportCaptureOptions({ width: viewport.width, height: viewport.height }),
    audioOptions: createRemoteBrowserAudioCaptureOptions(),
    buttonId: remoteBrowserViewportPublisherButtonId
  });
  await session.page.bringToFront().catch(() => undefined);
  return result;
}

async function prepareCurrentTabCaptureButton(page: Page): Promise<void> {
  await page.evaluate((buttonId) => {
    document.getElementById(buttonId)?.remove();
    const button = document.createElement("button");
    button.id = buttonId;
    button.type = "button";
    button.textContent = "Start current tab capture";
    Object.assign(button.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "2px",
      height: "2px",
      opacity: "0.01",
      zIndex: "2147483647",
      pointerEvents: "auto"
    });
    document.documentElement.appendChild(button);
  }, remoteBrowserCurrentTabCaptureButtonId);
}

async function publishViewportFromCurrentTab(session: RemoteBrowserSession, livekitUrl: string, token: string): Promise<RemoteBrowserViewportPublishResult> {
  await waitForPagePaint(session.page);
  await grantCurrentTabDisplayCapture(session);
  await session.page.addScriptTag({ path: resolveLiveKitClientBundlePath() });
  await prepareCurrentTabCaptureButton(session.page);
  const result = await publishViewportFromCapturePage({
    page: session.page,
    livekitUrl,
    token,
    captureOptions: createRemoteBrowserCurrentTabCaptureOptions({ width: viewport.width, height: viewport.height }),
    audioOptions: createRemoteBrowserAudioCaptureOptions(),
    buttonId: remoteBrowserCurrentTabCaptureButtonId,
    removeButtonAfterCapture: true
  });
  await session.page.bringToFront().catch(() => undefined);
  return result;
}

async function publishViewportToLiveKit(session: RemoteBrowserSession): Promise<RemoteBrowserViewportPublishResult> {
  const { token, livekitUrl } = await requestRemoteBrowserMediaToken(session);
  for (const origin of remoteBrowserServiceUrlOrigins(livekitUrl)) {
    session.serviceAllowedOrigins.add(origin);
  }
  return await publishViewportFromCurrentTab(session, livekitUrl, token);
}

async function startViewportPublisher(session: RemoteBrowserSession): Promise<void> {
  if (session.publisherStarted) {
    return;
  }
  session.publisherStarted = true;
  try {
    await patchRemoteBrowserExecutorState(session, {
      type: "mark-publishing",
      mediaParticipantId: session.mediaParticipantId,
      inputEventId: remoteBrowserExecutorInputEventId(session, "publishing")
    });
    const mockViewport = process.env.REMOTE_BROWSER_VIEWPORT_MOCK === "1";
    const published = mockViewport
      ? {
        videoTrackSid: `mock-remote-browser-video:${session.objectId}:${Date.now()}`,
        audioTrackSid: `mock-remote-browser-audio:${session.objectId}:${Date.now()}`
      }
      : await publishViewportToLiveKit(session);
    if (sessions.get(session.sessionId) !== session) return;
    await patchRemoteBrowserExecutorState(session, {
      type: "mark-active",
      mediaParticipantId: session.mediaParticipantId,
      mediaTrackSid: published.videoTrackSid,
      audioTrackSid: published.audioTrackSid,
      inputEventId: remoteBrowserExecutorInputEventId(session, "active")
    });
    if (!mockViewport) {
      void reportRemoteBrowserMediaSourceRect(session).catch(() => undefined);
    }
  } catch (error) {
    if (sessions.get(session.sessionId) !== session) return;
    await patchRemoteBrowserExecutorState(session, {
      type: "mark-failed",
      errorCode: remoteBrowserPublishErrorCode(error),
      errorDetail: remoteBrowserErrorDetail(error),
      inputEventId: remoteBrowserExecutorInputEventId(session, "failed")
    }).catch(() => undefined);
  }
}

async function reportRemoteBrowserMediaSourceRect(session: RemoteBrowserSession): Promise<void> {
  const rect = await waitForRemoteBrowserMediaSourceRect(session.page);
  await patchRemoteBrowserMediaSourceRect(session, rect, "source-rect");
}

async function refreshRemoteBrowserMediaSourceRect(session: RemoteBrowserSession): Promise<void> {
  const rect = await resolveRemoteBrowserMediaSourceRect(session.page);
  await patchRemoteBrowserMediaSourceRect(session, rect, "source-rect-input");
}

async function patchRemoteBrowserMediaSourceRect(session: RemoteBrowserSession, rect: RemoteBrowserMediaSourceRect | undefined, kind: string): Promise<void> {
  if (!rect || sessions.get(session.sessionId) !== session) {
    return;
  }
  await patchRemoteBrowserExecutorState(session, {
    type: "mark-source-rect",
    mediaSourceRect: rect,
    inputEventId: remoteBrowserExecutorInputEventId(session, kind)
  });
}

function getWritableFrameClients(session: RemoteBrowserSession): WebSocket[] {
  return Array.from(session.clients).filter((client) => client.readyState === client.OPEN && client.bufferedAmount <= frameBackpressureBytes);
}

function broadcastFrame(session: RemoteBrowserSession, clients: WebSocket[], dataUrl: string): void {
  const payload = JSON.stringify({
    type: "frame",
    sessionId: session.sessionId,
    frameStreamId: session.frameStreamId,
    width: viewport.width,
    height: viewport.height,
    dataUrl,
    capturedAtMs: session.lastFrameAtMs,
    preserveMediaOverlays: shouldPreserveRemoteBrowserMediaOverlays({
      lastInputAtMs: session.lastInputAtMs,
      capturedAtMs: session.lastFrameAtMs
    })
  });
  for (const client of clients) {
    if (client.readyState === client.OPEN && client.bufferedAmount <= frameBackpressureBytes) {
      client.send(payload);
    }
  }
}

async function captureFrame(session: RemoteBrowserSession, options: { force?: boolean } = {}): Promise<void> {
  const writableClients = getWritableFrameClients(session);
  if (!shouldCaptureRemoteBrowserFrame({
    frameCaptureInFlight: session.frameCaptureInFlight,
    writableClientCount: writableClients.length,
    mediaClientCount: session.mediaClients.size,
    lastFrameAtMs: session.lastFrameAtMs,
    nowMs: Date.now(),
    mediaFrameIntervalMs,
    force: options.force
  })) {
    return;
  }
  session.frameCaptureInFlight = true;
  try {
    const buffer = await session.page.screenshot({ type: "jpeg", quality: 60, animations: "disabled" });
    session.lastFrameAtMs = Date.now();
    broadcastFrame(session, writableClients, `data:image/jpeg;base64,${buffer.toString("base64")}`);
  } finally {
    session.frameCaptureInFlight = false;
  }
}

async function createMediaAnswerInFrame(frame: Frame, offer: RTCSessionDescriptionInit): Promise<RemoteBrowserMediaAnswerResult> {
  return await frame.evaluate(async ({ offer: serializedOffer, iceServers }) => {
    type MediaState = {
      pc?: RTCPeerConnection;
      stream?: MediaStream;
    };
    type CapturableVideo = HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const mediaWindow = window as Window & { __VRATA_REMOTE_BROWSER_MEDIA__?: MediaState };
    const state = mediaWindow.__VRATA_REMOTE_BROWSER_MEDIA__ ?? {};

    const collectVideos = (root: ParentNode): CapturableVideo[] => {
      const videos = [...root.querySelectorAll("video")] as CapturableVideo[];
      for (const element of [...root.querySelectorAll("*")] as HTMLElement[]) {
        if (element.shadowRoot) {
          videos.push(...collectVideos(element.shadowRoot));
        }
      }
      return videos;
    };
    const pickVideo = (): CapturableVideo | null => {
      const candidates = collectVideos(document)
        .filter((video) => typeof video.captureStream === "function" || typeof video.mozCaptureStream === "function")
        .sort((left, right) => (right.videoWidth * right.videoHeight) - (left.videoWidth * left.videoHeight));
      return candidates[0] ?? null;
    };
    const waitForVideo = async (): Promise<CapturableVideo | null> => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        const video = pickVideo();
        if (video) {
          return video;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    };
    const waitForIceGatheringComplete = async (pc: RTCPeerConnection): Promise<void> => {
      if (pc.iceGatheringState === "complete") {
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", onStateChange);
          resolve();
        }, 2500);
        const onStateChange = () => {
          if (pc.iceGatheringState !== "complete") {
            return;
          }
          window.clearTimeout(timeout);
          pc.removeEventListener("icegatheringstatechange", onStateChange);
          resolve();
        };
        pc.addEventListener("icegatheringstatechange", onStateChange);
      });
    };

    const source = await waitForVideo();
    if (!source) {
      return { ok: false, errorCode: "media_source_missing" };
    }
    const captureStream = source.captureStream?.bind(source) ?? source.mozCaptureStream?.bind(source);
    if (!captureStream) {
      return { ok: false, errorCode: "media_capture_unsupported" };
    }
    const stream = captureStream();
    const tracks: MediaStreamTrack[] = stream.getTracks().filter((track: MediaStreamTrack) => track.readyState === "live");
    if (!tracks.some((track) => track.kind === "video")) {
      return { ok: false, errorCode: "media_video_track_missing" };
    }

    state.pc?.close();
    const pc = new RTCPeerConnection({ iceServers });
    for (const track of tracks) {
      pc.addTrack(track, stream);
    }
    await pc.setRemoteDescription(serializedOffer);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIceGatheringComplete(pc);
    state.pc = pc;
    state.stream = stream;
    mediaWindow.__VRATA_REMOTE_BROWSER_MEDIA__ = state;
    return {
      ok: true,
      answer: pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : undefined,
      hasVideo: tracks.some((track) => track.kind === "video"),
      hasAudio: tracks.some((track) => track.kind === "audio"),
      trackKinds: tracks.map((track) => track.kind),
      sourceFrameUrl: location.href,
      sourceRect: (() => {
        const rect = source.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        };
      })()
    };
  }, { offer, iceServers: mediaIceServers });
}

async function mapSourceRectToPageViewport(frame: Frame, rect: RemoteBrowserMediaSourceRect | undefined): Promise<RemoteBrowserMediaSourceRect | undefined> {
  if (!rect) {
    return undefined;
  }
  let x = rect.x;
  let y = rect.y;
  let current: Frame | null = frame;
  while (current?.parentFrame()) {
    const element = await current.frameElement();
    const box = await element.boundingBox();
    await element.dispose();
    if (box) {
      x += box.x;
      y += box.y;
    }
    current = current.parentFrame();
  }
  return {
    ...rect,
    x,
    y,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height
  };
}

async function findLargestVideoRectInFrame(frame: Frame): Promise<RemoteBrowserMediaSourceRect | undefined> {
  return await frame.evaluate(() => {
    const candidates = [...document.querySelectorAll("video")]
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          area: rect.width * rect.height,
          readyState: video.readyState,
          videoArea: video.videoWidth * video.videoHeight
        };
      })
      .filter((rect) => rect.width > 100 && rect.height > 100 && rect.area > 10000 && rect.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      .sort((left, right) => (right.videoArea || right.area) - (left.videoArea || left.area));
    const rect = candidates[0];
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: rect.viewportWidth, viewportHeight: rect.viewportHeight }
      : undefined;
  });
}

async function resolveRemoteBrowserMediaSourceRect(page: Page): Promise<RemoteBrowserMediaSourceRect | undefined> {
  let bestRect: RemoteBrowserMediaSourceRect | undefined;
  let bestArea = 0;
  for (const frame of page.frames()) {
    try {
      const rect = await findLargestVideoRectInFrame(frame);
      const mapped = await mapSourceRectToPageViewport(frame, rect);
      const area = mapped ? mapped.width * mapped.height : 0;
      if (mapped && area > bestArea) {
        bestRect = mapped;
        bestArea = area;
      }
    } catch {
      // Cross-navigation and detached frames are expected while heavy pages load.
    }
  }
  return bestRect;
}

async function waitForRemoteBrowserMediaSourceRect(page: Page, timeoutMs = 30000): Promise<RemoteBrowserMediaSourceRect | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rect = await resolveRemoteBrowserMediaSourceRect(page);
    if (rect) {
      return rect;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

async function createMediaAnswer(session: RemoteBrowserSession, offer: RTCSessionDescriptionInit): Promise<RemoteBrowserMediaAnswerResult> {
  for (const frame of session.page.frames()) {
    try {
      const result = await createMediaAnswerInFrame(frame, offer);
      if (result.ok || result.errorCode !== "media_source_missing") {
        result.sourceRect = await mapSourceRectToPageViewport(frame, result.sourceRect).catch(() => result.sourceRect);
        return result;
      }
    } catch {
      // Cross-navigation and detached frames are expected while heavy pages load.
    }
  }
  return { ok: false, errorCode: "media_source_missing" };
}

async function handleFrameSocketMessage(session: RemoteBrowserSession, ws: WebSocket, raw: WebSocket.RawData): Promise<void> {
  let message: RemoteBrowserMediaOfferMessage;
  try {
    message = JSON.parse(raw.toString()) as RemoteBrowserMediaOfferMessage;
  } catch {
    return;
  }
  if (message.type === "media-connected") {
    session.mediaClients.add(ws);
    return;
  }
  if (message.type === "media-disconnected") {
    session.mediaClients.delete(ws);
    return;
  }
  if (message.type !== "media-offer" || !message.offer) {
    return;
  }
  const result = await createMediaAnswer(session, message.offer);
  if (!result.ok || !result.answer) {
    ws.send(JSON.stringify({ type: "media-error", errorCode: result.errorCode ?? "media_answer_failed" }));
    return;
  }
  ws.send(JSON.stringify({
    type: "media-answer",
    answer: result.answer,
    hasVideo: result.hasVideo ?? false,
    hasAudio: result.hasAudio ?? false,
    trackKinds: result.trackKinds ?? [],
    sourceFrameUrl: result.sourceFrameUrl ?? null,
    sourceRect: result.sourceRect ?? null
  }));
}

async function installRequestGuard(page: Page, policy: RemoteBrowserUrlPolicy, options: { serviceAllowedOrigins?: () => ReadonlySet<string> } = {}): Promise<void> {
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      const origin = new URL(requestUrl).origin;
      if (options.serviceAllowedOrigins?.().has(origin)) {
        await route.continue();
        return;
      }
    } catch {
      // Fall through to the normal URL policy validation.
    }
    const validation = await validateRemoteBrowserUrl(requestUrl, policy);
    if (!validation.allowed) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function installRemoteBrowserPageStyles(page: Page): Promise<void> {
  await page.addInitScript(remoteBrowserInitScript, remoteBrowserScrollbarStyle);
}

async function ensureRemoteBrowserPageStyles(page: Page): Promise<void> {
  await page.addStyleTag({ content: remoteBrowserScrollbarStyle }).catch(() => undefined);
}

type RemoteBrowserStopReason = "manual" | "replaced" | "expired" | "shutdown";

async function stopSession(sessionId: string, reason: RemoteBrowserStopReason = "manual"): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }
  sessions.delete(sessionId);
  closingSessions.add(session);
  try {
    clearInterval(session.frameTimer);
    clearTimeout(session.expiryTimer);
    for (const client of session.clients) client.close(1000, "session_stopped");
    const disconnectPublisher = (page: Page) => page.evaluate(() => {
      const pageWindow = window as Window & { __VRATA_REMOTE_BROWSER_LIVEKIT__?: { room?: { disconnect: () => void }; stream?: MediaStream; streams?: MediaStream[] } };
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__?.room?.disconnect();
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__?.stream?.getTracks().forEach((track) => track.stop());
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__?.streams?.flatMap((stream) => stream.getTracks()).forEach((track) => track.stop());
      pageWindow.__VRATA_REMOTE_BROWSER_LIVEKIT__ = undefined;
    }).catch(() => undefined);
    await Promise.all([disconnectPublisher(session.page), disconnectPublisher(session.publisherPage)]);
    await session.context.close().catch(() => undefined);
    if (reason === "expired") {
      metrics.ttlExpiredTotal += 1;
      await patchRemoteBrowserExecutorState(session, {
        type: "mark-failed",
        errorCode: "session_expired",
        inputEventId: remoteBrowserExecutorInputEventId(session, "expired")
      }).catch(() => undefined);
    } else if (reason !== "replaced") {
      await patchRemoteBrowserExecutorState(session, {
        type: "mark-stopped",
        inputEventId: remoteBrowserExecutorInputEventId(session, "stopped")
      }).catch(() => undefined);
    }
    return true;
  } finally {
    closingSessions.delete(session);
    incrementCounter(metrics.sessionsStoppedTotal, reason);
    logEvent({ service: "remote-browser", event: "session_stopped", sessionId: session.sessionId, roomId: session.roomId, objectId: session.objectId, reason, timestamp: new Date().toISOString() });
  }
}

async function createSession(input: { sessionId: string; executorInstanceId: string; frameStreamId?: string; mediaParticipantId: string; roomId: string; objectId: string; url: string }, policy = resolveRemoteBrowserServicePolicy()): Promise<RemoteBrowserSession> {
  if (!policy.enabled) {
    throw new Error("remote_browser_disabled");
  }
  if (!validateRemoteBrowserSessionIdentity(input)) {
    throw new Error("invalid_session_binding");
  }
  if (pendingSessionIds.has(input.sessionId) || [...closingSessions].some((session) => session.sessionId === input.sessionId)) {
    throw new Error("session_start_in_progress");
  }
  const occupiedSlots = sessions.size + pendingSessionIds.size + closingSessions.size;
  if (!canStartRemoteBrowserSession(occupiedSlots, sessions.has(input.sessionId), policy.maxSessions)) {
    throw new Error("session_limit_exceeded");
  }
  pendingSessionIds.add(input.sessionId);
  let pendingContext: BrowserContext | null = null;
  try {
  const validation = await validateRemoteBrowserUrl(input.url, urlPolicy);
  if (!validation.allowed || !validation.normalizedUrl) {
    throw new Error(`url_not_allowed:${validation.errorCode ?? "unknown"}`);
  }
  await stopSession(input.sessionId, "replaced");
  const browser = await getBrowser();
  const context = pendingContext = await browser.newContext({
    viewport,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    bypassCSP: true,
    permissions: []
  });
  const serviceAllowedOrigins = new Set<string>();
  const page = await context.newPage();
  await installRequestGuard(page, urlPolicy, { serviceAllowedOrigins: () => serviceAllowedOrigins });
  await installRemoteBrowserPageStyles(page);
  try {
    await page.goto(validation.normalizedUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  } catch (error) {
    await context.close().catch(() => undefined);
    throw new Error(`navigation_failed:${error instanceof Error ? error.message : "unknown"}`);
  }
  await ensureRemoteBrowserPageStyles(page);
  await page.evaluate(remoteBrowserCaptureTitleGuard, remoteBrowserCaptureTargetTitle).catch(() => undefined);
  const finalValidation = await validateRemoteBrowserUrl(page.url(), urlPolicy);
  if (!finalValidation.allowed) {
    await context.close().catch(() => undefined);
    throw new Error(`redirect_not_allowed:${finalValidation.errorCode ?? "unknown"}`);
  }
  const publisherPage = await context.newPage();
  await publisherPage.setContent(remoteBrowserViewportPublisherHtml(), { waitUntil: "domcontentloaded" });
  const createdAtMs = Date.now();
  let session: RemoteBrowserSession;
  const expiryTimer = scheduleRemoteBrowserSessionExpiry(policy.sessionTtlMs, () => {
    void stopSession(input.sessionId, "expired");
  });
  session = {
    ...input,
    url: page.url(),
    context,
    page,
    publisherPage,
    clients: new Set<WebSocket>(),
    mediaClients: new Set<WebSocket>(),
    serviceAllowedOrigins,
    frameTimer: setInterval(() => {
      void captureFrame(session).catch(() => undefined);
    }, frameIntervalMs),
    frameCaptureInFlight: false,
    lastFrameAtMs: 0,
    lastInputAtMs: 0,
    lastInputFrameAtMs: 0,
    publisherStarted: false,
    createdAtMs,
    expiresAtMs: createdAtMs + policy.sessionTtlMs,
    expiryTimer
  };
  sessions.set(input.sessionId, session);
  pendingContext = null;
  incrementCounter(metrics.sessionsStartedTotal, "success");
  logEvent({ service: "remote-browser", event: "session_started", sessionId: session.sessionId, roomId: session.roomId, objectId: session.objectId, expiresAtMs: session.expiresAtMs, timestamp: new Date().toISOString() });
  void startViewportPublisher(session);
  return session;
  } finally {
    await pendingContext?.close().catch(() => undefined);
    pendingSessionIds.delete(input.sessionId);
  }
}

export function remoteBrowserEventPoint(event: SurfaceInputEvent, size = viewport): { x: number; y: number } {
  const u = event.uv?.u ?? 0.5;
  const v = event.uv?.v ?? 0.5;
  return {
    x: Math.max(0, Math.min(size.width - 1, Math.round(u * size.width))),
    y: Math.max(0, Math.min(size.height - 1, Math.round((1 - v) * size.height)))
  };
}

function clampRemoteBrowserScrollDelta(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1600, Math.min(1600, value));
}

export function remoteBrowserScrollDelta(event: SurfaceInputEvent): { x: number; y: number } {
  if (!event.scrollDelta) {
    return { x: 0, y: 480 };
  }
  return {
    x: clampRemoteBrowserScrollDelta(event.scrollDelta.x),
    y: clampRemoteBrowserScrollDelta(event.scrollDelta.y)
  };
}

type RemoteBrowserRealtimeInputPatch = Extract<RemoteBrowserPatch, { type: "pointer" | "scroll" | "keyboard" }>;

function remoteBrowserPageUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

async function remoteBrowserInputTargetDetail(page: Page, point: { x: number; y: number }): Promise<string | undefined> {
  return await page.evaluate(({ x, y }) => {
    type InputDebugState = {
      pointerMoveCount?: number;
      mouseMoveCount?: number;
      clickCount?: number;
      lastType?: string;
      lastClientX?: number;
      lastClientY?: number;
      lastTarget?: string;
    };
    const labelElement = (element: Element | null): string => {
      if (!element) {
        return "none";
      }
      const className = typeof (element as HTMLElement).className === "string" ? (element as HTMLElement).className.trim().replace(/\s+/g, ".") : "";
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className.slice(0, 80)}` : ""}`;
    };
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    const targetRect = target?.getBoundingClientRect();
    const targetStyle = target ? window.getComputedStyle(target) : null;
    const inputDebug = (window as Window & { __VRATA_REMOTE_BROWSER_INPUT_DEBUG__?: InputDebugState }).__VRATA_REMOTE_BROWSER_INPUT_DEBUG__;
    const videos = Array.from(document.querySelectorAll("video"))
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}:${video.readyState}:${video.videoWidth}x${video.videoHeight}`;
      })
      .slice(0, 3)
      .join("|");
    return [
      `target=${labelElement(target)}`,
      targetRect ? `rect=${Math.round(targetRect.x)},${Math.round(targetRect.y)},${Math.round(targetRect.width)}x${Math.round(targetRect.height)}` : "rect=none",
      targetStyle ? `pointerEvents=${targetStyle.pointerEvents}` : "pointerEvents=none",
      `events=${inputDebug?.lastType ?? "none"}@${inputDebug?.lastClientX ?? "?"},${inputDebug?.lastClientY ?? "?"};pm=${inputDebug?.pointerMoveCount ?? 0};mm=${inputDebug?.mouseMoveCount ?? 0};click=${inputDebug?.clickCount ?? 0};lastTarget=${inputDebug?.lastTarget ?? "none"}`,
      `videos=${videos || "none"}`
    ].join(";");
  }, point).catch(() => undefined);
}

async function ensureRemoteBrowserInputDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    type InputDebugState = {
      pointerMoveCount: number;
      mouseMoveCount: number;
      clickCount: number;
      lastType?: string;
      lastClientX?: number;
      lastClientY?: number;
      lastTarget?: string;
    };
    type InputDebugWindow = Window & { __VRATA_REMOTE_BROWSER_INPUT_DEBUG__?: InputDebugState };

    const inputWindow = window as InputDebugWindow;
    if (inputWindow.__VRATA_REMOTE_BROWSER_INPUT_DEBUG__) {
      return;
    }
    const targetLabel = (target: EventTarget | null): string | undefined => {
      if (!(target instanceof Element)) {
        return undefined;
      }
      const className = typeof target.className === "string" ? target.className.trim().replace(/\s+/g, ".") : "";
      return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${className ? `.${className.slice(0, 80)}` : ""}`;
    };
    const state: InputDebugState = { pointerMoveCount: 0, mouseMoveCount: 0, clickCount: 0 };
    inputWindow.__VRATA_REMOTE_BROWSER_INPUT_DEBUG__ = state;
    const record = (event: MouseEvent | PointerEvent) => {
      if (event.type === "pointermove") {
        state.pointerMoveCount += 1;
      } else if (event.type === "mousemove") {
        state.mouseMoveCount += 1;
      } else if (event.type === "click") {
        state.clickCount += 1;
      }
      state.lastType = event.type;
      state.lastClientX = Math.round(event.clientX);
      state.lastClientY = Math.round(event.clientY);
      state.lastTarget = targetLabel(event.composedPath()[0] ?? event.target);
    };
    document.addEventListener("pointermove", record, true);
    document.addEventListener("mousemove", record, true);
    document.addEventListener("click", record, true);
  }).catch(() => undefined);
}

function createInputDiagnostic(session: RemoteBrowserSession, patch: RemoteBrowserRealtimeInputPatch, point: { x: number; y: number }, input: {
  receivedAtMs: number;
  status: RemoteBrowserExecutorInputState["status"];
  targetDetail?: string;
  errorDetail?: string;
}): RemoteBrowserExecutorInputState {
  return {
    inputEventId: patch.inputEventId,
    inputType: patch.type,
    eventKind: patch.event.kind,
    x: point.x,
    y: point.y,
    receivedAtMs: input.receivedAtMs,
    appliedAtMs: Date.now(),
    status: input.status,
    pageUrl: remoteBrowserPageUrl(session.page),
    pageClosed: session.page.isClosed(),
    targetDetail: input.targetDetail,
    errorDetail: input.errorDetail
  };
}

async function applyInput(session: RemoteBrowserSession, patch: RemoteBrowserPatch): Promise<RemoteBrowserExecutorInputState | null> {
  if (patch.type !== "pointer" && patch.type !== "scroll" && patch.type !== "keyboard") {
    return null;
  }
  const receivedAtMs = Date.now();
  session.lastInputAtMs = receivedAtMs;
  const { x, y } = remoteBrowserEventPoint(patch.event);
  const point = { x, y };
  try {
    await ensureRemoteBrowserInputDebug(session.page);
    await session.page.bringToFront().catch(() => undefined);
    if (patch.type === "scroll") {
      const delta = remoteBrowserScrollDelta(patch.event);
      await session.page.mouse.move(x, y);
      await session.page.mouse.wheel(delta.x, delta.y);
      requestInputFrameCapture(session);
      return createInputDiagnostic(session, patch, point, { receivedAtMs, status: "applied", targetDetail: await remoteBrowserInputTargetDetail(session.page, point) });
    }
    if (patch.type === "keyboard") {
      if (patch.event.kind === "key-down") {
        if (patch.event.text) {
          await session.page.keyboard.insertText(patch.event.text);
        } else if (patch.event.key) {
          await session.page.keyboard.press(patch.event.key);
        }
      }
      requestInputFrameCapture(session);
      return createInputDiagnostic(session, patch, point, { receivedAtMs, status: "applied", targetDetail: await remoteBrowserInputTargetDetail(session.page, point) });
    }
    await session.page.mouse.move(x, y, { steps: remoteBrowserMouseMoveSteps(patch.event.kind) });
    if (patch.event.kind === "pointer-down") {
      await session.page.mouse.down();
    } else if (patch.event.kind === "pointer-up") {
      await session.page.mouse.up();
    } else if (patch.event.kind === "click") {
      await session.page.mouse.click(x, y);
    }
    requestInputFrameCapture(session);
    return createInputDiagnostic(session, patch, point, { receivedAtMs, status: "applied", targetDetail: await remoteBrowserInputTargetDetail(session.page, point) });
  } catch (error) {
    return createInputDiagnostic(session, patch, point, { receivedAtMs, status: "failed", targetDetail: await remoteBrowserInputTargetDetail(session.page, point), errorDetail: remoteBrowserErrorDetail(error) });
  }
}

function requestInputFrameCapture(session: RemoteBrowserSession): void {
  const nowMs = Date.now();
  if (nowMs - session.lastInputFrameAtMs < frameIntervalMs) {
    return;
  }
  session.lastInputFrameAtMs = nowMs;
  void captureFrame(session, { force: true }).catch(() => undefined);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const id = requestId(request);
  response.setHeader("x-request-id", id);
  metrics.requestsTotal += 1;
  const policy = resolveRemoteBrowserServicePolicy(env);
  const configured = !policy.enabled || Boolean(resolveRemoteBrowserFrameTokenSecret(env) && (env.NODE_ENV !== "production" || getInternalServiceToken(env)));
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
  if (request.method === "GET" && url.pathname === "/health/live") {
    json(response, 200, { status: "live", service: "remote-browser", timestamp: new Date().toISOString() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health/ready") {
    json(response, configured ? 200 : 503, { status: configured ? "ready" : "not_ready", service: "remote-browser", enabled: policy.enabled, experimental: true, configured, sessions: sessions.size, limits: { maxSessions: policy.maxSessions, sessionTtlMs: policy.sessionTtlMs, viewport: policy.viewport }, timestamp: new Date().toISOString() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", service: "remote-browser", enabled: policy.enabled, experimental: true, configured, sessions: sessions.size, limits: { maxSessions: policy.maxSessions, sessionTtlMs: policy.sessionTtlMs, viewport: policy.viewport }, timestamp: new Date().toISOString() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    text(response, 200, remoteBrowserMetricsText());
    return;
  }
  if (request.method === "GET" && url.pathname === "/internal/viewport-publisher") {
    html(response, 200, remoteBrowserViewportPublisherHtml());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    if (!isAuthorizedInternalRequest(request, env)) {
      incrementCounter(metrics.deniedTotal, "forbidden");
      json(response, 403, { error: "forbidden" });
      return;
    }
    if (!policy.enabled) {
      incrementCounter(metrics.deniedTotal, "disabled");
      json(response, 503, { error: "remote_browser_disabled" });
      return;
    }
    const payload = await parseBody<{ sessionId?: string; executorInstanceId?: string; frameStreamId?: string; mediaParticipantId?: string; roomId?: string; objectId?: string; url?: string }>(request);
    if (!payload?.sessionId || !payload.executorInstanceId || !payload.mediaParticipantId || !payload.roomId || !payload.objectId || !payload.url) {
      json(response, 400, { error: "invalid_session_payload" });
      return;
    }
    if (!validateRemoteBrowserSessionIdentity({ sessionId: payload.sessionId, executorInstanceId: payload.executorInstanceId, frameStreamId: payload.frameStreamId, mediaParticipantId: payload.mediaParticipantId, objectId: payload.objectId })) {
      incrementCounter(metrics.deniedTotal, "invalid_binding");
      json(response, 400, { error: "invalid_session_binding" });
      return;
    }
    let session: RemoteBrowserSession;
    try {
      session = await createSession({ sessionId: payload.sessionId, executorInstanceId: payload.executorInstanceId, frameStreamId: payload.frameStreamId, mediaParticipantId: payload.mediaParticipantId, roomId: payload.roomId, objectId: payload.objectId, url: payload.url }, policy);
    } catch (error) {
      incrementCounter(metrics.sessionsStartedTotal, "failed");
      const errorCode = remoteBrowserSessionErrorCode(error);
      if (errorCode === "session_limit_exceeded") incrementCounter(metrics.deniedTotal, "session_limit");
      if (errorCode === "session_start_in_progress") incrementCounter(metrics.deniedTotal, "start_in_progress");
      if (errorCode === "url_not_allowed" || errorCode === "redirect_not_allowed") incrementCounter(metrics.deniedTotal, "url_policy");
      await patchRemoteBrowserExecutorState({ sessionId: payload.sessionId, executorInstanceId: payload.executorInstanceId, frameStreamId: payload.frameStreamId, mediaParticipantId: payload.mediaParticipantId, roomId: payload.roomId, objectId: payload.objectId }, {
        type: "mark-failed",
        errorCode,
        inputEventId: `${payload.sessionId}:failed:${Date.now()}`
      }).catch(() => undefined);
      const statusCode = errorCode === "session_limit_exceeded" ? 429
        : errorCode === "session_start_in_progress" ? 409
          : errorCode === "invalid_session_binding" ? 400
          : errorCode === "url_not_allowed" || errorCode === "redirect_not_allowed" ? 422
            : errorCode === "navigation_failed" ? 502 : 500;
      json(response, statusCode, { error: errorCode });
      return;
    }
    json(response, 200, { ok: true, sessionId: session.sessionId, mediaParticipantId: session.mediaParticipantId, frameStreamId: session.frameStreamId, url: session.url });
    return;
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    if (!isAuthorizedInternalRequest(request, env)) {
      incrementCounter(metrics.deniedTotal, "forbidden");
      json(response, 403, { error: "forbidden" });
      return;
    }
    json(response, 200, { ok: await stopSession(decodeURIComponent(sessionMatch[1] ?? "")) });
    return;
  }
  const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
  if (inputMatch && request.method === "POST") {
    if (!isAuthorizedInternalRequest(request, env)) {
      incrementCounter(metrics.deniedTotal, "forbidden");
      json(response, 403, { error: "forbidden" });
      return;
    }
    const session = sessions.get(decodeURIComponent(inputMatch[1] ?? ""));
    const payload = await parseBody<RemoteBrowserPatch>(request);
    if (!session || !payload || sessions.get(session.sessionId) !== session || Date.now() >= session.expiresAtMs) {
      json(response, 404, { error: "session_not_found" });
      return;
    }
    if (!policy.enabled) {
      incrementCounter(metrics.deniedTotal, "disabled");
      json(response, 503, { error: "remote_browser_disabled" });
      return;
    }
    const inputDiagnostic = await applyInput(session, payload);
    if (inputDiagnostic) {
      if (inputDiagnostic.status === "applied") {
        await refreshRemoteBrowserMediaSourceRect(session).catch(() => undefined);
      }
      await patchRemoteBrowserExecutorState(session, {
        type: "mark-input-applied",
        input: inputDiagnostic,
        inputEventId: remoteBrowserExecutorInputEventId(session, `input-${inputDiagnostic.status}`)
      }).catch(() => undefined);
    }
    if (inputDiagnostic?.status === "failed") {
      json(response, 500, { error: "input_failed", sessionId: session.sessionId, detail: inputDiagnostic.errorDetail ?? "unknown" });
      return;
    }
    json(response, 200, { ok: true, sessionId: session.sessionId, input: inputDiagnostic });
    return;
  }
  json(response, 404, { error: "not_found" });
}

export function startRemoteBrowserService(listenPort = port, env: NodeJS.ProcessEnv = process.env) {
  activeListenPort = listenPort;
  const server = createServer((request, response) => {
    handleRequest(request, response, env).catch((error: unknown) => {
      metrics.requestFailuresTotal += 1;
      const id = requestId(request);
      response.setHeader("x-request-id", id);
      logEvent({
        service: "remote-browser",
        event: "request_failed",
        env: env.NODE_ENV ?? "development",
        requestId: id,
        errorCode: "remote_browser_error",
        path: request.url ?? "",
        method: request.method ?? "GET",
        message: error instanceof Error ? error.message : "unknown",
        timestamp: new Date().toISOString()
      });
      json(response, 500, { error: "remote_browser_error", message: error instanceof Error ? error.message : "unknown" });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${listenPort}`}`);
    if (url.pathname !== "/frames") {
      socket.destroy();
      return;
    }
    if (!resolveRemoteBrowserServicePolicy(env).enabled) {
      socket.destroy();
      return;
    }
    const tokenSecret = resolveRemoteBrowserFrameTokenSecret(env);
    if (!tokenSecret) {
      incrementCounter(metrics.deniedTotal, "token_config");
      socket.destroy();
      return;
    }
    const token = decodeRemoteBrowserFrameToken(url.searchParams.get("token"), tokenSecret);
    const session = token ? sessions.get(token.executorSessionId) : null;
    if (!token || !session || session.frameStreamId !== token.frameStreamId || session.objectId !== token.objectId || session.roomId !== token.roomId) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      session.clients.add(ws);
      ws.on("message", (raw) => {
        void handleFrameSocketMessage(session, ws, raw).catch(() => {
          ws.send(JSON.stringify({ type: "media-error", errorCode: "media_signal_failed" }));
        });
      });
      ws.on("close", () => {
        metrics.socketDisconnectsTotal += 1;
        session.clients.delete(ws);
        session.mediaClients.delete(ws);
      });
      void captureFrame(session).catch(() => undefined);
    });
  });
  server.on("close", () => {
    for (const sessionId of [...sessions.keys()]) void stopSession(sessionId, "shutdown");
    void browserPromise?.then((browser) => browser.close()).catch(() => undefined);
    browserPromise = null;
  });
  return server.listen(listenPort, () => {
    const address = server.address();
    if (typeof address === "object" && address?.port) {
      activeListenPort = address.port;
    }
    logEvent({ service: "remote-browser", event: "listening", env: env.NODE_ENV ?? "development", port: listenPort, enabled: resolveRemoteBrowserServicePolicy(env).enabled, timestamp: new Date().toISOString() });
  });
}

if (process.env.NODE_ENV !== "test" && process.env.VRATA_DISABLE_AUTOSTART !== "1" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  startRemoteBrowserService();
}
