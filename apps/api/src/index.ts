import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { AccessToken } from "livekit-server-sdk";
import { createRoomAccessDebugState, getRoomPermissions, hasRoomPermission, parseRoomRole, type RoomPermission, type RoomRole } from "@vrata/shared-types";
import { signRoomSessionToken, verifyRoomSessionToken, type RoomSessionRoleSource, type RoomSessionTokenPayload, type RoomSessionTokenVerificationResult } from "@vrata/shared-types/session-token";

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
    roleQueryAllowed: boolean;
  };
}

type RoomAccessTokenPayload = RoomSessionTokenPayload;

interface StateTokenRequest {
  tenantId?: string;
  roomId?: string;
  participantId?: string;
  displayName?: string;
  requestedRole?: string;
  role?: string;
}

interface MediaTokenPayload {
  roomId: string;
  participantId: string;
  canPublishAudio: boolean;
  canPublishVideo: boolean;
  sessionToken?: string;
}

interface RemoteBrowserMediaTokenRequest {
  roomId?: string;
  objectId?: string;
  executorSessionId?: string;
  mediaParticipantId?: string;
  preferPublicLivekitUrl?: boolean;
}

interface RemoteBrowserFrameTokenRequest {
  roomId?: string;
  objectId?: string;
  executorSessionId?: string;
  frameStreamId?: string;
  sessionToken?: string;
}

type ControlPlanePermission =
  | "tenant.write"
  | "room.create"
  | "room.update"
  | "room.bind-scene-bundle"
  | "room.delete"
  | "asset.write"
  | "scene-bundle.write"
  | "diagnostics.read"
  | "xr-telemetry.read"
  | "audit.read";

interface ControlPlaneActor {
  actorType: "admin-token" | "room-session";
  actorId: string;
  role: RoomRole;
  roleSource?: RoomSessionRoleSource;
  tenantId?: string;
  roomId?: string;
  participantId?: string;
  sessionId?: string;
}

interface ControlPlaneAuditLogEntry {
  timestamp: string;
  requestId: string;
  action: string;
  permission: ControlPlanePermission;
  object: { type: string; id?: string };
  result: "allowed" | "denied";
  reason?: string;
  actor?: ControlPlaneActor;
}

interface ControlPlaneAuthorizationOptions {
  permission: ControlPlanePermission;
  action: string;
  objectType: string;
  objectId?: string;
  targetRoomId?: string;
  allowHostOwnRoom?: boolean;
}

interface PresenceRecord {
  participantId: string;
  displayName: string;
  role?: RoomRole;
  permissions?: RoomPermission[];
  mode: "desktop" | "mobile" | "vr";
  rootTransform: { x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
  headTransform?: { x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
  bodyTransform?: { x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
  muted: boolean;
  activeMedia: { audio: boolean; screenShare: boolean };
  seq?: number;
  clientTimeMs?: number;
  serverTimeMs?: number;
  updatedAt: string;
}

interface RuntimeSpaceRecord {
  roomId: string;
  tenantId: string;
  name: string;
  templateId: string;
  roomLink: string;
}

interface XrTelemetryRecord {
  participantId: string;
  roomId: string;
  updatedAt: string;
  kind?: string | null;
  kinds?: string[];
  statusLine?: string | null;
  currentSeatId?: string | null;
  xrAxes?: {
    moveX?: number;
    moveY?: number;
    turnX?: number;
    turnY?: number;
  };
  interactionRay?: {
    active?: boolean;
    mode?: string | null;
    targetKind?: string | null;
    seatId?: string | null;
    origin?: { x?: number; y?: number; z?: number } | null;
    direction?: { x?: number; y?: number; z?: number } | null;
    source?: { index?: number; handedness?: string | null } | null;
  };
  xrAvatarDebug?: {
    profile?: string | null;
    rightGrip?: { x?: number; y?: number; z?: number } | null;
    rightController?: { x?: number; y?: number; z?: number } | null;
    rightResolved?: { x?: number; y?: number; z?: number } | null;
    rightHandWorld?: { x?: number; y?: number; z?: number } | null;
    rightControllerWorld?: { x?: number; y?: number; z?: number } | null;
  };
  xrRawInputs?: Array<{
    index: number;
    handedness?: string | null;
    targetRayMode?: string | null;
    profiles?: string[];
    button0Pressed?: boolean;
    button1Pressed?: boolean;
    axes?: number[];
  }>;
  xrTurnCandidates?: {
    rightPrimaryX?: number;
    rightPrimaryY?: number;
    rightSecondaryX?: number;
    rightSecondaryY?: number;
    mappedTurnX?: number;
    mappedTurnY?: number;
    snapTurnFired?: boolean;
    playerYaw?: number;
    selectEventCount?: number;
  };
}

interface XrTelemetryParticipantBuffer {
  latest: XrTelemetryRecord;
  history: XrTelemetryRecord[];
}

const apiPort = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const runtimeStaticRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/dist", import.meta.url))));
const runtimePublicRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/public", import.meta.url))));
const controlPlaneStaticRoot = normalize(join(fileURLToPath(new URL("../../control-plane/dist", import.meta.url))));
const livekitApiKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitApiSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const presenceTtlMs = Number.parseInt(process.env.PRESENCE_TTL_MS ?? "15000", 10);
const storagePromise = createStorage();
const requiredProductionApiEnvVars = ["CONTROL_PLANE_ADMIN_TOKEN", "ROOM_STATE_PUBLIC_URL", "RUNTIME_BASE_URL", "STATE_TOKEN_SECRET"] as const;

const presenceByRoom = new Map<string, Map<string, PresenceRecord>>();
const xrTelemetryByRoom = new Map<string, Map<string, XrTelemetryParticipantBuffer>>();
const controlPlaneAuditLog: ControlPlaneAuditLogEntry[] = [];
const CONTROL_PLANE_AUDIT_LIMIT = 1000;
const xrTelemetryHistoryLimit = 80;
const requestIds = new WeakMap<IncomingMessage, string>();
const sensitiveKeyPattern = /(authorization|cookie|password|secret|token|invite)/i;
const REDACTED_VALUE = "[redacted]";
const metrics = {
  requestsTotal: 0,
  requestFailuresTotal: 0,
  diagnosticsReportsCreatedTotal: 0,
  roomJoinFailuresTotal: new Map<string, number>(),
  mediaJoinFailuresTotal: new Map<string, number>()
};

function isEnabledEnvValue(value: string | undefined): boolean | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function isDevRoleQueryAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.VRATA_DEV_ROLE_QUERY ?? env.NOAH_DEV_ROLE_QUERY ?? env.FEATURE_DEV_ROLE_QUERY);
  if (explicit !== null) {
    return explicit;
  }
  return env.NODE_ENV !== "production";
}

function resolveAccessRole(requestedRole: unknown, env: NodeJS.ProcessEnv = process.env): { role: RoomRole; roleSource: RoomSessionRoleSource } {
  if (!isDevRoleQueryAllowed(env)) {
    return { role: "guest", roleSource: "default" };
  }
  return { role: parseRoomRole(requestedRole, "guest"), roleSource: requestedRole === undefined || requestedRole === null ? "default" : "dev-query" };
}

function getStateTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.STATE_TOKEN_SECRET ?? "dev-state-secret";
}

