import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { AccessToken } from "livekit-server-sdk";

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

interface TenantRecord {
  tenantId: string;
  name: string;
}

interface TemplateRecord {
  templateId: string;
  label: string;
  assetSlots: string[];
}

interface AssetRecord {
  assetId: string;
  tenantId: string;
  kind: string;
  url: string;
}

interface RoomRecord {
  roomId: string;
  tenantId: string;
  templateId: string;
  name: string;
  features: RoomManifest["features"];
  assetIds: string[];
}

interface PresenceRecord {
  participantId: string;
  displayName: string;
  mode: "desktop" | "mobile" | "vr";
  rootTransform: {
    x: number;
    y: number;
    z: number;
  };
  headTransform?: {
    x: number;
    y: number;
    z: number;
  };
  muted: boolean;
  activeMedia: {
    audio: boolean;
    screenShare: boolean;
  };
  updatedAt: string;
}

const apiPort = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const staticRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/dist", import.meta.url))));
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const presenceTtlMs = Number.parseInt(process.env.PRESENCE_TTL_MS ?? "15000", 10);

const tenants = new Map<string, TenantRecord>([
  ["demo-tenant", { tenantId: "demo-tenant", name: "Demo Tenant" }]
]);

const templates = new Map<string, TemplateRecord>([
  [
    "meeting-room-basic",
    {
      templateId: "meeting-room-basic",
      label: "Meeting Room Basic",
      assetSlots: ["logo", "hero-screen"]
    }
  ],
  [
    "showroom-basic",
    {
      templateId: "showroom-basic",
      label: "Showroom Basic",
      assetSlots: ["logo", "wall-graphic"]
    }
  ],
  [
    "event-demo-basic",
    {
      templateId: "event-demo-basic",
      label: "Event Demo Basic",
      assetSlots: ["logo", "media-placeholder"]
    }
  ]
]);

const assets = new Map<string, AssetRecord>();
const presenceByRoom = new Map<string, Map<string, PresenceRecord>>();

const rooms = new Map<string, RoomRecord>([
  [
    "demo-room",
    {
      roomId: "demo-room",
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: "Demo Room",
      features: {
        voice: true,
        spatialAudio: true,
        screenShare: false
      },
      assetIds: []
    }
  ]
]);

const defaultManifest = (roomId: string): RoomManifest => ({
  schemaVersion: 1,
  tenantId: "demo-tenant",
  roomId,
  template: "meeting-room-basic",
  features: {
    voice: true,
    spatialAudio: true,
    screenShare: false
  },
  quality: {
    default: "desktop-standard",
    mobile: "mobile-lite",
    xr: "xr"
  },
  access: {
    joinMode: "link",
    guestAllowed: true
  }
});

function createRoomLink(roomId: string, host?: string): string {
  const publicUrl = process.env.RUNTIME_BASE_URL ?? `http://${host ?? `localhost:${apiPort}`}`;
  return new URL(`/rooms/${roomId}`, publicUrl).toString();
}

function cleanupPresence(roomId: string): void {
  const roomPresence = presenceByRoom.get(roomId);
  if (!roomPresence) {
    return;
  }

  const now = Date.now();
  for (const [participantId, state] of roomPresence.entries()) {
    if (now - Date.parse(state.updatedAt) > presenceTtlMs) {
      roomPresence.delete(participantId);
    }
  }

  if (roomPresence.size === 0) {
    presenceByRoom.delete(roomId);
  }
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
  const roomPresence = presenceByRoom.get(roomId);
  roomPresence?.delete(participantId);
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
  if (!normalized.startsWith(staticRoot) || !existsSync(normalized)) {
    return false;
  }

  const data = await readFile(normalized);
  response.writeHead(200, { "content-type": contentType(normalized) });
  response.end(data);
  return true;
}

function buildManifest(roomId: string): RoomManifest {
  const room = rooms.get(roomId);
  if (!room) {
    return defaultManifest(roomId);
  }

  return {
    schemaVersion: 1,
    tenantId: room.tenantId,
    roomId: room.roomId,
    template: room.templateId,
    features: room.features,
    quality: {
      default: "desktop-standard",
      mobile: "mobile-lite",
      xr: "xr"
    },
    access: {
      joinMode: "link",
      guestAllowed: true
    }
  };
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  response.end(JSON.stringify(body));
}

