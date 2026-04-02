import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { AccessToken } from "livekit-server-sdk";

import {
  resolveSceneBundlePublicUrl,
  type SceneBundleCreateInput,
  type SceneBundleRecord,
  type SceneBundleProvider
} from "./scene-bundle-storage.js";

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
  sceneBundle?: {
    url: string;
  };
  realtime: {
    roomStateUrl: string;
  };
  theme: {
    primaryColor: string;
    accentColor: string;
  };
  assets: Array<{
    assetId: string;
    kind: string;
    url: string;
    processedUrl?: string;
    validationStatus?: "pending" | "validated" | "rejected";
  }>;
  features: {
    voice: boolean;
    spatialAudio: boolean;
    screenShare: boolean;
  };
  avatars: {
    avatarsEnabled: boolean;
    avatarCatalogUrl?: string;
    avatarQualityProfile: "desktop-standard" | "mobile-lite" | "xr";
    avatarPoseBinaryEnabled: boolean;
    avatarLipsyncEnabled: boolean;
    avatarLegIkEnabled: boolean;
    avatarFallbackCapsulesEnabled: boolean;
    avatarSeatsEnabled: boolean;
    avatarCustomizationEnabled: boolean;
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

interface RuntimeSpaceRecord {
  roomId: string;
  tenantId: string;
  name: string;
  templateId: string;
  roomLink: string;
}

const apiPort = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const runtimeStaticRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/dist", import.meta.url))));
const runtimePublicRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/public", import.meta.url))));
const controlPlaneStaticRoot = normalize(join(fileURLToPath(new URL("../../control-plane/dist", import.meta.url))));
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const controlPlaneAdminToken = process.env.CONTROL_PLANE_ADMIN_TOKEN ?? "";
const presenceTtlMs = Number.parseInt(process.env.PRESENCE_TTL_MS ?? "15000", 10);
const storagePromise = createStorage();
const requiredProductionApiEnvVars = ["CONTROL_PLANE_ADMIN_TOKEN", "ROOM_STATE_PUBLIC_URL", "RUNTIME_BASE_URL"] as const;

const presenceByRoom = new Map<string, Map<string, PresenceRecord>>();

export function getMissingRequiredApiEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return requiredProductionApiEnvVars.filter((name) => !env[name] || env[name]?.trim().length === 0);
}

function validateProductionApiEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const missing = getMissingRequiredApiEnvVars(env);
  if (missing.length === 0) {
    return;
  }
  throw new Error(`missing_required_api_env:${missing.join(",")}`);
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function defaultManifest(roomId: string): RoomManifest {
  return {
    schemaVersion: 1,
    tenantId: "demo-tenant",
    roomId,
    template: "meeting-room-basic",
    sceneBundle: undefined,
    realtime: {
      roomStateUrl: process.env.ROOM_STATE_PUBLIC_URL ?? "ws://127.0.0.1:2567"
    },
    theme: {
      primaryColor: "#5fc8ff",
      accentColor: "#163354"
    },
    assets: [],
    features: { voice: true, spatialAudio: true, screenShare: true },
    avatars: {
      avatarsEnabled: false,
      avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
      avatarQualityProfile: "desktop-standard",
      avatarPoseBinaryEnabled: false,
      avatarLipsyncEnabled: false,
      avatarLegIkEnabled: false,
      avatarFallbackCapsulesEnabled: true,
      avatarSeatsEnabled: false,
      avatarCustomizationEnabled: false
    },
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
  const roomAssets = (await storage.listAssets()).filter((asset) => room.assetIds.includes(asset.assetId));
  return {
    schemaVersion: 1,
    tenantId: room.tenantId,
    roomId: room.roomId,
    template: room.templateId,
    sceneBundle: room.sceneBundleUrl ? { url: room.sceneBundleUrl } : undefined,
    realtime: {
      roomStateUrl: process.env.ROOM_STATE_PUBLIC_URL ?? `ws://state-${process.env.API_PUBLIC_URL?.replace(/^https?:\/\//, "") ?? "127.0.0.1:2567"}`
    },
    theme: room.theme ?? {
      primaryColor: "#5fc8ff",
      accentColor: "#163354"
    },
    assets: roomAssets.map((asset) => ({
      assetId: asset.assetId,
      kind: asset.kind,
      url: asset.url,
      processedUrl: asset.processedUrl,
      validationStatus: asset.validationStatus
    })),
    features: room.features,
    avatars: {
      avatarsEnabled: room.avatarConfig?.avatarsEnabled ?? false,
      avatarCatalogUrl: room.avatarConfig?.avatarCatalogUrl,
      avatarQualityProfile: room.avatarConfig?.avatarQualityProfile ?? "desktop-standard",
      avatarPoseBinaryEnabled: process.env.FEATURE_AVATAR_POSE_BINARY === "true",
      avatarLipsyncEnabled: process.env.FEATURE_AVATAR_LIPSYNC === "true",
      avatarLegIkEnabled: process.env.FEATURE_AVATAR_LEG_IK === "true",
      avatarFallbackCapsulesEnabled: room.avatarConfig?.avatarFallbackCapsulesEnabled ?? true,
      avatarSeatsEnabled: room.avatarConfig?.avatarSeatsEnabled ?? false,
      avatarCustomizationEnabled: process.env.FEATURE_AVATAR_CUSTOMIZATION === "true"
    },
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: room.guestAllowed ?? true }
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

function normalizeRoomPayload(input: Partial<RoomRecord> & {
  avatarsEnabled?: boolean;
  avatarCatalogUrl?: string;
  avatarQualityProfile?: "mobile-lite" | "desktop-standard" | "xr";
  avatarFallbackCapsulesEnabled?: boolean;
  avatarSeatsEnabled?: boolean;
}): Partial<RoomRecord> {
  const legacyAvatarConfig: Partial<NonNullable<RoomRecord["avatarConfig"]>> = {
    avatarsEnabled: input.avatarsEnabled,
    avatarCatalogUrl: input.avatarCatalogUrl,
    avatarQualityProfile: input.avatarQualityProfile,
    avatarFallbackCapsulesEnabled: input.avatarFallbackCapsulesEnabled,
    avatarSeatsEnabled: input.avatarSeatsEnabled
  };

  const hasLegacyAvatarField = Object.values(legacyAvatarConfig).some((value) => value !== undefined);

  const normalized = { ...input } as Partial<RoomRecord>;
  if (hasLegacyAvatarField) {
    normalized.avatarConfig = {
      ...legacyAvatarConfig,
      ...input.avatarConfig
    } as RoomRecord["avatarConfig"];
  }

  return normalized;
}

async function validateRoomAssetIds(
  storage: Awaited<typeof storagePromise>,
  assetIds: string[] | undefined,
  templateId?: string
): Promise<string | null> {
  if (!assetIds || assetIds.length === 0) {
    return null;
  }
  const assets = await storage.listAssets();
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const template = (await storage.listTemplates()).find((item) => item.templateId === templateId);
  for (const assetId of assetIds) {
    const asset = byId.get(assetId);
    if (!asset) {
      return "invalid_asset_reference";
    }
    if (asset.validationStatus === "rejected") {
      return "rejected_asset_not_attachable";
    }
    if (template && !template.assetSlots.includes(asset.kind)) {
      return "asset_kind_not_supported_by_template";
    }
  }
  return null;
}

function validateAssetInput(input: Partial<AssetRecord>): string | null {
  if (!input.url) {
    return "invalid_asset_url";
  }

  const fileName = input.url.split("/").pop() ?? "";
  const extensionMatch = fileName.match(/(\.[a-z0-9]+)$/i);
  const extension = extensionMatch?.[1] ?? "";
  if (!fileName) {
    return "missing_filename";
  }
  if (!/[.]glb$|[.]gltf$|[.]ktx2$/i.test(extension)) {
    return "unsupported_extension";
  }

  return null;
}

function validateSceneBundleInput(input: Partial<SceneBundleCreateInput>): string | null {
  if (!input.storageKey || input.storageKey.trim().length === 0) {
    return "invalid_scene_bundle_storage_key";
  }
  if (input.provider && input.provider !== "minio-default" && input.provider !== "s3-compatible") {
    return "invalid_scene_bundle_provider";
  }
  if (input.publicUrl) {
    try {
      new URL(input.publicUrl);
    } catch {
      return "invalid_scene_bundle_public_url";
    }
  }
  return null;
}

function getCurrentSceneBundleVersion(bundle: SceneBundleRecord): string {
  return bundle.version;
}

function encodeToken(payload: StateTokenPayload | MediaTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function listRuntimeSpaces(storage: Awaited<typeof storagePromise>, roomId: string, host?: string): Promise<RuntimeSpaceRecord[]> {
  const currentRoom = await storage.getRoom(roomId);
  if (!currentRoom) {
    return [{
      roomId,
      tenantId: defaultManifest(roomId).tenantId,
      name: roomId,
      templateId: defaultManifest(roomId).template,
      roomLink: createRoomLink(roomId, host)
    }];
  }

  const rooms = (await storage.listRooms())
    .filter((room) => room.tenantId === currentRoom.tenantId)
    .filter((room) => room.roomId === currentRoom.roomId || room.guestAllowed !== false)
    .map((room) => ({
      roomId: room.roomId,
      tenantId: room.tenantId,
      name: room.name,
      templateId: room.templateId,
      roomLink: createRoomLink(room.roomId, host)
    }));

  return rooms.sort((left, right) => {
    if (left.roomId === currentRoom.roomId) {
      return -1;
    }
    if (right.roomId === currentRoom.roomId) {
      return 1;
    }
    return left.name.localeCompare(right.name) || left.roomId.localeCompare(right.roomId);
  });
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
      env: process.env.NODE_ENV ?? "development",
      port: apiPort,
      timestamp: new Date().toISOString(),
      features: {
        xrEnabled: process.env.FEATURE_XR !== "false",
        voiceEnabled: process.env.FEATURE_VOICE !== "false",
        screenShareEnabled: process.env.FEATURE_SCREEN_SHARE !== "false",
        spatialAudioEnabled: process.env.FEATURE_SPATIAL_AUDIO !== "false",
        roomStateRealtimeEnabled: process.env.FEATURE_ROOM_STATE_REALTIME !== "false",
        remoteDiagnosticsEnabled: process.env.FEATURE_REMOTE_DIAGNOSTICS !== "false",
        sceneBundlesEnabled: process.env.FEATURE_SCENE_BUNDLES !== "false",
        avatarsEnabled: process.env.FEATURE_AVATARS !== "false",
        avatarPoseBinaryEnabled: process.env.FEATURE_AVATAR_POSE_BINARY === "true",
        avatarLipsyncEnabled: process.env.FEATURE_AVATAR_LIPSYNC === "true",
        avatarLegIkEnabled: process.env.FEATURE_AVATAR_LEG_IK === "true",
        avatarSeatingEnabled: process.env.FEATURE_AVATAR_SEATING === "true",
        avatarCustomizationEnabled: process.env.FEATURE_AVATAR_CUSTOMIZATION === "true",
        avatarFallbackCapsulesEnabled: process.env.FEATURE_AVATAR_FALLBACK_CAPSULES !== "false",
        postgresEnabled: Boolean(process.env.POSTGRES_URL),
        controlPlaneAuthEnabled: Boolean(controlPlaneAdminToken)
      },
      dependencies: {
        postgres: Boolean(process.env.POSTGRES_URL),
        livekit: Boolean(process.env.LIVEKIT_URL),
        roomStatePublicUrl: process.env.ROOM_STATE_PUBLIC_URL ?? "ws://127.0.0.1:2567"
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
    const served = await serveStatic(response, join(runtimeStaticRoot, url.pathname.slice(1)))
      || await serveStatic(response, join(runtimePublicRoot, url.pathname.slice(1)));
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

  if (method === "GET" && url.pathname === "/api/scene-bundles") {
    json(response, 200, { items: await storage.listSceneBundles() });
    return;
  }

  const sceneBundleItemMatch = url.pathname.match(/^\/api\/scene-bundles\/([^/]+)$/);
  if (method === "GET" && sceneBundleItemMatch) {
    const bundle = await storage.getSceneBundle(decodeURIComponent(sceneBundleItemMatch[1]));
    if (!bundle) return json(response, 404, { error: "scene_bundle_not_found" });
    json(response, 200, bundle);
    return;
  }

  const sceneBundleVersionsMatch = url.pathname.match(/^\/api\/scene-bundles\/([^/]+)\/versions$/);
  if (method === "GET" && sceneBundleVersionsMatch) {
    json(response, 200, { items: await storage.listSceneBundleVersions(decodeURIComponent(sceneBundleVersionsMatch[1])) });
    return;
  }

  const roomSpacesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/spaces$/);
  if (method === "GET" && roomSpacesMatch) {
    if (url.searchParams.get("fail") === "1") {
      json(response, 503, { error: "spaces_unavailable" });
      return;
    }
    json(response, 200, { items: await listRuntimeSpaces(storage, decodeURIComponent(roomSpacesMatch[1]), request.headers.host) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tenants") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const tenant = await storage.createTenant((await parseBody<Partial<TenantRecord>>(request)) ?? {});
    json(response, 201, tenant);
    return;
  }

  const tenantItemMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)$/);
  if (method === "PATCH" && tenantItemMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const tenant = await storage.updateTenant(decodeURIComponent(tenantItemMatch[1]), (await parseBody<Partial<TenantRecord>>(request)) ?? {});
    if (!tenant) return json(response, 404, { error: "tenant_not_found" });
    json(response, 200, tenant);
    return;
  }

  if (method === "DELETE" && tenantItemMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const deleted = await storage.deleteTenant(decodeURIComponent(tenantItemMatch[1]));
    if (!deleted) return json(response, 409, { error: "tenant_has_dependencies_or_missing" });
    json(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/assets") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const payload = (await parseBody<Partial<AssetRecord>>(request)) ?? {};
    const validationError = validateAssetInput(payload);
    if (validationError) return json(response, 400, { error: validationError });
    const asset = await storage.createAsset(payload);
    json(response, 201, asset);
    return;
  }

  if (method === "POST" && url.pathname === "/api/scene-bundles") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const payload = (await parseBody<Partial<SceneBundleCreateInput>>(request)) ?? {};
    const validationError = validateSceneBundleInput(payload);
    if (validationError) return json(response, 400, { error: validationError });

    try {
      const provider = (payload.provider ?? ((process.env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined) ?? "minio-default"));
      const publicUrl = payload.publicUrl ?? resolveSceneBundlePublicUrl(payload.storageKey!, process.env, provider);
      const bundle = await storage.createSceneBundle({
        ...payload,
        storageKey: payload.storageKey!,
        publicUrl,
        provider
      });
      json(response, 201, bundle);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "scene_bundle_publish_failed";
      json(response, 400, { error: message });
      return;
    }
  }

  if (method === "POST" && sceneBundleVersionsMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const bundleId = decodeURIComponent(sceneBundleVersionsMatch[1]);
    const payload = (await parseBody<Partial<SceneBundleCreateInput>>(request)) ?? {};
    const validationError = validateSceneBundleInput(payload);
    if (validationError) return json(response, 400, { error: validationError });
    try {
      const provider = (payload.provider ?? ((process.env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined) ?? "minio-default"));
      const publicUrl = payload.publicUrl ?? resolveSceneBundlePublicUrl(payload.storageKey!, process.env, provider);
      const bundle = await storage.createSceneBundle({
        ...payload,
        bundleId,
        storageKey: payload.storageKey!,
        publicUrl,
        provider
      });
      json(response, 201, bundle);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "scene_bundle_publish_failed";
      json(response, 400, { error: message });
      return;
    }
  }

  const sceneBundleCurrentMatch = url.pathname.match(/^\/api\/scene-bundles\/([^/]+)\/current$/);
  if (method === "POST" && sceneBundleCurrentMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const bundleId = decodeURIComponent(sceneBundleCurrentMatch[1]);
    const payload = (await parseBody<{ version?: string }>(request)) ?? {};
    if (!payload.version) return json(response, 400, { error: "missing_scene_bundle_version" });
    const current = await storage.setCurrentSceneBundleVersion(bundleId, payload.version);
    if (!current) return json(response, 404, { error: "scene_bundle_version_not_found" });
    json(response, 200, current);
    return;
  }

  const sceneBundleStatusMatch = url.pathname.match(/^\/api\/scene-bundles\/([^/]+)\/versions\/([^/]+)\/status$/);
  if (method === "POST" && sceneBundleStatusMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const bundleId = decodeURIComponent(sceneBundleStatusMatch[1]);
    const version = decodeURIComponent(sceneBundleStatusMatch[2]);
    const payload = (await parseBody<{ status?: SceneBundleRecord["status"] }>(request)) ?? {};
    if (!payload.status || !["active", "obsolete", "cleanup-ready"].includes(payload.status)) {
      return json(response, 400, { error: "invalid_scene_bundle_status" });
    }
    const versions = await storage.listSceneBundleVersions(bundleId);
    const target = versions.find((item) => item.version === version);
    if (!target) return json(response, 404, { error: "scene_bundle_version_not_found" });
    if (payload.status === "cleanup-ready") {
      const rooms = await storage.listRooms();
      if (rooms.some((room) => room.sceneBundleUrl === target.publicUrl)) {
        return json(response, 409, { error: "scene_bundle_version_still_bound" });
      }
    }
    const updated = await storage.updateSceneBundle(bundleId, {
      version,
      storageKey: target.storageKey,
      publicUrl: target.publicUrl,
      contentType: target.contentType,
      checksum: target.checksum,
      sizeBytes: target.sizeBytes,
      provider: target.provider,
      status: payload.status,
      isCurrent: target.isCurrent
    } as Partial<SceneBundleCreateInput> & { publicUrl: string; provider: SceneBundleProvider; status: SceneBundleRecord["status"]; isCurrent: boolean });
    json(response, 200, updated);
    return;
  }

  const assetItemMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (method === "PATCH" && assetItemMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const assetId = decodeURIComponent(assetItemMatch[1]);
    const payload = (await parseBody<Partial<AssetRecord>>(request)) ?? {};
    const validationError = validateAssetInput(payload.url ? payload : { ...payload, url: "placeholder.glb" });
    if (payload.url && validationError) return json(response, 400, { error: validationError });
    const asset = await storage.updateAsset(assetId, payload);
    if (!asset) return json(response, 404, { error: "asset_not_found" });
    json(response, 200, asset);
    return;
  }

  if (method === "DELETE" && assetItemMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const deleted = await storage.deleteAsset(decodeURIComponent(assetItemMatch[1]));
    if (!deleted) return json(response, 409, { error: "asset_has_dependencies_or_missing" });
    json(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/rooms") {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const payload = normalizeRoomPayload((await parseBody<Partial<RoomRecord> & {
      avatarsEnabled?: boolean;
      avatarCatalogUrl?: string;
      avatarQualityProfile?: "mobile-lite" | "desktop-standard" | "xr";
      avatarFallbackCapsulesEnabled?: boolean;
      avatarSeatsEnabled?: boolean;
    }>(request)) ?? {});
    const tenantIds = new Set((await storage.listTenants()).map((tenant) => tenant.tenantId));
    const templateIds = new Set((await storage.listTemplates()).map((template) => template.templateId));
    const validationError = validateRoomInput(payload, templateIds, tenantIds);
    if (validationError) return json(response, 400, { error: validationError });
    const assetValidationError = await validateRoomAssetIds(storage, payload.assetIds, payload.templateId);
    if (assetValidationError) return json(response, 400, { error: assetValidationError });
    const room = await storage.createRoom(payload);
    json(response, 201, { ...room, roomLink: createRoomLink(room.roomId, request.headers.host), manifest: await buildManifest(room.roomId) });
    return;
  }

  const roomItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "PATCH" && roomItemMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const roomId = decodeURIComponent(roomItemMatch[1]);
    const payload = normalizeRoomPayload((await parseBody<Partial<RoomRecord> & {
      avatarsEnabled?: boolean;
      avatarCatalogUrl?: string;
      avatarQualityProfile?: "mobile-lite" | "desktop-standard" | "xr";
      avatarFallbackCapsulesEnabled?: boolean;
      avatarSeatsEnabled?: boolean;
    }>(request)) ?? {});
    const existingRoom = await storage.getRoom(roomId);
    if (!existingRoom) return json(response, 404, { error: "room_not_found" });
    if (payload.assetIds) {
      const assetValidationError = await validateRoomAssetIds(storage, payload.assetIds, payload.templateId ?? existingRoom.templateId);
      if (assetValidationError) return json(response, 400, { error: assetValidationError });
    }
    const updated = await storage.updateRoom(roomId, payload);
    if (!updated) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...updated, roomLink: createRoomLink(updated.roomId, request.headers.host), manifest: await buildManifest(updated.roomId) });
    return;
  }

  const roomBindSceneBundleMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/bind-scene-bundle$/);
  if (method === "POST" && roomBindSceneBundleMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const roomId = decodeURIComponent(roomBindSceneBundleMatch[1]);
    const payload = (await parseBody<{ bundleId?: string; version?: string }>(request)) ?? {};
    if (!payload.bundleId) return json(response, 400, { error: "missing_scene_bundle_id" });
    const bundle = payload.version
      ? (await storage.listSceneBundleVersions(payload.bundleId)).find((item) => item.version === payload.version) ?? null
      : await storage.getSceneBundle(payload.bundleId);
    if (!bundle) return json(response, 404, { error: "scene_bundle_not_found" });
    const room = await storage.updateRoom(roomId, { sceneBundleUrl: bundle.publicUrl });
    if (!room) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...room, roomLink: createRoomLink(room.roomId, request.headers.host), sceneBundle: bundle, currentVersion: getCurrentSceneBundleVersion(bundle) });
    return;
  }

  if (method === "DELETE" && roomItemMatch) {
    if (!isAuthorizedControlPlaneRequest(request)) return json(response, 403, { error: "forbidden" });
    const roomId = decodeURIComponent(roomItemMatch[1]);
    const deleted = await storage.deleteRoom(roomId);
    if (!deleted) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ok: true, roomId });
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

  if (method === "GET" && roomItemMatch) {
    const room = await storage.getRoom(decodeURIComponent(roomItemMatch[1]));
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
      logEvent({
        service: "api",
        env: process.env.NODE_ENV ?? "development",
        errorCode: "internal_error",
        path: request.url ?? "",
        method: request.method ?? "GET",
        message: error instanceof Error ? error.message : "unknown",
        timestamp: new Date().toISOString()
      });
      json(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : "unknown" });
    });
  });
  return server.listen(port, () => {
    process.stdout.write(`api listening on ${port}\n`);
  });
}

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  validateProductionApiEnv();
  startApiServer();
}
