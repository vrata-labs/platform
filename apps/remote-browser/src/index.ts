import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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
  frameTimer: ReturnType<typeof setInterval>;
  lastFrameAtMs: number;
}

const port = Number.parseInt(process.env.REMOTE_BROWSER_PORT ?? "4010", 10);
const viewport = {
  width: Number.parseInt(process.env.REMOTE_BROWSER_VIEWPORT_WIDTH ?? "1280", 10),
  height: Number.parseInt(process.env.REMOTE_BROWSER_VIEWPORT_HEIGHT ?? "720", 10)
};
const frameIntervalMs = Math.max(250, Number.parseInt(process.env.REMOTE_BROWSER_FRAME_INTERVAL_MS ?? "500", 10));
const tokenSecret = process.env.REMOTE_BROWSER_TOKEN_SECRET ?? "dev-remote-browser-secret";
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
  browserPromise ??= chromium.launch({ executablePath, headless: true });
  return browserPromise;
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
  if (session.clients.size === 0) {
    return;
  }
  const buffer = await session.page.screenshot({ type: "jpeg", quality: 60, animations: "disabled" });
  session.lastFrameAtMs = Date.now();
  broadcastFrame(session, `data:image/jpeg;base64,${buffer.toString("base64")}`);
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
  await page.addInitScript((styleContent) => {
    const styleId = "noah-remote-browser-scrollbar-style";
    const installStyle = () => {
      if (document.getElementById(styleId)) {
        return;
      }
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = String(styleContent);
      (document.head || document.documentElement).appendChild(style);
    };
    installStyle();
    document.addEventListener("DOMContentLoaded", installStyle, { once: true });
  }, remoteBrowserScrollbarStyle);
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
    frameTimer: setInterval(() => {
      void captureFrame(session).catch(() => undefined);
    }, frameIntervalMs),
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
      ws.on("close", () => session.clients.delete(ws));
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