function parseBody<T>(request: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function encodeToken(payload: StateTokenPayload | MediaTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${apiPort}`}`);

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
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
        spatialAudioEnabled: process.env.FEATURE_SPATIAL_AUDIO !== "false"
      }
    });
    return;
  }

  if (method === "GET" && (url.pathname === "/" || /^\/rooms\/[^/]+$/.test(url.pathname))) {
    const served = await serveStatic(response, join(staticRoot, "index.html"));
    if (!served) {
      json(response, 503, { error: "runtime_build_missing" });
    }
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/assets/")) {
    const served = await serveStatic(response, join(staticRoot, url.pathname.slice(1)));
    if (!served) {
      json(response, 404, { error: "asset_not_found" });
    }
    return;
  }

  if (method === "GET" && url.pathname === "/api/templates") {
    json(response, 200, { items: Array.from(templates.values()) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/tenants") {
    json(response, 200, { items: Array.from(tenants.values()) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/rooms") {
    json(response, 200, {
      items: Array.from(rooms.values()).map((room) => ({
        ...room,
        roomLink: createRoomLink(room.roomId, request.headers.host)
      }))
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tenants") {
    const payload = (await parseBody<Partial<TenantRecord>>(request)) ?? {};
    const tenant: TenantRecord = {
      tenantId: payload.tenantId ?? crypto.randomUUID(),
      name: payload.name ?? "New Tenant"
    };
    tenants.set(tenant.tenantId, tenant);
    json(response, 201, tenant);
    return;
  }

  if (method === "POST" && url.pathname === "/api/assets") {
    const payload = (await parseBody<Partial<AssetRecord>>(request)) ?? {};
    const asset: AssetRecord = {
      assetId: payload.assetId ?? crypto.randomUUID(),
      tenantId: payload.tenantId ?? "demo-tenant",
      kind: payload.kind ?? "logo",
      url: payload.url ?? "/assets/demo/placeholder.png"
    };
    assets.set(asset.assetId, asset);
    json(response, 201, asset);
    return;
  }

  if (method === "POST" && url.pathname === "/api/rooms") {
    const payload = (await parseBody<Partial<RoomRecord>>(request)) ?? {};
    const roomId = payload.roomId ?? crypto.randomUUID();
    const room: RoomRecord = {
      roomId,
      tenantId: payload.tenantId ?? "demo-tenant",
      templateId: payload.templateId ?? "meeting-room-basic",
      name: payload.name ?? `Room ${roomId}`,
      features: {
        voice: payload.features?.voice ?? true,
        spatialAudio: payload.features?.spatialAudio ?? true,
        screenShare: payload.features?.screenShare ?? false
      },
      assetIds: payload.assetIds ?? []
    };
    rooms.set(roomId, room);
    json(response, 201, {
      ...room,
      roomLink: createRoomLink(roomId, request.headers.host),
      manifest: buildManifest(roomId)
    });
    return;
  }

  const manifestMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/manifest$/);
  if (method === "GET" && manifestMatch) {
    json(response, 200, buildManifest(decodeURIComponent(manifestMatch[1])));
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
    if (!payload) {
      json(response, 400, { error: "presence_payload_required" });
      return;
    }
    upsertPresence(decodeURIComponent(presenceItemMatch[1]), decodeURIComponent(presenceItemMatch[2]), payload);
    json(response, 200, { ok: true });
    return;
  }

  if (method === "DELETE" && presenceItemMatch) {
    deletePresence(decodeURIComponent(presenceItemMatch[1]), decodeURIComponent(presenceItemMatch[2]));
    json(response, 200, { ok: true });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "GET" && roomMatch) {
    const room = rooms.get(decodeURIComponent(roomMatch[1]));
    if (!room) {
      json(response, 404, { error: "room_not_found" });
      return;
    }
    json(response, 200, {
      ...room,
      roomLink: createRoomLink(room.roomId, request.headers.host),
      manifest: buildManifest(room.roomId)
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/state") {
    const payload = (await parseBody<StateTokenPayload>(request)) ?? {
      roomId: "demo-room",
      participantId: crypto.randomUUID(),
      role: "guest" as const
    };

    json(response, 200, {
      token: encodeToken(payload),
      expiresInSeconds: Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10)
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/media") {
    const payload = (await parseBody<MediaTokenPayload>(request)) ?? {
      roomId: "demo-room",
      participantId: crypto.randomUUID(),
      canPublishAudio: true,
      canPublishVideo: false
    };

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

  json(response, 404, {
    error: "not_found",
    path: url.pathname
  });
}

export function startApiServer(port = apiPort) {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      json(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "unknown"
      });
    });
  });

  return server.listen(port, () => {
    process.stdout.write(`api listening on ${port}\n`);
  });
}

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  startApiServer();
}
