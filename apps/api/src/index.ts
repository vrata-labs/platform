import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

const apiPort = Number.parseInt(process.env.API_PORT ?? "4000", 10);

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

function createRoomLink(roomId: string): string {
  const publicUrl = process.env.RUNTIME_BASE_URL ?? "http://localhost:3000";
  return new URL(`/rooms/${roomId}`, publicUrl).toString();
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
        roomLink: createRoomLink(room.roomId)
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
      roomLink: createRoomLink(roomId),
      manifest: buildManifest(roomId)
    });
    return;
  }

  const manifestMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/manifest$/);
  if (method === "GET" && manifestMatch) {
    json(response, 200, buildManifest(decodeURIComponent(manifestMatch[1])));
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
      roomLink: createRoomLink(room.roomId),
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

    json(response, 200, {
      token: encodeToken(payload),
      expiresInSeconds: Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10),
      livekitUrl: process.env.LIVEKIT_URL ?? "ws://localhost:7880"
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

const isEntrypoint = process.argv[1] ? new URL(`file://${process.argv[1]}`).href === import.meta.url : false;

if (isEntrypoint) {
  startApiServer();
}
