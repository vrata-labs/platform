import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { AccessToken } from "livekit-server-sdk";
import { extractSceneBundleZipToTemp, normalizeSceneBundleRelativePath, validateSceneBundlePath, validateSceneBundleReference } from "@vrata/asset-pipeline";
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
  type RoomDocumentRecord,
  type RoomNoteRecord,
  type RoomNoteScope,
  type RoomInviteRecord,
  type RoomRecord,
  type RoomPersonalState,
  type RoomSessionControlState,
  type RoomType,
  type RoomVisibility,
  type RuntimeDiagnosticRecord,
  type TenantRecord,
  type WaitingRoomRequestRecord
} from "./storage.js";

interface RoomManifest {
  schemaVersion: number;
  tenantId: string;
  roomId: string;
  roomType: RoomType;
  ownerParticipantId?: string | null;
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
    visibility: RoomVisibility;
    disabled?: boolean;
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
  inviteToken?: string;
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
  | "dashboard.read"
  | "tenant.write"
  | "room.create"
  | "room.update"
  | "room.bind-scene-bundle"
  | "room.delete"
  | "asset.write"
  | "scene-bundle.write"
  | "diagnostics.read"
  | "xr-telemetry.read"
  | "audit.read"
  | "room.invite"
  | "room.session-control"
  | "document.view"
  | "document.download"
  | "document.upload"
  | "document.delete"
  | "notes.view"
  | "notes.edit"
  | "room.join";

interface ControlPlaneActor {
  actorType: "admin-token" | "room-session";
  actorId: string;
  role: RoomRole;
  roleSource?: RoomSessionRoleSource;
  tenantId?: string;
  roomId?: string;
  participantId?: string;
  sessionId?: string;
  permissions?: RoomPermission[];
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
  currentHostParticipantId?: string | null;
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
  audioJoined?: boolean;
  muted: boolean;
  speaking?: boolean;
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

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

interface SceneBundleManifestMetadata {
  schemaVersion?: number;
  sceneId?: string;
  glbPath?: string;
  preview?: string;
}

type SceneBundleUploadStorage = {
  type: "local";
  provider: SceneBundleProvider;
  root: string;
  publicBaseUrl: string;
} | {
  type: "s3";
  provider: SceneBundleProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type DocumentUploadStorage = SceneBundleUploadStorage;

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
const presenceTtlMs = Number.parseInt(process.env.PRESENCE_TTL_MS ?? "15000", 10);
const storagePromise = createStorage();
const requiredProductionApiEnvVars = ["CONTROL_PLANE_ADMIN_TOKEN", "ROOM_STATE_PUBLIC_URL", "RUNTIME_BASE_URL", "STATE_TOKEN_SECRET", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;

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
  mediaJoinFailuresTotal: new Map<string, number>(),
  roomAccessDeniedTotal: new Map<string, number>(),
  hostActionsTotal: new Map<string, number>(),
  roomLockedTotal: 0,
  participantsRemovedTotal: 0,
  sessionsEndedTotal: 0,
  adminDashboardViewsTotal: 0,
  adminActionsTotal: new Map<string, number>(),
  roomsDisabledTotal: 0,
  invitesRevokedTotal: 0,
  roomsCreatedTotal: new Map<string, number>(),
  roomCreationFailuresTotal: new Map<string, number>(),
  sceneBundleUploadsTotal: new Map<string, number>(),
  sceneBundleUploadBytesTotal: 0,
  sceneBundleValidationFailuresTotal: new Map<string, number>(),
  notesCreatedTotal: new Map<string, number>(),
  notesSavedTotal: new Map<string, number>(),
  notesSaveFailuresTotal: new Map<string, number>(),
  notesPermissionDeniedTotal: 0,
  documentsUploadedTotal: new Map<string, number>(),
  documentDownloadsTotal: 0,
  documentStorageBytesTotal: new Map<string, number>(),
  documentPermissionDeniedTotal: 0,
  documentDeletesTotal: 0,
  documentSurfaceSelectionsTotal: 0,
  personalRoomsCreatedTotal: 0,
  personalRoomOpensTotal: new Map<string, number>(),
  personalRoomAccessDeniedTotal: new Map<string, number>(),
  personalStateSaveFailuresTotal: new Map<string, number>()
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

export function isSpatialAudioFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.SPATIAL_AUDIO_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_SPATIAL_AUDIO) ?? true;
}

export function isXrFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.XR_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_XR) ?? true;
}

export function isRoomAccessPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.ROOM_ACCESS_POLICY_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_ROOM_ACCESS_POLICY) ?? true;
}

export function isNotesFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnvValue(env.FEATURE_NOTES) ?? true;
}

export function isDocumentsFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnvValue(env.FEATURE_DOCUMENTS) ?? true;
}

export function isPersonalRoomsFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnabledEnvValue(env.FEATURE_PERSONAL_ROOMS) ?? true;
}

function isSceneBundleUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FEATURE_SCENE_BUNDLES === "false") return false;
  return isEnabledEnvValue(env.FEATURE_SCENE_BUNDLE_UPLOAD) ?? true;
}

export function isHostControlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = isEnabledEnvValue(env.HOST_CONTROLS_ENABLED);
  if (explicit !== null) {
    return explicit;
  }
  return isEnabledEnvValue(env.FEATURE_HOST_CONTROLS) ?? true;
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

function createInviteToken(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
}

function hashInviteToken(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return createHmac("sha256", getStateTokenSecret(env)).update(token).digest("base64url");
}

function isRoomVisibility(input: unknown): input is RoomVisibility {
  return input === "public" || input === "unlisted" || input === "private";
}

function sanitizeRoomVisibility(input: unknown, fallback: RoomVisibility = "public"): RoomVisibility {
  return isRoomVisibility(input) ? input : fallback;
}

function isRoomDisabled(room: RoomRecord | null | undefined): boolean {
  return room?.status === "disabled" || Boolean(room?.disabledAt);
}

const controlPlanePermissions: ControlPlanePermission[] = [
  "dashboard.read",
  "tenant.write",
  "room.create",
  "room.update",
  "room.bind-scene-bundle",
  "room.delete",
  "asset.write",
  "scene-bundle.write",
  "diagnostics.read",
  "xr-telemetry.read",
  "audit.read",
  "room.invite",
  "room.session-control",
  "document.view",
  "document.download",
  "document.upload",
  "document.delete",
  "notes.view",
  "notes.edit",
  "room.join"
];

function encodeRemoteBrowserFrameToken(payload: { roomId: string; objectId: string; executorSessionId: string; frameStreamId: string; exp: number }, env: NodeJS.ProcessEnv = process.env): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = env.REMOTE_BROWSER_TOKEN_SECRET ?? "dev-remote-browser-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function getMissingRequiredApiEnvVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return requiredProductionApiEnvVars.filter((name) => !env[name] || env[name]?.trim().length === 0);
}

export function validateProductionApiEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const missing = getMissingRequiredApiEnvVars(env);
  if (missing.length > 0) {
    throw new Error(`missing_required_api_env:${missing.join(",")}`);
  }
  const livekitConfigError = getMediaTokenConfigError(env);
  if (livekitConfigError) {
    throw new Error(`invalid_livekit_config:${livekitConfigError}`);
  }
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  return isEnabledEnvValue(value);
}

function isLoopbackLivekitHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function isInsecureLoopbackLivekitUrlAllowed(livekitUrl: string, env: NodeJS.ProcessEnv): boolean {
  if (parseBooleanEnv(env.VRATA_ALLOW_INSECURE_PRODUCTION_URLS) !== true) {
    return false;
  }
  try {
    const parsed = new URL(livekitUrl);
    return parsed.protocol === "ws:" && isLoopbackLivekitHost(parsed.hostname);
  } catch {
    return false;
  }
}

function getLivekitCredentials(env: NodeJS.ProcessEnv = process.env): { apiKey: string; apiSecret: string } {
  return {
    apiKey: env.LIVEKIT_API_KEY ?? "devkey",
    apiSecret: env.LIVEKIT_API_SECRET ?? "secret"
  };
}

function hasDevLivekitCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const { apiKey, apiSecret } = getLivekitCredentials(env);
  return apiKey === "devkey" || apiSecret === "secret" || apiSecret === "devsecret";
}

function getMediaTokenConfigError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production") {
    return null;
  }
  const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter((name) => !env[name] || env[name]?.trim().length === 0);
  if (missing.length > 0) {
    return `missing_required_livekit_env:${missing.join(",")}`;
  }
  const livekitUrl = env.LIVEKIT_URL ?? "";
  if (!livekitUrl.startsWith("wss://") && !isInsecureLoopbackLivekitUrlAllowed(livekitUrl, env)) {
    return "livekit_url_must_use_wss";
  }
  if (hasDevLivekitCredentials(env)) {
    return "livekit_dev_credentials_forbidden";
  }
  return null;
}

