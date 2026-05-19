import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import { WebSocketServer, type WebSocket } from "ws";
import type { RemoteBrowserErrorCode, RemoteBrowserPatch, SurfaceInputEvent } from "@noah/shared-types";

import { decodeRemoteBrowserFrameToken } from "./frame-token.js";
import { createRemoteBrowserUrlPolicy, validateRemoteBrowserUrl, type RemoteBrowserUrlPolicy } from "./url-policy.js";

interface RemoteBrowserSession {
  sessionId: string;
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
  frameTimer: ReturnType<typeof setInterval>;
  frameCaptureInFlight: boolean;
  lastFrameAtMs: number;
  lastInputAtMs: number;
  lastInputFrameAtMs: number;
  publisherStarted: boolean;
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

type RemoteBrowserSessionRef = Pick<RemoteBrowserSession, "sessionId" | "roomId" | "objectId" | "mediaParticipantId">;

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

interface RemoteBrowserMediaSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

const port = Number.parseInt(process.env.REMOTE_BROWSER_PORT ?? "4010", 10);
const viewport = {
  width: Number.parseInt(process.env.REMOTE_BROWSER_VIEWPORT_WIDTH ?? "1280", 10),
  height: Number.parseInt(process.env.REMOTE_BROWSER_VIEWPORT_HEIGHT ?? "720", 10)
};
const require = createRequire(import.meta.url);

function resolveInternalHttpUrl(value: string | undefined, fallback: string): string {
  const resolved = value?.trim() || fallback;
  return resolved.replace(/\/$/, "");
}

function getInternalServiceToken(): string | null {
  const token = process.env.NOAH_INTERNAL_SERVICE_TOKEN?.trim() || process.env.REMOTE_BROWSER_INTERNAL_TOKEN?.trim() || "";
  return token || null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedInternalRequest(request: IncomingMessage): boolean {
  const token = getInternalServiceToken();
  if (!token) {
    return true;
  }
  const provided = request.headers["x-noah-internal-token"];
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

export function shouldPreserveRemoteBrowserMediaOverlays(input: { lastInputAtMs: number; capturedAtMs: number; preserveMs?: number }): boolean {
  if (input.lastInputAtMs <= 0 || input.capturedAtMs < input.lastInputAtMs) {
    return false;
  }
  return input.capturedAtMs - input.lastInputAtMs <= (input.preserveMs ?? mediaOverlayPreserveMs);
}

const frameIntervalMs = resolveRemoteBrowserFrameIntervalMs(process.env.REMOTE_BROWSER_FRAME_INTERVAL_MS);
const mediaFrameIntervalMs = resolveRemoteBrowserMediaFrameIntervalMs(process.env.REMOTE_BROWSER_MEDIA_FRAME_INTERVAL_MS);
const frameBackpressureBytes = resolveRemoteBrowserFrameBackpressureBytes(process.env.REMOTE_BROWSER_FRAME_BACKPRESSURE_BYTES);
const tokenSecret = process.env.REMOTE_BROWSER_TOKEN_SECRET ?? "dev-remote-browser-secret";
const mediaIceServers = resolveRemoteBrowserMediaIceServers(process.env.REMOTE_BROWSER_MEDIA_ICE_SERVERS);
const apiInternalUrl = resolveInternalHttpUrl(process.env.API_INTERNAL_URL ?? process.env.NOAH_API_INTERNAL_URL, "http://127.0.0.1:4000");
const roomStateInternalUrl = resolveInternalHttpUrl(process.env.ROOM_STATE_INTERNAL_URL ?? process.env.NOAH_ROOM_STATE_INTERNAL_URL, "http://127.0.0.1:2567");
export const remoteBrowserCaptureTargetTitle = "Noah Remote Browser";
export const remoteBrowserViewportPublisherTitle = "Noah Remote Browser Publisher";
export const remoteBrowserViewportPublisherButtonId = "noah-remote-browser-start-capture";
const remoteBrowserCaptureTitleGuardKey = "__NOAH_REMOTE_BROWSER_CAPTURE_TITLE_GUARD__";
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
  const installStyle = () => {
    const styleId = "noah-remote-browser-scrollbar-style";
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
  document.addEventListener("DOMContentLoaded", installStyle, { once: true });
};

let browserPromise: Promise<Browser> | null = null;
const sessions = new Map<string, RemoteBrowserSession>();
const urlPolicy = createRemoteBrowserUrlPolicy();

export function remoteBrowserViewportPublisherHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${remoteBrowserViewportPublisherTitle}</title></head><body><button id="${remoteBrowserViewportPublisherButtonId}" type="button">Start capture</button></body></html>`;
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
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "include"
  } as unknown as DisplayMediaStreamOptions;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
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
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--enable-usermedia-screen-capturing",
      "--use-fake-ui-for-media-stream",
      "--allow-http-screen-capture",
      `--auto-select-desktop-capture-source=${remoteBrowserCaptureTargetTitle}`,
      `--auto-select-tab-capture-source-by-title=${remoteBrowserCaptureTargetTitle}`,
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${viewport.width},${viewport.height}`
    ]
  });
  return browserPromise;
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
    ...(token ? { "x-noah-internal-token": token } : {})
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
      mediaParticipantId: session.mediaParticipantId
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

