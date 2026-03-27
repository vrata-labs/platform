import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { AccessToken } from "livekit-server-sdk";

import {
  createStorage,
  type AssetRecord,
  type RoomRecord,
  type RuntimeDiagnosticRecord,
  type TenantRecord
} from "./storage.js";

type UserRole = "guest" | "member" | "host" | "admin";

interface RoomManifest {
  schemaVersion: number;
  tenantId: string;
  roomId: string;
  template: string;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  quality: {
    default: "desktop-standard" | "mobile-lite" | "xr";
    mobile: "mobile-lite";
    xr: "xr";
  };
  access: {
    joinMode: "link";
    guestAllowed: boolean;
  };
}

interface StateTokenPayload {
  roomId: string;
  participantId: string;
  role: UserRole;
}

interface MediaTokenPayload {
  roomId: string;
  participantId: string;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
}

interface PresenceRecord {
  participantId: string;
  displayName: string;
  mode: "desktop" | "mobile" | "vr";
  rootTransform: { x: number; y: number; z: number };
  headTransform?: { x: number; y: number; z: number };
  bodyTransform?: { x: number; y: number; z: number };
  muted: boolean;
  activeMedia: { audio: boolean; screenShare: boolean };
  updatedAt: string;
}

const apiPort = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const runtimeStaticRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/dist", import.meta.url))));
const controlPlaneStaticRoot = normalize(join(fileURLToPath(new URL("../../control-plane/dist", import.meta.url))));
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const controlPlaneAdminToken = process.env.CONTROL_PLANE_ADMIN_TOKEN ?? "";
const presenceTtlMs = Number.parseInt(process.env.PRESENCE_TTL_MS ?? "15000", 10);
const storagePromise = createStorage();

const presenceByRoom = new Map<string, Map<string, PresenceRecord>>();

function defaultManifest(roomId: string): RoomManifest {
  return {
    schemaVersion: 1,
    tenantId: "demo-tenant",
    roomId,
    template: "meeting-room-basic",
    features: { voice: true, spatialAudio: true, screenShare: false },
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: true }
  };
}

function createRoomLink(roomId: string, host?: string): string {
  const publicUrl = process.env.RUNTIME_BASE_URL ?? `http://${host ?? `localhost:${apiPort}`}`;
  return new URL(`/rooms/${roomId}`, publicUrl).toString();
}

function cleanupPresence(roomId: string): void {
  const roomPresence = presenceByRoom.get(roomId);
  if (!roomPresence) return;
  const now = Date.now();
  for (const [participantId, state] of roomPresence.entries()) {
    if (now - Date.parse(state.updatedAt) > presenceTtlMs) roomPresence.delete(participantId);
  }
  if (roomPresence.size === 0) presenceByRoom.delete(roomId);
}

function getPresence(roomId: string): PresenceRecord[] {
  cleanupPresence(roomId);
  return Array.from(presenceByRoom.get(roomId)?.values() ?? []);
}

function upsertPresence(roomId: string, participantId: string, payload: PresenceRecord): void {
  cleanupPresence(roomId);
  const roomPresence = presenceByRoom.get(roomId) ?? new Map<string, PresenceRecord>();
  roomPresence.set(participantId, payload);
  presenceByRoom.set(roomId, roomPresence);
}

function deletePresence(roomId: string, participantId: string): void {
  presenceByRoom.get(roomId)?.delete(participantId);
}

function contentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(response: ServerResponse, filePath: string): Promise<boolean> {
  const normalized = normalize(filePath);
  if (!existsSync(normalized)) return false;
  const data = await readFile(normalized);
  response.writeHead(200, { "content-type": contentType(normalized) });
  response.end(data);
  return true;
}

async function buildManifest(roomId: string): Promise<RoomManifest> {
  const storage = await storagePromise;
  const room = await storage.getRoom(roomId);
  if (!room) return defaultManifest(roomId);
  return {
    schemaVersion: 1,
    tenantId: room.tenantId,
    roomId: room.roomId,
    template: room.templateId,
    features: room.features,
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: true }
  };
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-noah-admin-token",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function isAuthorizedControlPlaneRequest(request: IncomingMessage): boolean {
  if (!controlPlaneAdminToken) {
    return true;
  }
  return request.headers["x-noah-admin-token"] === controlPlaneAdminToken;
}