function parsePortEnv(value: string | undefined): number | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && String(parsed) === normalized && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function getLivekitDeploymentDiagnostics(env: NodeJS.ProcessEnv = process.env) {
  const livekitUrl = env.LIVEKIT_URL?.trim() ?? "";
  let livekitUrlProtocol: string | null = null;
  let livekitUrlHost: string | null = null;
  if (livekitUrl) {
    try {
      const parsed = new URL(livekitUrl);
      livekitUrlProtocol = parsed.protocol.replace(/:$/, "");
      livekitUrlHost = parsed.host;
    } catch {
      livekitUrlProtocol = "invalid";
    }
  }

  return {
    configured: Boolean(livekitUrl && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET),
    signalingTls: livekitUrl.startsWith("wss://"),
    urlProtocol: livekitUrlProtocol,
    urlHost: livekitUrlHost,
    turn: {
      enabled: parseBooleanEnv(env.LIVEKIT_TURN_ENABLED) === true,
      domain: env.LIVEKIT_TURN_DOMAIN?.trim() || null,
      tlsPort: parsePortEnv(env.LIVEKIT_TURN_TLS_PORT),
      udpPort: parsePortEnv(env.LIVEKIT_TURN_UDP_PORT),
      externalTls: parseBooleanEnv(env.LIVEKIT_TURN_EXTERNAL_TLS) === true,
      relayRange: env.LIVEKIT_TURN_RELAY_RANGE_START && env.LIVEKIT_TURN_RELAY_RANGE_END
        ? {
          start: parsePortEnv(env.LIVEKIT_TURN_RELAY_RANGE_START),
          end: parsePortEnv(env.LIVEKIT_TURN_RELAY_RANGE_END)
        }
        : null
    }
  };
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
    roomType: "standard",
    ownerParticipantId: null,
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
    access: { joinMode: "link", guestAllowed: true, roleQueryAllowed: isDevRoleQueryAllowed(), visibility: "public", disabled: false }
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

function createInviteLink(roomId: string, inviteToken: string, request?: IncomingMessage): string {
  const url = new URL(createRoomLink(roomId, request));
  url.searchParams.set("invite", inviteToken);
  return url.toString();
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
    roomType: room.roomType ?? "standard",
    ownerParticipantId: room.ownerParticipantId ?? null,
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
    access: { joinMode: "link", guestAllowed: room.guestAllowed ?? true, roleQueryAllowed: isDevRoleQueryAllowed(), visibility: sanitizeRoomVisibility(room.visibility), disabled: isRoomDisabled(room) }
  };
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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

function incrementCounter(counter: Map<string, number>, reason: string | undefined, amount = 1): void {
  const label = reason && reason.trim().length > 0 ? reason : "unknown";
  counter.set(label, (counter.get(label) ?? 0) + amount);
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
    "# HELP vrata_room_access_denied_total Room access policy denials observed by API.",
    "# TYPE vrata_room_access_denied_total counter"
  );
  for (const [reason, count] of metrics.roomAccessDeniedTotal.entries()) {
    lines.push(formatMetricLine("vrata_room_access_denied_total", count, { reason }));
  }
  lines.push(
    "# HELP vrata_host_actions_total Host control actions observed by API.",
    "# TYPE vrata_host_actions_total counter"
  );
  for (const [label, count] of metrics.hostActionsTotal.entries()) {
    const [action = "unknown", result = "unknown"] = label.split(":");
    lines.push(formatMetricLine("vrata_host_actions_total", count, { action, result }));
  }
  lines.push(
    "# HELP vrata_room_locked_total Room lock actions accepted by API.",
    "# TYPE vrata_room_locked_total counter",
    formatMetricLine("vrata_room_locked_total", metrics.roomLockedTotal),
    "# HELP vrata_participants_removed_total Participant removals accepted by API.",
    "# TYPE vrata_participants_removed_total counter",
    formatMetricLine("vrata_participants_removed_total", metrics.participantsRemovedTotal),
    "# HELP vrata_sessions_ended_total Session end actions accepted by API.",
    "# TYPE vrata_sessions_ended_total counter",
    formatMetricLine("vrata_sessions_ended_total", metrics.sessionsEndedTotal),
    "# HELP vrata_admin_dashboard_views_total Admin dashboard session views accepted by API.",
    "# TYPE vrata_admin_dashboard_views_total counter",
    formatMetricLine("vrata_admin_dashboard_views_total", metrics.adminDashboardViewsTotal),
    "# HELP vrata_rooms_disabled_total Rooms disabled through the control plane.",
    "# TYPE vrata_rooms_disabled_total counter",
    formatMetricLine("vrata_rooms_disabled_total", metrics.roomsDisabledTotal),
    "# HELP vrata_invites_revoked_total Room invites revoked through the control plane.",
    "# TYPE vrata_invites_revoked_total counter",
    formatMetricLine("vrata_invites_revoked_total", metrics.invitesRevokedTotal),
    "# HELP vrata_rooms_created_total Rooms created through the API by source and visibility.",
    "# TYPE vrata_rooms_created_total counter",
    ...Array.from(metrics.roomsCreatedTotal.entries()).map(([label, count]) => {
      const [source = "unknown", visibility = "unknown"] = label.split(":");
      return formatMetricLine("vrata_rooms_created_total", count, { source, visibility });
    }),
    "# HELP vrata_room_creation_failures_total Room creation failures by reason.",
    "# TYPE vrata_room_creation_failures_total counter",
    ...Array.from(metrics.roomCreationFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_room_creation_failures_total", count, { reason })),
    "# HELP vrata_personal_rooms_created_total Personal rooms created through the self-service runtime flow.",
    "# TYPE vrata_personal_rooms_created_total counter",
    formatMetricLine("vrata_personal_rooms_created_total", metrics.personalRoomsCreatedTotal),
    "# HELP vrata_personal_room_opens_total Personal room open requests by result.",
    "# TYPE vrata_personal_room_opens_total counter",
    ...Array.from(metrics.personalRoomOpensTotal.entries()).map(([result, count]) => formatMetricLine("vrata_personal_room_opens_total", count, { result })),
    "# HELP vrata_personal_room_access_denied_total Personal room access denials by reason.",
    "# TYPE vrata_personal_room_access_denied_total counter",
    ...Array.from(metrics.personalRoomAccessDeniedTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_personal_room_access_denied_total", count, { reason })),
    "# HELP vrata_personal_state_save_failures_total Personal state save failures by reason.",
    "# TYPE vrata_personal_state_save_failures_total counter",
    ...Array.from(metrics.personalStateSaveFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_personal_state_save_failures_total", count, { reason })),
    "# HELP vrata_scene_bundle_upload_bytes_total Uploaded scene bundle bytes accepted by API.",
    "# TYPE vrata_scene_bundle_upload_bytes_total counter",
    formatMetricLine("vrata_scene_bundle_upload_bytes_total", metrics.sceneBundleUploadBytesTotal),
    "# HELP vrata_documents_uploaded_total Document upload attempts by MIME and result.",
    "# TYPE vrata_documents_uploaded_total counter",
    ...Array.from(metrics.documentsUploadedTotal.entries()).map(([label, count]) => {
      const [mime = "unknown", result = "unknown"] = label.split(":");
      return formatMetricLine("vrata_documents_uploaded_total", count, { mime, result });
    }),
    "# HELP vrata_document_downloads_total Authorized document downloads.",
    "# TYPE vrata_document_downloads_total counter",
    formatMetricLine("vrata_document_downloads_total", metrics.documentDownloadsTotal),
    "# HELP vrata_document_storage_bytes Document bytes accepted by tenant.",
    "# TYPE vrata_document_storage_bytes counter",
    ...Array.from(metrics.documentStorageBytesTotal.entries()).map(([tenant, count]) => formatMetricLine("vrata_document_storage_bytes", count, { tenant })),
    "# HELP vrata_document_permission_denied_total Document permission denials.",
    "# TYPE vrata_document_permission_denied_total counter",
    formatMetricLine("vrata_document_permission_denied_total", metrics.documentPermissionDeniedTotal),
    "# HELP vrata_document_deletes_total Document delete actions accepted by API.",
    "# TYPE vrata_document_deletes_total counter",
    formatMetricLine("vrata_document_deletes_total", metrics.documentDeletesTotal),
    "# HELP vrata_document_surface_selections_total Document surface selection actions accepted by API.",
    "# TYPE vrata_document_surface_selections_total counter",
    formatMetricLine("vrata_document_surface_selections_total", metrics.documentSurfaceSelectionsTotal),
    "# HELP vrata_notes_created_total Notes first created through the API by scope.",
    "# TYPE vrata_notes_created_total counter",
    ...Array.from(metrics.notesCreatedTotal.entries()).map(([scope, count]) => formatMetricLine("vrata_notes_created_total", count, { scope })),
    "# HELP vrata_notes_saved_total Notes save attempts by scope and result.",
    "# TYPE vrata_notes_saved_total counter",
    ...Array.from(metrics.notesSavedTotal.entries()).map(([label, count]) => {
      const [scope = "unknown", result = "unknown"] = label.split(":");
      return formatMetricLine("vrata_notes_saved_total", count, { scope, result });
    }),
    "# HELP vrata_notes_save_failures_total Notes save failures by reason.",
    "# TYPE vrata_notes_save_failures_total counter",
    ...Array.from(metrics.notesSaveFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_notes_save_failures_total", count, { reason })),
    "# HELP vrata_notes_permission_denied_total Notes permission denials.",
    "# TYPE vrata_notes_permission_denied_total counter",
    formatMetricLine("vrata_notes_permission_denied_total", metrics.notesPermissionDeniedTotal)
  );
  lines.push(
    "# HELP vrata_admin_actions_total Control-plane admin authorization decisions by action and result.",
    "# TYPE vrata_admin_actions_total counter"
  );
  for (const [label, count] of metrics.adminActionsTotal.entries()) {
    const [action = "unknown", result = "unknown"] = label.split(":");
    lines.push(formatMetricLine("vrata_admin_actions_total", count, { action, result }));
  }
  lines.push(
    "# HELP vrata_scene_bundle_uploads_total Scene bundle upload attempts by result.",
    "# TYPE vrata_scene_bundle_uploads_total counter"
  );
  for (const [result, count] of metrics.sceneBundleUploadsTotal.entries()) {
    lines.push(formatMetricLine("vrata_scene_bundle_uploads_total", count, { result }));
  }
  lines.push(
    "# HELP vrata_scene_bundle_validation_failures_total Scene bundle upload validation failures by reason.",
    "# TYPE vrata_scene_bundle_validation_failures_total counter"
  );
  for (const [reason, count] of metrics.sceneBundleValidationFailuresTotal.entries()) {
    lines.push(formatMetricLine("vrata_scene_bundle_validation_failures_total", count, { reason }));
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
          role: "admin",
          permissions: getRoomPermissions("admin")
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
        sessionId: session.payload.sessionId,
        permissions: session.payload.permissions
      }
    };
  }

  return { ok: false, statusCode: 401, reason: "missing_identity" };
}

function isControlPlaneActorAllowed(actor: ControlPlaneActor, options: ControlPlaneAuthorizationOptions): boolean {
  if (actor.actorType === "admin-token") {
    return true;
  }
  if (!options.allowHostOwnRoom || actor.role !== "host" || actor.roleSource !== "trusted" || !options.targetRoomId || actor.roomId !== options.targetRoomId) {
    return false;
  }
  return !options.currentHostParticipantId || actor.participantId === options.currentHostParticipantId;
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
    incrementCounter(metrics.adminActionsTotal, `${options.action}:denied`);
    writeControlPlaneAudit({
      ...auditBase,
      result: "denied",
      reason: actorResult.reason
    });
    json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId });
    return null;
  }

  if (!isControlPlaneActorAllowed(actorResult.actor, options)) {
    incrementCounter(metrics.adminActionsTotal, `${options.action}:denied`);
    writeControlPlaneAudit({
      ...auditBase,
      result: "denied",
      reason: "permission_denied",
      actor: actorResult.actor
    });
    json(response, 403, { error: "forbidden", reason: "permission_denied", permission: options.permission, requestId });
    return null;
  }

  incrementCounter(metrics.adminActionsTotal, `${options.action}:allowed`);
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

function isPrivateRoom(room: RoomRecord): boolean {
  return isRoomAccessPolicyEnabled() && sanitizeRoomVisibility(room.visibility) === "private";
}

function isPersonalRoom(room: RoomRecord | null | undefined): boolean {
  return room?.roomType === "personal";
}

function isPersonalRoomOwner(room: RoomRecord, participantId: string | null | undefined): boolean {
  return isPersonalRoom(room) && Boolean(participantId) && room.ownerParticipantId === participantId;
}

function normalizeParticipantId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const value = input.trim();
  return /^[A-Za-z0-9._:-]{3,128}$/.test(value) ? value : null;
}

function normalizeDisplayName(input: unknown, participantId: string): string {
  if (typeof input !== "string") {
    return `Guest-${participantId.slice(0, 4)}`;
  }
  const value = input.trim().replace(/\s+/g, " ").slice(0, 40);
  return value || `Guest-${participantId.slice(0, 4)}`;
}

function createPersonalRoomId(participantId: string): string {
  return `personal-${sha256Hex(participantId).slice(0, 16)}`;
}

function personalRoomName(displayName: string): string {
  const ownerName = displayName.replace(/[<>]/g, "").trim().slice(0, 48);
  return ownerName ? `${ownerName} Personal Room` : "Personal Room";
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePersonalState(input: unknown, updatedBy: string | null): RoomPersonalState | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const posePayload = payload.lastPose;
  if (!posePayload || typeof posePayload !== "object") {
    return {};
  }
  const pose = posePayload as Record<string, unknown>;
  const positionPayload = pose.position;
  if (!positionPayload || typeof positionPayload !== "object") {
    return null;
  }
  const position = positionPayload as Record<string, unknown>;
  const x = numberFromRecord(position, "x");
  const y = numberFromRecord(position, "y");
  const z = numberFromRecord(position, "z");
  const yaw = numberFromRecord(pose, "yaw");
  const pitch = numberFromRecord(pose, "pitch");
  if (x === null || y === null || z === null || yaw === null || pitch === null) {
    return null;
  }
  return {
    lastPose: {
      position: {
        x: Math.max(-1000, Math.min(1000, x)),
        y: Math.max(-100, Math.min(100, y)),
        z: Math.max(-1000, Math.min(1000, z))
      },
      yaw: Math.max(-Math.PI * 4, Math.min(Math.PI * 4, yaw)),
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
      updatedAt: new Date().toISOString(),
      updatedBy
    }
  };
}

function canReadPrivateRoomWithControlPlaneActor(request: IncomingMessage, roomId: string): boolean {
  const actorResult = resolveControlPlaneActor(request);
  if (!actorResult.ok) {
    return false;
  }
  if (actorResult.actor.actorType === "admin-token") {
    return true;
  }
  return actorResult.actor.roomId === roomId;
}

function canManageDisabledRoom(request: IncomingMessage): boolean {
  const actorResult = resolveControlPlaneActor(request);
  return actorResult.ok && actorResult.actor.actorType === "admin-token";
}

function roomNoteId(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): string {
  return scope === "shared" ? `${roomId}:shared` : `${roomId}:private:${ownerParticipantId ?? ""}`;
}

function emptyRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): RoomNoteRecord {
  return {
    noteId: roomNoteId(roomId, scope, ownerParticipantId),
    roomId,
    scope,
    ownerParticipantId: scope === "private" ? ownerParticipantId ?? null : null,
    content: "",
    updatedAt: null,
    updatedBy: null
  };
}

function writeRoomNotesAudit(input: {
  request: IncomingMessage;
  action: "notes.read" | "notes.save";
  roomId: string;
  scope: RoomNoteScope;
  result: "allowed" | "denied";
  reason?: string;
  actor?: ControlPlaneActor;
}): void {
  logEvent({
    service: "api",
    event: "room_notes_audit",
    timestamp: new Date().toISOString(),
    requestId: getRequestId(input.request),
    action: input.action,
    roomId: input.roomId,
    scope: input.scope,
    result: input.result,
    reason: input.reason,
    actor: input.actor ? {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      role: input.actor.role,
      tenantId: input.actor.tenantId,
      roomId: input.actor.roomId,
      participantId: input.actor.participantId,
      sessionId: input.actor.sessionId
    } : undefined
  });
}

function noteActorPermissions(actor: ControlPlaneActor): RoomPermission[] {
  return actor.permissions ?? getRoomPermissions(actor.role);
}

function resolveRoomNoteOwner(scope: RoomNoteScope, actor: ControlPlaneActor, url: URL): string | null {
  if (scope === "shared") return null;
  if (actor.actorType === "room-session") return actor.participantId ?? null;
  return url.searchParams.get("participantId")?.trim() || null;
}

function resolveRoomNotesActor(
  request: IncomingMessage,
  response: ServerResponse,
  input: { room: RoomRecord; scope: RoomNoteScope; permission: "notes.view" | "notes.edit"; action: "notes.read" | "notes.save" }
): ControlPlaneActor | null {
  const actorResult = resolveControlPlaneActor(request);
  if (!actorResult.ok) {
    metrics.notesPermissionDeniedTotal += 1;
    writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "denied", reason: actorResult.reason });
    json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId: getRequestId(request) });
    return null;
  }

  const actor = actorResult.actor;
  const deny = (reason: string): null => {
    metrics.notesPermissionDeniedTotal += 1;
    writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "denied", reason, actor });
    json(response, reason === "room_mismatch" ? 403 : 403, { error: "forbidden", reason, permission: input.permission, requestId: getRequestId(request) });
    return null;
  };

  if (actor.actorType === "room-session" && actor.roomId !== input.room.roomId) {
    return deny("room_mismatch");
  }
  if (isRoomDisabled(input.room) && actor.actorType !== "admin-token") {
    return deny("room_disabled");
  }
  if (!hasRoomPermission(noteActorPermissions(actor), input.permission)) {
    return deny("permission_denied");
  }

  writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "allowed", actor });
  return actor;
}

const allowedDocumentContentTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain"
]);

function writeRoomDocumentsAudit(input: {
  request: IncomingMessage;
  action: "documents.list" | "documents.upload" | "documents.download" | "documents.delete" | "documents.select-surface";
  roomId: string;
  documentId?: string;
  result: "allowed" | "denied";
  reason?: string;
  actor?: ControlPlaneActor;
}): void {
  logEvent({
    service: "api",
    event: "room_documents_audit",
    timestamp: new Date().toISOString(),
    requestId: getRequestId(input.request),
    action: input.action,
    roomId: input.roomId,
    documentId: input.documentId,
    result: input.result,
    reason: input.reason,
    actor: input.actor ? {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      role: input.actor.role,
      tenantId: input.actor.tenantId,
      roomId: input.actor.roomId,
      participantId: input.actor.participantId,
      sessionId: input.actor.sessionId
    } : undefined
  });
}

function resolveRoomDocumentsActor(
  request: IncomingMessage,
  response: ServerResponse,
  input: { room: RoomRecord; permission: "document.view" | "document.download" | "document.upload" | "document.delete"; action: Parameters<typeof writeRoomDocumentsAudit>[0]["action"]; documentId?: string }
): ControlPlaneActor | null {
  const actorResult = resolveControlPlaneActor(request);
  if (!actorResult.ok) {
    metrics.documentPermissionDeniedTotal += 1;
    writeRoomDocumentsAudit({ request, action: input.action, roomId: input.room.roomId, documentId: input.documentId, result: "denied", reason: actorResult.reason });
    json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId: getRequestId(request) });
    return null;
  }

  const actor = actorResult.actor;
  const deny = (reason: string): null => {
    metrics.documentPermissionDeniedTotal += 1;
    writeRoomDocumentsAudit({ request, action: input.action, roomId: input.room.roomId, documentId: input.documentId, result: "denied", reason, actor });
    json(response, 403, { error: "forbidden", reason, permission: input.permission, requestId: getRequestId(request) });
    return null;
  };

  if (actor.actorType === "room-session" && actor.roomId !== input.room.roomId) {
    return deny("room_mismatch");
  }
  if (isRoomDisabled(input.room) && actor.actorType !== "admin-token") {
    return deny("room_disabled");
  }
  if (!hasRoomPermission(actor.permissions ?? getRoomPermissions(actor.role), input.permission)) {
    return deny("permission_denied");
  }

  writeRoomDocumentsAudit({ request, action: input.action, roomId: input.room.roomId, documentId: input.documentId, result: "allowed", actor });
  return actor;
}

function inferDocumentContentType(filename: string): string | null {
  switch (extname(filename).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".txt": return "text/plain";
    default: return null;
  }
}

function normalizeDocumentContentType(part: MultipartPart, filename: string): string | null {
  const raw = part.contentType?.split(";")[0]?.trim().toLowerCase() || "";
  const inferred = inferDocumentContentType(filename);
  const contentType = raw && raw !== "application/octet-stream" ? raw : inferred;
  return contentType && allowedDocumentContentTypes.has(contentType) ? contentType : null;
}

function normalizeDocumentFilename(input: string | undefined): string | null {
  const raw = input?.trim() ?? "";
  if (!raw || raw.length > 160 || /[\\/\0]/.test(raw)) return null;
  const safe = basename(raw).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!safe || safe === "." || safe === "..") return null;
  return safe;
}

function documentStorageKey(tenantId: string, roomId: string, documentId: string, filename: string): string {
  return [trimSlashes(process.env.MINIO_DOCUMENT_PREFIX ?? "documents"), tenantId, roomId, documentId, filename].filter(Boolean).join("/");
}

function serializeRoomDocument(request: IncomingMessage, document: RoomDocumentRecord) {
  return {
    documentId: document.documentId,
    roomId: document.roomId,
    tenantId: document.tenantId,
    filename: document.filename,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    uploadedBy: document.uploadedBy ?? null,
    uploadedAt: document.uploadedAt,
    linkedSurfaceId: document.linkedSurfaceId ?? null,
    downloadUrl: `/api/rooms/${encodeURIComponent(document.roomId)}/documents/${encodeURIComponent(document.documentId)}/download`
  };
}

function normalizeDocumentSurfaceId(input: unknown): string | null | undefined {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : undefined;
}

function safeHeaderFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

async function canReadRoomDetails(request: IncomingMessage, room: RoomRecord): Promise<boolean> {
  if (!isPrivateRoom(room)) {
    return true;
  }
  if (canReadPrivateRoomWithControlPlaneActor(request, room.roomId)) {
    return true;
  }
  const session = await verifyRoomSessionRequest(request, { roomId: room.roomId });
  return session.ok;
}

function sanitizeRoomInvite(invite: RoomInviteRecord, inviteLink?: string): Omit<RoomInviteRecord, "tokenHash"> & { inviteLink?: string } {
  const { tokenHash: _tokenHash, ...rest } = invite;
  return inviteLink ? { ...rest, inviteLink } : rest;
}

function sanitizeWaitingRoomRequest(request: WaitingRoomRequestRecord): WaitingRoomRequestRecord {
  return { ...request };
}

function defaultSessionControlState(input?: RoomSessionControlState | null): Required<RoomSessionControlState> {
  return {
    hostParticipantId: input?.hostParticipantId ?? null,
    lockedAt: input?.lockedAt ?? null,
    lockedBy: input?.lockedBy ?? null,
    endedAt: input?.endedAt ?? null,
    endedBy: input?.endedBy ?? null,
    removedParticipants: input?.removedParticipants ?? {}
  };
}

function sanitizeSessionControlState(input?: RoomSessionControlState | null): Required<RoomSessionControlState> {
  const state = defaultSessionControlState(input);
  return {
    ...state,
    removedParticipants: { ...state.removedParticipants }
  };
}

function getRemovedParticipant(room: RoomRecord, participantId: string | null | undefined): Required<RoomSessionControlState>["removedParticipants"][string] | null {
  if (!participantId) {
    return null;
  }
  return defaultSessionControlState(room.sessionControl).removedParticipants[participantId] ?? null;
}

function resolveEffectiveRoomRole(room: RoomRecord | null, participantId: string, role: RoomRole): RoomRole {
  const hostParticipantId = room ? defaultSessionControlState(room.sessionControl).hostParticipantId : null;
  if (!hostParticipantId) {
    return role;
  }
  if (participantId === hostParticipantId) {
    return "host";
  }
  return role === "host" ? "member" : role;
}

function canJoinLockedRoom(role: RoomRole): boolean {
  return role === "host" || role === "admin";
}

function getSessionControlBlockReason(room: RoomRecord | null, participantId: string, role: RoomRole, hasExistingSession: boolean): string | null {
  if (!room) {
    return null;
  }
  if (isRoomDisabled(room)) {
    return "room_disabled";
  }
  if (!isHostControlsEnabled()) {
    return null;
  }
  const control = defaultSessionControlState(room.sessionControl);
  if (control.endedAt) {
    return "session_ended";
  }
  if (getRemovedParticipant(room, participantId)) {
    return "participant_removed";
  }
  if (control.lockedAt && !hasExistingSession && !canJoinLockedRoom(role)) {
    return "room_locked";
  }
  return null;
}

async function updateRoomSessionControl(
  storage: Awaited<typeof storagePromise>,
  room: RoomRecord,
  nextControl: RoomSessionControlState
): Promise<RoomRecord> {
  const updated = await storage.updateRoom(room.roomId, {
    sessionControl: sanitizeSessionControlState(nextControl)
  });
  return updated ?? { ...room, sessionControl: sanitizeSessionControlState(nextControl) };
}

function incrementHostActionMetric(action: string, result: "allowed" | "denied"): void {
  incrementCounter(metrics.hostActionsTotal, `${action}:${result}`);
}

function createRoomAccessTokenResponse(input: {
  room: RoomRecord | null;
  roomId: string;
  participantId: string;
  displayName: string;
  role: RoomRole;
  roleSource: RoomSessionRoleSource;
  sessionId?: string;
  ttlSeconds: number;
  nowSeconds?: number;
}): {
  token: string;
  expiresInSeconds: number;
  sessionId: string;
  access: ReturnType<typeof createRoomAccessDebugState>;
  role: RoomRole;
  permissions: RoomPermission[];
} {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const permissions = getRoomPermissions(input.role);
  const payload: RoomAccessTokenPayload = {
    tenantId: input.room?.tenantId ?? "demo-tenant",
    roomId: input.roomId,
    participantId: input.participantId,
    displayName: input.displayName,
    role: input.role,
    roleSource: input.roleSource,
    permissions,
    sessionId: input.sessionId ?? randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + input.ttlSeconds,
    jti: randomUUID()
  };
  return {
    token: encodeAccessToken(payload),
    expiresInSeconds: input.ttlSeconds,
    sessionId: payload.sessionId,
    access: createRoomAccessDebugState(input.role),
    role: input.role,
    permissions
  };
}