async function grantViewportPublisherDisplayCapture(session: RemoteBrowserSession): Promise<void> {
  const cdp = await session.context.newCDPSession(session.publisherPage);
  try {
    const targetInfo = await cdp.send("Target.getTargetInfo").catch(() => null) as { targetInfo?: { browserContextId?: string } } | null;
    const browserContextId = targetInfo?.targetInfo?.browserContextId;
    await cdp.send("Browser.grantPermissions", {
      origin: getRemoteBrowserViewportPublisherOrigin(),
      permissions: ["displayCapture"],
      ...(browserContextId ? { browserContextId } : {})
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

async function patchRemoteBrowserExecutorState(session: RemoteBrowserSessionRef, patch: RemoteBrowserPatch): Promise<void> {
  const response = await fetch(`${roomStateInternalUrl}/api/internal/remote-browser/sessions/${encodeURIComponent(session.sessionId)}`, {
    method: "POST",
    headers: getInternalHeaders(),
    body: JSON.stringify({
      roomId: session.roomId,
      surfaceId: "debug-main",
      objectId: session.objectId,
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

async function publishViewportToLiveKit(session: RemoteBrowserSession): Promise<RemoteBrowserViewportPublishResult> {
  const { token, livekitUrl } = await requestRemoteBrowserMediaToken(session);
  await prepareViewportPublisherPage(session);
  await grantViewportPublisherDisplayCapture(session);
  await session.publisherPage.addScriptTag({ path: resolveLiveKitClientBundlePath() });
  const captureOptions = createRemoteBrowserViewportCaptureOptions({ width: viewport.width, height: viewport.height });
  await session.publisherPage.evaluate(({ livekitUrl: targetLivekitUrl, token: targetToken, displayMediaOptions, buttonId }) => {
    type PublishResult = { ok?: boolean; videoTrackSid?: string; audioTrackSid?: string; errorCode?: string; message?: string };
    type PublishState = {
      room?: { disconnect: () => void };
      stream?: MediaStream;
    };
    const pageWindow = window as Window & {
      LivekitClient?: any;
      LiveKitClient?: any;
      livekitClient?: any;
      __NOAH_REMOTE_BROWSER_LIVEKIT__?: PublishState;
      __NOAH_REMOTE_BROWSER_PUBLISH_RESULT__?: PublishResult;
    };
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;
    pageWindow.__NOAH_REMOTE_BROWSER_PUBLISH_RESULT__ = undefined;

    const publish = async (): Promise<PublishResult> => {
      const LiveKit = pageWindow.LivekitClient ?? pageWindow.LiveKitClient ?? pageWindow.livekitClient;
      if (!LiveKit?.Room || !LiveKit?.Track) {
        return { ok: false, errorCode: "livekit_publish_failed", message: "livekit_client_missing" };
      }
      if (!navigator.mediaDevices?.getDisplayMedia) {
        return { ok: false, errorCode: "viewport_capture_unsupported", message: "getDisplayMedia_missing" };
      }
      pageWindow.__NOAH_REMOTE_BROWSER_LIVEKIT__?.room?.disconnect();
      pageWindow.__NOAH_REMOTE_BROWSER_LIVEKIT__?.stream?.getTracks().forEach((track) => track.stop());
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions as DisplayMediaStreamOptions);
      } catch (error) {
        return { ok: false, errorCode: error instanceof DOMException && error.name === "NotAllowedError" ? "viewport_capture_denied" : "viewport_capture_failed", message: error instanceof Error ? `${error.name}:${error.message}` : "capture_failed" };
      }
      const videoTrack = stream.getVideoTracks().find((track) => track.readyState === "live");
      const audioTrack = stream.getAudioTracks().find((track) => track.readyState === "live");
      if (!videoTrack) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, errorCode: "video_track_missing", message: "video_track_missing" };
      }
      if (!audioTrack) {
        stream.getTracks().forEach((track) => track.stop());
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
        pageWindow.__NOAH_REMOTE_BROWSER_LIVEKIT__ = { room, stream };
        return {
          ok: true,
          videoTrackSid: videoPublication.trackSid ?? videoPublication.sid ?? videoTrack.id,
          audioTrackSid: audioPublication.trackSid ?? audioPublication.sid ?? audioTrack.id
        };
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, errorCode: "livekit_publish_failed", message: error instanceof Error ? error.message : "publish_failed" };
      }
    };

    if (!button) {
      pageWindow.__NOAH_REMOTE_BROWSER_PUBLISH_RESULT__ = { ok: false, errorCode: "viewport_capture_failed", message: "publisher_button_missing" };
      return;
    }
    button.onclick = () => {
      void publish()
        .then((result) => {
          pageWindow.__NOAH_REMOTE_BROWSER_PUBLISH_RESULT__ = result;
        })
        .catch((error: unknown) => {
          pageWindow.__NOAH_REMOTE_BROWSER_PUBLISH_RESULT__ = { ok: false, errorCode: "viewport_capture_failed", message: error instanceof Error ? error.message : "publish_exception" };
        });
    };
  }, { livekitUrl, token, displayMediaOptions: captureOptions, buttonId: remoteBrowserViewportPublisherButtonId });
  await session.publisherPage.bringToFront().catch(() => undefined);
  await session.publisherPage.click(`#${remoteBrowserViewportPublisherButtonId}`, { timeout: 5000 });
  const resultHandle = await session.publisherPage.waitForFunction(() => {
    const pageWindow = window as Window & { __NOAH_REMOTE_BROWSER_PUBLISH_RESULT__?: unknown };
    return pageWindow.__NOAH_REMOTE_BROWSER_PUBLISH_RESULT__ ?? false;
  }, undefined, { timeout: 45000 });
  const result = await resultHandle.jsonValue() as { ok?: boolean; videoTrackSid?: string; audioTrackSid?: string; errorCode?: string; message?: string };
  await resultHandle.dispose();
  if (!result.ok || !result.videoTrackSid || !result.audioTrackSid) {
    throw new Error(`${result.errorCode ?? "livekit_publish_failed"}:${result.message ?? "unknown"}`);
  }
  await session.page.bringToFront().catch(() => undefined);
  return { videoTrackSid: result.videoTrackSid, audioTrackSid: result.audioTrackSid };
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
    const published = process.env.REMOTE_BROWSER_VIEWPORT_MOCK === "1"
      ? {
        videoTrackSid: `mock-remote-browser-video:${session.objectId}:${Date.now()}`,
        audioTrackSid: `mock-remote-browser-audio:${session.objectId}:${Date.now()}`
      }
      : await publishViewportToLiveKit(session);
    await patchRemoteBrowserExecutorState(session, {
      type: "mark-active",
      mediaParticipantId: session.mediaParticipantId,
      mediaTrackSid: published.videoTrackSid,
      audioTrackSid: published.audioTrackSid,
      inputEventId: remoteBrowserExecutorInputEventId(session, "active")
    });
  } catch (error) {
    await patchRemoteBrowserExecutorState(session, {
      type: "mark-failed",
      errorCode: remoteBrowserPublishErrorCode(error),
      errorDetail: remoteBrowserErrorDetail(error),
      inputEventId: remoteBrowserExecutorInputEventId(session, "failed")
    }).catch(() => undefined);
  }
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
    const mediaWindow = window as Window & { __NOAH_REMOTE_BROWSER_MEDIA__?: MediaState };
    const state = mediaWindow.__NOAH_REMOTE_BROWSER_MEDIA__ ?? {};

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
    mediaWindow.__NOAH_REMOTE_BROWSER_MEDIA__ = state;
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

async function installRequestGuard(page: Page, policy: RemoteBrowserUrlPolicy): Promise<void> {
  await page.route("**/*", async (route) => {
    const validation = await validateRemoteBrowserUrl(route.request().url(), policy);
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

async function stopSession(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }
  sessions.delete(sessionId);
  clearInterval(session.frameTimer);
  for (const client of session.clients) {
    client.close(1000, "session_stopped");
  }
  await session.publisherPage.evaluate(() => {
    const pageWindow = window as Window & { __NOAH_REMOTE_BROWSER_LIVEKIT__?: { room?: { disconnect: () => void }; stream?: MediaStream } };
    pageWindow.__NOAH_REMOTE_BROWSER_LIVEKIT__?.room?.disconnect();
    pageWindow.__NOAH_REMOTE_BROWSER_LIVEKIT__?.stream?.getTracks().forEach((track) => track.stop());
    pageWindow.__NOAH_REMOTE_BROWSER_LIVEKIT__ = undefined;
  }).catch(() => undefined);
  await patchRemoteBrowserExecutorState(session, {
    type: "mark-stopped",
    inputEventId: remoteBrowserExecutorInputEventId(session, "stopped")
  }).catch(() => undefined);
  await session.context.close().catch(() => undefined);
  return true;
}

async function createSession(input: { sessionId: string; frameStreamId?: string; mediaParticipantId: string; roomId: string; objectId: string; url: string }): Promise<RemoteBrowserSession> {
  const validation = await validateRemoteBrowserUrl(input.url, urlPolicy);
  if (!validation.allowed || !validation.normalizedUrl) {
    throw new Error(`url_not_allowed:${validation.errorCode ?? "unknown"}`);
  }
  await stopSession(input.sessionId);
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport,
    acceptDownloads: false,
    ignoreHTTPSErrors: false,
    bypassCSP: true,
    permissions: []
  });
  const page = await context.newPage();
  await installRequestGuard(page, urlPolicy);
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
  const session: RemoteBrowserSession = {
    ...input,
    url: page.url(),
    context,
    page,
    publisherPage,
    clients: new Set<WebSocket>(),
    mediaClients: new Set<WebSocket>(),
    frameTimer: setInterval(() => {
      void captureFrame(session).catch(() => undefined);
    }, frameIntervalMs),
    frameCaptureInFlight: false,
    lastFrameAtMs: 0,
    lastInputAtMs: 0,
    lastInputFrameAtMs: 0,
    publisherStarted: false
  };
  sessions.set(input.sessionId, session);
  void startViewportPublisher(session);
  return session;
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

async function applyInput(session: RemoteBrowserSession, patch: RemoteBrowserPatch): Promise<void> {
  if (patch.type !== "pointer" && patch.type !== "scroll" && patch.type !== "keyboard") {
    return;
  }
  session.lastInputAtMs = Date.now();
  const { x, y } = remoteBrowserEventPoint(patch.event);
  if (patch.type === "scroll") {
    const delta = remoteBrowserScrollDelta(patch.event);
    await session.page.mouse.move(x, y);
    await session.page.mouse.wheel(delta.x, delta.y);
    requestInputFrameCapture(session);
    return;
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
    return;
  }
  await session.page.mouse.move(x, y);
  if (patch.event.kind === "pointer-down") {
    await session.page.mouse.down();
  } else if (patch.event.kind === "pointer-up") {
    await session.page.mouse.up();
  } else if (patch.event.kind === "click") {
    await session.page.mouse.click(x, y);
  }
  requestInputFrameCapture(session);
}

function requestInputFrameCapture(session: RemoteBrowserSession): void {
  const nowMs = Date.now();
  if (nowMs - session.lastInputFrameAtMs < frameIntervalMs) {
    return;
  }
  session.lastInputFrameAtMs = nowMs;
  void captureFrame(session, { force: true }).catch(() => undefined);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", service: "remote-browser", sessions: sessions.size, timestamp: new Date().toISOString() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/internal/viewport-publisher") {
    html(response, 200, remoteBrowserViewportPublisherHtml());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    if (!isAuthorizedInternalRequest(request)) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    const payload = await parseBody<{ sessionId?: string; frameStreamId?: string; mediaParticipantId?: string; roomId?: string; objectId?: string; url?: string }>(request);
    if (!payload?.sessionId || !payload.mediaParticipantId || !payload.roomId || !payload.objectId || !payload.url) {
      json(response, 400, { error: "invalid_session_payload" });
      return;
    }
    let session: RemoteBrowserSession;
    try {
      session = await createSession({ sessionId: payload.sessionId, frameStreamId: payload.frameStreamId, mediaParticipantId: payload.mediaParticipantId, roomId: payload.roomId, objectId: payload.objectId, url: payload.url });
    } catch (error) {
      await patchRemoteBrowserExecutorState({ sessionId: payload.sessionId, mediaParticipantId: payload.mediaParticipantId, roomId: payload.roomId, objectId: payload.objectId }, {
        type: "mark-failed",
        errorCode: remoteBrowserSessionErrorCode(error),
        inputEventId: `${payload.sessionId}:failed:${Date.now()}`
      }).catch(() => undefined);
      throw error;
    }
    json(response, 200, { ok: true, sessionId: session.sessionId, mediaParticipantId: session.mediaParticipantId, frameStreamId: session.frameStreamId, url: session.url });
    return;
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    if (!isAuthorizedInternalRequest(request)) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    json(response, 200, { ok: await stopSession(decodeURIComponent(sessionMatch[1] ?? "")) });
    return;
  }
  const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
  if (inputMatch && request.method === "POST") {
    if (!isAuthorizedInternalRequest(request)) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    const session = sessions.get(decodeURIComponent(inputMatch[1] ?? ""));
    const payload = await parseBody<RemoteBrowserPatch>(request);
    if (!session || !payload) {
      json(response, 404, { error: "session_not_found" });
      return;
    }
    await applyInput(session, payload);
    json(response, 200, { ok: true, sessionId: session.sessionId });
    return;
  }
  json(response, 404, { error: "not_found" });
}

export function startRemoteBrowserService(listenPort = port) {
  activeListenPort = listenPort;
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
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
        session.clients.delete(ws);
        session.mediaClients.delete(ws);
      });
      void captureFrame(session).catch(() => undefined);
    });
  });
  return server.listen(listenPort, () => {
    const address = server.address();
    if (typeof address === "object" && address?.port) {
      activeListenPort = address.port;
    }
    process.stdout.write(`remote-browser listening on ${listenPort}\n`);
  });
}

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  startRemoteBrowserService();
}