function parseBody<T>(request: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        reject(new Error("payload_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function validateRoomInput(input: Partial<RoomRecord>, templateIds: Set<string>, tenantIds: Set<string>): string | null {
  if (!input.name || input.name.trim().length < 3 || input.name.trim().length > 80) {
    return "invalid_room_name";
  }
  if (!input.templateId || !templateIds.has(input.templateId)) {
    return "invalid_template";
  }
  if (!input.tenantId || !tenantIds.has(input.tenantId)) {
    return "invalid_tenant";
  }
  return null;
}

function encodeToken(payload: StateTokenPayload | MediaTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${apiPort}`}`);
  const storage = await storagePromise;

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    });
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      status: "ok",
      service: "api",
      port: apiPort,
      features: {
        xrEnabled: process.env.FEATURE_XR !== "false",
        screenShareEnabled: process.env.FEATURE_SCREEN_SHARE !== "false",
        spatialAudioEnabled: process.env.FEATURE_SPATIAL_AUDIO !== "false",
        postgresEnabled: Boolean(process.env.POSTGRES_URL),
        controlPlaneAuthEnabled: Boolean(controlPlaneAdminToken)
      }
    });
    return;
  }

  if (method === "GET" && (url.pathname === "/" || /^\/rooms\/[^/]+$/.test(url.pathname))) {
    const served = await serveStatic(response, join(runtimeStaticRoot, "index.html"));
    if (!served) json(response, 503, { error: "runtime_build_missing" });
    return;
  }

  if (method === "GET" && (url.pathname === "/control-plane" || url.pathname === "/control-plane/")) {
    const served = await serveStatic(response, join(controlPlaneStaticRoot, "index.html"));
    if (!served) json(response, 503, { error: "control_plane_build_missing" });
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/assets/")) {
    const served = await serveStatic(response, join(runtimeStaticRoot, url.pathname.slice(1)));
    if (!served) json(response, 404, { error: "asset_not_found" });
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/control-plane/assets/")) {
    const served = await serveStatic(response, join(controlPlaneStaticRoot, url.pathname.replace(/^\/control-plane\//, "")));
    if (!served) json(response, 404, { error: "control_plane_asset_not_found" });
    return;
  }

  if (method === "GET" && url.pathname === "/api/templates") {
    json(response, 200, { items: await storage.listTemplates() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/assets") {
    json(response, 200, { items: await storage.listAssets() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/tenants") {
    json(response, 200, { items: await storage.listTenants() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/rooms") {
    const rooms = await storage.listRooms();
    json(response, 200, { items: rooms.map((room) => ({ ...room, roomLink: createRoomLink(room.roomId, request.headers.host) })) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tenants") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const tenant = await storage.createTenant((await parseBody<Partial<TenantRecord>>(request)) ?? {});
    json(response, 201, tenant);
    return;
  }

  if (method === "POST" && url.pathname === "/api/assets") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const asset = await storage.createAsset((await parseBody<Partial<AssetRecord>>(request)) ?? {});
    json(response, 201, asset);
    return;
  }

  if (method === "POST" && url.pathname === "/api/rooms") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const payload = (await parseBody<Partial<RoomRecord>>(request)) ?? {};
    const tenantIds = new Set((await storage.listTenants()).map((tenant) => tenant.tenantId));
    const templateIds = new Set((await storage.listTemplates()).map((template) => template.templateId));
    const validationError = validateRoomInput(payload, templateIds, tenantIds);
    if (validationError) return json(response, 400, { error: validationError });
    const room = await storage.createRoom(payload);
    json(response, 201, { ...room, roomLink: createRoomLink(room.roomId, request.headers.host), manifest: await buildManifest(room.roomId) });
    return;
  }

  const manifestMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/manifest$/);
  if (method === "GET" && manifestMatch) {
    json(response, 200, await buildManifest(decodeURIComponent(manifestMatch[1])));
    return;
  }

  const presenceListMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/presence$/);
  if (method === "GET" && presenceListMatch) {
    json(response, 200, { items: getPresence(decodeURIComponent(presenceListMatch[1])) });
    return;
  }

  const presenceItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/presence\/([^/]+)$/);
  if (method === "PUT" && presenceItemMatch) {
    const payload = await parseBody<PresenceRecord>(request);
    if (!payload) return json(response, 400, { error: "presence_payload_required" });
    upsertPresence(decodeURIComponent(presenceItemMatch[1]), decodeURIComponent(presenceItemMatch[2]), payload);
    json(response, 200, { ok: true });
    return;
  }

  if (method === "DELETE" && presenceItemMatch) {
    deletePresence(decodeURIComponent(presenceItemMatch[1]), decodeURIComponent(presenceItemMatch[2]));
    json(response, 200, { ok: true });
    return;
  }

  const diagnosticsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/diagnostics$/);
  if (method === "GET" && diagnosticsMatch) {
    json(response, 200, { items: await storage.getDiagnostics(decodeURIComponent(diagnosticsMatch[1])) });
    return;
  }

  if (method === "POST" && diagnosticsMatch) {
    const payload = await parseBody<RuntimeDiagnosticRecord>(request);
    if (!payload) return json(response, 400, { error: "diagnostics_payload_required" });
    await storage.addDiagnostic(decodeURIComponent(diagnosticsMatch[1]), payload);
    json(response, 201, { ok: true });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "GET" && roomMatch) {
    const room = await storage.getRoom(decodeURIComponent(roomMatch[1]));
    if (!room) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...room, roomLink: createRoomLink(room.roomId, request.headers.host), manifest: await buildManifest(room.roomId) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/state") {
    const payload = (await parseBody<StateTokenPayload>(request)) ?? { roomId: "demo-room", participantId: crypto.randomUUID(), role: "guest" as const };
    json(response, 200, { token: encodeToken(payload), expiresInSeconds: Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/media") {
    const payload = (await parseBody<MediaTokenPayload>(request)) ?? { roomId: "demo-room", participantId: crypto.randomUUID(), canPublishAudio: true, canPublishVideo: false };
    const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: payload.participantId,
      name: payload.participantId,
      ttl: `${Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10)}s`
    });
    accessToken.addGrant({
      room: `${process.env.LIVEKIT_ROOM_PREFIX ?? "noah-"}${payload.roomId}`,
      roomJoin: true,
      canPublish: payload.canPublishAudio || payload.canPublishVideo,
      canSubscribe: true
    });
    json(response, 200, {
      token: await accessToken.toJwt(),
      expiresInSeconds: Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10),
      livekitUrl: process.env.LIVEKIT_URL ?? `ws://${request.headers.host?.split(":")[0] ?? "localhost"}:7880`
    });
    return;
  }

  json(response, 404, { error: "not_found", path: url.pathname });
}

export function startApiServer(port = apiPort) {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      json(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : "unknown" });
    });
  });
  return server.listen(port, () => {
    process.stdout.write(`api listening on ${port}\n`);
  });
}

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  startApiServer();
}