function parseInviteToken(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length >= 20 && /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function writeInviteUseAudit(input: {
  request: IncomingMessage;
  roomId: string;
  invite?: RoomInviteRecord;
  result: "allowed" | "denied";
  reason?: string;
  participantId?: string;
}): void {
  writeControlPlaneAudit({
    timestamp: new Date().toISOString(),
    requestId: getRequestId(input.request),
    action: "invite.use",
    permission: "room.join",
    object: { type: "room-invite", id: input.invite?.inviteId ?? input.roomId },
    result: input.result,
    reason: input.reason,
    actor: input.participantId
      ? {
        actorType: "room-session",
        actorId: input.participantId,
        role: input.invite?.role ?? "guest",
        roomId: input.roomId,
        participantId: input.participantId
      }
      : undefined
  });
}

type StateTokenAccessResult =
  | { ok: true; role: RoomRole; roleSource: RoomSessionRoleSource; invite?: RoomInviteRecord }
  | { ok: false; statusCode: 202 | 403; reason: string; accessRequestId?: string };

async function resolveStateTokenAccess(
  storage: Awaited<typeof storagePromise>,
  request: IncomingMessage,
  room: RoomRecord | null,
  requestPayload: StateTokenRequest | null,
  requested: { role: RoomRole; roleSource: RoomSessionRoleSource }
): Promise<StateTokenAccessResult> {
  const participantId = requestPayload?.participantId ?? randomUUID();
  if (!room) {
    return { ok: true, ...requested };
  }
  if (isRoomDisabled(room)) {
    return { ok: false, statusCode: 403, reason: "room_disabled" };
  }

  const existingSession = await verifyRoomSessionRequest(request, { roomId: room.roomId, participantId: requestPayload?.participantId });
  if (existingSession.ok) {
    const role = resolveEffectiveRoomRole(room, existingSession.payload.participantId, existingSession.payload.role);
    const blockReason = getSessionControlBlockReason(room, existingSession.payload.participantId, role, true);
    if (blockReason) {
      return { ok: false, statusCode: 403, reason: blockReason };
    }
    return { ok: true, role, roleSource: existingSession.payload.roleSource ?? "trusted" };
  }

  const inviteToken = parseInviteToken(requestPayload?.inviteToken);
  if (!inviteToken) {
    if (isPersonalRoom(room)) {
      if (isPersonalRoomOwner(room, participantId)) {
        const role = resolveEffectiveRoomRole(room, participantId, "host");
        const blockReason = getSessionControlBlockReason(room, participantId, role, false);
        if (blockReason) {
          incrementCounter(metrics.personalRoomAccessDeniedTotal, blockReason);
          return { ok: false, statusCode: 403, reason: blockReason };
        }
        incrementCounter(metrics.personalRoomOpensTotal, "owner");
        return { ok: true, role, roleSource: "trusted" };
      }
      incrementCounter(metrics.personalRoomAccessDeniedTotal, "invite_required");
      writeInviteUseAudit({ request, roomId: room.roomId, result: "denied", reason: "invite_required", participantId });
      return { ok: false, statusCode: 403, reason: "invite_required" };
    }
    const visibility = isRoomAccessPolicyEnabled() ? sanitizeRoomVisibility(room.visibility) : "public";
    if (visibility !== "private") {
      const role = resolveEffectiveRoomRole(room, participantId, requested.role);
      const blockReason = getSessionControlBlockReason(room, participantId, role, false);
      if (blockReason) {
        return { ok: false, statusCode: 403, reason: blockReason };
      }
      return { ok: true, role, roleSource: requested.roleSource };
    }
    writeInviteUseAudit({ request, roomId: room.roomId, result: "denied", reason: "invite_required", participantId });
    return { ok: false, statusCode: 403, reason: "invite_required" };
  }

  const invite = await storage.getRoomInviteByTokenHash(hashInviteToken(inviteToken));
  if (!invite || invite.roomId !== room.roomId) {
    writeInviteUseAudit({ request, roomId: room.roomId, result: "denied", reason: "invite_required", participantId });
    if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomAccessDeniedTotal, "invite_required");
    return { ok: false, statusCode: 403, reason: "invite_required" };
  }
  if (invite.revokedAt) {
    writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "denied", reason: "invite_revoked", participantId });
    if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomAccessDeniedTotal, "invite_revoked");
    return { ok: false, statusCode: 403, reason: "invite_revoked" };
  }
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "denied", reason: "invite_expired", participantId });
    if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomAccessDeniedTotal, "invite_expired");
    return { ok: false, statusCode: 403, reason: "invite_expired" };
  }

  if (invite.waitingRoomEnabled) {
    const existingRequest = await storage.getWaitingRoomRequestForInviteParticipant(invite.inviteId, participantId);
    if (existingRequest?.status === "approved") {
      const role = resolveEffectiveRoomRole(room, participantId, invite.role);
      const blockReason = getSessionControlBlockReason(room, participantId, role, false);
      if (blockReason) {
        writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "denied", reason: blockReason, participantId });
        if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomAccessDeniedTotal, blockReason);
        return { ok: false, statusCode: 403, reason: blockReason };
      }
      writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "allowed", participantId });
      if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomOpensTotal, "invite");
      return { ok: true, role, roleSource: "trusted", invite };
    }
    if (existingRequest?.status === "rejected") {
      writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "denied", reason: "waiting_room_rejected", participantId });
      if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomAccessDeniedTotal, "waiting_room_rejected");
      return { ok: false, statusCode: 403, reason: "waiting_room_rejected", accessRequestId: existingRequest.requestId };
    }
    const waitingRequest = existingRequest ?? await storage.createWaitingRoomRequest({
      roomId: room.roomId,
      inviteId: invite.inviteId,
      participantId,
      displayName: requestPayload?.displayName ?? participantId
    });
    return { ok: false, statusCode: 202, reason: "waiting_room_pending", accessRequestId: waitingRequest.requestId };
  }

  const role = resolveEffectiveRoomRole(room, participantId, invite.role);
  const blockReason = getSessionControlBlockReason(room, participantId, role, false);
  if (blockReason) {
    writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "denied", reason: blockReason, participantId });
    if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomAccessDeniedTotal, blockReason);
    return { ok: false, statusCode: 403, reason: blockReason };
  }
  writeInviteUseAudit({ request, roomId: room.roomId, invite, result: "allowed", participantId });
  if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomOpensTotal, "invite");
  return { ok: true, role, roleSource: "trusted", invite };
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

function readRequestBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        reject(new Error("payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMultipartBoundary(contentType: string | undefined): string | null {
  const match = contentType?.match(/(?:^|;)\s*boundary=("([^"]+)"|[^;]+)/i);
  return match ? (match[2] ?? match[1]).replace(/^"|"$/g, "") : null;
}

function parseContentDisposition(value: string | undefined): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  for (const part of value?.split(";") ?? []) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key || rawValueParts.length === 0) continue;
    const rawValue = rawValueParts.join("=").trim();
    const valueText = rawValue.replace(/^"|"$/g, "");
    if (key === "name") result.name = valueText;
    if (key === "filename") result.filename = valueText;
  }
  return result;
}

function parseMultipartFormData(buffer: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const prefixedDelimiter = Buffer.from(`\r\n--${boundary}`);
  const headerTerminator = Buffer.from("\r\n\r\n");
  const parts: MultipartPart[] = [];
  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) throw new Error("invalid_multipart_body");

  while (cursor >= 0) {
    cursor += delimiter.byteLength;
    if (buffer.subarray(cursor, cursor + 2).toString("utf8") === "--") break;
    if (buffer.subarray(cursor, cursor + 2).toString("utf8") === "\r\n") cursor += 2;
    const headerEnd = buffer.indexOf(headerTerminator, cursor);
    if (headerEnd < 0) throw new Error("invalid_multipart_part_headers");
    const headers = new Map<string, string>();
    const headerText = buffer.subarray(cursor, headerEnd).toString("utf8");
    for (const line of headerText.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    const contentStart = headerEnd + headerTerminator.byteLength;
    const nextBoundary = buffer.indexOf(prefixedDelimiter, contentStart);
    if (nextBoundary < 0) throw new Error("invalid_multipart_part_body");
    const disposition = parseContentDisposition(headers.get("content-disposition"));
    if (disposition.name) {
      parts.push({
        name: disposition.name,
        filename: disposition.filename,
        contentType: headers.get("content-type"),
        data: buffer.subarray(contentStart, nextBoundary)
      });
    }
    cursor = nextBoundary + 2;
  }

  return parts;
}

function textPart(parts: MultipartPart[], name: string): string | undefined {
  const value = parts.find((part) => part.name === name && !part.filename)?.data.toString("utf8").trim();
  return value && value.length > 0 ? value : undefined;
}

function filePart(parts: MultipartPart[], name: string): MultipartPart | undefined {
  return parts.find((part) => part.name === name && Boolean(part.filename));
}

function sanitizeSceneBundleId(value: string | undefined, fallback: string): string | null {
  const candidate = (value ?? fallback).trim();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : null;
}

function sanitizeSceneBundleVersion(value: string | undefined): string | null {
  const candidate = (value ?? "v1").trim();
  return /^[a-zA-Z0-9._-]{1,64}$/.test(candidate) ? candidate : null;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinUrlPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.split("/").map(encodeURIComponent).join("/"), base).toString();
}

function contentTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".json": return "application/json";
    case ".glb": return "model/gltf-binary";
    case ".gltf": return "model/gltf+json";
    case ".fbx": return "application/octet-stream";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".ktx2": return "image/ktx2";
    default: return "application/octet-stream";
  }
}

async function listFilesRecursive(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(root, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, absolutePath).split(sep).join("/"));
    }
  }
  return files;
}

function publicBaseUrlFromRequest(request: IncomingMessage): string {
  const url = new URL(createRoomLink("__scene_bundle_upload__", request));
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getSceneBundleUploadStorage(request: IncomingMessage): SceneBundleUploadStorage {
  const provider = (process.env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined) ?? "minio-default";
  if (provider === "minio-default") {
    if (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD && process.env.MINIO_BUCKET && process.env.MINIO_PUBLIC_BASE_URL) {
      return {
        type: "s3",
        provider,
        endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
        region: process.env.SCENE_BUNDLE_S3_REGION || "us-east-1",
        bucket: process.env.MINIO_BUCKET,
        accessKeyId: process.env.MINIO_ROOT_USER,
        secretAccessKey: process.env.MINIO_ROOT_PASSWORD
      };
    }
  } else if (provider === "s3-compatible") {
    if (process.env.SCENE_BUNDLE_S3_ENDPOINT && process.env.SCENE_BUNDLE_S3_REGION && process.env.SCENE_BUNDLE_S3_BUCKET && process.env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL && process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID && process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY) {
      return {
        type: "s3",
        provider,
        endpoint: process.env.SCENE_BUNDLE_S3_ENDPOINT,
        region: process.env.SCENE_BUNDLE_S3_REGION,
        bucket: process.env.SCENE_BUNDLE_S3_BUCKET,
        accessKeyId: process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY
      };
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(`misconfigured_scene_bundle_upload_storage:${provider}`);
  }

  const root = resolve(process.env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT ?? join(runtimePublicRoot, "assets", "uploaded-scene-bundles"));
  return {
    type: "local",
    provider: "minio-default",
    root,
    publicBaseUrl: new URL("/assets/uploaded-scene-bundles/", publicBaseUrlFromRequest(request)).toString()
  };
}

function getDocumentUploadStorage(request: IncomingMessage): DocumentUploadStorage {
  const provider = ((process.env.DOCUMENT_PROVIDER as SceneBundleProvider | undefined) ?? (process.env.SCENE_BUNDLE_PROVIDER as SceneBundleProvider | undefined)) ?? "minio-default";
  if (provider === "minio-default") {
    if (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD && process.env.MINIO_BUCKET && process.env.MINIO_PUBLIC_BASE_URL) {
      return {
        type: "s3",
        provider,
        endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
        region: process.env.SCENE_BUNDLE_S3_REGION || "us-east-1",
        bucket: process.env.MINIO_BUCKET,
        accessKeyId: process.env.MINIO_ROOT_USER,
        secretAccessKey: process.env.MINIO_ROOT_PASSWORD
      };
    }
  } else if (provider === "s3-compatible") {
    if (process.env.SCENE_BUNDLE_S3_ENDPOINT && process.env.SCENE_BUNDLE_S3_REGION && process.env.SCENE_BUNDLE_S3_BUCKET && process.env.SCENE_BUNDLE_S3_PUBLIC_BASE_URL && process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID && process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY) {
      return {
        type: "s3",
        provider,
        endpoint: process.env.SCENE_BUNDLE_S3_ENDPOINT,
        region: process.env.SCENE_BUNDLE_S3_REGION,
        bucket: process.env.SCENE_BUNDLE_S3_BUCKET,
        accessKeyId: process.env.SCENE_BUNDLE_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.SCENE_BUNDLE_S3_SECRET_ACCESS_KEY
      };
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(`misconfigured_document_upload_storage:${provider}`);
  }

  const root = resolve(process.env.DOCUMENT_LOCAL_UPLOAD_ROOT ?? join(runtimePublicRoot, "assets", "uploaded-documents"));
  return {
    type: "local",
    provider: "minio-default",
    root,
    publicBaseUrl: new URL("/assets/uploaded-documents/", publicBaseUrlFromRequest(request)).toString()
  };
}

function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

async function putS3Object(storage: Extract<SceneBundleUploadStorage, { type: "s3" }>, key: string, body: Buffer, contentType: string, errorPrefix = "scene_bundle_object_upload_failed"): Promise<void> {
  const endpoint = storage.endpoint.endsWith("/") ? storage.endpoint : `${storage.endpoint}/`;
  const url = new URL(`${trimSlashes(storage.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`, endpoint);
  const payloadHash = sha256Hex(body);
  const { amzDate, dateStamp } = formatAmzDate(new Date());
  const headers = new Map<string, string>([
    ["content-type", contentType],
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate]
  ]);
  const signedHeaders = Array.from(headers.keys()).sort().join(";");
  const canonicalHeaders = Array.from(headers.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}:${value.trim()}\n`).join("");
  const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${storage.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${storage.secretAccessKey}`, dateStamp), storage.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "authorization": authorization,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    },
    body: new Uint8Array(body)
  });
  if (!response.ok) {
    throw new Error(`${errorPrefix}:${response.status}`);
  }
}