function encodeAccessToken(payload: RoomAccessTokenPayload, env: NodeJS.ProcessEnv = process.env): string {
  return signRoomSessionToken(payload, getStateTokenSecret(env));
}

function encodeRemoteBrowserFrameToken(payload: { roomId: string; objectId: string; executorSessionId: string; frameStreamId: string; exp: number }, env: NodeJS.ProcessEnv = process.env): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = env.REMOTE_BROWSER_TOKEN_SECRET ?? "dev-remote-browser-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

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

function redactString(value: string): string {
  if (value.length > 80 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return REDACTED_VALUE;
  }
  if (!/[?&](authorization|password|secret|token|invite)=/i.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveKeyPattern.test(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }
    return url.toString();
  } catch (_error) {
    return value.replace(/([?&][^=]*(?:authorization|password|secret|token|invite)[^=]*=)[^&]+/gi, `$1${REDACTED_VALUE}`);
  }
}

function redactSecrets(value: unknown, key = ""): unknown {
  if (sensitiveKeyPattern.test(key)) {
    return REDACTED_VALUE;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]));
  }
  return value;
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(redactSecrets(event))}\n`);
}

function defaultManifest(roomId: string, request?: IncomingMessage): RoomManifest {
  return {
    schemaVersion: 1,
    tenantId: "demo-tenant",
    roomId,
    template: "meeting-room-basic",
    sceneBundle: undefined,
    realtime: {
      roomStateUrl: getDefaultRoomStateUrl(request)
    },
    theme: {
      primaryColor: "#5fc8ff",
      accentColor: "#163354"
    },
    assets: [],
    features: { voice: true, spatialAudio: true, screenShare: true },
    avatars: {
      avatarsEnabled: true,
      avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
      avatarQualityProfile: "desktop-standard",
      avatarPoseBinaryEnabled: true,
      avatarLipsyncEnabled: false,
      avatarLegIkEnabled: false,
      avatarFallbackCapsulesEnabled: true,
      avatarSeatsEnabled: true,
      avatarCustomizationEnabled: false
    },
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: true, roleQueryAllowed: isDevRoleQueryAllowed() }
  };
}

function getRequestHost(request?: IncomingMessage): string | undefined {
  const forwarded = request?.headers["x-forwarded-host"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]?.trim();
  }
  const host = request?.headers.host;
  return typeof host === "string" && host.trim().length > 0 ? host.trim() : undefined;
}

function getRequestProto(request?: IncomingMessage): "http" | "https" {
  const forwarded = request?.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    const proto = forwarded.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") {
      return "https";
    }
  }
  return "http";
}

function getDefaultRoomStateUrl(request?: IncomingMessage): string {
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

function getDefaultLivekitUrl(request?: IncomingMessage): string {
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

function getConfiguredPublicLivekitUrl(): string | null {
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

function getRemoteBrowserLivekitUrl(request: IncomingMessage, payload: RemoteBrowserMediaTokenRequest): string {
  if (payload.preferPublicLivekitUrl) {
    return getConfiguredPublicLivekitUrl() ?? getDefaultLivekitUrl(request);
  }
  return getDefaultLivekitUrl(request);
}

function getDefaultRemoteBrowserFrameStreamUrl(request?: IncomingMessage): string {
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

function createRoomLink(roomId: string, request?: IncomingMessage): string {
  const host = getRequestHost(request) ?? `localhost:${apiPort}`;
  const proto = getRequestProto(request);
  const configuredRuntimeBaseUrl = process.env.RUNTIME_BASE_URL;
  const publicUrl = configuredRuntimeBaseUrl
    ? (proto !== "https" || !configuredRuntimeBaseUrl.startsWith("http://") || !host
      ? configuredRuntimeBaseUrl
      : `https://${host}`)
    : `${proto}://${host}`;
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

function shouldStoreXrTelemetryHistory(record: XrTelemetryRecord, previous?: XrTelemetryRecord | null): boolean {
  const xrAxes = record.xrAxes;
  const rawInputs = record.xrRawInputs ?? [];
  return Boolean(
    record.kind
    || record.currentSeatId !== (previous?.currentSeatId ?? null)
    || record.interactionRay?.active
    || (xrAxes && (Math.abs(xrAxes.moveX ?? 0) > 0.01 || Math.abs(xrAxes.moveY ?? 0) > 0.01 || Math.abs(xrAxes.turnX ?? 0) > 0.01 || Math.abs(xrAxes.turnY ?? 0) > 0.01))
    || rawInputs.some((input) => input.button0Pressed || input.button1Pressed || (input.axes ?? []).some((value) => Math.abs(value) > 0.01))
    || record.xrAvatarDebug?.profile === "dual"
    || record.xrAvatarDebug?.profile === "right-only"
    || record.xrAvatarDebug?.profile === "left-only"
  );
}

