import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import { WebSocketServer, type WebSocket } from "ws";
import type { RemoteBrowserPatch, SurfaceInputEvent } from "@noah/shared-types";

import { decodeRemoteBrowserFrameToken } from "./frame-token.js";
import { createRemoteBrowserUrlPolicy, validateRemoteBrowserUrl, type RemoteBrowserUrlPolicy } from "./url-policy.js";

interface RemoteBrowserSession {
  sessionId: string;
  frameStreamId: string;
  roomId: string;
  objectId: string;
  url: string;
  context: BrowserContext;
  page: Page;
  clients: Set<WebSocket>;
  mediaClients: Set<WebSocket>;
  frameTimer: ReturnType<typeof setInterval>;
  frameCaptureInFlight: boolean;
  lastFrameAtMs: number;
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
export function resolveRemoteBrowserFrameIntervalMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "250", 10);
  return Math.max(250, Number.isFinite(parsed) ? parsed : 250);
}

const frameIntervalMs = resolveRemoteBrowserFrameIntervalMs(process.env.REMOTE_BROWSER_FRAME_INTERVAL_MS);
const tokenSecret = process.env.REMOTE_BROWSER_TOKEN_SECRET ?? "dev-remote-browser-secret";
const mediaIceServers = resolveRemoteBrowserMediaIceServers(process.env.REMOTE_BROWSER_MEDIA_ICE_SERVERS);
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

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
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
  browserPromise ??= chromium.launch({
    executablePath,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"]
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

function broadcastFrame(session: RemoteBrowserSession, dataUrl: string): void {
  const payload = JSON.stringify({
    type: "frame",
    sessionId: session.sessionId,
    frameStreamId: session.frameStreamId,
    width: viewport.width,
    height: viewport.height,
    dataUrl,
    capturedAtMs: session.lastFrameAtMs
  });
  for (const client of session.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

async function captureFrame(session: RemoteBrowserSession): Promise<void> {
  if (session.clients.size === 0 || session.frameCaptureInFlight) {
    return;
  }
  session.frameCaptureInFlight = true;
  try {
    const buffer = await session.page.screenshot({ type: "jpeg", quality: 60, animations: "disabled" });
    session.lastFrameAtMs = Date.now();
    broadcastFrame(session, `data:image/jpeg;base64,${buffer.toString("base64")}`);
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
  await session.context.close().catch(() => undefined);
  return true;
}

async function createSession(input: { sessionId: string; frameStreamId: string; roomId: string; objectId: string; url: string }): Promise<RemoteBrowserSession> {
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
    permissions: []
  });
  const page = await context.newPage();
  await installRequestGuard(page, urlPolicy);
  await installRemoteBrowserPageStyles(page);
  await page.goto(validation.normalizedUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await ensureRemoteBrowserPageStyles(page);
  const finalValidation = await validateRemoteBrowserUrl(page.url(), urlPolicy);
  if (!finalValidation.allowed) {
    await context.close().catch(() => undefined);
    throw new Error(`redirect_not_allowed:${finalValidation.errorCode ?? "unknown"}`);
  }
  const session: RemoteBrowserSession = {
    ...input,
    url: page.url(),
    context,
    page,
    clients: new Set<WebSocket>(),
    mediaClients: new Set<WebSocket>(),
    frameTimer: setInterval(() => {
      void captureFrame(session).catch(() => undefined);
    }, frameIntervalMs),
    frameCaptureInFlight: false,
    lastFrameAtMs: 0
  };
  sessions.set(input.sessionId, session);
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
  const { x, y } = remoteBrowserEventPoint(patch.event);
  if (patch.type === "scroll") {
    const delta = remoteBrowserScrollDelta(patch.event);
    await session.page.mouse.move(x, y);
    await session.page.mouse.wheel(delta.x, delta.y);
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
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", service: "remote-browser", sessions: sessions.size, timestamp: new Date().toISOString() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const payload = await parseBody<{ sessionId?: string; frameStreamId?: string; roomId?: string; objectId?: string; url?: string }>(request);
    if (!payload?.sessionId || !payload.frameStreamId || !payload.roomId || !payload.objectId || !payload.url) {
      json(response, 400, { error: "invalid_session_payload" });
      return;
    }
    const session = await createSession({ sessionId: payload.sessionId, frameStreamId: payload.frameStreamId, roomId: payload.roomId, objectId: payload.objectId, url: payload.url });
    json(response, 200, { ok: true, sessionId: session.sessionId, frameStreamId: session.frameStreamId, url: session.url });
    return;
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    json(response, 200, { ok: await stopSession(decodeURIComponent(sessionMatch[1] ?? "")) });
    return;
  }
  const inputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
  if (inputMatch && request.method === "POST") {
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
    process.stdout.write(`remote-browser listening on ${listenPort}\n`);
  });
}

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  startRemoteBrowserService();
}