async function writeDocumentObject(storage: DocumentUploadStorage, storageKey: string, body: Buffer, contentType: string): Promise<void> {
  if (storage.type === "local") {
    const target = join(storage.root, storageKey);
    if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_document_storage_key");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return;
  }
  await putS3Object(storage, storageKey, body, contentType, "document_object_upload_failed");
}

function resolveUploadedDocumentPublicUrl(storage: DocumentUploadStorage, storageKey: string): string {
  if (storage.type === "local") {
    return joinUrlPath(storage.publicBaseUrl, storageKey);
  }
  return resolveSceneBundlePublicUrl(storageKey, process.env, storage.provider);
}

async function readDocumentObject(storage: DocumentUploadStorage, storageKey: string): Promise<Buffer> {
  if (storage.type === "local") {
    const target = join(storage.root, storageKey);
    if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_document_storage_key");
    return readFile(target);
  }
  const response = await fetch(resolveUploadedDocumentPublicUrl(storage, storageKey));
  if (!response.ok) {
    throw new Error(`document_object_download_failed:${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function publishSceneBundleFiles(storage: SceneBundleUploadStorage, bundleRoot: string, storagePrefix: string): Promise<void> {
  const files = await listFilesRecursive(bundleRoot);
  for (const filePath of files) {
    const normalizedPath = normalizeSceneBundleRelativePath(filePath);
    if (!normalizedPath) throw new Error("unsafe_scene_bundle_file_path");
    const sourcePath = join(bundleRoot, normalizedPath);
    const objectKey = `${storagePrefix}/${normalizedPath}`;
    if (storage.type === "local") {
      const target = join(storage.root, storagePrefix, normalizedPath);
      if (!target.startsWith(`${storage.root}${sep}`)) throw new Error("unsafe_scene_bundle_file_path");
      await mkdir(dirname(target), { recursive: true });
      await copyFile(sourcePath, target);
    } else {
      await putS3Object(storage, objectKey, await readFile(sourcePath), contentTypeForPath(normalizedPath));
    }
  }
}

function resolveUploadedSceneBundlePublicUrl(storage: SceneBundleUploadStorage, storageKey: string): string {
  if (storage.type === "local") {
    return joinUrlPath(storage.publicBaseUrl, storageKey);
  }
  return resolveSceneBundlePublicUrl(storageKey, process.env, storage.provider);
}

function relativeManifestPathFromZipManifest(inputPath: string, manifestPath: string | null): string {
  const marker = `${inputPath}!/`;
  if (manifestPath?.startsWith(marker)) {
    return manifestPath.slice(marker.length);
  }
  return "scene.json";
}

function readManifestMetadata(value: unknown): SceneBundleManifestMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const manifest = value as Record<string, unknown>;
  return {
    schemaVersion: typeof manifest.schemaVersion === "number" ? manifest.schemaVersion : undefined,
    sceneId: typeof manifest.sceneId === "string" ? manifest.sceneId : undefined,
    glbPath: typeof manifest.glbPath === "string" ? manifest.glbPath : undefined,
    preview: typeof manifest.preview === "string" ? manifest.preview : undefined
  };
}

async function handleSceneBundleZipUpload(
  request: IncomingMessage,
  response: ServerResponse,
  storage: Awaited<typeof storagePromise>,
  actor: ControlPlaneActor
): Promise<void> {
  const maxBytes = Number.parseInt(process.env.SCENE_BUNDLE_UPLOAD_MAX_BYTES ?? `${50 * 1024 * 1024}`, 10);
  const boundary = parseMultipartBoundary(request.headers["content-type"]);
  if (!boundary) {
    incrementCounter(metrics.sceneBundleUploadsTotal, "rejected");
    json(response, 415, { error: "expected_multipart_scene_bundle_upload" });
    return;
  }

  const body = await readRequestBuffer(request, maxBytes);
  const parts = parseMultipartFormData(body, boundary);
  const bundleFile = filePart(parts, "bundle") ?? filePart(parts, "file");
  if (!bundleFile || !bundleFile.filename || extname(bundleFile.filename).toLowerCase() !== ".zip") {
    incrementCounter(metrics.sceneBundleUploadsTotal, "rejected");
    json(response, 400, { error: "unsupported_scene_bundle_upload_format" });
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "vrata-scene-upload-"));
  const zipPath = join(tempRoot, basename(bundleFile.filename));
  let extracted: Awaited<ReturnType<typeof extractSceneBundleZipToTemp>> | null = null;
  try {
    await writeFile(zipPath, bundleFile.data);
    const validation = await validateSceneBundlePath(zipPath, { maxBundleBytes: maxBytes });
    if (!validation.ok) {
      incrementCounter(metrics.sceneBundleUploadsTotal, "validation_failed");
      for (const issue of validation.issues.filter((entry) => entry.severity === "error")) {
        incrementCounter(metrics.sceneBundleValidationFailuresTotal, issue.code);
      }
      json(response, 400, { error: "scene_bundle_validation_failed", issues: validation.issues, stats: validation.stats });
      return;
    }

    extracted = await extractSceneBundleZipToTemp(zipPath);
    const manifestRelativePath = relativeManifestPathFromZipManifest(zipPath, validation.manifestPath);
    const manifestDir = dirname(manifestRelativePath);
    const extractedBundleRoot = manifestDir === "." ? extracted.root : join(extracted.root, manifestDir);
    const resolvedExtractedRoot = resolve(extracted.root);
    const resolvedBundleRoot = resolve(extractedBundleRoot);
    if (resolvedBundleRoot !== resolvedExtractedRoot && !resolvedBundleRoot.startsWith(`${resolvedExtractedRoot}${sep}`)) {
      throw new Error("unsafe_scene_bundle_manifest_root");
    }

    const manifest = readManifestMetadata(JSON.parse(await readFile(join(resolvedBundleRoot, "scene.json"), "utf8")));
    const bundleId = sanitizeSceneBundleId(textPart(parts, "bundleId"), manifest.sceneId ?? "uploaded-scene");
    if (!bundleId) {
      incrementCounter(metrics.sceneBundleUploadsTotal, "rejected");
      json(response, 400, { error: "invalid_scene_bundle_id" });
      return;
    }
    const version = sanitizeSceneBundleVersion(textPart(parts, "version"));
    if (!version) {
      incrementCounter(metrics.sceneBundleUploadsTotal, "rejected");
      json(response, 400, { error: "invalid_scene_bundle_version" });
      return;
    }
    if ((await storage.listSceneBundleVersions(bundleId)).some((item) => item.version === version)) {
      incrementCounter(metrics.sceneBundleUploadsTotal, "rejected");
      json(response, 409, { error: "scene_bundle_version_conflict" });
      return;
    }

    const uploadStorage = getSceneBundleUploadStorage(request);
    const scenePrefix = trimSlashes(process.env.MINIO_SCENE_PREFIX ?? "scenes");
    const storagePrefix = [scenePrefix, bundleId, version].filter(Boolean).join("/");
    const storageKey = `${storagePrefix}/scene.json`;
    await publishSceneBundleFiles(uploadStorage, resolvedBundleRoot, storagePrefix);
    const publicUrl = resolveUploadedSceneBundlePublicUrl(uploadStorage, storageKey);
    const previewPath = manifest.preview ? normalizeSceneBundleRelativePath(manifest.preview) : null;
    const previewUrl = previewPath ? resolveUploadedSceneBundlePublicUrl(uploadStorage, `${storagePrefix}/${previewPath}`) : undefined;
    const record = await storage.createSceneBundle({
      bundleId,
      version,
      storageKey,
      publicUrl,
      checksum: `sha256:${sha256Hex(bundleFile.data)}`,
      sizeBytes: validation.stats.bundleBytes,
      schemaVersion: manifest.schemaVersion,
      entryScene: manifest.glbPath,
      previewUrl,
      createdBy: actor.actorId,
      contentType: "application/json",
      provider: uploadStorage.provider
    });
    metrics.sceneBundleUploadBytesTotal += bundleFile.data.byteLength;
    incrementCounter(metrics.sceneBundleUploadsTotal, "success");
    json(response, 201, { ...record, validation: { issues: validation.issues, stats: validation.stats } });
  } catch (error) {
    if (!response.writableEnded) {
      const message = error instanceof Error ? error.message : "scene_bundle_upload_failed";
      incrementCounter(metrics.sceneBundleUploadsTotal, "failed");
      json(response, message.startsWith("misconfigured_scene_bundle_upload_storage") ? 503 : 400, { error: message });
    }
  } finally {
    if (extracted) await rm(extracted.root, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function validateRoomInput(input: Partial<RoomRecord>, templateIds: Set<string>, tenantIds: Set<string>): string | null {
  if (input.roomId !== undefined && (typeof input.roomId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.roomId) || input.roomId.length < 3 || input.roomId.length > 64)) {
    return "invalid_room_slug";
  }
  if (!input.name || input.name.trim().length < 3 || input.name.trim().length > 80) {
    return "invalid_room_name";
  }
  if (!input.templateId || !templateIds.has(input.templateId)) {
    return "invalid_template";
  }
  if (!input.tenantId || !tenantIds.has(input.tenantId)) {
    return "invalid_tenant";
  }
  if (input.visibility !== undefined && !isRoomVisibility(input.visibility)) {
    return "invalid_room_visibility";
  }
  if (input.roomType !== undefined && input.roomType !== "standard" && input.roomType !== "personal") {
    return "invalid_room_type";
  }
  if (input.roomType === "personal" && !normalizeParticipantId(input.ownerParticipantId)) {
    return "missing_personal_room_owner";
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
  if (typeof input.roomId === "string") {
    normalized.roomId = input.roomId.trim() || undefined;
  }
  if (hasLegacyAvatarField) {
    normalized.avatarConfig = {
      ...legacyAvatarConfig,
      ...input.avatarConfig
    } as RoomRecord["avatarConfig"];
  }
  if (input.roomType === "personal") {
    normalized.visibility = "private";
    normalized.guestAllowed = false;
    normalized.templateId = input.templateId ?? "personal-workspace-basic";
  }
  normalized.visibility = input.visibility === undefined || isRoomVisibility(input.visibility)
    ? sanitizeRoomVisibility(normalized.visibility ?? input.visibility, input.guestAllowed === false || input.roomType === "personal" ? "private" : "public")
    : input.visibility;

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
  return validateSceneBundleReference(input).find((issue) => issue.severity === "error")?.code ?? null;
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
    .filter((room) => !isRoomDisabled(room))
    .filter((room) => room.roomId === currentRoom.roomId || ((!isRoomAccessPolicyEnabled() || sanitizeRoomVisibility(room.visibility) === "public") && room.guestAllowed !== false))
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
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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
        livekitConfig: getLivekitDeploymentDiagnostics(),
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
        xrEnabled: isXrFeatureEnabled(),
        voiceEnabled: process.env.FEATURE_VOICE !== "false",
        screenShareEnabled: process.env.FEATURE_SCREEN_SHARE !== "false",
        spatialAudioEnabled: isSpatialAudioFeatureEnabled(),
        roomStateRealtimeEnabled: process.env.FEATURE_ROOM_STATE_REALTIME !== "false",
        remoteDiagnosticsEnabled: process.env.FEATURE_REMOTE_DIAGNOSTICS !== "false",
        sceneBundlesEnabled: process.env.FEATURE_SCENE_BUNDLES !== "false",
        sceneBundleUploadEnabled: isSceneBundleUploadEnabled(),
        avatarsEnabled: process.env.FEATURE_AVATARS !== "false",
        avatarPoseBinaryEnabled: process.env.FEATURE_AVATAR_POSE_BINARY !== "false",
        avatarLipsyncEnabled: process.env.FEATURE_AVATAR_LIPSYNC === "true",
        avatarLegIkEnabled: process.env.FEATURE_AVATAR_LEG_IK === "true",
        avatarSeatingEnabled: process.env.FEATURE_AVATAR_SEATING !== "false",
        avatarCustomizationEnabled: process.env.FEATURE_AVATAR_CUSTOMIZATION === "true",
        avatarFallbackCapsulesEnabled: process.env.FEATURE_AVATAR_FALLBACK_CAPSULES !== "false",
        roomAccessPolicyEnabled: isRoomAccessPolicyEnabled(),
        hostControlsEnabled: isHostControlsEnabled(),
        documentsEnabled: isDocumentsFeatureEnabled(),
        notesEnabled: isNotesFeatureEnabled(),
        personalRoomsEnabled: isPersonalRoomsFeatureEnabled(),
        postgresEnabled: Boolean(process.env.POSTGRES_URL),
        controlPlaneAuthEnabled: Boolean(getControlPlaneAdminToken())
      },
      dependencies: {
        postgres: Boolean(process.env.POSTGRES_URL),
        livekit: Boolean(process.env.LIVEKIT_URL),
        livekitConfig: getLivekitDeploymentDiagnostics(),
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

  if (method === "GET" && (url.pathname === "/diagnostics" || url.pathname === "/diagnostics.html")) {
    const served = await serveStatic(response, join(runtimeStaticRoot, "diagnostics.html"));
    if (!served) json(response, 503, { error: "diagnostics_build_missing" });
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
    const localUploadRoot = process.env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT ? resolve(process.env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT) : null;
    const uploadedScenePath = url.pathname.match(/^\/assets\/uploaded-scene-bundles\/(.+)$/)?.[1];
    const normalizedUploadedScenePath = uploadedScenePath ? normalizeSceneBundleRelativePath(uploadedScenePath) : null;
    const served = (localUploadRoot && normalizedUploadedScenePath ? await serveStatic(response, join(localUploadRoot, normalizedUploadedScenePath)) : false)
      || await serveStatic(response, join(runtimeStaticRoot, url.pathname.slice(1)))
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
    const actorResult = resolveControlPlaneActor(request);
    const canListPrivate = actorResult.ok && actorResult.actor.actorType === "admin-token";
    const rooms = (await storage.listRooms()).filter((room) => canListPrivate || (!isRoomDisabled(room) && (!isRoomAccessPolicyEnabled() || sanitizeRoomVisibility(room.visibility) === "public")));
    json(response, 200, { items: rooms.map((room) => ({ ...room, roomLink: createRoomLink(room.roomId, request) })) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/control-plane/session") {
    const actor = await requireControlPlanePermission(request, response, { permission: "dashboard.read", action: "admin.dashboard.view", objectType: "dashboard", objectId: "control-plane" });
    if (!actor) return;
    metrics.adminDashboardViewsTotal += 1;
    json(response, 200, {
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        role: actor.role,
        tenantId: actor.tenantId,
        roomId: actor.roomId
      },
      permissions: controlPlanePermissions
    });
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

  if (method === "POST" && url.pathname === "/api/scene-bundles/uploads") {
    if (!isSceneBundleUploadEnabled()) return json(response, 404, { error: "scene_bundle_upload_disabled" });
    const actor = await requireControlPlanePermission(request, response, { permission: "scene-bundle.write", action: "scene-bundle.upload", objectType: "scene-bundle" });
    if (!actor) return;
    await handleSceneBundleZipUpload(request, response, storage, actor);
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
    if (validationError) {
      incrementCounter(metrics.roomCreationFailuresTotal, validationError);
      return json(response, 400, { error: validationError });
    }
    const assetValidationError = await validateRoomAssetIds(storage, payload.assetIds, payload.templateId);
    if (assetValidationError) {
      incrementCounter(metrics.roomCreationFailuresTotal, assetValidationError);
      return json(response, 400, { error: assetValidationError });
    }
    if (payload.roomId && await storage.getRoom(payload.roomId)) {
      incrementCounter(metrics.roomCreationFailuresTotal, "room_slug_conflict");
      return json(response, 409, { error: "room_slug_conflict" });
    }
    let room: RoomRecord;
    try {
      room = await storage.createRoom(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "room_create_failed";
      const reason = /duplicate key|unique constraint|already exists/i.test(message) ? "room_slug_conflict" : "room_create_failed";
      incrementCounter(metrics.roomCreationFailuresTotal, reason);
      return json(response, reason === "room_slug_conflict" ? 409 : 400, { error: reason });
    }
    incrementCounter(metrics.roomsCreatedTotal, `control-plane:${sanitizeRoomVisibility(room.visibility)}`);
    json(response, 201, { ...room, roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/personal-room") {
    if (!isPersonalRoomsFeatureEnabled()) return json(response, 404, { error: "personal_rooms_disabled" });
    const payload = (await parseBody<{ participantId?: unknown; displayName?: unknown; tenantId?: unknown }>(request)) ?? {};
    const participantId = normalizeParticipantId(payload.participantId);
    if (!participantId) {
      incrementCounter(metrics.personalRoomOpensTotal, "invalid_participant");
      return json(response, 400, { error: "invalid_participant_id" });
    }
    const tenantId = typeof payload.tenantId === "string" && payload.tenantId.trim() ? payload.tenantId.trim() : "demo-tenant";
    const tenantIds = new Set((await storage.listTenants()).map((tenant) => tenant.tenantId));
    if (!tenantIds.has(tenantId)) {
      incrementCounter(metrics.personalRoomOpensTotal, "invalid_tenant");
      return json(response, 400, { error: "invalid_tenant" });
    }

    const existing = (await storage.listRooms()).find((room) => room.roomType === "personal" && room.ownerParticipantId === participantId && room.tenantId === tenantId) ?? null;
    if (existing) {
      if (isRoomDisabled(existing)) {
        incrementCounter(metrics.personalRoomOpensTotal, "disabled");
        return json(response, 403, { error: "room_access_denied", reason: "room_disabled", roomId: existing.roomId });
      }
      incrementCounter(metrics.personalRoomOpensTotal, "existing");
      return json(response, 200, { created: false, room: existing, roomLink: createRoomLink(existing.roomId, request), manifest: await buildManifest(existing.roomId, request) });
    }

    const displayName = normalizeDisplayName(payload.displayName, participantId);
    const roomId = createPersonalRoomId(`${tenantId}:${participantId}`);
    if (await storage.getRoom(roomId)) {
      incrementCounter(metrics.personalRoomOpensTotal, "slug_conflict");
      return json(response, 409, { error: "room_slug_conflict" });
    }
    const room = await storage.createRoom({
      roomId,
      tenantId,
      templateId: "personal-workspace-basic",
      name: personalRoomName(displayName),
      roomType: "personal",
      ownerParticipantId: participantId,
      visibility: "private",
      guestAllowed: false,
      features: { voice: true, spatialAudio: true, screenShare: true },
      theme: { primaryColor: "#7dd3fc", accentColor: "#312e81" },
      sessionControl: { hostParticipantId: participantId }
    });
    metrics.personalRoomsCreatedTotal += 1;
    incrementCounter(metrics.roomsCreatedTotal, "self-service:private");
    incrementCounter(metrics.personalRoomOpensTotal, "created");
    logEvent({
      service: "api",
      event: "personal_room_created",
      requestId,
      roomId: room.roomId,
      tenantId: room.tenantId,
      ownerParticipantId: participantId,
      timestamp: new Date().toISOString()
    });
    json(response, 201, { created: true, room, roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request) });
    return;
  }

  const roomPersonalStateMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/personal-state$/);
  if ((method === "GET" || method === "PUT") && roomPersonalStateMatch) {
    if (!isPersonalRoomsFeatureEnabled()) return json(response, 404, { error: "personal_rooms_disabled" });
    const roomId = decodeURIComponent(roomPersonalStateMatch[1]);
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    if (!isPersonalRoom(room)) return json(response, 404, { error: "personal_state_not_available" });
    const actorResult = resolveControlPlaneActor(request);
    if (!actorResult.ok) {
      incrementCounter(metrics.personalStateSaveFailuresTotal, method === "PUT" ? actorResult.reason : "read_unauthorized");
      return json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId });
    }
    const actor = actorResult.actor;
    const canAccessPersonalState = actor.actorType === "admin-token" || (actor.actorType === "room-session" && actor.roomId === roomId && actor.participantId === room.ownerParticipantId);
    if (!canAccessPersonalState) {
      if (method === "PUT") incrementCounter(metrics.personalStateSaveFailuresTotal, "owner_required");
      return json(response, 403, { error: "forbidden", reason: "owner_required", requestId });
    }

    if (method === "GET") {
      json(response, 200, { state: room.personalState ?? {} });
      return;
    }

    const state = normalizePersonalState(await parseBody<unknown>(request), actor.actorId);
    if (!state) {
      incrementCounter(metrics.personalStateSaveFailuresTotal, "invalid_personal_state");
      return json(response, 400, { error: "invalid_personal_state" });
    }
    const updated = await storage.updateRoom(roomId, { personalState: state });
    if (!updated) {
      incrementCounter(metrics.personalStateSaveFailuresTotal, "room_not_found");
      return json(response, 404, { error: "room_not_found" });
    }
    json(response, 200, { state: updated.personalState ?? state });
    return;
  }

  const roomDocumentsListMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/documents$/);
  if ((method === "GET" || method === "POST") && roomDocumentsListMatch) {
    if (!isDocumentsFeatureEnabled()) return json(response, 404, { error: "documents_disabled" });
    const roomId = decodeURIComponent(roomDocumentsListMatch[1]);
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const permission = method === "GET" ? "document.view" : "document.upload";
    const actor = resolveRoomDocumentsActor(request, response, { room, permission, action: method === "GET" ? "documents.list" : "documents.upload" });
    if (!actor) return;

    if (method === "GET") {
      const documents = await storage.listRoomDocuments(roomId);
      json(response, 200, { items: documents.map((document) => serializeRoomDocument(request, document)) });
      return;
    }

    const maxBytes = Number.parseInt(process.env.DOCUMENT_UPLOAD_MAX_BYTES ?? `${10 * 1024 * 1024}`, 10);
    const boundary = parseMultipartBoundary(request.headers["content-type"]);
    if (!boundary) {
      incrementCounter(metrics.documentsUploadedTotal, "unknown:rejected");
      return json(response, 415, { error: "expected_multipart_document_upload" });
    }
    const body = await readRequestBuffer(request, maxBytes);
    const parts = parseMultipartFormData(body, boundary);
    const documentFile = filePart(parts, "document") ?? filePart(parts, "file");
    const filename = normalizeDocumentFilename(documentFile?.filename);
    if (!documentFile || !filename) {
      incrementCounter(metrics.documentsUploadedTotal, "unknown:rejected");
      return json(response, 400, { error: "invalid_document_filename" });
    }
    const contentType = normalizeDocumentContentType(documentFile, filename);
    if (!contentType) {
      incrementCounter(metrics.documentsUploadedTotal, "unsupported:rejected");
      return json(response, 400, { error: "unsupported_document_mime" });
    }
    if (documentFile.data.byteLength > maxBytes) {
      incrementCounter(metrics.documentsUploadedTotal, `${contentType}:rejected`);
      return json(response, 413, { error: "document_too_large" });
    }

    try {
      const documentId = randomUUID();
      const uploadStorage = getDocumentUploadStorage(request);
      const storageKey = documentStorageKey(room.tenantId, roomId, documentId, filename);
      await writeDocumentObject(uploadStorage, storageKey, documentFile.data, contentType);
      const document = await storage.createRoomDocument({
        documentId,
        roomId,
        tenantId: room.tenantId,
        filename,
        contentType,
        sizeBytes: documentFile.data.byteLength,
        storageKey,
        checksum: `sha256:${sha256Hex(documentFile.data)}`,
        uploadedBy: actor.actorId
      });
      incrementCounter(metrics.documentsUploadedTotal, `${contentType}:success`);
      incrementCounter(metrics.documentStorageBytesTotal, room.tenantId, document.sizeBytes);
      json(response, 201, { document: serializeRoomDocument(request, document) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "document_upload_failed";
      incrementCounter(metrics.documentsUploadedTotal, `${contentType}:failed`);
      json(response, message.startsWith("misconfigured_document_upload_storage") ? 503 : 400, { error: message, requestId });
    }
    return;
  }

  const roomDocumentItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/documents\/([^/]+)(?:\/(download|surface))?$/);
  if ((method === "GET" || method === "DELETE" || method === "POST") && roomDocumentItemMatch) {
    if (!isDocumentsFeatureEnabled()) return json(response, 404, { error: "documents_disabled" });
    const roomId = decodeURIComponent(roomDocumentItemMatch[1]);
    const documentId = decodeURIComponent(roomDocumentItemMatch[2]);
    const actionPath = roomDocumentItemMatch[3] ?? "item";
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const permission = actionPath === "download" ? "document.download" : method === "DELETE" ? "document.delete" : "document.upload";
    const action = actionPath === "download" ? "documents.download" : method === "DELETE" ? "documents.delete" : "documents.select-surface";
    const actor = resolveRoomDocumentsActor(request, response, { room, permission, action, documentId });
    if (!actor) return;
    const document = await storage.getRoomDocument(roomId, documentId);
    if (!document || document.deletedAt) return json(response, 404, { error: "document_not_found" });

    if (method === "GET" && actionPath === "download") {
      try {
        const bytes = await readDocumentObject(getDocumentUploadStorage(request), document.storageKey);
        metrics.documentDownloadsTotal += 1;
        response.writeHead(200, {
          "content-type": document.contentType,
          "content-length": String(bytes.byteLength),
          "content-disposition": `attachment; filename="${safeHeaderFilename(document.filename)}"`,
          "x-request-id": requestId
        });
        response.end(bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : "document_download_failed";
        json(response, 503, { error: message, requestId });
      }
      return;
    }

    if (method === "DELETE" && actionPath === "item") {
      const deleted = await storage.markRoomDocumentDeleted(roomId, documentId, new Date().toISOString(), actor.actorId);
      if (!deleted) return json(response, 404, { error: "document_not_found" });
      metrics.documentDeletesTotal += 1;
      json(response, 200, { document: serializeRoomDocument(request, deleted) });
      return;
    }

    if (method === "POST" && actionPath === "surface") {
      const payload = (await parseBody<{ surfaceId?: unknown }>(request)) ?? {};
      const surfaceId = normalizeDocumentSurfaceId(payload.surfaceId);
      if (surfaceId === undefined) return json(response, 400, { error: "invalid_document_surface_id" });
      const updated = await storage.updateRoomDocumentSurface(roomId, documentId, surfaceId);
      if (!updated) return json(response, 404, { error: "document_not_found" });
      metrics.documentSurfaceSelectionsTotal += 1;
      json(response, 200, { document: serializeRoomDocument(request, updated) });
      return;
    }

    json(response, 405, { error: "unsupported_document_action" });
    return;
  }

  const roomNotesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)$/);
  if ((method === "GET" || method === "PUT") && roomNotesMatch) {
    if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
    const roomId = decodeURIComponent(roomNotesMatch[1]);
    const scope = roomNotesMatch[2] as RoomNoteScope;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const permission: "notes.view" | "notes.edit" = method === "GET" || scope === "private" ? "notes.view" : "notes.edit";
    const actor = resolveRoomNotesActor(request, response, { room, scope, permission, action: method === "GET" ? "notes.read" : "notes.save" });
    if (!actor) return;
    const requestedOwnerParticipantId = scope === "private" ? url.searchParams.get("participantId")?.trim() || null : null;
    if (scope === "private" && actor.actorType === "room-session" && requestedOwnerParticipantId && requestedOwnerParticipantId !== actor.participantId) {
      metrics.notesPermissionDeniedTotal += 1;
      writeRoomNotesAudit({ request, action: method === "GET" ? "notes.read" : "notes.save", roomId, scope, result: "denied", reason: "note_owner_mismatch", actor });
      return json(response, 403, { error: "forbidden", reason: "note_owner_mismatch", permission, requestId });
    }
    const ownerParticipantId = resolveRoomNoteOwner(scope, actor, url);
    if (scope === "private" && !ownerParticipantId) {
      incrementCounter(metrics.notesSaveFailuresTotal, "missing_private_note_owner");
      return json(response, 400, { error: "missing_private_note_owner" });
    }

    if (method === "GET") {
      const note = await storage.getRoomNote(roomId, scope, ownerParticipantId);
      json(response, 200, { note: note ?? emptyRoomNote(roomId, scope, ownerParticipantId) });
      return;
    }

    const payload = (await parseBody<{ content?: unknown }>(request)) ?? {};
    if (typeof payload.content !== "string") {
      incrementCounter(metrics.notesSaveFailuresTotal, "invalid_note_content");
      incrementCounter(metrics.notesSavedTotal, `${scope}:failed`);
      return json(response, 400, { error: "invalid_note_content" });
    }
    if (payload.content.length > 20_000) {
      incrementCounter(metrics.notesSaveFailuresTotal, "note_too_large");
      incrementCounter(metrics.notesSavedTotal, `${scope}:failed`);
      return json(response, 413, { error: "note_too_large" });
    }

    const existing = await storage.getRoomNote(roomId, scope, ownerParticipantId);
    const note = await storage.upsertRoomNote({
      roomId,
      scope,
      ownerParticipantId,
      content: payload.content,
      updatedBy: actor.actorId
    });
    if (!existing) incrementCounter(metrics.notesCreatedTotal, scope);
    incrementCounter(metrics.notesSavedTotal, `${scope}:saved`);
    json(response, existing ? 200 : 201, { note });
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
    if (payload.visibility !== undefined && !isRoomVisibility(payload.visibility)) return json(response, 400, { error: "invalid_room_visibility" });
    if (payload.assetIds) {
      const assetValidationError = await validateRoomAssetIds(storage, payload.assetIds, payload.templateId ?? existingRoom.templateId);
      if (assetValidationError) return json(response, 400, { error: assetValidationError });
    }
    const updated = await storage.updateRoom(roomId, payload);
    if (!updated) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...updated, roomLink: createRoomLink(updated.roomId, request), manifest: await buildManifest(updated.roomId, request) });
    return;
  }

  const roomLifecycleMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(disable|enable)$/);
  if (method === "POST" && roomLifecycleMatch) {
    const roomId = decodeURIComponent(roomLifecycleMatch[1]);
    const lifecycleAction = roomLifecycleMatch[2] as "disable" | "enable";
    const actor = await requireControlPlanePermission(request, response, { permission: "room.update", action: `room.${lifecycleAction}`, objectType: "room", objectId: roomId });
    if (!actor) return;
    const existingRoom = await storage.getRoom(roomId);
    if (!existingRoom) return json(response, 404, { error: "room_not_found" });
    const updated = await storage.updateRoom(roomId, lifecycleAction === "disable"
      ? { status: "disabled", disabledAt: new Date().toISOString(), disabledBy: actor.actorId }
      : { status: "active", disabledAt: null, disabledBy: null });
    if (!updated) return json(response, 404, { error: "room_not_found" });
    if (lifecycleAction === "disable") {
      metrics.roomsDisabledTotal += 1;
      presenceByRoom.delete(roomId);
    }
    json(response, 200, { ...updated, roomLink: createRoomLink(updated.roomId, request), manifest: await buildManifest(updated.roomId, request) });
    return;
  }

  const roomInvitesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invites$/);
  if (roomInvitesMatch && (method === "GET" || method === "POST")) {
    const roomId = decodeURIComponent(roomInvitesMatch[1]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.invite",
      action: method === "POST" ? "invite.create" : "invite.list",
      objectType: "room",
      objectId: roomId,
      targetRoomId: roomId,
      allowHostOwnRoom: true
    });
    if (!actor) return;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    if (method === "GET") {
      json(response, 200, { items: (await storage.listRoomInvites(roomId)).map((invite) => sanitizeRoomInvite(invite)) });
      return;
    }

    const payload = (await parseBody<{ expiresInSeconds?: number; expiresAt?: string; role?: string; waitingRoomEnabled?: boolean }>(request)) ?? {};
    const nowMs = Date.now();
    const expiresAtMs = payload.expiresAt
      ? Date.parse(payload.expiresAt)
      : nowMs + Math.max(1, Math.min(30 * 24 * 60 * 60, Math.floor(payload.expiresInSeconds ?? 3600))) * 1000;
    if (!Number.isFinite(expiresAtMs)) return json(response, 400, { error: "invalid_invite_expiry" });
    const token = createInviteToken();
    const invite = await storage.createRoomInvite({
      roomId,
      tokenHash: hashInviteToken(token),
      role: parseRoomRole(payload.role, "guest"),
      waitingRoomEnabled: payload.waitingRoomEnabled === true,
      expiresAt: new Date(expiresAtMs).toISOString(),
      createdBy: actor.actorId
    });
    json(response, 201, sanitizeRoomInvite(invite, createInviteLink(roomId, token, request)));
    return;
  }

  const roomInviteRevokeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/invites\/([^/]+)\/revoke$/);
  if (method === "POST" && roomInviteRevokeMatch) {
    const roomId = decodeURIComponent(roomInviteRevokeMatch[1]);
    const inviteId = decodeURIComponent(roomInviteRevokeMatch[2]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.invite",
      action: "invite.revoke",
      objectType: "room-invite",
      objectId: inviteId,
      targetRoomId: roomId,
      allowHostOwnRoom: true
    });
    if (!actor) return;
    const invite = await storage.revokeRoomInvite(roomId, inviteId, new Date().toISOString(), actor.actorId);
    if (!invite) return json(response, 404, { error: "invite_not_found" });
    metrics.invitesRevokedTotal += 1;
    json(response, 200, sanitizeRoomInvite(invite));
    return;
  }

  const waitingRoomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/waiting-room$/);
  if (method === "GET" && waitingRoomMatch) {
    const roomId = decodeURIComponent(waitingRoomMatch[1]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.invite",
      action: "waiting-room.list",
      objectType: "room",
      objectId: roomId,
      targetRoomId: roomId,
      allowHostOwnRoom: true
    });
    if (!actor) return;
    json(response, 200, { items: (await storage.listWaitingRoomRequests(roomId)).map(sanitizeWaitingRoomRequest) });
    return;
  }

  const waitingRoomDecisionMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/waiting-room\/([^/]+)\/(approve|reject)$/);
  if (method === "POST" && waitingRoomDecisionMatch) {
    const roomId = decodeURIComponent(waitingRoomDecisionMatch[1]);
    const waitingRequestId = decodeURIComponent(waitingRoomDecisionMatch[2]);
    const decision = waitingRoomDecisionMatch[3] === "approve" ? "approved" : "rejected";
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.invite",
      action: `waiting-room.${waitingRoomDecisionMatch[3]}`,
      objectType: "waiting-room-request",
      objectId: waitingRequestId,
      targetRoomId: roomId,
      allowHostOwnRoom: true
    });
    if (!actor) return;
    const waitingRequest = await storage.updateWaitingRoomRequest(roomId, waitingRequestId, {
      status: decision,
      decidedAt: new Date().toISOString(),
      decidedBy: actor.actorId
    });
    if (!waitingRequest) return json(response, 404, { error: "waiting_room_request_not_found" });
    json(response, 200, sanitizeWaitingRoomRequest(waitingRequest));
    return;
  }

  const sessionControlMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/session-control$/);
  if (method === "GET" && sessionControlMatch) {
    const roomId = decodeURIComponent(sessionControlMatch[1]);
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actorResult = resolveControlPlaneActor(request);
    if (!actorResult.ok) {
      return json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId });
    }
    if (actorResult.actor.actorType !== "admin-token" && actorResult.actor.roomId !== roomId) {
      return json(response, 403, { error: "forbidden", reason: "room_mismatch", requestId });
    }

    const session = actorResult.actor.actorType === "room-session"
      ? verifyRoomSessionToken(getBearerToken(request), getStateTokenSecret(), { roomId, participantId: actorResult.actor.participantId })
      : null;
    const participantIdForStatus = session?.ok ? session.payload.participantId : actorResult.actor.participantId;
    const currentRole = session?.ok ? session.payload.role : actorResult.actor.role;
    const effectiveRole = participantIdForStatus ? resolveEffectiveRoomRole(room, participantIdForStatus, currentRole) : currentRole;
    const statusReason = participantIdForStatus ? getSessionControlBlockReason(room, participantIdForStatus, effectiveRole, true) : null;
    const ttlSeconds = Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10);
    const tokenResponse = session?.ok && !statusReason ? createRoomAccessTokenResponse({
      room,
      roomId,
      participantId: session.payload.participantId,
      displayName: session.payload.displayName,
      role: effectiveRole,
      roleSource: session.payload.roleSource ?? "trusted",
      sessionId: session.payload.sessionId,
      ttlSeconds
    }) : null;
    json(response, 200, {
      state: sanitizeSessionControlState(room.sessionControl),
      participant: participantIdForStatus ? {
        participantId: participantIdForStatus,
        role: effectiveRole,
        permissions: getRoomPermissions(effectiveRole),
        status: statusReason ? "blocked" : "active",
        reason: statusReason
      } : null,
      token: tokenResponse?.token,
      expiresInSeconds: tokenResponse?.expiresInSeconds,
      access: tokenResponse?.access,
      role: tokenResponse?.role,
      permissions: tokenResponse?.permissions
    });
    return;
  }

  const sessionControlActionMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/session-control\/(lock|unlock|end)$/);
  if (method === "POST" && sessionControlActionMatch) {
    const roomId = decodeURIComponent(sessionControlActionMatch[1]);
    const action = sessionControlActionMatch[2] as "lock" | "unlock" | "end";
    if (!isHostControlsEnabled()) return json(response, 404, { error: "host_controls_disabled" });
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.session-control",
      action: `room.session-control.${action}`,
      objectType: "room",
      objectId: roomId,
      targetRoomId: roomId,
      allowHostOwnRoom: true,
      currentHostParticipantId: defaultSessionControlState(room.sessionControl).hostParticipantId
    });
    if (!actor) {
      incrementHostActionMetric(action, "denied");
      return;
    }
    const now = new Date().toISOString();
    const current = defaultSessionControlState(room.sessionControl);
    const next = action === "lock"
      ? { ...current, lockedAt: now, lockedBy: actor.actorId }
      : action === "unlock"
        ? { ...current, lockedAt: null, lockedBy: null }
        : { ...current, endedAt: now, endedBy: actor.actorId };
    const updated = await updateRoomSessionControl(storage, room, next);
    if (action === "lock") metrics.roomLockedTotal += 1;
    if (action === "end") {
      metrics.sessionsEndedTotal += 1;
      for (const participant of getPresence(roomId)) {
        deletePresence(roomId, participant.participantId);
      }
    }
    incrementHostActionMetric(action, "allowed");
    json(response, 200, { state: sanitizeSessionControlState(updated.sessionControl) });
    return;
  }

  const participantRemoveMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/participants\/([^/]+)\/remove$/);
  if (method === "POST" && participantRemoveMatch) {
    const roomId = decodeURIComponent(participantRemoveMatch[1]);
    const targetParticipantId = decodeURIComponent(participantRemoveMatch[2]);
    if (!isHostControlsEnabled()) return json(response, 404, { error: "host_controls_disabled" });
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.session-control",
      action: "room.session-control.participant.remove",
      objectType: "participant",
      objectId: targetParticipantId,
      targetRoomId: roomId,
      allowHostOwnRoom: true,
      currentHostParticipantId: defaultSessionControlState(room.sessionControl).hostParticipantId
    });
    if (!actor) {
      incrementHostActionMetric("remove", "denied");
      return;
    }
    if (actor.participantId === targetParticipantId) {
      incrementHostActionMetric("remove", "denied");
      return json(response, 400, { error: "cannot_remove_self" });
    }
    const current = defaultSessionControlState(room.sessionControl);
    if (current.hostParticipantId === targetParticipantId && actor.actorType !== "admin-token") {
      incrementHostActionMetric("remove", "denied");
      return json(response, 403, { error: "cannot_remove_current_host" });
    }
    const payload = (await parseBody<{ reason?: string }>(request)) ?? {};
    const now = new Date().toISOString();
    const updated = await updateRoomSessionControl(storage, room, {
      ...current,
      removedParticipants: {
        ...current.removedParticipants,
        [targetParticipantId]: {
          removedAt: now,
          removedBy: actor.actorId,
          reason: typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim().slice(0, 120) : null
        }
      }
    });
    deletePresence(roomId, targetParticipantId);
    metrics.participantsRemovedTotal += 1;
    incrementHostActionMetric("remove", "allowed");
    json(response, 200, { state: sanitizeSessionControlState(updated.sessionControl), removedParticipantId: targetParticipantId });
    return;
  }

  const hostTransferMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/host\/transfer$/);
  if (method === "POST" && hostTransferMatch) {
    const roomId = decodeURIComponent(hostTransferMatch[1]);
    if (!isHostControlsEnabled()) return json(response, 404, { error: "host_controls_disabled" });
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.session-control",
      action: "room.session-control.host.transfer",
      objectType: "room",
      objectId: roomId,
      targetRoomId: roomId,
      allowHostOwnRoom: true,
      currentHostParticipantId: defaultSessionControlState(room.sessionControl).hostParticipantId
    });
    if (!actor) {
      incrementHostActionMetric("transfer_host", "denied");
      return;
    }
    const payload = (await parseBody<{ participantId?: string }>(request)) ?? {};
    const targetParticipantId = typeof payload.participantId === "string" ? payload.participantId.trim() : "";
    if (!targetParticipantId) {
      incrementHostActionMetric("transfer_host", "denied");
      return json(response, 400, { error: "missing_participant_id" });
    }
    const participant = getPresence(roomId).find((item) => item.participantId === targetParticipantId);
    if (!participant || getRemovedParticipant(room, targetParticipantId)) {
      incrementHostActionMetric("transfer_host", "denied");
      return json(response, 404, { error: "participant_not_found" });
    }
    const updated = await updateRoomSessionControl(storage, room, {
      ...defaultSessionControlState(room.sessionControl),
      hostParticipantId: targetParticipantId
    });
    incrementHostActionMetric("transfer_host", "allowed");
    json(response, 200, { state: sanitizeSessionControlState(updated.sessionControl), hostParticipantId: targetParticipantId });
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
    const roomId = decodeURIComponent(manifestMatch[1]);
    const room = await storage.getRoom(roomId);
    if (room && isRoomDisabled(room) && !canManageDisabledRoom(request)) return json(response, 403, { error: "room_access_denied", reason: "room_disabled" });
    if (room && !(await canReadRoomDetails(request, room))) return json(response, 404, { error: "room_not_found" });
    json(response, 200, await buildManifest(roomId, request));
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
    const room = await storage.getRoom(roomId);
    const effectiveRole = resolveEffectiveRoomRole(room, session.payload.participantId, session.payload.role);
    const blockReason = getSessionControlBlockReason(room, session.payload.participantId, effectiveRole, true);
    if (blockReason) {
      return json(response, 403, { error: "room_access_denied", reason: blockReason });
    }
    upsertPresence(roomId, participantId, {
      ...payload,
      role: effectiveRole,
      permissions: getRoomPermissions(effectiveRole)
    });
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
    if (isRoomDisabled(room) && !canManageDisabledRoom(request)) return json(response, 403, { error: "room_access_denied", reason: "room_disabled" });
    if (!(await canReadRoomDetails(request, room))) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...room, roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/state") {
    const requestPayload = await parseBody<StateTokenRequest>(request);
    const ttlSeconds = Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const roomId = requestPayload?.roomId ?? "demo-room";
    const room = await storage.getRoom(roomId);
    const requested = resolveAccessRole(requestPayload?.requestedRole ?? requestPayload?.role);
    const accessResult = await resolveStateTokenAccess(storage, request, room, requestPayload, requested);
    if (!accessResult.ok) {
      incrementCounter(metrics.roomAccessDeniedTotal, accessResult.reason);
      return json(response, accessResult.statusCode, {
        error: "room_access_denied",
        reason: accessResult.reason,
        accessRequestId: accessResult.accessRequestId,
        requestId
      });
    }
    const participantId = requestPayload?.participantId ?? randomUUID();
    let tokenRoom = room;
    if (room && accessResult.role === "host" && accessResult.roleSource === "trusted" && !defaultSessionControlState(room.sessionControl).hostParticipantId) {
      tokenRoom = await updateRoomSessionControl(storage, room, {
        ...defaultSessionControlState(room.sessionControl),
        hostParticipantId: participantId
      });
    }
    json(response, 200, createRoomAccessTokenResponse({
      room: tokenRoom,
      roomId,
      participantId,
      displayName: requestPayload?.displayName ?? participantId,
      role: accessResult.role,
      roleSource: accessResult.roleSource,
      ttlSeconds,
      nowSeconds
    }));
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
    const room = await storage.getRoom(payload.roomId);
    const effectiveRole = resolveEffectiveRoomRole(room, session.payload.participantId, session.payload.role);
    const blockReason = getSessionControlBlockReason(room, session.payload.participantId, effectiveRole, true);
    if (blockReason) {
      incrementCounter(metrics.mediaJoinFailuresTotal, blockReason);
      return json(response, 403, { error: "room_access_denied", reason: blockReason });
    }
    const effectivePermissions = getRoomPermissions(effectiveRole);
    const canPublishAudio = hasRoomPermission(effectivePermissions, "audio.join") && payload.canPublishAudio !== false;
    const canPublishVideo = Boolean(payload.canPublishVideo) && hasRoomPermission(effectivePermissions, "screen-share.start");
    if (!canPublishAudio && !canPublishVideo) {
      incrementCounter(metrics.mediaJoinFailuresTotal, "media_publish_not_allowed");
      return json(response, 403, { error: "forbidden", reason: "media_publish_not_allowed" });
    }
    const configError = getMediaTokenConfigError();
    if (configError) {
      incrementCounter(metrics.mediaJoinFailuresTotal, "livekit_config_invalid");
      return json(response, 503, { error: "livekit_config_invalid", reason: configError });
    }
    const { apiKey, apiSecret } = getLivekitCredentials();
    const accessToken = new AccessToken(apiKey, apiSecret, {
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
    const configError = getMediaTokenConfigError();
    if (configError) {
      incrementCounter(metrics.mediaJoinFailuresTotal, "livekit_config_invalid");
      return json(response, 503, { error: "livekit_config_invalid", reason: configError });
    }
    const ttlSeconds = Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10);
    const { apiKey, apiSecret } = getLivekitCredentials();
    const accessToken = new AccessToken(apiKey, apiSecret, {
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