function createXrTelemetryRecord(roomId: string, participantId: string, payload: XrTelemetryRecord): XrTelemetryRecord {
  return {
    ...payload,
    roomId,
    participantId,
    updatedAt: payload.updatedAt || new Date().toISOString()
  };
}

function appendXrTelemetryRecord(roomTelemetry: Map<string, XrTelemetryParticipantBuffer>, nextRecord: XrTelemetryRecord): boolean {
  const existing = roomTelemetry.get(nextRecord.participantId);
  const shouldStoreHistory = shouldStoreXrTelemetryHistory(nextRecord, existing?.latest ?? null);
  const history = shouldStoreHistory
    ? [...(existing?.history ?? []), nextRecord].slice(-xrTelemetryHistoryLimit)
    : (existing?.history ?? []);
  roomTelemetry.set(nextRecord.participantId, {
    latest: nextRecord,
    history
  });
  return shouldStoreHistory;
}

function cloneXrTelemetryBuffer(buffer: XrTelemetryParticipantBuffer): XrTelemetryParticipantBuffer {
  return {
    latest: structuredClone(buffer.latest),
    history: structuredClone(buffer.history)
  };
}

function compareXrTelemetryUpdatedAt(left: XrTelemetryRecord, right: XrTelemetryRecord): number {
  return left.updatedAt.localeCompare(right.updatedAt);
}

function mergeXrTelemetryHistories(...histories: XrTelemetryRecord[][]): XrTelemetryRecord[] {
  const merged = [...histories.flat()].sort(compareXrTelemetryUpdatedAt);
  const deduped = new Map<string, XrTelemetryRecord>();
  for (const record of merged) {
    const key = JSON.stringify(record);
    if (!deduped.has(key)) {
      deduped.set(key, structuredClone(record));
    }
  }
  return Array.from(deduped.values()).slice(-xrTelemetryHistoryLimit);
}

function mergeXrTelemetryBuffers(left: XrTelemetryParticipantBuffer, right: XrTelemetryParticipantBuffer): XrTelemetryParticipantBuffer {
  return {
    latest: compareXrTelemetryUpdatedAt(left.latest, right.latest) >= 0 ? structuredClone(left.latest) : structuredClone(right.latest),
    history: mergeXrTelemetryHistories(left.history, right.history)
  };
}

async function upsertXrTelemetry(roomId: string, participantId: string, payload: XrTelemetryRecord): Promise<void> {
  const roomTelemetry = xrTelemetryByRoom.get(roomId) ?? new Map<string, XrTelemetryParticipantBuffer>();
  const nextRecord = createXrTelemetryRecord(roomId, participantId, payload);
  const shouldPersist = appendXrTelemetryRecord(roomTelemetry, nextRecord);
  xrTelemetryByRoom.set(roomId, roomTelemetry);
  if (shouldPersist) {
    const storage = await storagePromise;
    await storage.addXrTelemetry(roomId, participantId, structuredClone(nextRecord) as unknown as Record<string, unknown>);
  }
}

async function listXrTelemetry(roomId: string): Promise<Array<XrTelemetryRecord & { history: XrTelemetryRecord[] }>> {
  const storage = await storagePromise;
  const persistedTelemetry = new Map<string, XrTelemetryParticipantBuffer>();
  for (const entry of await storage.getXrTelemetry(roomId)) {
    appendXrTelemetryRecord(
      persistedTelemetry,
      createXrTelemetryRecord(roomId, entry.participantId, entry.payload as unknown as XrTelemetryRecord)
    );
  }

  const liveTelemetry = xrTelemetryByRoom.get(roomId) ?? new Map<string, XrTelemetryParticipantBuffer>();
  const participantIds = new Set<string>([...persistedTelemetry.keys(), ...liveTelemetry.keys()]);
  return Array.from(participantIds)
    .map((participantId) => {
      const persisted = persistedTelemetry.get(participantId);
      const live = liveTelemetry.get(participantId);
      const merged = persisted && live
        ? mergeXrTelemetryBuffers(persisted, live)
        : persisted
          ? cloneXrTelemetryBuffer(persisted)
          : live
            ? cloneXrTelemetryBuffer(live)
            : null;
      if (!merged) {
        return null;
      }
      return {
        ...merged.latest,
        history: merged.history
      };
    })
    .filter((entry): entry is XrTelemetryRecord & { history: XrTelemetryRecord[] } => entry !== null)
    .sort((left, right) => left.participantId.localeCompare(right.participantId));
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
  const [data, metadata] = await Promise.all([readFile(normalized), stat(normalized)]);
  response.writeHead(200, {
    "content-type": contentType(normalized),
    "content-length": String(metadata.size)
  });
  response.end(data);
  return true;
}

async function buildManifest(roomId: string, request?: IncomingMessage): Promise<RoomManifest> {
  const storage = await storagePromise;
  const room = await storage.getRoom(roomId);
  if (!room) return defaultManifest(roomId, request);
  const roomAssets = (await storage.listAssets()).filter((asset) => room.assetIds.includes(asset.assetId));
  return {
    schemaVersion: 1,
    tenantId: room.tenantId,
    roomId: room.roomId,
    template: room.templateId,
    sceneBundle: room.sceneBundleUrl ? { url: room.sceneBundleUrl } : undefined,
    realtime: {
      roomStateUrl: getDefaultRoomStateUrl(request)
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
      avatarsEnabled: room.avatarConfig?.avatarsEnabled ?? true,
      avatarCatalogUrl: room.avatarConfig?.avatarCatalogUrl,
      avatarQualityProfile: room.avatarConfig?.avatarQualityProfile ?? "desktop-standard",
      avatarPoseBinaryEnabled: process.env.FEATURE_AVATAR_POSE_BINARY !== "false",
      avatarLipsyncEnabled: process.env.FEATURE_AVATAR_LIPSYNC === "true",
      avatarLegIkEnabled: process.env.FEATURE_AVATAR_LEG_IK === "true",
      avatarFallbackCapsulesEnabled: room.avatarConfig?.avatarFallbackCapsulesEnabled ?? true,
      avatarSeatsEnabled: room.avatarConfig?.avatarSeatsEnabled ?? true,
      avatarCustomizationEnabled: process.env.FEATURE_AVATAR_CUSTOMIZATION === "true"
    },
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: room.guestAllowed ?? true, roleQueryAllowed: isDevRoleQueryAllowed() }
  };
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-request-id,x-vrata-admin-token,x-vrata-internal-token,x-noah-admin-token,x-noah-internal-token",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, statusCode: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store"
  });
  response.end(body);
}

function getHeaderString(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name.toLowerCase()];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return null;
}

function getRequestId(request: IncomingMessage): string {
  const existing = requestIds.get(request);
  if (existing) {
    return existing;
  }
  const requestId = getHeaderString(request, "x-request-id")?.trim() || randomUUID();
  requestIds.set(request, requestId);
  return requestId;
}

function attachRequestId(request: IncomingMessage, response: ServerResponse): string {
  const requestId = getRequestId(request);
  response.setHeader("x-request-id", requestId);
  return requestId;
}

function incrementCounter(counter: Map<string, number>, reason: string | undefined): void {
  const label = reason && reason.trim().length > 0 ? reason : "unknown";
  counter.set(label, (counter.get(label) ?? 0) + 1);
}

function cleanupAllPresence(): void {
  for (const roomId of Array.from(presenceByRoom.keys())) {
    cleanupPresence(roomId);
  }
}

function activeParticipantCount(): number {
  cleanupAllPresence();
  let total = 0;
  for (const roomPresence of presenceByRoom.values()) {
    total += roomPresence.size;
  }
  return total;
}

function formatMetricLine(name: string, value: number, labels?: Record<string, string>): string {
  const labelEntries = Object.entries(labels ?? {});
  const labelText = labelEntries.length === 0
    ? ""
    : `{${labelEntries.map(([key, labelValue]) => `${key}="${labelValue.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",")}}`;
  return `${name}${labelText} ${value}`;
}

function createReportId(): string {
  return `rpt_${randomUUID()}`;
}

function normalizeReportId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^rpt_[A-Za-z0-9_-]{8,80}$/.test(trimmed) ? trimmed : null;
}

function createDiagnosticRecord(roomId: string, payload: RuntimeDiagnosticRecord, request: IncomingMessage): RuntimeDiagnosticRecord {
  const requestId = getRequestId(request);
  const reportId = normalizeReportId(payload.reportId) ?? createReportId();
  const sanitized = redactSecrets({
    ...payload,
    reportId,
    requestId,
    createdAt: payload.createdAt || new Date().toISOString()
  }) as RuntimeDiagnosticRecord;
  if (sanitized.sceneDebug?.screenshot && "dataUrl" in sanitized.sceneDebug.screenshot) {
    const screenshot = { ...sanitized.sceneDebug.screenshot };
    delete screenshot.dataUrl;
    sanitized.sceneDebug = { ...sanitized.sceneDebug, screenshot };
  }
  logEvent({
    service: "api",
    event: "runtime_diagnostic_report",
    roomId,
    participantId: sanitized.participantId,
    reportId,
    requestId,
    issueCode: sanitized.issueCode ?? null,
    note: sanitized.note ?? null,
    timestamp: sanitized.createdAt
  });
  return sanitized;
}

async function apiMetricsText(storage: Awaited<typeof storagePromise>): Promise<string> {
  cleanupAllPresence();
  const rooms = await storage.listRooms();
  const lines = [
    "# HELP vrata_api_requests_total Total API HTTP requests handled by this process.",
    "# TYPE vrata_api_requests_total counter",
    formatMetricLine("vrata_api_requests_total", metrics.requestsTotal),
    "# HELP vrata_api_request_failures_total Total unhandled API request failures.",
    "# TYPE vrata_api_request_failures_total counter",
    formatMetricLine("vrata_api_request_failures_total", metrics.requestFailuresTotal),
    "# HELP vrata_rooms_total Rooms known to the API storage backend.",
    "# TYPE vrata_rooms_total gauge",
    formatMetricLine("vrata_rooms_total", rooms.length),
    "# HELP vrata_active_rooms Rooms with currently fresh runtime presence.",
    "# TYPE vrata_active_rooms gauge",
    formatMetricLine("vrata_active_rooms", presenceByRoom.size),
    "# HELP vrata_active_participants Fresh runtime participants currently known by API fallback presence.",
    "# TYPE vrata_active_participants gauge",
    formatMetricLine("vrata_active_participants", activeParticipantCount()),
    "# HELP vrata_diagnostic_reports_created_total Runtime diagnostic reports accepted by API.",
    "# TYPE vrata_diagnostic_reports_created_total counter",
    formatMetricLine("vrata_diagnostic_reports_created_total", metrics.diagnosticsReportsCreatedTotal),
    "# HELP vrata_room_join_failures_total Runtime join or room failures reported by clients.",
    "# TYPE vrata_room_join_failures_total counter"
  ];
  for (const [reason, count] of metrics.roomJoinFailuresTotal.entries()) {
    lines.push(formatMetricLine("vrata_room_join_failures_total", count, { reason }));
  }
  lines.push(
    "# HELP vrata_media_join_failures_total Media token or media join failures observed by API.",
    "# TYPE vrata_media_join_failures_total counter"
  );
  for (const [reason, count] of metrics.mediaJoinFailuresTotal.entries()) {
    lines.push(formatMetricLine("vrata_media_join_failures_total", count, { reason }));
  }
  return `${lines.join("\n")}\n`;
}

function getControlPlaneAdminToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONTROL_PLANE_ADMIN_TOKEN?.trim() || "";
}

function writeControlPlaneAudit(entry: ControlPlaneAuditLogEntry): void {
  controlPlaneAuditLog.push(entry);
  if (controlPlaneAuditLog.length > CONTROL_PLANE_AUDIT_LIMIT) {
    controlPlaneAuditLog.splice(0, controlPlaneAuditLog.length - CONTROL_PLANE_AUDIT_LIMIT);
  }
  logEvent({
    service: "api",
    event: "control_plane_audit",
    ...entry
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getInternalServiceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.VRATA_INTERNAL_SERVICE_TOKEN?.trim() || env.NOAH_INTERNAL_SERVICE_TOKEN?.trim() || env.REMOTE_BROWSER_INTERNAL_TOKEN?.trim() || "";
  return token || null;
}

function isAuthorizedInternalRequest(request: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = getInternalServiceToken(env);
  if (!token) {
    return true;
  }
  const provided = request.headers["x-vrata-internal-token"] ?? request.headers["x-noah-internal-token"];
  return typeof provided === "string" && safeEqual(provided, token);
}

function getBearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return null;
  }
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

function resolveControlPlaneActor(request: IncomingMessage):
  | { ok: true; actor: ControlPlaneActor }
  | { ok: false; statusCode: 401; reason: string } {
  const adminToken = getControlPlaneAdminToken();
  const providedAdminToken = getHeaderString(request, "x-vrata-admin-token") ?? getHeaderString(request, "x-noah-admin-token");
  if (providedAdminToken !== null) {
    if (adminToken && safeEqual(providedAdminToken, adminToken)) {
      return {
        ok: true,
        actor: {
          actorType: "admin-token",
          actorId: "control-plane-admin",
          role: "admin"
        }
      };
    }
    return { ok: false, statusCode: 401, reason: "invalid_control_plane_admin_token" };
  }

  const bearerToken = getBearerToken(request);
  if (bearerToken) {
    const session = verifyRoomSessionToken(bearerToken, getStateTokenSecret());
    if (!session.ok) {
      return { ok: false, statusCode: 401, reason: session.code };
    }
    return {
      ok: true,
      actor: {
        actorType: "room-session",
        actorId: session.payload.participantId,
        role: session.payload.role,
        roleSource: session.payload.roleSource,
        tenantId: session.payload.tenantId,
        roomId: session.payload.roomId,
        participantId: session.payload.participantId,
        sessionId: session.payload.sessionId
      }
    };
  }

  return { ok: false, statusCode: 401, reason: "missing_identity" };
}

function isControlPlaneActorAllowed(actor: ControlPlaneActor, options: ControlPlaneAuthorizationOptions): boolean {
  if (actor.actorType === "admin-token") {
    return true;
  }
  return Boolean(options.allowHostOwnRoom && actor.role === "host" && actor.roleSource === "trusted" && options.targetRoomId && actor.roomId === options.targetRoomId);
}

async function requireControlPlanePermission(
  request: IncomingMessage,
  response: ServerResponse,
  options: ControlPlaneAuthorizationOptions
): Promise<ControlPlaneActor | null> {
  const requestId = getRequestId(request);
  const actorResult = resolveControlPlaneActor(request);
  const auditBase = {
    timestamp: new Date().toISOString(),
    requestId,
    action: options.action,
    permission: options.permission,
    object: { type: options.objectType, id: options.objectId }
  } satisfies Omit<ControlPlaneAuditLogEntry, "result">;

  if (!actorResult.ok) {
    writeControlPlaneAudit({
      ...auditBase,
      result: "denied",
      reason: actorResult.reason
    });
    json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId });
    return null;
  }

  if (!isControlPlaneActorAllowed(actorResult.actor, options)) {
    writeControlPlaneAudit({
      ...auditBase,
      result: "denied",
      reason: "permission_denied",
      actor: actorResult.actor
    });
    json(response, 403, { error: "forbidden", reason: "permission_denied", permission: options.permission, requestId });
    return null;
  }

  writeControlPlaneAudit({
    ...auditBase,
    result: "allowed",
    actor: actorResult.actor
  });
  return actorResult.actor;
}

function sessionTokenStatusCode(result: RoomSessionTokenVerificationResult): 401 | 403 {
  if (result.ok) {
    return 403;
  }
  return result.code.endsWith("_mismatch") ? 403 : 401;
}

function writeSessionTokenError(response: ServerResponse, result: RoomSessionTokenVerificationResult): void {
  if (result.ok) {
    return;
  }
  json(response, sessionTokenStatusCode(result), {
    error: result.code === "missing_token" ? "session_token_required" : "session_token_invalid",
    reason: result.code
  });
}

async function resolveRoomTenantId(roomId: string): Promise<string> {
  const storage = await storagePromise;
  const room = await storage.getRoom(roomId);
  return room?.tenantId ?? "demo-tenant";
}

async function verifyRoomSessionRequest(
  request: IncomingMessage,
  input: { roomId: string; participantId?: string; sessionToken?: string | null }
): Promise<RoomSessionTokenVerificationResult> {
  const tenantId = await resolveRoomTenantId(input.roomId);
  return verifyRoomSessionToken(input.sessionToken ?? getBearerToken(request), getStateTokenSecret(), {
    tenantId,
    roomId: input.roomId,
    participantId: input.participantId
  });
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

async function listRuntimeSpaces(storage: Awaited<typeof storagePromise>, roomId: string, request?: IncomingMessage): Promise<RuntimeSpaceRecord[]> {
  const currentRoom = await storage.getRoom(roomId);
  if (!currentRoom) {
    return [{
      roomId,
      tenantId: defaultManifest(roomId).tenantId,
      name: roomId,
      templateId: defaultManifest(roomId).template,
      roomLink: createRoomLink(roomId, request)
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
      roomLink: createRoomLink(room.roomId, request)
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
  const requestId = attachRequestId(request, response);
  metrics.requestsTotal += 1;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${apiPort}`}`);
  const storage = await storagePromise;

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-request-id,x-vrata-admin-token,x-vrata-internal-token,x-noah-admin-token,x-noah-internal-token",
      "x-request-id": requestId
    });
    response.end();
    return;
  }

  if (method === "GET" && url.pathname === "/health/live") {
    json(response, 200, {
      status: "live",
      service: "api",
      env: process.env.NODE_ENV ?? "development",
      port: apiPort,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (method === "GET" && url.pathname === "/health/ready") {
    json(response, 200, {
      status: "ready",
      service: "api",
      env: process.env.NODE_ENV ?? "development",
      port: apiPort,
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: Boolean(process.env.POSTGRES_URL),
        livekit: Boolean(process.env.LIVEKIT_URL),
        roomStatePublicUrl: process.env.ROOM_STATE_PUBLIC_URL ?? "ws://127.0.0.1:2567"
      }
    });
    return;
  }

  if (method === "GET" && url.pathname === "/metrics") {
    text(response, 200, await apiMetricsText(storage));
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
        avatarPoseBinaryEnabled: process.env.FEATURE_AVATAR_POSE_BINARY !== "false",
        avatarLipsyncEnabled: process.env.FEATURE_AVATAR_LIPSYNC === "true",
        avatarLegIkEnabled: process.env.FEATURE_AVATAR_LEG_IK === "true",
        avatarSeatingEnabled: process.env.FEATURE_AVATAR_SEATING !== "false",
        avatarCustomizationEnabled: process.env.FEATURE_AVATAR_CUSTOMIZATION === "true",
        avatarFallbackCapsulesEnabled: process.env.FEATURE_AVATAR_FALLBACK_CAPSULES !== "false",
        postgresEnabled: Boolean(process.env.POSTGRES_URL),
        controlPlaneAuthEnabled: Boolean(getControlPlaneAdminToken())
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

  if (method === "GET" && url.pathname === "/remote-browser-demo.html") {
    const served = await serveStatic(response, join(runtimePublicRoot, "remote-browser-demo.html"));
    if (!served) json(response, 404, { error: "remote_browser_demo_missing" });
    return;
  }

  if (method === "GET" && url.pathname === "/remote-browser-media-demo.html") {
    const served = await serveStatic(response, join(runtimePublicRoot, "remote-browser-media-demo.html"));
    if (!served) json(response, 404, { error: "remote_browser_media_demo_missing" });
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
    json(response, 200, { items: rooms.map((room) => ({ ...room, roomLink: createRoomLink(room.roomId, request) })) });
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
    json(response, 200, { items: await listRuntimeSpaces(storage, decodeURIComponent(roomSpacesMatch[1]), request) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/audit/control-plane") {
    const actor = await requireControlPlanePermission(request, response, { permission: "audit.read", action: "audit.control-plane.list", objectType: "audit-log", objectId: "control-plane" });
    if (!actor) return;
    json(response, 200, { items: controlPlaneAuditLog });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tenants") {
    const actor = await requireControlPlanePermission(request, response, { permission: "tenant.write", action: "tenant.create", objectType: "tenant" });
    if (!actor) return;
    const tenant = await storage.createTenant((await parseBody<Partial<TenantRecord>>(request)) ?? {});
    json(response, 201, tenant);
    return;
  }

  const tenantItemMatch = url.pathname.match(/^\/api\/tenants\/([^/]+)$/);
  if (method === "PATCH" && tenantItemMatch) {
    const tenantId = decodeURIComponent(tenantItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "tenant.write", action: "tenant.update", objectType: "tenant", objectId: tenantId });
    if (!actor) return;
    const tenant = await storage.updateTenant(tenantId, (await parseBody<Partial<TenantRecord>>(request)) ?? {});
    if (!tenant) return json(response, 404, { error: "tenant_not_found" });
    json(response, 200, tenant);
    return;
  }

  if (method === "DELETE" && tenantItemMatch) {
    const tenantId = decodeURIComponent(tenantItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "tenant.write", action: "tenant.delete", objectType: "tenant", objectId: tenantId });
    if (!actor) return;
    const deleted = await storage.deleteTenant(tenantId);
    if (!deleted) return json(response, 409, { error: "tenant_has_dependencies_or_missing" });
    json(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/assets") {
    const actor = await requireControlPlanePermission(request, response, { permission: "asset.write", action: "asset.create", objectType: "asset" });
    if (!actor) return;
    const payload = (await parseBody<Partial<AssetRecord>>(request)) ?? {};
    const validationError = validateAssetInput(payload);
    if (validationError) return json(response, 400, { error: validationError });
    const asset = await storage.createAsset(payload);
    json(response, 201, asset);
    return;
  }

  if (method === "POST" && url.pathname === "/api/scene-bundles") {
    const actor = await requireControlPlanePermission(request, response, { permission: "scene-bundle.write", action: "scene-bundle.create", objectType: "scene-bundle" });
    if (!actor) return;
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
    const bundleId = decodeURIComponent(sceneBundleVersionsMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "scene-bundle.write", action: "scene-bundle.version.create", objectType: "scene-bundle", objectId: bundleId });
    if (!actor) return;
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
    const bundleId = decodeURIComponent(sceneBundleCurrentMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "scene-bundle.write", action: "scene-bundle.current.set", objectType: "scene-bundle", objectId: bundleId });
    if (!actor) return;
    const payload = (await parseBody<{ version?: string }>(request)) ?? {};
    if (!payload.version) return json(response, 400, { error: "missing_scene_bundle_version" });
    const current = await storage.setCurrentSceneBundleVersion(bundleId, payload.version);
    if (!current) return json(response, 404, { error: "scene_bundle_version_not_found" });
    json(response, 200, current);
    return;
  }

  const sceneBundleStatusMatch = url.pathname.match(/^\/api\/scene-bundles\/([^/]+)\/versions\/([^/]+)\/status$/);
  if (method === "POST" && sceneBundleStatusMatch) {
    const bundleId = decodeURIComponent(sceneBundleStatusMatch[1]);
    const version = decodeURIComponent(sceneBundleStatusMatch[2]);
    const actor = await requireControlPlanePermission(request, response, { permission: "scene-bundle.write", action: "scene-bundle.version.status.update", objectType: "scene-bundle", objectId: `${bundleId}:${version}` });
    if (!actor) return;
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
    const assetId = decodeURIComponent(assetItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "asset.write", action: "asset.update", objectType: "asset", objectId: assetId });
    if (!actor) return;
    const payload = (await parseBody<Partial<AssetRecord>>(request)) ?? {};
    const validationError = validateAssetInput(payload.url ? payload : { ...payload, url: "placeholder.glb" });
    if (payload.url && validationError) return json(response, 400, { error: validationError });
    const asset = await storage.updateAsset(assetId, payload);
    if (!asset) return json(response, 404, { error: "asset_not_found" });
    json(response, 200, asset);
    return;
  }

  if (method === "DELETE" && assetItemMatch) {
    const assetId = decodeURIComponent(assetItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "asset.write", action: "asset.delete", objectType: "asset", objectId: assetId });
    if (!actor) return;
    const deleted = await storage.deleteAsset(assetId);
    if (!deleted) return json(response, 409, { error: "asset_has_dependencies_or_missing" });
    json(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/rooms") {
    const actor = await requireControlPlanePermission(request, response, { permission: "room.create", action: "room.create", objectType: "room" });
    if (!actor) return;
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
    json(response, 201, { ...room, roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request) });
    return;
  }

  const roomItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "PATCH" && roomItemMatch) {
    const roomId = decodeURIComponent(roomItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "room.update", action: "room.update", objectType: "room", objectId: roomId });
    if (!actor) return;
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
    json(response, 200, { ...updated, roomLink: createRoomLink(updated.roomId, request), manifest: await buildManifest(updated.roomId, request) });
    return;
  }

  const roomBindSceneBundleMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/bind-scene-bundle$/);
  if (method === "POST" && roomBindSceneBundleMatch) {
    const roomId = decodeURIComponent(roomBindSceneBundleMatch[1]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.bind-scene-bundle",
      action: "room.bind-scene-bundle",
      objectType: "room",
      objectId: roomId,
      targetRoomId: roomId,
      allowHostOwnRoom: true
    });
    if (!actor) return;
    const payload = (await parseBody<{ bundleId?: string; version?: string }>(request)) ?? {};
    if (!payload.bundleId) return json(response, 400, { error: "missing_scene_bundle_id" });
    const bundle = payload.version
      ? (await storage.listSceneBundleVersions(payload.bundleId)).find((item) => item.version === payload.version) ?? null
      : await storage.getSceneBundle(payload.bundleId);
    if (!bundle) return json(response, 404, { error: "scene_bundle_not_found" });
    const room = await storage.updateRoom(roomId, { sceneBundleUrl: bundle.publicUrl });
    if (!room) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...room, roomLink: createRoomLink(room.roomId, request), sceneBundle: bundle, currentVersion: getCurrentSceneBundleVersion(bundle) });
    return;
  }

  if (method === "DELETE" && roomItemMatch) {
    const roomId = decodeURIComponent(roomItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "room.delete", action: "room.delete", objectType: "room", objectId: roomId });
    if (!actor) return;
    const deleted = await storage.deleteRoom(roomId);
    if (!deleted) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ok: true, roomId });
    return;
  }

  const manifestMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/manifest$/);
  if (method === "GET" && manifestMatch) {
    json(response, 200, await buildManifest(decodeURIComponent(manifestMatch[1]), request));
    return;
  }

  const presenceListMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/presence$/);
  if (method === "GET" && presenceListMatch) {
    json(response, 200, { items: getPresence(decodeURIComponent(presenceListMatch[1])) });
    return;
  }

  const presenceItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/presence\/([^/]+)$/);
  if (method === "PUT" && presenceItemMatch) {
    const roomId = decodeURIComponent(presenceItemMatch[1]);
    const participantId = decodeURIComponent(presenceItemMatch[2]);
    const payload = await parseBody<PresenceRecord>(request);
    if (!payload) return json(response, 400, { error: "presence_payload_required" });
    const session = await verifyRoomSessionRequest(request, { roomId, participantId });
    if (!session.ok) return writeSessionTokenError(response, session);
    upsertPresence(roomId, participantId, payload);
    json(response, 200, { ok: true });
    return;
  }

  if (method === "DELETE" && presenceItemMatch) {
    const roomId = decodeURIComponent(presenceItemMatch[1]);
    const participantId = decodeURIComponent(presenceItemMatch[2]);
    const session = await verifyRoomSessionRequest(request, { roomId, participantId });
    if (!session.ok) return writeSessionTokenError(response, session);
    deletePresence(roomId, participantId);
    json(response, 200, { ok: true });
    return;
  }

  const diagnosticsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/diagnostics$/);
  if (method === "GET" && diagnosticsMatch) {
    const roomId = decodeURIComponent(diagnosticsMatch[1]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "diagnostics.read",
      action: "diagnostics.list",
      objectType: "room",
      objectId: roomId
    });
    if (!actor) return;
    json(response, 200, { items: await storage.getDiagnostics(roomId) });
    return;
  }

  if (method === "POST" && diagnosticsMatch) {
    const roomId = decodeURIComponent(diagnosticsMatch[1]);
    const payload = await parseBody<RuntimeDiagnosticRecord>(request);
    if (!payload) return json(response, 400, { error: "diagnostics_payload_required" });
    const participantId = typeof payload.participantId === "string" ? payload.participantId : undefined;
    const session = await verifyRoomSessionRequest(request, { roomId, participantId });
    if (!session.ok) return writeSessionTokenError(response, session);
    const diagnostic = createDiagnosticRecord(roomId, payload, request);
    metrics.diagnosticsReportsCreatedTotal += 1;
    if (diagnostic.issueCode) {
      incrementCounter(metrics.roomJoinFailuresTotal, diagnostic.issueCode);
    }
    await storage.addDiagnostic(roomId, diagnostic);
    json(response, 201, { ok: true, reportId: diagnostic.reportId, requestId: diagnostic.requestId });
    return;
  }

  const xrTelemetryListMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/xr-telemetry$/);
  if (method === "GET" && xrTelemetryListMatch) {
    const roomId = decodeURIComponent(xrTelemetryListMatch[1]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "xr-telemetry.read",
      action: "xr-telemetry.list",
      objectType: "room",
      objectId: roomId,
      targetRoomId: roomId,
      allowHostOwnRoom: true
    });
    if (!actor) return;
    json(response, 200, { items: await listXrTelemetry(roomId) });
    return;
  }

  const xrTelemetryItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/xr-telemetry\/([^/]+)$/);
  if (method === "PUT" && xrTelemetryItemMatch) {
    const roomId = decodeURIComponent(xrTelemetryItemMatch[1]);
    const participantId = decodeURIComponent(xrTelemetryItemMatch[2]);
    const payload = await parseBody<XrTelemetryRecord>(request);
    if (!payload) return json(response, 400, { error: "xr_telemetry_payload_required" });
    const session = await verifyRoomSessionRequest(request, { roomId, participantId });
    if (!session.ok) return writeSessionTokenError(response, session);
    await upsertXrTelemetry(roomId, participantId, payload);
    json(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && roomItemMatch) {
    const room = await storage.getRoom(decodeURIComponent(roomItemMatch[1]));
    if (!room) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...room, roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/state") {
    const requestPayload = await parseBody<StateTokenRequest>(request);
    const ttlSeconds = Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const roomId = requestPayload?.roomId ?? "demo-room";
    const { role, roleSource } = resolveAccessRole(requestPayload?.requestedRole ?? requestPayload?.role);
    const permissions = getRoomPermissions(role);
    const payload: RoomAccessTokenPayload = {
      tenantId: await resolveRoomTenantId(roomId),
      roomId,
      participantId: requestPayload?.participantId ?? randomUUID(),
      displayName: requestPayload?.displayName ?? requestPayload?.participantId ?? "Guest",
      role,
      roleSource,
      permissions,
      sessionId: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
      jti: randomUUID()
    };
    json(response, 200, {
      token: encodeAccessToken(payload),
      expiresInSeconds: ttlSeconds,
      sessionId: payload.sessionId,
      access: createRoomAccessDebugState(role),
      role,
      permissions
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/media") {
    const payload = (await parseBody<MediaTokenPayload>(request)) ?? { roomId: "demo-room", participantId: randomUUID(), canPublishAudio: true, canPublishVideo: false };
    const session = await verifyRoomSessionRequest(request, {
      roomId: payload.roomId,
      participantId: payload.participantId,
      sessionToken: payload.sessionToken
    });
    if (!session.ok) {
      incrementCounter(metrics.mediaJoinFailuresTotal, session.code);
      return writeSessionTokenError(response, session);
    }
    const canPublishAudio = hasRoomPermission(session.payload.permissions, "audio.join") && payload.canPublishAudio !== false;
    const canPublishVideo = Boolean(payload.canPublishVideo) && hasRoomPermission(session.payload.permissions, "screen-share.start");
    if (!canPublishAudio && !canPublishVideo) {
      incrementCounter(metrics.mediaJoinFailuresTotal, "media_publish_not_allowed");
      return json(response, 403, { error: "forbidden", reason: "media_publish_not_allowed" });
    }
    const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: session.payload.participantId,
      name: session.payload.displayName,
      ttl: `${Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10)}s`
    });
    accessToken.addGrant({
      room: `${process.env.LIVEKIT_ROOM_PREFIX ?? "vrata-"}${session.payload.roomId}`,
      roomJoin: true,
      canPublish: canPublishAudio || canPublishVideo,
      canSubscribe: true
    });
    json(response, 200, {
      token: await accessToken.toJwt(),
      expiresInSeconds: Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10),
      livekitUrl: getDefaultLivekitUrl(request)
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/remote-browser-media") {
    if (!isAuthorizedInternalRequest(request)) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    const payload = (await parseBody<RemoteBrowserMediaTokenRequest>(request)) ?? {};
    if (!payload.roomId || !payload.objectId || !payload.executorSessionId || !payload.mediaParticipantId) {
      json(response, 400, { error: "remote_browser_media_token_payload_required" });
      return;
    }
    const ttlSeconds = Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10);
    const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity: payload.mediaParticipantId,
      name: `Remote Browser ${payload.objectId}`,
      ttl: `${ttlSeconds}s`
    });
    accessToken.addGrant({
      room: `${process.env.LIVEKIT_ROOM_PREFIX ?? "vrata-"}${payload.roomId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: false
    });
    json(response, 200, {
      token: await accessToken.toJwt(),
      expiresInSeconds: ttlSeconds,
      livekitUrl: getRemoteBrowserLivekitUrl(request, payload),
      participantId: payload.mediaParticipantId
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/remote-browser-frame") {
    const payload = await parseBody<RemoteBrowserFrameTokenRequest>(request);
    if (!payload?.roomId || !payload.objectId || !payload.executorSessionId || !payload.frameStreamId) {
      json(response, 400, { error: "remote_browser_frame_token_payload_required" });
      return;
    }
    const session = await verifyRoomSessionRequest(request, {
      roomId: payload.roomId,
      sessionToken: payload.sessionToken
    });
    if (!session.ok) return writeSessionTokenError(response, session);
    if (!hasRoomPermission(session.payload.permissions, "surface.view")) {
      return json(response, 403, { error: "forbidden", reason: "remote_browser_frame_not_allowed" });
    }
    const ttlSeconds = Number.parseInt(process.env.REMOTE_BROWSER_TOKEN_TTL_SECONDS ?? "300", 10);
    const token = encodeRemoteBrowserFrameToken({
      roomId: payload.roomId,
      objectId: payload.objectId,
      executorSessionId: payload.executorSessionId,
      frameStreamId: payload.frameStreamId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds
    });
    const frameStreamUrl = new URL(getDefaultRemoteBrowserFrameStreamUrl(request));
    frameStreamUrl.searchParams.set("token", token);
    json(response, 200, {
      token,
      expiresInSeconds: ttlSeconds,
      frameStreamUrl: frameStreamUrl.toString()
    });
    return;
  }

  json(response, 404, { error: "not_found", path: url.pathname });
}

export function startApiServer(port = apiPort) {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      const requestId = attachRequestId(request, response);
      metrics.requestFailuresTotal += 1;
      logEvent({
        service: "api",
        event: "request_failed",
        env: process.env.NODE_ENV ?? "development",
        requestId,
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
    logEvent({ service: "api", event: "listening", env: process.env.NODE_ENV ?? "development", port, timestamp: new Date().toISOString() });
  });
}

if (process.env.NODE_ENV !== "test" && process.env.VRATA_DISABLE_AUTOSTART !== "1" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  validateProductionApiEnv();
  startApiServer();
}
