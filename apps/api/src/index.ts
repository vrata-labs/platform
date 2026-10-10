import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { AccessToken } from "livekit-server-sdk";
import { PDFDocument } from "pdf-lib";
import { extractSceneBundleZipToTemp, normalizeSceneBundleRelativePath, validateSceneBundlePath, validateSceneBundleReference } from "@vrata/asset-pipeline";
import { createRoomAccessDebugState, getRoomPermissions, hasRoomPermission, parseRoomRole, type RoomPermission, type RoomRole } from "@vrata/shared-types";
import { getRoomSessionTokenSecret, isRotatedDevelopmentSession, signRoomSessionToken, verifyRoomSessionToken, type RoomSessionRoleSource, type RoomSessionTokenPayload, type RoomSessionTokenVerificationResult } from "@vrata/shared-types/session-token";

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
  type RoomDocumentMetadata,
  type RoomNoteRecord,
  type RoomNoteScope,
  type RoomInviteRecord,
  type RoomRecord,
  type RoomSessionControlState,
  type RuntimeDiagnosticRecord,
  type TenantRecord,
  type WaitingRoomRequestRecord
} from "./storage.js";

import {
  isDevRoleQueryAllowed,
  isSpatialAudioFeatureEnabled,
  isXrFeatureEnabled,
  isRoomAccessPolicyEnabled,
  isNotesFeatureEnabled,
  isDocumentsFeatureEnabled,
  isPersonalRoomsFeatureEnabled,
  isRemoteBrowserFeatureEnabled,
  isSceneBundleUploadEnabled,
  isHostControlsEnabled
} from "./feature-flags.js";
import { createLegacyIdentityBoundary, IdentityBoundaryError, legacyBoundaryApplies, legacyBoundaryAllowsAdministrator } from "./identity/legacy-boundary.js";
import { assertVirtualRoomId, InvalidVirtualRoomId } from "./identity/virtual-effect-facade.js";
import { validId } from "./identity/authority.js";
import { createRoomIdentityService } from "./identity/service.js";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { admitV2RoomSession, type V2AdmissionRequest } from "./identity/http-admission.js";
import { currentSessionControlV2, resolveRoomRequestV2, untrustedSessionRoom, type VerifiedRoomRequestV2 } from "./identity/http-authority.js";
import { roomMediaGrantName } from "./identity/media-room.js";
import { applyRoomLifecycleV2, lifecycleV2Error, roomIdentityActorFromHttp } from "./identity/http-lifecycle.js";
import { finalizeProofBoundToken } from "./identity/effect-fence.js";
import { IdentityStorageError } from "./identity/contracts.js";
import { PersonalOwnerRoomBlocked } from "./identity/personal-owner-response.js";
import type { RoomEffectGuard, RoomEffectActor } from "./identity/effect-write-guard.js";
import type { Storage, RoomIdentityEffectStorage, VirtualRoomEffectStorage, LegacyRoomCredentialSelector, LegacyRoomCredentialSnapshot } from "./storage-contracts.js";
import { createRoomEffectFacade } from "./identity/effect-facade.js";
import { identityFenceUnavailable, uncertainRoomCommit } from "./identity/fence-transaction.js";
import { releaseFencedResponse } from "./identity/response-release.js";
import { identityAdmissionOriginHash as hashAdmissionOrigin } from "./identity/admission-origin.js";
import { adminCurrentOwnerParticipantId, currentRoomOwner } from "./identity/admin-room-projection.js";
import {
  classifyLegacyBearer, confirmLegacyAdmission, evaluateLegacyAdmission, normalizeLegacyParticipant,
  type LegacyAdmissionConfirmation, type LegacyAdmissionContext, type LegacyAdmissionDecision,
  type LegacyAdmissionRequest, type LegacyAdmissionSnapshot, type LegacyBearerClass
} from "./identity/legacy-state-admission.js";

import { getLivekitCredentials, getMediaTokenConfigError, getLivekitDeploymentDiagnostics } from "./livekit-config.js";

import { redactSecrets } from "./diagnostics-redaction.js";

import { createStoredZip } from "./stored-zip.js";

import { noteExportFilename, noteExportJson, formatNoteMarkdown, formatRoomNotesMarkdown } from "./notes-export.js";

import { inspectImageDocument, inspectVideoDocument } from "./document-media-metadata.js";

import { normalizeDocumentContentType, normalizeDocumentFilename, safeHeaderFilename } from "./document-file-policy.js";

import { parseMultipartBoundary, parseMultipartFormData, textPart, filePart } from "./multipart-form-data.js";

import { parseBody, readRequestBuffer } from "./request-body.js";

import { serveStatic, json, text, attachment } from "./http-responses.js";

import { createApiMetrics, incrementCounter } from "./api-metrics.js";

import { createUploadStorageConfig } from "./upload-storage-config.js";
import { configuredRoomPluginBlobStorage, deleteRoomWithPluginCleanup, roomPluginDeletionFailure, isRoomDeletionRequest } from "./plugins/index.js";
import { handleRoomPluginHttp } from "./plugins/http.js";
import { RoomPluginHttpError } from "./plugins/http-errors.js";
import type { RoomPluginAuthorActor } from "./plugins/access-contracts.js";

import {
  trimSlashes,
  sha256Hex,
  writeDocumentObject,
  deleteDocumentObject,
  resolveUploadedDocumentPublicUrl,
  readDocumentObject,
  publishSceneBundleFiles,
  resolveUploadedSceneBundlePublicUrl
} from "./uploaded-object-storage.js";

import {
  isRoomVisibility,
  sanitizeRoomVisibility,
  normalizeParticipantId,
  validateRoomInput,
  normalizeRoomPayload,
  type RoomPayloadInput
} from "./room-input.js";

import { defaultManifest } from "./default-room-manifest.js";
import { createRoomManifestBuilder } from "./room-manifest.js";
import { loadSceneMediaSurfaces } from "./scene-media-surfaces.js";
import { legacySceneMediaSurfaces } from "./legacy-scene-media-surfaces.js";
import { normalizeRoomAvatarOverrides } from "./room-input.js";
import { assertRoomTemplatePatch, listRoomTemplateMetadata, resolveRoomTemplateCreate, roomTemplateSessionContext, templateInputError } from "./room-template-policy.js";

import {
  isRoomDisabled,
  defaultSessionControlState,
  sanitizeSessionControlState,
  getRemovedParticipant,
  resolveEffectiveRoomRole,
  getSessionControlBlockReason
} from "./room-session-control.js";

import {
  isPersonalRoom,
  normalizeDisplayName,
  personalRoomName,
  normalizePersonalState
} from "./personal-room-rules.js";

import { createRoomPresence, type PresenceRecord } from "./room-presence.js";

import { validateRoomAssetIds, validateAssetInput } from "./room-asset-validation.js";

import { createXrTelemetryScheduler, createXrTelemetryService, XrTelemetryQueueFull } from "./xr-telemetry-service.js";
import { IDENTITY_LIFECYCLE_REQUIRES_V2 } from "./identity/lifecycle.js";
import type { XrTelemetryRecord } from "./xr-telemetry-buffer.js";

import {
  getRequestHost,
  getRequestProto,
  getDefaultLivekitUrl,
  getConfiguredPublicLivekitUrl,
  getDefaultRemoteBrowserFrameStreamUrl
} from "./public-endpoints.js";

export {
  isSpatialAudioFeatureEnabled,
  isXrFeatureEnabled,
  isRoomAccessPolicyEnabled,
  isNotesFeatureEnabled,
  isDocumentsFeatureEnabled,
  isPersonalRoomsFeatureEnabled,
  isRemoteBrowserFeatureEnabled,
  isHostControlsEnabled
} from "./feature-flags.js";

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
  executorInstanceId?: string;
  mediaParticipantId?: string;
  preferPublicLivekitUrl?: boolean;
}

interface RemoteBrowserFrameTokenRequest {
  roomId?: string;
  objectId?: string;
  executorSessionId?: string;
  executorInstanceId?: string;
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
  identityProtocolVersion?: 2;
  identityId?: string;
  authEpoch?: number;
  isOwner?: boolean;
  expiresAtSeconds?: number;
}

class RoomEffectPermissionDenied extends Error {}
class RoomEffectNotFound extends Error {}

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

interface RuntimeSpaceRecord {
  roomId: string;
  tenantId: string;
  name: string;
  templateId: string;
  roomLink: string;
}

interface SceneBundleManifestMetadata {
  schemaVersion?: number;
  sceneId?: string;
  glbPath?: string;
  preview?: string;
}

const apiPort = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const runtimeStaticRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/dist", import.meta.url))));
const runtimePublicRoot = normalize(join(fileURLToPath(new URL("../../runtime-web/public", import.meta.url))));
const controlPlaneStaticRoot = normalize(join(fileURLToPath(new URL("../../control-plane/dist", import.meta.url))));
const presenceTtlMs = Number.parseInt(process.env.PRESENCE_TTL_MS ?? "15000", 10);
const storagePromise = createStorage();
const legacyIdentityBoundary = createLegacyIdentityBoundary(storagePromise);
const requiredProductionApiEnvVars = ["CONTROL_PLANE_ADMIN_TOKEN", "ROOM_STATE_PUBLIC_URL", "RUNTIME_BASE_URL", "STATE_TOKEN_SECRET", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;

const presenceByRoom = new Map<string, Map<string, PresenceRecord>>();
const { getPresence, upsertPresence, deletePresence, cleanupAllPresence, activeParticipantCount } = createRoomPresence(presenceByRoom, presenceTtlMs);
// Missing-room (virtual) live state never shares a map with a persisted room's.
const virtualPresenceByRoom = new Map<string, Map<string, PresenceRecord>>();
const virtualPresence = createRoomPresence(virtualPresenceByRoom, presenceTtlMs);
// One scheduler keeps the API-wide commit slots and pending budget across both namespaces.
const xrTelemetryScheduler = createXrTelemetryScheduler();
const { upsertXrTelemetryWithFence, listXrTelemetry } = createXrTelemetryService(storagePromise, xrTelemetryScheduler);
const virtualXrTelemetry = createXrTelemetryService(storagePromise, xrTelemetryScheduler);
const controlPlaneAuditLog: ControlPlaneAuditLogEntry[] = [];
const CONTROL_PLANE_AUDIT_LIMIT = 1000;
const requestIds = new WeakMap<IncomingMessage, string>();
const v2SessionsByRequest = new WeakMap<IncomingMessage, VerifiedRoomRequestV2>();
// Aggregate gauges still count missing-room presence, as the single map did.
const activePresenceRooms = { get size() { return new Set([...presenceByRoom.keys(), ...virtualPresenceByRoom.keys()]).size; } };
const { metrics, apiMetricsText } = createApiMetrics(activePresenceRooms,
  () => { cleanupAllPresence(); virtualPresence.cleanupAllPresence(); },
  () => activeParticipantCount() + virtualPresence.activeParticipantCount());

function resolveAccessRole(requestedRole: unknown, env: NodeJS.ProcessEnv = process.env): { role: RoomRole; roleSource: RoomSessionRoleSource } {
  if (!isDevRoleQueryAllowed(env)) {
    return { role: "guest", roleSource: "default" };
  }
  return { role: parseRoomRole(requestedRole, "guest"), roleSource: requestedRole === undefined || requestedRole === null ? "default" : "dev-query" };
}

function getStateTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  return getRoomSessionTokenSecret(env);
}

function encodeAccessToken(payload: RoomAccessTokenPayload, env: NodeJS.ProcessEnv = process.env): string {
  return signRoomSessionToken(payload, getStateTokenSecret(env));
}

function createInviteToken(): string {
  return `${randomUUID()}${randomUUID()}`.replace(/-/g, "");
}

function hashInviteToken(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return hashInviteTokenWithSecret(token, getStateTokenSecret(env));
}

function hashInviteTokenWithSecret(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("base64url");
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

function getRemoteBrowserFrameTokenSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.REMOTE_BROWSER_TOKEN_SECRET?.trim();
  if (secret) return secret;
  return env.NODE_ENV === "production" ? null : "dev-remote-browser-secret";
}

export function resolveRemoteBrowserTokenTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REMOTE_BROWSER_TOKEN_TTL_SECONDS?.trim() ?? "300";
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 300;
  return Math.max(30, Math.min(600, Number.isFinite(parsed) ? parsed : 300));
}

function encodeRemoteBrowserFrameToken(payload: { roomId: string; objectId: string; executorSessionId: string; frameStreamId: string; exp: number }, env: NodeJS.ProcessEnv = process.env): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = getRemoteBrowserFrameTokenSecret(env);
  if (!secret) throw new Error("remote_browser_token_config_invalid");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function isRemoteBrowserIdentityBinding(input: { objectId: string; executorSessionId: string; executorInstanceId: string; mediaParticipantId?: string; frameStreamId?: string }): boolean {
  const expectedSessionId = `remote-browser:${input.objectId}`;
  return input.executorSessionId === expectedSessionId
    && input.executorInstanceId.startsWith(`${expectedSessionId}:instance:`)
    && input.executorInstanceId.length > `${expectedSessionId}:instance:`.length
    && (input.mediaParticipantId === undefined || input.mediaParticipantId === expectedSessionId)
    && (input.frameStreamId === undefined || input.frameStreamId === `${expectedSessionId}:frames`);
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
  if (isRemoteBrowserFeatureEnabled(env)) {
    if (!getRemoteBrowserFrameTokenSecret(env)) {
      throw new Error("invalid_remote_browser_config:remote_browser_token_secret_required");
    }
    if (!env.REMOTE_BROWSER_INTERNAL_TOKEN?.trim()) {
      throw new Error("invalid_remote_browser_config:remote_browser_internal_token_required");
    }
  }
  const livekitConfigError = getMediaTokenConfigError(env);
  if (livekitConfigError) {
    throw new Error(`invalid_livekit_config:${livekitConfigError}`);
  }
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(redactSecrets(event))}\n`);
}

function getRemoteBrowserLivekitUrl(request: IncomingMessage, payload: RemoteBrowserMediaTokenRequest): string {
  if (payload.preferPublicLivekitUrl) {
    return getConfiguredPublicLivekitUrl() ?? getDefaultLivekitUrl(request);
  }
  return getDefaultLivekitUrl(request);
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

const buildManifest = createRoomManifestBuilder(storagePromise);

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

function createDiagnosticRecord(payload: RuntimeDiagnosticRecord, requestId: string): RuntimeDiagnosticRecord {
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
  return sanitized;
}

/** Post-commit only: metrics, screen-share map and log describe a persisted report. */
function publishDiagnosticRecord(roomId: string, diagnostic: RuntimeDiagnosticRecord): void {
  logEvent({
    service: "api",
    event: "runtime_diagnostic_report",
    roomId,
    participantId: diagnostic.participantId,
    reportId: diagnostic.reportId,
    requestId: diagnostic.requestId,
    issueCode: diagnostic.issueCode ?? null,
    note: diagnostic.note ?? null,
    timestamp: diagnostic.createdAt
  });
  metrics.diagnosticsReportsCreatedTotal += 1;
  observeScreenShareDiagnostic(roomId, diagnostic);
  if (diagnostic.issueCode) {
    incrementCounter(metrics.roomJoinFailuresTotal, diagnostic.issueCode);
  }
}

function screenShareSessionKey(roomId: string, diagnostic: RuntimeDiagnosticRecord): string | null {
  const participantId = typeof diagnostic.participantId === "string" ? diagnostic.participantId.trim() : "";
  return participantId ? `${roomId}:${participantId}` : null;
}

function observeScreenShareDiagnostic(roomId: string, diagnostic: RuntimeDiagnosticRecord): void {
  const note = typeof diagnostic.note === "string" ? diagnostic.note.trim().toLowerCase().split(":")[0] : "";
  if (!note) return;
  const sessionKey = screenShareSessionKey(roomId, diagnostic);
  if (note === "screenshare_started" || note === "screenshare_mock_started") {
    incrementCounter(metrics.screenShareStartedTotal, "success");
    if (sessionKey) metrics.screenShareActiveSessions.add(sessionKey);
    return;
  }
  if (note === "screenshare_stopped" || note === "screenshare_mock_stopped" || note === "screenshare_track_ended") {
    if (sessionKey) metrics.screenShareActiveSessions.delete(sessionKey);
    return;
  }
  const failureReason = note === "screen_share_denied"
    ? "denied"
    : note === "screen_share_unsupported"
      ? "unsupported"
      : note === "media_network_blocked"
        ? "media_network_blocked"
        : note === "screenshare_stop_failed"
          ? "stop_failed"
          : note === "screenshare_failed"
            ? "failed"
            : null;
  if (!failureReason) return;
  incrementCounter(metrics.screenShareFailuresTotal, failureReason);
  if (failureReason === "denied") metrics.screenSharePermissionDeniedTotal += 1;
  if (sessionKey) metrics.screenShareActiveSessions.delete(sessionKey);
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

function getInternalServiceHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = getInternalServiceToken(env);
  return {
    "content-type": "application/json",
    ...(token ? { "x-vrata-internal-token": token } : {})
  };
}

function isAuthorizedInternalRequest(request: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = getInternalServiceToken(env);
  if (!token) {
    return env.NODE_ENV !== "production";
  }
  const provided = request.headers["x-vrata-internal-token"] ?? request.headers["x-noah-internal-token"];
  return typeof provided === "string" && safeEqual(provided, token);
}

function isAuthorizedRemoteBrowserRequest(request: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const scopedToken = env.REMOTE_BROWSER_INTERNAL_TOKEN?.trim();
  const token = scopedToken || (env.NODE_ENV === "production" ? "" : getInternalServiceToken(env) ?? "");
  if (!token) return false;
  const provided = request.headers["x-vrata-internal-token"] ?? request.headers["x-noah-internal-token"];
  return typeof provided === "string" && safeEqual(provided, token);
}

async function verifyRemoteBrowserAuthority(input: { roomId: string; objectId: string; executorSessionId: string; executorInstanceId: string; mediaParticipantId?: string; frameStreamId?: string }, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const baseUrl = env.ROOM_STATE_INTERNAL_URL?.trim();
  if (!baseUrl) return env.NODE_ENV !== "production";
  try {
    const response = await fetch(new URL("/api/internal/remote-browser/bindings/verify", baseUrl), {
      method: "POST",
      headers: getInternalServiceHeaders(env),
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify(input)
    });
    return response.ok;
  } catch {
    return false;
  }
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

/** Caddy authenticates its client-IP override. Raw forwarded headers never
 * override the transport peer on the publicly reachable direct API port. */
function identityAdmissionOriginHash(request: IncomingMessage): string {
  return hashAdmissionOrigin({ peerAddress: request.socket.remoteAddress,
    proxyAddress: request.headers["x-vrata-client-ip"], proxyToken: request.headers["x-vrata-proxy-auth"],
    proxySecret: process.env.VRATA_IDENTITY_PROXY_TOKEN ?? null, signingSecret: getStateTokenSecret() });
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
    const verifiedV2 = v2SessionsByRequest.get(request);
    if (verifiedV2) {
      return { ok: true, actor: {
        actorType: "room-session", actorId: verifiedV2.identity.participantId,
        role: verifiedV2.role, roleSource: "trusted", tenantId: verifiedV2.room.tenantId,
        roomId: verifiedV2.room.roomId, participantId: verifiedV2.identity.participantId,
        sessionId: verifiedV2.sessionId, permissions: verifiedV2.permissions,
        identityProtocolVersion: 2, identityId: verifiedV2.identity.identityId,
        authEpoch: verifiedV2.identity.authEpoch, isOwner: verifiedV2.isOwner,
        expiresAtSeconds: verifiedV2.expiresAtSeconds
      } };
    }
    const session = verifyRoomSessionToken(bearerToken, getStateTokenSecret());
    if (!session.ok) {
      if (isRotatedDevelopmentSession(bearerToken, getStateTokenSecret())) throw new IdentityBoundaryError(409, "identity_upgrade_required");
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
  if (options.allowHostOwnRoom && actor.identityProtocolVersion === 2 && actor.isOwner === true
    && actor.roleSource === "trusted" && actor.roomId === options.targetRoomId) return true;
  if (!options.allowHostOwnRoom || actor.role !== "host" || actor.roleSource !== "trusted" || !options.targetRoomId || actor.roomId !== options.targetRoomId) {
    return false;
  }
  return actor.identityProtocolVersion === 2 || !options.currentHostParticipantId || actor.participantId === options.currentHostParticipantId;
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

/** Plugin HTTP grants originate only from the explicit administrator secret or
 * MAC-verified RS2 possession. The repository resolves current authority again. */
async function resolveRoomPluginActor(request: IncomingMessage, roomId: string): Promise<RoomPluginAuthorActor> {
  const storage = await storagePromise;
  const provided = getHeaderString(request, "x-vrata-admin-token");
  if (provided !== null) {
    const configured = getControlPlaneAdminToken();
    if (!configured || !safeEqual(provided, configured)) throw new RoomPluginHttpError(401, "identity_required");
    const room = await storage.getRoom(roomId);
    if (!room) throw new RoomPluginHttpError(404, "room_not_found");
    return { actorType: "administrator", scope: { tenantId: room.tenantId, roomId: room.roomId } };
  }
  const token = getBearerToken(request);
  if (!token?.startsWith("rs2.")) throw new RoomPluginHttpError(401, "identity_required");
  const foreignRoom = untrustedSessionRoom(token) !== roomId;
  let verified: VerifiedRoomRequestV2 | null;
  try { verified = await resolveRoomRequestV2({ storage, secret: getStateTokenSecret(), token }); }
  catch (error) {
    if (foreignRoom && error instanceof IdentityBoundaryError && error.reason === "identity_session_expired") {
      throw new IdentityBoundaryError(409, "identity_recovery_required");
    }
    throw error;
  }
  if (!verified) throw new IdentityBoundaryError(409, "identity_recovery_required");
  if (verified.room.roomId !== roomId) throw new RoomPluginHttpError(403, "room_mismatch");
  const { identityId, participantId, authEpoch } = verified.identity;
  return { actorType: "room-session", proof: { tenantId: verified.room.tenantId, roomId: verified.room.roomId,
    identityId, participantId, authEpoch }, expiresAtSeconds: verified.expiresAtSeconds };
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

class InvalidSessionTokenInput extends Error {}

async function verifyRoomSessionRequest(
  request: IncomingMessage,
  input: { roomId: string; participantId?: string; sessionToken?: unknown }
): Promise<RoomSessionTokenVerificationResult> {
  const suppliedToken = input.sessionToken ?? getBearerToken(request);
  if (suppliedToken != null && typeof suppliedToken !== "string") throw new InvalidSessionTokenInput();
  const token = typeof suppliedToken === "string" ? suppliedToken : null;
  if (await legacyIdentityBoundary.minimum() >= 2) {
    // Entry-time metadata may precede a client-controlled body wait. Drop it
    // and resolve MAC, expiry, scope and current epoch/role again before use.
    v2SessionsByRequest.delete(request);
    if (!token) throw new IdentityBoundaryError(426, "identity_upgrade_required");
    if (!token.startsWith("rs2.")) throw new IdentityBoundaryError(409, "identity_upgrade_required");
    const current = await resolveRoomRequestV2({ storage: await storagePromise, secret: getStateTokenSecret(), token,
      expectedRoomId: input.roomId, participantId: input.participantId });
    if (!current || (input.participantId !== undefined && current.identity.participantId !== input.participantId)) {
      throw new IdentityBoundaryError(409, "identity_recovery_required");
    }
    if (token === getBearerToken(request)) v2SessionsByRequest.set(request, current);
    return { ok: true, payload: {
      tenantId: current.room.tenantId, roomId: current.room.roomId, participantId: current.identity.participantId,
      displayName: current.identity.displayName, role: current.role, roleSource: "trusted", permissions: current.permissions,
      sessionId: current.sessionId, iat: 0, exp: current.expiresAtSeconds, jti: current.sessionId,
      identityProtocolVersion: 2, identityId: current.identity.identityId,
      authEpoch: current.identity.authEpoch, isOwner: current.isOwner
    } };
  }
  await legacyIdentityBoundary.assertCompatible(input.roomId);
  const tenantId = await resolveRoomTenantId(input.roomId);
  const secret = getStateTokenSecret();
  const result = verifyRoomSessionToken(token, secret, {
    tenantId,
    roomId: input.roomId,
    participantId: input.participantId
  });
  if (!result.ok && isRotatedDevelopmentSession(token, secret)) throw new IdentityBoundaryError(409, "identity_upgrade_required");
  return result;
}

/** Local token signing can be slow or delayed by the client-controlled body.
 * Ignore the entry-time cache and never release a prepared v2 token after its
 * holder has lost its epoch, role, ownership or room admission. */
async function finalizeRoomToken(request: IncomingMessage,
  session: Extract<RoomSessionTokenVerificationResult, { ok: true }>,
  sessionToken: string | null | undefined, prepare: () => Promise<string>): Promise<string> {
  const proof = session.payload;
  if (proof.identityProtocolVersion !== 2) return prepare();
  if (!proof.identityId || typeof proof.authEpoch !== "number" || !Number.isSafeInteger(proof.authEpoch)
    || proof.authEpoch < 1 || typeof proof.isOwner !== "boolean") {
    throw new IdentityBoundaryError(409, "identity_recovery_required");
  }
  const prepared = await finalizeProofBoundToken({ before: {
    tenantId: proof.tenantId, roomId: proof.roomId, identityId: proof.identityId,
    participantId: proof.participantId, authEpoch: proof.authEpoch, role: proof.role, isOwner: proof.isOwner
  }, prepare, readCurrent: async () => resolveRoomRequestV2({ storage: await storagePromise, secret: getStateTokenSecret(),
    token: sessionToken ?? getBearerToken(request), expectedRoomId: proof.roomId, participantId: proof.participantId }) });
  if (prepared === null) throw new IdentityBoundaryError(409, "identity_recovery_required");
  return prepared;
}

async function runGuardedRoomEffect<T>(storage: Storage, actor: ControlPlaneActor, room: RoomRecord,
  permission: RoomPermission, effect: (scoped: RoomIdentityEffectStorage, current: RoomEffectActor | null) => Promise<T>,
  options: { ownerOnly?: boolean; hostOrOwner?: boolean; roomWrite?: boolean } = {}): Promise<T> {
  if (actor.actorType === "admin-token") {
    let active = true;
    const scoped = createRoomEffectFacade(storage, { roomWrite: true,
      check: () => { if (!active) throw new Error("room_effect_scope_closed"); } });
    try { return await effect(scoped, null); }
    finally { active = false; }
  }
  if (actor.identityProtocolVersion !== 2) return runLegacyRoomEffect(storage, room, options,
    scoped => effect(scoped, null));
  if (!actor.identityId || !actor.participantId || !actor.authEpoch || !actor.expiresAtSeconds) {
    throw new IdentityBoundaryError(409, "identity_recovery_required");
  }
  const guard: RoomEffectGuard = { tenantId: room.tenantId, roomId: room.roomId,
    identityId: actor.identityId, participantId: actor.participantId, authEpoch: actor.authEpoch,
    expiresAtSeconds: actor.expiresAtSeconds, permission, ...options };
  try {
    return await storage.withRoomIdentityEffect(guard, effect);
  } catch (error) {
    if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
    if (error instanceof IdentityStorageError) {
      if (error.code === "identity_session_expired") throw new IdentityBoundaryError(401, "identity_session_expired");
      if (error.code === "identity_forbidden") throw new RoomEffectPermissionDenied("permission_denied");
      throw new IdentityBoundaryError(409, "identity_recovery_required");
    }
    throw error;
  }
}

async function runLegacyRoomEffect<T>(storage: Storage, room: RoomRecord, options: { roomWrite?: boolean },
  effect: (scoped: RoomIdentityEffectStorage) => Promise<T>): Promise<T> {
  try {
    return await storage.withLegacyRoomEffect({ tenantId: room.tenantId, roomId: room.roomId }, options, effect);
  } catch (error) {
    if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
    if (error instanceof IdentityStorageError && error.code === "room_not_found") throw new RoomEffectNotFound("room_not_found");
    throw error;
  }
}

/** Floor-1 effect for an unpersisted room id: telemetry writes or a synchronous
 * release. Credential release additionally pins absence against room creation. */
async function runLegacyVirtualRoomEffect<T>(storage: Storage, roomId: string, options: { roomWrite?: boolean; expiresAtSeconds?: number; pinAbsence?: boolean },
  effect: (scoped: VirtualRoomEffectStorage) => Promise<T>): Promise<T> {
  try {
    return await storage.withLegacyVirtualRoomEffect(roomId, options, effect);
  } catch (error) {
    if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
    throw error;
  }
}

/** The five virtual-data path groups fall back to a virtual room. Their segments are
 * decoded and the room id bounded before any session, boundary or room lookup; an id
 * that namespace can never hold is the same public 404 as an absent room. */
const virtualDataPath = /^\/api\/rooms\/([^/]+)\/(?:manifest|diagnostics|(?:presence|xr-telemetry)(?:\/([^/]+))?)$/;
function assertVirtualDataPath(pathname: string): void {
  const match = virtualDataPath.exec(pathname);
  if (!match) return;
  let roomId: string;
  try {
    roomId = decodeURIComponent(match[1]);
    if (match[2] !== undefined) decodeURIComponent(match[2]);
  } catch { throw new InvalidVirtualRoomId(); }
  assertVirtualRoomId(roomId);
}

async function releaseRoomRead(request: IncomingMessage, storage: Storage, roomId: string, room: RoomRecord | null, send: () => void): Promise<void> {
  const actor = resolveControlPlaneActor(request);
  // A missing-room fallback contains no persisted room data. Only the administrator bypasses its fence.
  if (!room) {
    if (actor.ok && actor.actor.actorType === "admin-token") { send(); return; }
    if (actor.ok && actor.actor.identityProtocolVersion === 2) throw new RoomEffectNotFound("room_not_found");
    // Floor 1 and absence are observed before the one synchronous release.
    await runLegacyVirtualRoomEffect(storage, roomId, {}, async scoped => { scoped.releaseResponse(send); });
    return;
  }
  if (actor.ok) await runGuardedRoomEffect(storage, actor.actor, room, "room.join", async scoped => { scoped.releaseResponse(send); });
  else await runLegacyRoomEffect(storage, room, {}, async scoped => { scoped.releaseResponse(send); });
}

/** Virtual issuance pins absence through the one synchronous sign-and-release.
 * The pin is read-only, so a COMMIT or connection failure after a successful send
 * cannot revoke the released token: count it and let the queued reply finish.
 * Anything before or during send keeps its original error. */
async function releaseVirtualStateToken(storage: Storage, roomId: string, send: () => void): Promise<void> {
  let released = false;
  try {
    await runLegacyVirtualRoomEffect(storage, roomId, { pinAbsence: true }, async scoped => {
      scoped.releaseResponse(() => { send(); released = true; });
    });
  } catch (error) {
    if (!released) throw error;
    metrics.virtualStateReleaseCompletionFailuresTotal += 1;
  }
}

/** Every persisted-room floor-1 credential reply: one read-only fenced snapshot, one synchronous
 * send. As with virtual issuance, a COMMIT or connection failure after a successful send cannot
 * revoke the released reply: count it and let the queued reply finish. Anything before or during
 * send keeps its mapped error. */
async function releaseLegacyStateToken(storage: Storage, selector: LegacyRoomCredentialSelector,
  send: (fresh: LegacyRoomCredentialSnapshot) => undefined): Promise<void> {
  const captured: LegacyRoomCredentialSelector = Object.freeze({ tenantId: selector.tenantId, roomId: selector.roomId,
    participantId: selector.participantId, inviteTokenHash: selector.inviteTokenHash });
  let released = false;
  try {
    await storage.releaseLegacyRoomCredential(captured, {}, fresh => { send(fresh); released = true; return undefined; });
  } catch (error) {
    if (released) { metrics.legacyStateReleaseCompletionFailuresTotal += 1; return; }
    if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
    if (error instanceof IdentityStorageError && error.code === "room_not_found") throw new RoomEffectNotFound("room_not_found");
    throw error;
  }
}

async function releaseLegacyPersonalRoom(request: IncomingMessage, response: ServerResponse, storage: Storage,
  room: RoomRecord, participantId: string, created: boolean): Promise<void> {
  const prepared = { created, room: roomResponseRecord(request, room), roomLink: createRoomLink(room.roomId, request),
    manifest: await buildManifest(room.roomId, request, room) };
  await runLegacyRoomEffect(storage, room, {}, async scoped => {
    const current = await scoped.getRoom(room.roomId);
    if (!current || current.tenantId !== room.tenantId || current.roomType !== "personal" || current.ownerParticipantId !== participantId) {
      scoped.releaseResponse(() => { json(response, 404, { error: "room_not_found" }); });
      return;
    }
    if (isRoomDisabled(current)) {
      scoped.releaseResponse(() => {
        incrementCounter(metrics.personalRoomOpensTotal, "disabled");
        json(response, 403, { error: "room_access_denied", reason: "room_disabled", roomId: room.roomId });
      });
      return;
    }
    scoped.releaseResponse(() => {
      incrementCounter(metrics.personalRoomOpensTotal, created ? "created" : "existing");
      json(response, created ? 201 : 200, prepared);
    });
  });
}

async function releaseRoomNotes(request: IncomingMessage, storage: Storage, actor: ControlPlaneActor, room: RoomRecord,
  scope: RoomNoteScope, action: "notes.read" | "notes.versions" | "notes.export", send: () => void): Promise<void> {
  await releaseFencedResponse({ send,
    run: release => runGuardedRoomEffect(storage, actor, room, "notes.view", async scoped => { scoped.releaseResponse(release); }),
    onReleased: () => {
      if (actor.identityProtocolVersion === 2) writeRoomNotesAudit({ request, action, roomId: room.roomId, scope, result: "allowed", actor });
    },
    onDenied: error => {
      if (actor.identityProtocolVersion === 2 && (error instanceof RoomEffectPermissionDenied || error instanceof IdentityBoundaryError)) {
        writeRoomNotesAudit({ request, action, roomId: room.roomId, scope,
          result: "denied", reason: error instanceof RoomEffectPermissionDenied ? "permission_denied" : error.reason, actor });
      }
    }
  });
}

async function releaseDocumentBytes(storage: Storage, actor: ControlPlaneActor, room: RoomRecord,
  document: RoomDocumentRecord, permission: RoomPermission, activeSurfaceRequired: boolean, send: () => void): Promise<boolean> {
  return runGuardedRoomEffect(storage, actor, room, permission, async scoped => {
    if (actor.identityProtocolVersion === 2) {
      const current = await scoped.getRoomDocument(room.roomId, document.documentId);
      if (!current || current.deletedAt || current.storageKey !== document.storageKey
        || activeSurfaceRequired && (!current.linkedSurfaceId || current.linkedSurfaceId !== document.linkedSurfaceId
          || current.metadata?.kind !== document.metadata?.kind)) return false;
    }
    scoped.releaseResponse(send);
    return true;
  });
}

function isPrivateRoom(room: RoomRecord): boolean {
  return isRoomAccessPolicyEnabled() && sanitizeRoomVisibility(room.visibility) === "private";
}

function createPersonalRoomId(participantId: string): string {
  return `personal-${sha256Hex(participantId).slice(0, 16)}`;
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
    updatedBy: null,
    deletedAt: null,
    deletedBy: null
  };
}

function writeRoomNotesAudit(input: {
  request: IncomingMessage;
  action: "notes.read" | "notes.save" | "notes.versions" | "notes.restore" | "notes.delete" | "notes.export";
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

function noteWritePermission(scope: RoomNoteScope): "notes.view" | "notes.edit" {
  return scope === "private" ? "notes.view" : "notes.edit";
}

function resolveRoomNoteOwner(scope: RoomNoteScope, actor: ControlPlaneActor, url: URL): string | null {
  if (scope === "shared") return null;
  if (actor.actorType === "room-session") return actor.participantId ?? null;
  return url.searchParams.get("participantId")?.trim() || null;
}

function resolveRoomNotesActor(
  request: IncomingMessage,
  response: ServerResponse,
  input: { room: RoomRecord; scope: RoomNoteScope; permission: "notes.view" | "notes.edit"; action: Parameters<typeof writeRoomNotesAudit>[0]["action"] }
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

  if (actor.identityProtocolVersion !== 2 || !["notes.read", "notes.versions", "notes.export"].includes(input.action)) {
    writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "allowed", actor });
  }
  return actor;
}

function resolveAuthorizedRoomNoteOwner(request: IncomingMessage, response: ServerResponse, input: { roomId: string; scope: RoomNoteScope; actor: ControlPlaneActor; url: URL; permission: "notes.view" | "notes.edit"; action: Parameters<typeof writeRoomNotesAudit>[0]["action"] }): string | null | undefined {
  const requestedOwnerParticipantId = input.scope === "private" ? input.url.searchParams.get("participantId")?.trim() || null : null;
  if (input.scope === "private" && input.actor.actorType === "room-session" && requestedOwnerParticipantId && requestedOwnerParticipantId !== input.actor.participantId) {
    metrics.notesPermissionDeniedTotal += 1;
    if (input.action === "notes.export") metrics.notesExportDeniedTotal += 1;
    writeRoomNotesAudit({ request, action: input.action, roomId: input.roomId, scope: input.scope, result: "denied", reason: "note_owner_mismatch", actor: input.actor });
    json(response, 403, { error: "forbidden", reason: "note_owner_mismatch", permission: input.permission, requestId: getRequestId(request) });
    return undefined;
  }
  const ownerParticipantId = resolveRoomNoteOwner(input.scope, input.actor, input.url);
  if (input.scope === "private" && !ownerParticipantId) {
    incrementCounter(metrics.notesSaveFailuresTotal, "missing_private_note_owner");
    json(response, 400, { error: "missing_private_note_owner" });
    return undefined;
  }
  return ownerParticipantId;
}

function roomNoteVisibleToActor(note: RoomNoteRecord, actor: ControlPlaneActor): boolean {
  if (note.scope === "shared") return true;
  if (actor.actorType === "admin-token") return true;
  return note.ownerParticipantId === actor.participantId;
}

/** Room metadata is visible to invitees; owner-only state has a separate
 * authority-fenced endpoint and must never hitchhike in a generic room DTO. */
function roomResponseRecord(request: IncomingMessage, room: RoomRecord): RoomRecord | Omit<RoomRecord, "personalState"> {
  const actor = resolveControlPlaneActor(request);
  const record = { ...room };
  Reflect.deleteProperty(record, "currentOwnerParticipantId");
  if (actor.ok && actor.actor.actorType === "admin-token") return record;
  const { personalState: _privateState, ...metadata } = record;
  return metadata;
}

function writeRoomDocumentsAudit(input: {
  request: IncomingMessage;
  action: "documents.list" | "documents.upload" | "documents.download" | "documents.presentation" | "documents.delete" | "documents.select-surface";
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
  input: { room: RoomRecord; permission: "surface.view" | "document.view" | "document.download" | "document.upload" | "document.present" | "document.delete"; action: Parameters<typeof writeRoomDocumentsAudit>[0]["action"]; documentId?: string }
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
  const effectiveRole = actor.actorType === "room-session"
    ? actor.identityProtocolVersion === 2 ? actor.role
      : resolveEffectiveRoomRole(input.room, actor.participantId ?? actor.actorId, actor.role)
    : actor.role;
  if (!hasRoomPermission(getRoomPermissions(effectiveRole), input.permission)) {
    return deny("permission_denied");
  }

  writeRoomDocumentsAudit({ request, action: input.action, roomId: input.room.roomId, documentId: input.documentId, result: "allowed", actor });
  return actor;
}

async function inspectPdfDocument(data: Buffer): Promise<RoomDocumentMetadata> {
  if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("corrupt_pdf");
  }
  try {
    const pdf = await PDFDocument.load(new Uint8Array(data), { ignoreEncryption: true, updateMetadata: false });
    if (pdf.isEncrypted) {
      throw new Error("encrypted_pdf_unsupported");
    }
    const pageCount = pdf.getPageCount();
    const maxPages = Number.parseInt(process.env.PDF_PRESENTATION_MAX_PAGES ?? "250", 10);
    if (pageCount < 1) {
      throw new Error("corrupt_pdf");
    }
    if (pageCount > maxPages) {
      throw new Error("pdf_page_limit_exceeded");
    }
    const firstPage = pdf.getPage(0).getSize();
    return {
      kind: "pdf",
      pageCount,
      title: pdf.getTitle()?.slice(0, 300) ?? null,
      author: pdf.getAuthor()?.slice(0, 300) ?? null,
      firstPageWidthPt: Number(firstPage.width.toFixed(2)),
      firstPageHeightPt: Number(firstPage.height.toFixed(2))
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "corrupt_pdf";
    if (message === "encrypted_pdf_unsupported" || message === "pdf_page_limit_exceeded" || message === "corrupt_pdf") {
      throw error;
    }
    throw new Error("corrupt_pdf");
  }
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
    metadata: document.metadata ?? {},
    uploadedBy: document.uploadedBy ?? null,
    uploadedAt: document.uploadedAt,
    linkedSurfaceId: document.linkedSurfaceId ?? null,
    downloadUrl: `/api/rooms/${encodeURIComponent(document.roomId)}/documents/${encodeURIComponent(document.documentId)}/download`,
    presentationUrl: document.metadata?.kind === "pdf"
      ? `/api/rooms/${encodeURIComponent(document.roomId)}/documents/${encodeURIComponent(document.documentId)}/presentation`
      : null,
    contentUrl: document.metadata?.kind === "image" || document.metadata?.kind === "video"
      ? `/api/rooms/${encodeURIComponent(document.roomId)}/documents/${encodeURIComponent(document.documentId)}/content`
      : null
  };
}

function normalizeDocumentSurfaceId(input: unknown): string | null | undefined {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : undefined;
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

function incrementPresenterChangeMetric(action: "grant" | "revoke", result: "allowed" | "denied"): void {
  incrementCounter(metrics.presenterChangesTotal, `${action}:${result}`);
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
  sceneMediaSurfaces?: RoomSessionTokenPayload["sceneMediaSurfaces"];
  /** The request's captured signing secret; when omitted the current one is read. */
  secret?: string;
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
  const roomTemplate = roomTemplateSessionContext(input.room);
  const payload: RoomAccessTokenPayload = {
    ...(input.sceneMediaSurfaces === undefined ? {} : { sceneMediaSurfaces: input.sceneMediaSurfaces }),
    ...(roomTemplate ? { roomTemplate } : {}),
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
    token: input.secret === undefined ? encodeAccessToken(payload) : signRoomSessionToken(payload, input.secret),
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

interface LegacyStateTokenClaims {
  roomId: string;
  explicitParticipantId: string | null;
  displayName: string | null;
  inviteToken: string | null;
  requestedRole: unknown;
}

/** Validate floor-1 input before room/binding lookups. Identity stays null until the virtual
 * path mints it or the persisted path normalizes it against the captured bearer. */
function parseLegacyStateTokenRequest(payload: unknown): LegacyStateTokenClaims | null {
  const body = payload ?? {};
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as StateTokenRequest;
  const roomId = input.roomId ?? "demo-room";
  assertVirtualRoomId(roomId);
  const explicitParticipantId = input.participantId ?? null;
  if (explicitParticipantId !== null && !validId(explicitParticipantId)) return null;
  const displayName = input.displayName ?? null;
  if (displayName !== null && typeof displayName !== "string") return null;
  return { roomId, explicitParticipantId, displayName, inviteToken: parseInviteToken(input.inviteToken),
    requestedRole: input.requestedRole ?? input.role };
}

/** Initial pool snapshot outside any fence: the stored room, this room's exact-hash invite
 * only, and that invite's waiting record for this participant. */
async function loadLegacyAdmissionSnapshot(storage: Storage, room: RoomRecord, participantId: string,
  inviteTokenHash: string | null): Promise<LegacyAdmissionSnapshot> {
  const found = inviteTokenHash === null ? null : await storage.getRoomInviteByTokenHash(inviteTokenHash);
  const invite = found && found.roomId === room.roomId && found.tokenHash === inviteTokenHash ? found : null;
  const waiting = invite ? await storage.getWaitingRoomRequestForInviteParticipant(invite.inviteId, participantId) : null;
  return { room, invite, waiting: waiting && waiting.roomId === room.roomId ? waiting : null };
}

/** The original bounded denial sinks, keyed by stable reason; never a bearer, invite token or hash. */
function recordLegacyStateDenial(request: IncomingMessage, room: RoomRecord, invite: RoomInviteRecord | null,
  participantId: string, reason: string, inviteId: string | undefined, proofSubject: boolean): void {
  incrementCounter(metrics.roomAccessDeniedTotal, reason);
  if (reason === "room_disabled" || reason === "waiting_room_pending") return;
  const personal = isPersonalRoom(room);
  if (inviteId !== undefined || reason === "invite_required") {
    const audited = inviteId !== undefined && invite && invite.inviteId === inviteId ? invite : undefined;
    writeInviteUseAudit({ request, roomId: room.roomId, invite: audited, result: "denied", reason, participantId });
    if (personal) incrementCounter(metrics.personalRoomAccessDeniedTotal, reason);
  } else if (personal && !proofSubject) {
    // A lifecycle block outside the invite path: only the personal-owner path counted it.
    incrementCounter(metrics.personalRoomAccessDeniedTotal, reason);
  }
}

function recordLegacyStateAdmission(request: IncomingMessage, room: RoomRecord, invite: RoomInviteRecord | null,
  decision: LegacyAdmissionDecision): void {
  const { source } = decision;
  if (source.kind === "invite" || source.kind === "waiting_approved") {
    writeInviteUseAudit({ request, roomId: room.roomId, invite: invite && invite.inviteId === source.inviteId ? invite : undefined,
      result: "allowed", participantId: decision.participantId });
    if (isPersonalRoom(room)) incrementCounter(metrics.personalRoomOpensTotal, "invite");
  } else if (source.kind === "personal_owner") incrementCounter(metrics.personalRoomOpensTotal, "owner");
}

/** Same body the request handler writes for IdentityBoundaryError(409, "room_state_changed"). */
function writeRoomStateChanged(response: ServerResponse): void {
  json(response, 409, { error: "room_state_changed", reason: "room_state_changed" });
}

function writeLegacyBearerError(response: ServerResponse, bearer: Exclude<LegacyBearerClass, { kind: "valid" }>): void {
  if (bearer.kind === "rotated_dev") return json(response, 409, { error: "identity_required", reason: "identity_upgrade_required" });
  writeSessionTokenError(response, bearer.kind === "absent" ? { ok: false, code: "missing_token" } : bearer.result);
}

function legacySessionControlBody(room: RoomRecord, participantId: string, role: RoomRole, reason: string | null) {
  return {
    state: sanitizeSessionControlState(room.sessionControl),
    participant: { participantId, role, permissions: getRoomPermissions(role), status: reason ? "blocked" : "active", reason }
  };
}

/** Floor-1 persisted-room state token. Flags, secret and bearer are captured once; the pure
 * evaluator admits on a pool snapshot and the read-only release re-admits on a fresh one.
 * The host claim and a new pending request stay unfenced writes ahead of that release. */
async function admitLegacyStateToken(request: IncomingMessage, response: ServerResponse, storage: Storage, room: RoomRecord,
  claims: LegacyStateTokenClaims, requested: { role: RoomRole; roleSource: RoomSessionRoleSource }, ttlSeconds: number,
  requestId: string): Promise<void> {
  const ctx: LegacyAdmissionContext = Object.freeze({ rawBearer: getBearerToken(request), secret: getStateTokenSecret(),
    nowMs: Date.now(), accessPolicyEnabled: isRoomAccessPolicyEnabled(), hostControlsEnabled: isHostControlsEnabled() });
  const bearer = classifyLegacyBearer(ctx, room, claims.explicitParticipantId);
  const participantId = normalizeLegacyParticipant(claims.explicitParticipantId, bearer, randomUUID);
  const displayName = claims.displayName ?? participantId;
  const admission: LegacyAdmissionRequest = Object.freeze({ mode: "admit", requestId,
    explicitParticipantId: claims.explicitParticipantId, participantId, displayName, requested: Object.freeze({ ...requested }),
    inviteTokenHash: claims.inviteToken === null ? null : hashInviteTokenWithSecret(claims.inviteToken, ctx.secret) });
  // A valid scoped proof is always the subject's own; only it skips the owner-path counter.
  const proofSubject = bearer.kind === "valid";
  const snapshot = await loadLegacyAdmissionSnapshot(storage, room, participantId, admission.inviteTokenHash);
  const initial = evaluateLegacyAdmission(admission, snapshot, ctx);
  if (initial.kind === "session") return writeSessionTokenError(response, initial.result);
  if (initial.kind === "upgrade_required") throw new IdentityBoundaryError(409, "identity_upgrade_required");
  if (initial.kind === "deny") {
    recordLegacyStateDenial(request, room, snapshot.invite, participantId, initial.reason, initial.inviteId, proofSubject);
    return json(response, 403, { error: "room_access_denied", reason: initial.reason, accessRequestId: initial.accessRequestId, requestId });
  }
  if (initial.kind === "waiting") {
    // Deferred unfenced write; a pending request carries no credential.
    const accessRequestId = initial.requestId ?? (await storage.createWaitingRoomRequest({
      roomId: room.roomId, inviteId: initial.inviteId, participantId, displayName })).requestId;
    incrementCounter(metrics.roomAccessDeniedTotal, "waiting_room_pending");
    return json(response, 202, { error: "room_access_denied", reason: "waiting_room_pending", accessRequestId, requestId });
  }
  const { decision } = initial;
  const control = defaultSessionControlState(room.sessionControl);
  if (decision.role === "host" && decision.roleSource === "trusted" && !control.hostParticipantId) {
    // Deferred unfenced claim; the release below still re-admits on a fresh snapshot.
    await updateRoomSessionControl(storage, room, { ...control, hostParticipantId: participantId });
  }
  // Prepared from the frozen binding through the shared cache outside the fence; confirmation rejects any binding drift.
  const prepared = decision.binding.contentHash === null ? await legacySceneMediaSurfaces.resolve(decision.binding.sceneBundleUrl,
    `http://127.0.0.1:${request.socket.localPort ?? process.env.API_PORT ?? "4000"}`) : undefined;
  const preparedSurfaces = prepared?.kind === "loaded" ? prepared.surfaces : undefined;
  // A cold admission keeps the no-surface fallback; a bearer renewal never signs over an unproven manifest.
  const unavailable = prepared?.kind === "failed" && decision.source.kind === "bearer";
  let verdict = undefined as { confirmation: LegacyAdmissionConfirmation; fresh: LegacyRoomCredentialSnapshot } | undefined;
  await releaseLegacyStateToken(storage, { tenantId: room.tenantId, roomId: room.roomId, participantId,
    inviteTokenHash: admission.inviteTokenHash }, fresh => {
    const finalCtx: LegacyAdmissionContext = Object.freeze({ ...ctx, nowMs: Date.now() });
    const confirmation = confirmLegacyAdmission(decision, admission, fresh, finalCtx);
    // Only after a confirmed admission: no token and no sinks; the caller keeps its credential and retries.
    if (confirmation.ok && unavailable) { json(response, 503, { error: "scene_media_surfaces_unavailable" }); return undefined; }
    if (confirmation.ok) {
      json(response, 200, createRoomAccessTokenResponse({ room: confirmation.room, roomId: room.roomId, participantId, displayName,
        role: confirmation.role, roleSource: confirmation.roleSource, sceneMediaSurfaces: confirmation.templateContext?.surfaces ?? preparedSurfaces,
        ttlSeconds, nowSeconds: Math.floor(finalCtx.nowMs / 1000), secret: ctx.secret }));
    } else if (confirmation.kind === "deny") {
      json(response, confirmation.status, { error: "room_access_denied", reason: confirmation.reason,
        accessRequestId: confirmation.accessRequestId, requestId });
    } else if (confirmation.kind === "session") writeSessionTokenError(response, confirmation.result);
    else writeRoomStateChanged(response);
    verdict = { confirmation, fresh };
    return undefined;
  });
  // Sinks follow the settled release and reflect only what was actually sent.
  if (!verdict) return;
  const { confirmation, fresh } = verdict;
  if (confirmation.ok) recordLegacyStateAdmission(request, fresh.room, fresh.invite, decision);
  else if (confirmation.kind === "deny") {
    recordLegacyStateDenial(request, fresh.room, fresh.invite, participantId, confirmation.reason, confirmation.inviteId, proofSubject);
  }
}

/** Floor-1 room-session read. Every reply for a valid scoped proof, with or without a renewed token, is
 * released from a read-only fenced snapshot; only a positive initial admission prepares surfaces, outside it.
 * Claims come from the captured MAC-verified bearer, never the request; any other bearer is its codec
 * refusal before any snapshot or fence. */
async function releaseLegacySessionControl(request: IncomingMessage, response: ServerResponse, storage: Storage,
  room: RoomRecord, requestId: string): Promise<void> {
  const ctx: LegacyAdmissionContext = Object.freeze({ rawBearer: getBearerToken(request), secret: getStateTokenSecret(),
    nowMs: Date.now(), accessPolicyEnabled: isRoomAccessPolicyEnabled(), hostControlsEnabled: isHostControlsEnabled() });
  const bearer = classifyLegacyBearer(ctx, room, null);
  if (bearer.kind !== "valid") return writeLegacyBearerError(response, bearer);
  const subject = bearer.payload;
  const { participantId } = subject;
  const admission: LegacyAdmissionRequest = Object.freeze({ mode: "renew", requestId, explicitParticipantId: null, participantId,
    displayName: subject.displayName,
    requested: Object.freeze({ role: subject.role, roleSource: subject.roleSource ?? "trusted" }), inviteTokenHash: null });
  const initial = evaluateLegacyAdmission(admission, { room, invite: null, waiting: null }, ctx);
  const ttlSeconds = Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10);
  const prepared = initial.kind === "admit" && initial.decision.binding.contentHash === null
    ? await legacySceneMediaSurfaces.resolve(initial.decision.binding.sceneBundleUrl,
      `http://127.0.0.1:${request.socket.localPort ?? process.env.API_PORT ?? "4000"}`) : undefined;
  const preparedSurfaces = prepared?.kind === "loaded" ? prepared.surfaces : undefined;
  await releaseLegacyStateToken(storage, { tenantId: room.tenantId, roomId: room.roomId, participantId, inviteTokenHash: null }, fresh => {
    const finalCtx: LegacyAdmissionContext = Object.freeze({ ...ctx, nowMs: Date.now() });
    // Expiry, MAC and scope first: a stale proof never observes fresh state.
    const current = classifyLegacyBearer(finalCtx, fresh.room, null);
    if (current.kind !== "valid") { writeLegacyBearerError(response, current); return undefined; }
    const blocked = (reason: string) => json(response, 200, legacySessionControlBody(fresh.room, participantId,
      resolveEffectiveRoomRole(fresh.room, participantId, current.payload.role), reason));
    if (initial.kind === "admit") {
      const confirmation = confirmLegacyAdmission(initial.decision, admission, fresh, finalCtx);
      // Renew admits only the bearer source, so a failed load is strict: no token, the old credential stays.
      if (confirmation.ok && prepared?.kind === "failed") json(response, 503, { error: "scene_media_surfaces_unavailable" });
      else if (confirmation.ok) {
        const { source } = initial.decision;
        const renewed = createRoomAccessTokenResponse({ room: confirmation.room, roomId: room.roomId, participantId,
          displayName: initial.decision.displayName, role: confirmation.role, roleSource: confirmation.roleSource,
          sessionId: source.kind === "bearer" ? source.sessionId : undefined,
          sceneMediaSurfaces: confirmation.templateContext?.surfaces ?? preparedSurfaces, ttlSeconds,
          nowSeconds: Math.floor(finalCtx.nowMs / 1000), secret: ctx.secret });
        json(response, 200, { ...legacySessionControlBody(confirmation.room, participantId, confirmation.role, null),
          token: renewed.token, expiresInSeconds: renewed.expiresInSeconds, access: renewed.access,
          role: renewed.role, permissions: renewed.permissions });
      } else if (confirmation.kind === "deny") blocked(confirmation.reason);
      else if (confirmation.kind === "session") writeSessionTokenError(response, confirmation.result);
      else writeRoomStateChanged(response);
      return undefined;
    }
    const next = evaluateLegacyAdmission(admission, fresh, finalCtx);
    if (next.kind === "deny") blocked(next.reason);
    else if (next.kind === "session") writeSessionTokenError(response, next.result);
    // A fresh admission after an initial denial is never widened to a token: the client retries.
    else writeRoomStateChanged(response);
    return undefined;
  });
}

function sanitizeSceneBundleId(value: string | undefined, fallback: string): string | null {
  const candidate = (value ?? fallback).trim();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : null;
}

function sanitizeSceneBundleVersion(value: string | undefined): string | null {
  const candidate = (value ?? "v1").trim();
  return /^[a-zA-Z0-9._-]{1,64}$/.test(candidate) ? candidate : null;
}

function publicBaseUrlFromRequest(request: IncomingMessage): string {
  const url = new URL(createRoomLink("__scene_bundle_upload__", request));
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

const { getSceneBundleUploadStorage, getDocumentUploadStorage } = createUploadStorageConfig(runtimePublicRoot, publicBaseUrlFromRequest);

async function cleanupDocumentMediaObjects(roomId: string, documentId: string): Promise<void> {
  const baseUrl = process.env.ROOM_STATE_INTERNAL_URL?.trim();
  if (!baseUrl) {
    return;
  }
  const response = await fetch(new URL(`/api/internal/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(documentId)}/media-objects`, baseUrl), {
    method: "DELETE",
    headers: getInternalServiceHeaders()
  });
  if (!response.ok) {
    throw new Error(`presentation_cleanup_failed:${response.status}`);
  }
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
  // Before storage, plugin, session, boundary or room lookups; preflight keeps its CORS response.
  if (method !== "OPTIONS") assertVirtualDataPath(url.pathname);
  const storage = await storagePromise;

  // This optional protocol family owns its admission/response boundary. At
  // floor 1 it denies before legacy actors, artifact buffering or blob IO.
  if (method !== "OPTIONS" && await handleRoomPluginHttp(request, response, url, {
    storage, getBlobs: () => configuredRoomPluginBlobStorage(runtimePublicRoot, request, publicBaseUrlFromRequest),
    resolveActor: resolveRoomPluginActor
  })) return;

  // Only v2 Bearers defer classification to handlers with body-bound identity.
  // Legacy Bearers still hit the activation boundary before payload validation.
  const bodyTokenRoute = method === "POST" && ["/api/tokens/media", "/api/tokens/remote-browser-frame"].includes(url.pathname);
  const bearer = getBearerToken(request);
  const diagnosticRoom = method === "POST" ? /^\/api\/rooms\/([^/]+)\/diagnostics$/.exec(url.pathname)?.[1] : undefined;
  // For a foreign URL room, retain valid-session 403 / expired-session 409 at
  // entry. This decoded lookup hint never supplies authentication metadata.
  const deferV2Body = !!bearer?.startsWith("rs2.") && (bodyTokenRoute
    || !!diagnosticRoom && decodeURIComponent(diagnosticRoom) === untrustedSessionRoom(bearer));
  const bodySessionRoute = bodyTokenRoute && !bearer || deferV2Body;
  if (bearer?.startsWith("rs2.")) {
    if (await legacyIdentityBoundary.minimum() < 2) throw new IdentityBoundaryError(426, "identity_upgrade_required");
    if (!deferV2Body) {
      const pathRoom = /^\/api\/rooms\/([^/]+)/.exec(url.pathname)?.[1];
      const pathParticipant = method === "PUT"
        ? /^\/api\/rooms\/[^/]+\/(?:presence|xr-telemetry)\/([^/]+)$/.exec(url.pathname)?.[1]
        : method === "DELETE" ? /^\/api\/rooms\/[^/]+\/presence\/([^/]+)$/.exec(url.pathname)?.[1] : undefined;
      const foreignRoom = !!pathRoom && decodeURIComponent(pathRoom) !== untrustedSessionRoom(bearer);
      let verified: VerifiedRoomRequestV2 | null;
      try {
        verified = await resolveRoomRequestV2({ storage, secret: getStateTokenSecret(), token: bearer,
          participantId: !foreignRoom && pathParticipant ? decodeURIComponent(pathParticipant) : undefined });
      } catch (error) {
        // The decoded room is only a denial hint. Preserve valid-session 403,
        // but never suggest renewable expiry for a foreign-room request.
        if (error instanceof IdentityBoundaryError && error.reason === "identity_session_expired" && foreignRoom) {
          throw new IdentityBoundaryError(409, "identity_recovery_required");
        }
        throw error;
      }
      if (!verified) throw new IdentityBoundaryError(409, "identity_recovery_required");
      if (pathRoom && decodeURIComponent(pathRoom) !== verified.room.roomId) {
        return json(response, 403, { error: "forbidden", reason: "room_mismatch" });
      }
      v2SessionsByRequest.set(request, verified);
    }
  }

  if (legacyBoundaryApplies(method, url.pathname)) {
    const actor = resolveControlPlaneActor(request);
    const administrator = actor.ok && actor.actor.actorType === "admin-token";
    const verifiedV2 = v2SessionsByRequest.has(request);
    const publicListing = method === "GET" && url.pathname === "/api/rooms";
    if (!publicListing && !bodySessionRoute && !verifiedV2 && (!administrator || !legacyBoundaryAllowsAdministrator(url.pathname))) {
      const scopedRoom = /^\/api\/rooms\/([^/]+)/.exec(url.pathname)?.[1];
      const roomId = scopedRoom ? decodeURIComponent(scopedRoom)
        : actor.ok && actor.actor.actorType === "room-session" ? actor.actor.roomId : undefined;
      await legacyIdentityBoundary.assertCompatible(roomId);
    }
  }

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
    const identityProtocolVersion = await legacyIdentityBoundary.minimum() >= 2 ? 2 : null;
    json(response, 200, {
      status: "ok",
      service: "api",
      env: process.env.NODE_ENV ?? "development",
      port: apiPort,
      timestamp: new Date().toISOString(),
      features: {
        ...(identityProtocolVersion ? { identityProtocolVersion } : {}),
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
        remoteBrowserEnabled: isRemoteBrowserFeatureEnabled(),
        remoteBrowserExperimental: true,
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

  if (method === "GET" && url.pathname === "/plugin-sandbox-probe.html") {
    const served = await serveStatic(response, join(runtimeStaticRoot, "plugin-sandbox-probe.html"));
    if (!served) json(response, 503, { error: "plugin_sandbox_probe_build_missing" });
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

  if (method === "GET" && url.pathname === "/api/internal/identity-policy") {
    if (!isAuthorizedInternalRequest(request)) return json(response, 403, { error: "forbidden" });
    const minimumProtocolVersion = await legacyIdentityBoundary.minimum();
    const roomId = url.searchParams.get("roomId");
    const roomRequiresV2 = roomId ? await storage.hasRoomIdentityAuthority(roomId) : false;
    return json(response, 200, { minimumProtocolVersion, roomRequiresV2 });
  }

  if (method === "POST" && url.pathname === "/api/internal/identity-session/verify") {
    if (!isAuthorizedInternalRequest(request)) return json(response, 403, { error: "forbidden" });
    const payload = await parseBody<{ roomId?: unknown; participantId?: unknown; sessionToken?: unknown; includeSceneContext?: unknown }>(request);
    if (typeof payload?.roomId !== "string" || typeof payload?.participantId !== "string"
      || typeof payload?.sessionToken !== "string" || payload.sessionToken.length > 4096) {
      return json(response, 400, { error: "invalid_identity_session_request" });
    }
    if (await legacyIdentityBoundary.minimum() < 2) return json(response, 409, { error: "identity_required", reason: "identity_upgrade_required" });
    const room = await storage.getRoom(payload.roomId);
    if (!room) return json(response, 401, { error: "identity_required", reason: "identity_recovery_required" });
    const session = await resolveRoomRequestV2({ storage, secret: getStateTokenSecret(), token: payload.sessionToken,
      expectedRoomId: payload.roomId, participantId: payload.participantId });
    if (!session || session.identity.participantId !== payload.participantId) {
      return json(response, 401, { error: "identity_required", reason: "identity_recovery_required" });
    }
    const context = payload.includeSceneContext === true ? roomTemplateSessionContext(room) : null;
    return json(response, 200, {
      tenantId: room.tenantId, roomId: room.roomId, identityId: session.identity.identityId,
      participantId: session.identity.participantId, displayName: session.identity.displayName,
      authEpoch: session.identity.authEpoch, sessionId: session.sessionId,
      expiresAtSeconds: session.expiresAtSeconds, authorityRevision: session.authority.revision,
      role: session.role, permissions: session.permissions,
      ...(payload.includeSceneContext === true ? {
        sceneMediaSurfaces: context?.surfaces
          ?? await loadSceneMediaSurfaces(room.sceneBundleUrl, `http://127.0.0.1:${request.socket.localPort ?? process.env.API_PORT ?? "4000"}`),
        ...(context ? { roomTemplate: context } : {})
      } : {})
    });
  }

  if (method === "GET" && url.pathname === "/api/templates") {
    json(response, 200, { items: await listRoomTemplateMetadata(storage) });
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
    json(response, 200, { items: rooms.map((room) => ({ ...roomResponseRecord(request, room), roomLink: createRoomLink(room.roomId, request) })) });
    return;
  }

  if (method === "GET" && url.pathname === "/api/control-plane/session") {
    const actor = await requireControlPlanePermission(request, response, { permission: "dashboard.read", action: "admin.dashboard.view", objectType: "dashboard", objectId: "control-plane" });
    if (!actor) return;
    const minimumIdentityProtocol = await legacyIdentityBoundary.minimum();
    if (minimumIdentityProtocol !== 1 && minimumIdentityProtocol !== 2) throw new IdentityBoundaryError(503, "identity_authority_unavailable");
    metrics.adminDashboardViewsTotal += 1;
    json(response, 200, {
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        role: actor.role,
        tenantId: actor.tenantId,
        roomId: actor.roomId
      },
      permissions: controlPlanePermissions,
      minimumIdentityProtocol
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
    const rawPayload = normalizeRoomAvatarOverrides((await parseBody<RoomPayloadInput>(request)) ?? {});
    const allowUnownedPersonal = await legacyIdentityBoundary.minimum() >= 2;
    let payload: Partial<RoomRecord>;
    try {
      const resolved = await resolveRoomTemplateCreate(storage, rawPayload, { allowUnownedPersonal });
      payload = { ...normalizeRoomPayload(resolved.input, "create"), templateVersion: resolved.version.version };
    } catch (error) {
      const failure = templateInputError(error);
      if (!failure) throw error;
      incrementCounter(metrics.roomCreationFailuresTotal, failure.code);
      return json(response, failure.status, { error: failure.code });
    }
    const tenantIds = new Set((await storage.listTenants()).map((tenant) => tenant.tenantId));
    const templateIds = new Set((await storage.listTemplates()).map((template) => template.templateId));
    const validationError = validateRoomInput(payload, templateIds, tenantIds, { allowUnownedPersonal });
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
      room = await storage.createAdministrativeRoom(payload);
    } catch (error) {
      if (error instanceof IdentityBoundaryError) throw error;
      if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
      const templateFailure = templateInputError(error);
      if (templateFailure) {
        incrementCounter(metrics.roomCreationFailuresTotal, templateFailure.code);
        return json(response, templateFailure.status, { error: templateFailure.code });
      }
      const message = error instanceof Error ? error.message : "room_create_failed";
      const reason = message === "room_slug_conflict" || /duplicate key|unique constraint|already exists/i.test(message)
        ? "room_slug_conflict"
        : /^(template_deprecated|template_version_not_found):/.test(message)
          ? "invalid_template"
          : "room_create_failed";
      incrementCounter(metrics.roomCreationFailuresTotal, reason);
      return json(response, reason === "room_slug_conflict" ? 409 : 400, { error: reason });
    }
    incrementCounter(metrics.roomsCreatedTotal, `control-plane:${sanitizeRoomVisibility(room.visibility)}`);
    json(response, 201, { ...room, roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request, room) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/personal-room") {
    if (!isPersonalRoomsFeatureEnabled()) return json(response, 404, { error: "personal_rooms_disabled" });
    if (await legacyIdentityBoundary.minimum() >= 2) {
      const personalBearer = getBearerToken(request);
      if (personalBearer && !personalBearer.startsWith("rs2.")) throw new IdentityBoundaryError(409, "identity_upgrade_required");
      const payload = (await parseBody<{ identityProtocolVersion?: unknown; participantId?: unknown; displayName?: unknown;
        tenantId?: unknown; roomId?: unknown; identityCredential?: unknown }>(request)) ?? {};
      if (payload.identityProtocolVersion !== 2) throw new IdentityBoundaryError(409, "identity_upgrade_required");
      if (personalBearer) return json(response, 426, { error: "identity_required", reason: "identity_upgrade_required" });
      const tenantId = typeof payload.tenantId === "string" && payload.tenantId.trim() ? payload.tenantId.trim() : "demo-tenant";
      if (!(await storage.listTenants()).some(item => item.tenantId === tenantId)) return json(response, 400, { error: "invalid_tenant" });
      if (payload.identityCredential !== undefined) {
        if (typeof payload.roomId !== "string") return json(response, 409, { error: "identity_required", reason: "identity_recovery_required" });
        const existing = await storage.getRoom(payload.roomId);
        if (!existing || existing.roomType !== "personal" || existing.tenantId !== tenantId) {
          return json(response, 409, { error: "identity_required", reason: "identity_recovery_required" });
        }
        const scope = { tenantId, roomId: existing.roomId };
        // Prepare unsigned response metadata before locking. Only the original
        // possession proof can authorize release; signing cannot widen its deadline.
        const codec = createRoomIdentityCodec(getStateTokenSecret());
        const proof = codec.verify(payload.identityCredential, scope);
        if (!proof) throw new IdentityBoundaryError(409, "identity_recovery_required");
        try {
          const roomLink = createRoomLink(existing.roomId, request);
          await storage.releasePersonalRoomOwnerResponse(proof, (room, identity) => {
            const identityCredential = codec.sign(identity, { nowSeconds: Math.floor(Date.now() / 1000), lifetimeSeconds: 86_400 });
            json(response, 200, { created: false, room: roomResponseRecord(request, room), roomLink,
              identityProtocolVersion: 2, participantId: identity.participantId, identityCredential });
          });
          return;
        } catch (error) {
          if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
          if (error instanceof PersonalOwnerRoomBlocked) return json(response, 403, { error: "room_access_denied", reason: error.reason });
          if (error instanceof IdentityStorageError) {
            throw new IdentityBoundaryError(409, "identity_recovery_required");
          }
          throw error;
        }
      }
      if (payload.roomId !== undefined) return json(response, 409, { error: "identity_required", reason: "identity_recovery_required" });
      // A remembered public legacy ID is only a lookup hint. It cannot claim a
      // former personal room or trigger a silent new-room replacement.
      if (typeof payload.participantId === "string" && (await storage.listRooms()).some(room =>
        room.tenantId === tenantId && room.roomType === "personal" && room.ownerParticipantId === payload.participantId)) {
        return json(response, 409, { error: "identity_required", reason: "identity_recovery_required" });
      }
      if (!await storage.reserveIdentityAdmission({ originHash: identityAdmissionOriginHash(request), kind: "personal" })) {
        return json(response, 429, { error: "room_access_denied", reason: "identity_rate_limited" });
      }
      const displayName = normalizeDisplayName(payload.displayName, "Owner");
      const templates = await storage.listTemplates();
      const templateId = templates.some(template => template.templateId === "personal-room-basic" && template.status === "active")
        ? "personal-room-basic" : "personal-workspace-basic";
      let owned: Awaited<ReturnType<typeof storage.createPersonalOwnedRoom>>;
      try {
        owned = await storage.createPersonalOwnedRoom({ tenantId, templateId, displayName, name: personalRoomName(displayName) });
      } catch (error) {
        if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
        throw error;
      }
      const { room, identity } = owned;
      const identityCredential = createRoomIdentityCodec(getStateTokenSecret()).sign(identity, { lifetimeSeconds: 86_400 });
      return json(response, 201, { created: true, room: roomResponseRecord(request, room), roomLink: createRoomLink(room.roomId, request),
        identityProtocolVersion: 2, participantId: identity.participantId, identityCredential });
    }
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
      await releaseLegacyPersonalRoom(request, response, storage, existing, participantId, false);
      return;
    }

    const displayName = normalizeDisplayName(payload.displayName, participantId);
    const roomId = createPersonalRoomId(`${tenantId}:${participantId}`);
    let room: RoomRecord;
    let created = false;
    try {
      const activeTemplates = await storage.listTemplates();
      const templateId = activeTemplates.some(template => template.templateId === "personal-room-basic") ? "personal-room-basic" : "personal-workspace-basic";
      const resolved = await resolveRoomTemplateCreate(storage, {
        roomId,
        tenantId,
        templateId,
        name: personalRoomName(displayName),
        roomType: "personal",
        ownerParticipantId: participantId,
        visibility: "private",
        guestAllowed: false,
        ...(templateId === "personal-workspace-basic" ? { features: { voice: true, spatialAudio: true, screenShare: true }, theme: { primaryColor: "#7dd3fc", accentColor: "#312e81" } } : {}),
        sessionControl: { hostParticipantId: participantId }
      });
      let result: Awaited<ReturnType<typeof storage.createLegacyPersonalRoom>>;
      try {
        result = await storage.createLegacyPersonalRoom({ ...resolved.input, roomId, tenantId, ownerParticipantId: participantId });
      } catch (error) {
        if (identityFenceUnavailable(error)) throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
        throw error;
      }
      room = result.room;
      created = result.created;
    } catch (error) {
      if (error instanceof Error && error.message === "room_slug_conflict") {
        incrementCounter(metrics.personalRoomOpensTotal, "slug_conflict");
        return json(response, 409, { error: "room_slug_conflict" });
      }
      if (error instanceof Error && (/^(template_deprecated|template_version_not_found):/.test(error.message) || error.message === "deprecated_template")) {
        incrementCounter(metrics.personalRoomOpensTotal, "template_unavailable");
        return json(response, 503, { error: "personal_room_template_unavailable" });
      }
      throw error;
    }
    if (!created) {
      await releaseLegacyPersonalRoom(request, response, storage, room, participantId, false);
      return;
    }
    metrics.personalRoomsCreatedTotal += 1;
    incrementCounter(metrics.roomsCreatedTotal, "self-service:private");
    logEvent({
      service: "api",
      event: "personal_room_created",
      requestId,
      roomId: room.roomId,
      tenantId: room.tenantId,
      ownerParticipantId: participantId,
      timestamp: new Date().toISOString()
    });
    await releaseLegacyPersonalRoom(request, response, storage, room, participantId, true);
    return;
  }

  const identityRecoveryMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/identity-recovery$/);
  if (method === "POST" && identityRecoveryMatch) {
    const roomId = decodeURIComponent(identityRecoveryMatch[1]);
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.session-control", action: "identity.recovery.issue", objectType: "room", objectId: roomId
    });
    if (!actor) return;
    if (actor.actorType !== "admin-token") return json(response, 403, { error: "forbidden" });
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const payload = (await parseBody<{ participantId?: unknown; role?: unknown }>(request)) ?? {};
    const participantId = normalizeParticipantId(payload.participantId);
    if (!participantId || (payload.role !== "host" && payload.role !== "owner")) {
      return json(response, 400, { error: "invalid_identity_recovery_target" });
    }
    try {
      const service = createRoomIdentityService(storage.roomIdentities, getStateTokenSecret(), Date.now,
        { identityLifetimeSeconds: 86_400 });
      const issued = await service.issueRecovery({ tenantId: room.tenantId, roomId,
        targetParticipantId: participantId, targetRole: payload.role,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        issuer: { actorType: "admin-token", actorId: actor.actorId, role: "admin" } });
      return json(response, 201, { recoveryCredential: issued.credential, expiresAt: issued.expiresAt });
    } catch (error) {
      const failure = lifecycleV2Error(error);
      if (failure) return json(response, failure.status, { error: failure.error });
      throw error;
    }
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
    const canAccessPersonalState = actor.actorType === "admin-token" || (actor.actorType === "room-session" && actor.roomId === roomId
      && (actor.identityProtocolVersion === 2 ? actor.isOwner === true : actor.participantId === room.ownerParticipantId));
    if (!canAccessPersonalState) {
      if (method === "PUT") incrementCounter(metrics.personalStateSaveFailuresTotal, "owner_required");
      return json(response, 403, { error: "forbidden", reason: "owner_required", requestId });
    }

    if (method === "GET") {
      await runGuardedRoomEffect(storage, actor, room, "room.join", async scoped => {
        const state = await scoped.getPersonalRoomState(room.tenantId, roomId);
        if (state === null) return scoped.releaseResponse(() => { json(response, 404, { error: "room_not_found" }); });
        scoped.releaseResponse(() => { json(response, 200, { state }); });
      }, { ownerOnly: true });
      return;
    }

    const state = normalizePersonalState(await parseBody<unknown>(request), actor.actorId);
    if (!state) {
      incrementCounter(metrics.personalStateSaveFailuresTotal, "invalid_personal_state");
      return json(response, 400, { error: "invalid_personal_state" });
    }
    const updated = await runGuardedRoomEffect(storage, actor, room, "room.join",
      scoped => scoped.updatePersonalRoomState(room.tenantId, roomId, state), { ownerOnly: true, roomWrite: true });
    if (updated === null) {
      incrementCounter(metrics.personalStateSaveFailuresTotal, "room_not_found");
      return json(response, 404, { error: "room_not_found" });
    }
    json(response, 200, { state: updated });
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
      const items = documents.map((document) => serializeRoomDocument(request, document));
      await runGuardedRoomEffect(storage, actor, room, permission, async scoped => { scoped.releaseResponse(() => { json(response, 200, { items }); }); });
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

    let documentMetadata: RoomDocumentMetadata = {};
    if (contentType === "application/pdf") {
      try {
        documentMetadata = await inspectPdfDocument(documentFile.data);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "corrupt_pdf";
        incrementCounter(metrics.pdfValidationFailuresTotal, reason);
        incrementCounter(metrics.documentsUploadedTotal, `${contentType}:rejected`);
        return json(response, 422, { error: reason, requestId });
      }
    } else if (contentType.startsWith("image/") || contentType.startsWith("video/")) {
      const kind = contentType.startsWith("image/") ? "image" : "video";
      try {
        documentMetadata = kind === "image"
          ? inspectImageDocument(documentFile.data, contentType)
          : inspectVideoDocument(documentFile.data, contentType, parts);
      } catch (error) {
        const reason = error instanceof Error ? error.message : `invalid_${kind}`;
        incrementCounter(metrics.documentMediaValidationFailuresTotal, `${kind}:${reason}`);
        incrementCounter(metrics.documentsUploadedTotal, `${contentType}:rejected`);
        return json(response, 422, { error: reason, requestId });
      }
    }

    let uploadedStorage: ReturnType<typeof getDocumentUploadStorage> | null = null;
    let uploadedKey: string | null = null;
    let documentPersisted = false;
    try {
      const documentId = randomUUID();
      const uploadStorage = getDocumentUploadStorage(request);
      const storageKey = documentStorageKey(room.tenantId, roomId, documentId, filename);
      await writeDocumentObject(uploadStorage, storageKey, documentFile.data, contentType);
      uploadedStorage = uploadStorage;
      uploadedKey = storageKey;
      const document = await runGuardedRoomEffect(storage, actor, room, permission, scoped => scoped.createRoomDocument({
        documentId,
        roomId,
        tenantId: room.tenantId,
        filename,
        contentType,
        sizeBytes: documentFile.data.byteLength,
        storageKey,
        checksum: `sha256:${sha256Hex(documentFile.data)}`,
        uploadedBy: actor.actorId,
        metadata: documentMetadata
      }));
      documentPersisted = true;
      incrementCounter(metrics.documentsUploadedTotal, `${contentType}:success`);
      incrementCounter(metrics.documentStorageBytesTotal, room.tenantId, document.sizeBytes);
      json(response, 201, { document: serializeRoomDocument(request, document) });
    } catch (error) {
      // A lost COMMIT acknowledgement is not evidence that publication failed.
      // Retain the blob for reconciliation rather than breaking a committed row.
      if (uploadedKey && uploadedStorage && !documentPersisted && !uncertainRoomCommit(error)) {
        await deleteDocumentObject(uploadedStorage, uploadedKey).catch(() => {
          incrementCounter(metrics.documentBlobDeletesTotal, "failed");
        });
      }
      if (uncertainRoomCommit(error)) {
        incrementCounter(metrics.documentsUploadedTotal, `${contentType}:uncertain`);
        throw new IdentityBoundaryError(503, "identity_authority_unavailable", error);
      }
      if (error instanceof RoomEffectPermissionDenied || error instanceof IdentityBoundaryError) throw error;
      const message = error instanceof Error ? error.message : "document_upload_failed";
      incrementCounter(metrics.documentsUploadedTotal, `${contentType}:failed`);
      json(response, message.startsWith("misconfigured_document_upload_storage") ? 503 : 400, { error: message, requestId });
    }
    return;
  }

  const roomDocumentItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/documents\/([^/]+)(?:\/(download|presentation|content|surface))?$/);
  if ((method === "GET" || method === "DELETE" || method === "POST") && roomDocumentItemMatch) {
    if (!isDocumentsFeatureEnabled()) return json(response, 404, { error: "documents_disabled" });
    const roomId = decodeURIComponent(roomDocumentItemMatch[1]);
    const documentId = decodeURIComponent(roomDocumentItemMatch[2]);
    const actionPath = roomDocumentItemMatch[3] ?? "item";
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const permission = actionPath === "download" ? "document.download" : actionPath === "presentation" || actionPath === "content" ? "surface.view" : method === "DELETE" ? "document.delete" : "document.present";
    const action = actionPath === "download" ? "documents.download" : actionPath === "presentation" || actionPath === "content" ? "documents.presentation" : method === "DELETE" ? "documents.delete" : "documents.select-surface";
    const actor = resolveRoomDocumentsActor(request, response, { room, permission, action, documentId });
    if (!actor) return;
    const document = await storage.getRoomDocument(roomId, documentId);
    const deleteItem = method === "DELETE" && actionPath === "item";
    if (!document || (document.deletedAt && !deleteItem)) return json(response, 404, { error: "document_not_found" });

    if (method === "GET" && actionPath === "download") {
      let bytes: Buffer;
      try {
        bytes = await readDocumentObject(getDocumentUploadStorage(request), document.storageKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : "document_download_failed";
        json(response, 503, { error: message, requestId });
        return;
      }
      const released = await releaseDocumentBytes(storage, actor, room, document, permission, false, () => {
        metrics.documentDownloadsTotal += 1;
        response.writeHead(200, {
          "content-type": document.contentType,
          "content-length": String(bytes.byteLength),
          "content-disposition": `attachment; filename="${safeHeaderFilename(document.filename)}"`,
          "cache-control": "private, no-store",
          "x-request-id": requestId
        });
        response.end(bytes);
      });
      if (!released) json(response, 404, { error: "document_not_found" });
      return;
    }

    if (method === "GET" && actionPath === "presentation") {
      if (document.metadata?.kind !== "pdf" || !document.linkedSurfaceId) {
        incrementCounter(metrics.documentPresentationContentTotal, "not_active");
        return json(response, 404, { error: "presentation_not_active" });
      }
      let bytes: Buffer;
      try {
        bytes = await readDocumentObject(getDocumentUploadStorage(request), document.storageKey);
      } catch (error) {
        incrementCounter(metrics.documentPresentationContentTotal, "failed");
        const message = error instanceof Error ? error.message : "presentation_content_failed";
        json(response, 503, { error: message, requestId });
        return;
      }
      const released = await releaseDocumentBytes(storage, actor, room, document, permission, true, () => {
        incrementCounter(metrics.documentPresentationContentTotal, "success");
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": String(bytes.byteLength),
          "content-disposition": `inline; filename="${safeHeaderFilename(document.filename)}"`,
          "cache-control": "private, no-store",
          "x-request-id": requestId
        });
        response.end(bytes);
      });
      if (!released) json(response, 404, { error: "presentation_not_active" });
      return;
    }

    if (method === "GET" && actionPath === "content") {
      const kind = document.metadata?.kind;
      if ((kind !== "image" && kind !== "video") || !document.linkedSurfaceId) {
        incrementCounter(metrics.documentMediaContentTotal, `${kind === "video" ? "video" : "image"}:not_active`);
        return json(response, 404, { error: "media_content_not_active" });
      }
      let bytes: Buffer;
      try {
        bytes = await readDocumentObject(getDocumentUploadStorage(request), document.storageKey);
      } catch (error) {
        incrementCounter(metrics.documentMediaContentTotal, `${kind}:failed`);
        json(response, 503, { error: error instanceof Error ? error.message : "media_content_failed", requestId });
        return;
      }
      const released = await releaseDocumentBytes(storage, actor, room, document, permission, true, () => {
        incrementCounter(metrics.documentMediaContentTotal, `${kind}:success`);
        response.writeHead(200, {
          "content-type": document.contentType,
          "content-length": String(bytes.byteLength),
          "content-disposition": `inline; filename="${safeHeaderFilename(document.filename)}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": requestId
        });
        response.end(bytes);
      });
      if (!released) json(response, 404, { error: "media_content_not_active" });
      return;
    }

    if (method === "DELETE" && actionPath === "item") {
      // A confirmed tombstone is the deletion intent for every protocol.
      // Retry decisions are read under the fence, not from the pre-fence hint.
      const result = await runGuardedRoomEffect(storage, actor, room, permission, async scoped => {
        const marked = await scoped.markRoomDocumentDeleted(roomId, documentId, new Date().toISOString(), actor.actorId);
        if (marked) return { document: marked, transitioned: true };
        const current = await scoped.getRoomDocument(roomId, documentId);
        return current?.deletedAt ? { document: current, transitioned: false } : null;
      });
      if (!result) return json(response, 404, { error: "document_not_found" });
      if (result.transitioned) metrics.documentDeletesTotal += 1;
      try {
        await cleanupDocumentMediaObjects(roomId, documentId);
      } catch (error) {
        return json(response, 503, { error: error instanceof Error ? error.message : "presentation_cleanup_failed", requestId });
      }
      try {
        await deleteDocumentObject(getDocumentUploadStorage(request), result.document.storageKey);
        incrementCounter(metrics.documentBlobDeletesTotal, "success");
      } catch (error) {
        incrementCounter(metrics.documentBlobDeletesTotal, "failed");
        return json(response, 503, { error: error instanceof Error ? error.message : "document_object_delete_failed", requestId });
      }
      json(response, 200, { document: serializeRoomDocument(request, result.document) });
      return;
    }

    if (method === "POST" && actionPath === "surface") {
      if (!document.metadata?.kind || !["pdf", "image", "video"].includes(document.metadata.kind)
        || (document.metadata.kind === "pdf" && !document.metadata.pageCount)
        || ((document.metadata.kind === "image" || document.metadata.kind === "video") && (!document.metadata.widthPx || !document.metadata.heightPx))) {
        return json(response, 422, { error: "document_not_presentable" });
      }
      const payload = (await parseBody<{ surfaceId?: unknown }>(request)) ?? {};
      const surfaceId = normalizeDocumentSurfaceId(payload.surfaceId);
      if (surfaceId === undefined) return json(response, 400, { error: "invalid_document_surface_id" });
      const updated = await runGuardedRoomEffect(storage, actor, room, permission,
        scoped => scoped.updateRoomDocumentSurface(roomId, documentId, surfaceId));
      if (!updated) return json(response, 404, { error: "document_not_found" });
      metrics.documentSurfaceSelectionsTotal += 1;
      json(response, 200, { document: serializeRoomDocument(request, updated) });
      return;
    }

    json(response, 405, { error: "unsupported_document_action" });
    return;
  }

  const roomNotesArchiveExportMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/export$/);
  if (method === "GET" && roomNotesArchiveExportMatch) {
    if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
    const roomId = decodeURIComponent(roomNotesArchiveExportMatch[1]);
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = resolveRoomNotesActor(request, response, { room, scope: "shared", permission: "notes.view", action: "notes.export" });
    if (!actor) {
      metrics.notesExportDeniedTotal += 1;
      return;
    }
    const format = url.searchParams.get("format")?.trim().toLowerCase() || "json";
    if (format !== "json" && format !== "markdown" && format !== "zip") {
      incrementCounter(metrics.notesExportsTotal, `${format}:failed`);
      return json(response, 400, { error: "unsupported_notes_export_format" });
    }
    const notes = (await storage.listRoomNotes(roomId, true)).filter((note) => roomNoteVisibleToActor(note, actor));
    const items = await Promise.all(notes.map(async (note) => ({
      note,
      versions: await storage.listRoomNoteVersions(note.roomId, note.scope, note.ownerParticipantId, 100)
    })));
    const exportedAt = new Date().toISOString();
    const payload = { schemaVersion: 1, exportedAt, roomId, notes: items };
    const body = format === "markdown" ? formatRoomNotesMarkdown(roomId, items) : format === "zip"
      ? createStoredZip([
        { name: "room-notes.json", content: JSON.stringify(payload, null, 2) },
        { name: "room-notes.md", content: formatRoomNotesMarkdown(roomId, items) },
        { name: "board.json", content: JSON.stringify({ status: "not_included", reason: "board_state_is_realtime_only", followUp: "VRATA-FEAT-023-board-history" }, null, 2) },
        ...items.map(({ note, versions }) => ({
          name: `notes/${note.scope}${note.ownerParticipantId ? `-${note.ownerParticipantId}` : ""}.md`,
          content: formatNoteMarkdown(note, versions)
        }))
      ]) : JSON.stringify(payload, null, 2);
    await releaseRoomNotes(request, storage, actor, room, "shared", "notes.export", () => {
      attachment(response, 200, body, noteExportFilename(roomId, "room", format === "markdown" ? "md" : format),
        format === "markdown" ? "text/markdown; charset=utf-8" : format === "zip" ? "application/zip" : "application/json; charset=utf-8");
    });
    incrementCounter(metrics.notesExportsTotal, `${format}:saved`);
    return;
  }

  const roomNoteVersionsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/versions$/);
  if (method === "GET" && roomNoteVersionsMatch) {
    if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
    const roomId = decodeURIComponent(roomNoteVersionsMatch[1]);
    const scope = roomNoteVersionsMatch[2] as RoomNoteScope;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = resolveRoomNotesActor(request, response, { room, scope, permission: "notes.view", action: "notes.versions" });
    if (!actor) return;
    const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission: "notes.view", action: "notes.versions" });
    if (ownerParticipantId === undefined) return;
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const versions = await storage.listRoomNoteVersions(roomId, scope, ownerParticipantId, Number.isFinite(limit) ? limit : 20);
    await releaseRoomNotes(request, storage, actor, room, scope, "notes.versions", () => { json(response, 200, { items: versions }); });
    return;
  }

  const roomNoteRestoreMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/restore$/);
  if (method === "POST" && roomNoteRestoreMatch) {
    if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
    const roomId = decodeURIComponent(roomNoteRestoreMatch[1]);
    const scope = roomNoteRestoreMatch[2] as RoomNoteScope;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const permission = noteWritePermission(scope);
    const actor = resolveRoomNotesActor(request, response, { room, scope, permission, action: "notes.restore" });
    if (!actor) {
      incrementCounter(metrics.notesRestoresTotal, `${scope}:denied`);
      return;
    }
    const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission, action: "notes.restore" });
    if (ownerParticipantId === undefined) {
      incrementCounter(metrics.notesRestoresTotal, `${scope}:denied`);
      return;
    }
    const payload = (await parseBody<{ versionId?: unknown }>(request)) ?? {};
    if (typeof payload.versionId !== "string" || !payload.versionId.trim()) {
      incrementCounter(metrics.notesRestoresTotal, `${scope}:failed`);
      return json(response, 400, { error: "invalid_note_version" });
    }
    const versionId = payload.versionId.trim();
    const restored = await runGuardedRoomEffect(storage, actor, room, permission,
      scoped => scoped.restoreRoomNoteVersion(roomId, scope, ownerParticipantId, versionId, actor.actorId));
    if (!restored) {
      incrementCounter(metrics.notesRestoresTotal, `${scope}:failed`);
      return json(response, 404, { error: "note_version_not_found" });
    }
    metrics.notesVersionsCreatedTotal += 1;
    incrementCounter(metrics.notesRestoresTotal, `${scope}:saved`);
    json(response, 200, restored);
    return;
  }

  const roomNoteExportMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/export$/);
  if (method === "GET" && roomNoteExportMatch) {
    if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
    const roomId = decodeURIComponent(roomNoteExportMatch[1]);
    const scope = roomNoteExportMatch[2] as RoomNoteScope;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = resolveRoomNotesActor(request, response, { room, scope, permission: "notes.view", action: "notes.export" });
    if (!actor) {
      metrics.notesExportDeniedTotal += 1;
      return;
    }
    const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission: "notes.view", action: "notes.export" });
    if (ownerParticipantId === undefined) return;
    const format = url.searchParams.get("format")?.trim().toLowerCase() || "markdown";
    if (format !== "markdown" && format !== "json") {
      incrementCounter(metrics.notesExportsTotal, `${format}:failed`);
      return json(response, 400, { error: "unsupported_notes_export_format" });
    }
    const note = await storage.getRoomNote(roomId, scope, ownerParticipantId) ?? emptyRoomNote(roomId, scope, ownerParticipantId);
    const versions = await storage.listRoomNoteVersions(roomId, scope, ownerParticipantId, 100);
    const body = format === "json" ? JSON.stringify(noteExportJson(note, versions), null, 2) : formatNoteMarkdown(note, versions);
    await releaseRoomNotes(request, storage, actor, room, scope, "notes.export", () => {
      attachment(response, 200, body, noteExportFilename(roomId, scope, format === "json" ? "json" : "md"),
        format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8");
    });
    incrementCounter(metrics.notesExportsTotal, `${format}:saved`);
    return;
  }

  const roomNotesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)$/);
  if ((method === "GET" || method === "PUT" || method === "DELETE") && roomNotesMatch) {
    if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
    const roomId = decodeURIComponent(roomNotesMatch[1]);
    const scope = roomNotesMatch[2] as RoomNoteScope;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const permission: "notes.view" | "notes.edit" = method === "GET" ? "notes.view" : noteWritePermission(scope);
    const action = method === "GET" ? "notes.read" : method === "DELETE" ? "notes.delete" : "notes.save";
    const actor = resolveRoomNotesActor(request, response, { room, scope, permission, action });
    if (!actor) return;
    const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission, action });
    if (ownerParticipantId === undefined) return;

    if (method === "GET") {
      const note = await storage.getRoomNote(roomId, scope, ownerParticipantId);
      const result = note && !note.deletedAt ? note : emptyRoomNote(roomId, scope, ownerParticipantId);
      await releaseRoomNotes(request, storage, actor, room, scope, "notes.read", () => { json(response, 200, { note: result }); });
      return;
    }

    if (method === "DELETE") {
      const deleted = await runGuardedRoomEffect(storage, actor, room, permission,
        scoped => scoped.deleteRoomNote(roomId, scope, ownerParticipantId, actor.actorId));
      if (!deleted) return json(response, 404, { error: "note_not_found" });
      metrics.notesVersionsCreatedTotal += 1;
      json(response, 200, { note: deleted });
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
    const noteContent = payload.content;

    const existing = await storage.getRoomNote(roomId, scope, ownerParticipantId);
    const note = await runGuardedRoomEffect(storage, actor, room, permission, scoped => scoped.upsertRoomNote({
      roomId,
      scope,
      ownerParticipantId,
      content: noteContent,
      updatedBy: actor.actorId
    }));
    if (!existing) incrementCounter(metrics.notesCreatedTotal, scope);
    metrics.notesVersionsCreatedTotal += 1;
    incrementCounter(metrics.notesSavedTotal, `${scope}:saved`);
    json(response, existing ? 200 : 201, { note });
    return;
  }

  const roomItemMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (method === "PATCH" && roomItemMatch) {
    const roomId = decodeURIComponent(roomItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "room.update", action: "room.update", objectType: "room", objectId: roomId });
    if (!actor) return;
    const rawPayload = (await parseBody<RoomPayloadInput>(request)) ?? {};
    const existingRoom = await storage.getRoom(roomId);
    if (!existingRoom) return json(response, 404, { error: "room_not_found" });
    try { assertRoomTemplatePatch(existingRoom, rawPayload); } catch (error) {
      const failure = templateInputError(error);
      if (!failure) throw error;
      return json(response, failure.status, { error: failure.code });
    }
    const payload = normalizeRoomPayload(rawPayload, "patch");
    if (payload.visibility !== undefined && !isRoomVisibility(payload.visibility)) return json(response, 400, { error: "invalid_room_visibility" });
    if (payload.roomType !== undefined && payload.roomType !== "standard" && payload.roomType !== "personal") return json(response, 400, { error: "invalid_room_type" });
    if (payload.templateId !== undefined) {
      if (payload.templateId !== existingRoom.templateId) {
        const templateIds = new Set((await storage.listTemplates()).map((template) => template.templateId));
        if (!templateIds.has(payload.templateId)) return json(response, 400, { error: "invalid_template" });
        return json(response, 409, { error: "room_template_binding_changed" });
      }
    }
    if (payload.assetIds || payload.templateId !== undefined) {
      const effectiveTemplateId = payload.templateId ?? existingRoom.templateId;
      const templateChanged = effectiveTemplateId !== existingRoom.templateId;
      const assetValidationError = await validateRoomAssetIds(
        storage,
        payload.assetIds ?? existingRoom.assetIds,
        effectiveTemplateId,
        templateChanged ? undefined : existingRoom.templateVersion
      );
      if (assetValidationError) return json(response, 400, { error: assetValidationError });
    }
    if (Object.keys(payload).length === 0) {
      json(response, 200, { ...existingRoom, roomLink: createRoomLink(existingRoom.roomId, request), manifest: await buildManifest(existingRoom.roomId, request, existingRoom) });
      return;
    }
    let updated: RoomRecord | null;
    try {
      updated = await storage.updateRoom(roomId, payload, {
        templateId: existingRoom.templateId,
        templateVersion: existingRoom.templateVersion
      });
    } catch (error) {
      const templateFailure = templateInputError(error);
      if (templateFailure) return json(response, templateFailure.status, { error: templateFailure.code });
      if (error instanceof Error && error.message === "room_template_binding_changed") {
        return json(response, 409, { error: "room_template_binding_changed" });
      }
      throw error;
    }
    if (!updated) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...updated, roomLink: createRoomLink(updated.roomId, request), manifest: await buildManifest(updated.roomId, request, updated) });
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
    json(response, 200, { ...updated, roomLink: createRoomLink(updated.roomId, request), manifest: await buildManifest(updated.roomId, request, updated) });
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
      await runGuardedRoomEffect(storage, actor, room, "room.join", async scoped => {
        const items = (await scoped.listRoomInvites(roomId)).map((invite) => sanitizeRoomInvite(invite));
        scoped.releaseResponse(() => { json(response, 200, { items }); });
      }, { hostOrOwner: true });
      return;
    }

    const payload = (await parseBody<{ expiresInSeconds?: number; expiresAt?: string; role?: string; waitingRoomEnabled?: boolean }>(request)) ?? {};
    const nowMs = Date.now();
    const expiresAtMs = payload.expiresAt
      ? Date.parse(payload.expiresAt)
      : nowMs + Math.max(1, Math.min(30 * 24 * 60 * 60, Math.floor(payload.expiresInSeconds ?? 3600))) * 1000;
    if (!Number.isFinite(expiresAtMs)) return json(response, 400, { error: "invalid_invite_expiry" });
    const token = createInviteToken();
    const inviteInput = {
      roomId,
      tokenHash: hashInviteToken(token),
      role: parseRoomRole(payload.role, "guest"),
      waitingRoomEnabled: payload.waitingRoomEnabled === true,
      expiresAt: new Date(expiresAtMs).toISOString(),
      createdBy: actor.actorId
    };
    let invite: RoomInviteRecord;
    if (await legacyIdentityBoundary.minimum() >= 2) {
      try { invite = await storage.createRoomInviteV2({ ...inviteInput, actor: roomIdentityActorFromHttp(actor, room) }); }
      catch (error) {
        const failure = lifecycleV2Error(error);
        if (failure) return json(response, failure.status, { error: failure.error });
        throw error;
      }
    } else invite = await storage.createRoomInvite(inviteInput);
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
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const invite = await runGuardedRoomEffect(storage, actor, room, "room.join",
      scoped => scoped.revokeRoomInvite(roomId, inviteId, new Date().toISOString(), actor.actorId), { hostOrOwner: true });
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
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    await runGuardedRoomEffect(storage, actor, room, "room.join", async scoped => {
      const items = (await scoped.listWaitingRoomRequests(roomId)).map(sanitizeWaitingRoomRequest);
      scoped.releaseResponse(() => { json(response, 200, { items }); });
    }, { hostOrOwner: true });
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
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    let waitingRequest: WaitingRoomRequestRecord | null;
    try {
      waitingRequest = await runGuardedRoomEffect(storage, actor, room, "room.join", scoped => scoped.updateWaitingRoomRequest(roomId, waitingRequestId, {
        status: decision,
        decidedAt: new Date().toISOString(),
        decidedBy: actor.actorId
      }), { hostOrOwner: true });
    } catch (error) {
      if (error instanceof Error && error.message === "waiting_decision_finalized") {
        return json(response, 409, { error: "waiting_decision_finalized" });
      }
      throw error;
    }
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
    // Floor-1 room sessions: every reply is released from a read-only fenced snapshot.
    if (actorResult.actor.actorType === "room-session" && actorResult.actor.identityProtocolVersion !== 2) {
      await releaseLegacySessionControl(request, response, storage, room, requestId);
      return;
    }

    const session = actorResult.actor.actorType === "room-session"
      ? await verifyRoomSessionRequest(request, { roomId, participantId: actorResult.actor.participantId })
      : null;
    const atFloor2 = await legacyIdentityBoundary.minimum() >= 2;
    const v2 = session?.ok && session.payload.identityProtocolVersion === 2;
    const current = atFloor2 ? await currentRoomOwner(storage, { tenantId: room.tenantId, roomId }) : null;
    const participantIdForStatus = session?.ok ? session.payload.participantId : actorResult.actor.participantId;
    const currentRole = session?.ok ? session.payload.role : actorResult.actor.role;
    const effectiveRole = v2 ? currentRole
      : participantIdForStatus ? resolveEffectiveRoomRole(room, participantIdForStatus, currentRole) : currentRole;
    const statusReason = v2 ? null : participantIdForStatus ? getSessionControlBlockReason(room, participantIdForStatus, effectiveRole, true) : null;
    const ttlSeconds = Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10);
    const tokenResponse = session?.ok && !statusReason && !v2 ? createRoomAccessTokenResponse({
      room,
      roomId,
      participantId: session.payload.participantId,
      displayName: session.payload.displayName,
      role: effectiveRole,
      roleSource: session.payload.roleSource ?? "trusted",
      sessionId: session.payload.sessionId,
      sceneMediaSurfaces: session.payload.sceneMediaSurfaces,
      ttlSeconds
    }) : null;
    json(response, 200, {
      state: sanitizeSessionControlState(atFloor2
        ? await currentSessionControlV2(storage, room) : room.sessionControl),
      ...(current ? { authorityRevision: current.authority.revision, ownerParticipantId: current.ownerParticipantId } : {}),
      participant: participantIdForStatus ? {
        participantId: participantIdForStatus,
        role: effectiveRole,
        permissions: getRoomPermissions(effectiveRole),
        ...(v2 ? { isOwner: session.payload.isOwner === true } : {}),
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
    if (await legacyIdentityBoundary.minimum() >= 2) {
      const payload = (await parseBody<{ expectedRevision?: number }>(request)) ?? {};
      try {
        const updated = await applyRoomLifecycleV2({ storage, room, actor, command: { type: action }, expectedRevision: payload.expectedRevision });
        if (action === "lock") metrics.roomLockedTotal += 1;
        if (action === "end") {
          metrics.sessionsEndedTotal += 1;
          for (const participant of getPresence(roomId)) deletePresence(roomId, participant.participantId);
        }
        incrementHostActionMetric(action, "allowed");
        return json(response, 200, updated);
      } catch (error) {
        incrementHostActionMetric(action, "denied");
        const failure = lifecycleV2Error(error);
        if (failure) return json(response, failure.status, { error: failure.error });
        throw error;
      }
    }
    const now = new Date().toISOString();
    const current = defaultSessionControlState(room.sessionControl);
    const next = action === "lock"
      ? { ...current, lockedAt: now, lockedBy: actor.actorId }
      : action === "unlock"
        ? { ...current, lockedAt: null, lockedBy: null }
        : {
          ...current,
          endedAt: now,
          endedBy: actor.actorId,
          presenterParticipantId: null,
          presenterRevokedAt: now,
          presenterRevokedBy: actor.actorId
        };
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
    if (await legacyIdentityBoundary.minimum() >= 2) {
      const payload = (await parseBody<{ reason?: string; expectedRevision?: number }>(request)) ?? {};
      try {
        const updated = await applyRoomLifecycleV2({ storage, room, actor,
          command: { type: "remove", targetParticipantId,
            ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}) }, expectedRevision: payload.expectedRevision });
        deletePresence(roomId, targetParticipantId);
        metrics.participantsRemovedTotal += 1;
        incrementHostActionMetric("remove", "allowed");
        return json(response, 200, { ...updated, removedParticipantId: targetParticipantId });
      } catch (error) {
        incrementHostActionMetric("remove", "denied");
        const failure = lifecycleV2Error(error);
        if (failure) return json(response, failure.status, { error: failure.error });
        throw error;
      }
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
      presenterParticipantId: current.presenterParticipantId === targetParticipantId ? null : current.presenterParticipantId,
      presenterRevokedAt: current.presenterParticipantId === targetParticipantId ? now : current.presenterRevokedAt,
      presenterRevokedBy: current.presenterParticipantId === targetParticipantId ? actor.actorId : current.presenterRevokedBy,
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

  const presenterActionMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/presenters\/([^/]+)\/(grant|revoke)$/);
  if (method === "POST" && presenterActionMatch) {
    const roomId = decodeURIComponent(presenterActionMatch[1]);
    const targetParticipantId = decodeURIComponent(presenterActionMatch[2]);
    const action = presenterActionMatch[3] as "grant" | "revoke";
    if (!isHostControlsEnabled()) return json(response, 404, { error: "host_controls_disabled" });
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.session-control",
      action: `room.session-control.presenter.${action}`,
      objectType: "participant",
      objectId: targetParticipantId,
      targetRoomId: roomId,
      allowHostOwnRoom: true,
      currentHostParticipantId: defaultSessionControlState(room.sessionControl).hostParticipantId
    });
    if (!actor) {
      incrementPresenterChangeMetric(action, "denied");
      return;
    }
    if (await legacyIdentityBoundary.minimum() >= 2) {
      if (action === "grant" && !getPresence(roomId).some(item => item.participantId === targetParticipantId)) {
        incrementPresenterChangeMetric(action, "denied");
        return json(response, 404, { error: "participant_not_found" });
      }
      const payload = (await parseBody<{ expectedRevision?: number }>(request)) ?? {};
      try {
        const updated = await applyRoomLifecycleV2({ storage, room, actor,
          command: { type: action === "grant" ? "grant-presenter" : "revoke-presenter", targetParticipantId }, expectedRevision: payload.expectedRevision });
        incrementPresenterChangeMetric(action, "allowed");
        return json(response, 200, { ...updated, presenterParticipantId: action === "grant" ? targetParticipantId : null });
      } catch (error) {
        incrementPresenterChangeMetric(action, "denied");
        const failure = lifecycleV2Error(error);
        if (failure) return json(response, failure.status, { error: failure.error });
        throw error;
      }
    }
    const current = defaultSessionControlState(room.sessionControl);
    if (getRemovedParticipant(room, targetParticipantId)) {
      incrementPresenterChangeMetric(action, "denied");
      return json(response, 404, { error: "participant_not_found" });
    }
    const participant = getPresence(roomId).find((item) => item.participantId === targetParticipantId);
    if (action === "grant" && !participant) {
      incrementPresenterChangeMetric(action, "denied");
      return json(response, 404, { error: "participant_not_found" });
    }
    if (action === "revoke" && current.presenterParticipantId !== targetParticipantId) {
      incrementPresenterChangeMetric(action, "denied");
      return json(response, 404, { error: "presenter_not_found" });
    }
    const now = new Date().toISOString();
    const updated = await updateRoomSessionControl(storage, room, action === "grant"
      ? {
        ...current,
        presenterParticipantId: targetParticipantId,
        presenterGrantedAt: now,
        presenterGrantedBy: actor.actorId,
        presenterRevokedAt: null,
        presenterRevokedBy: null
      }
      : {
        ...current,
        presenterParticipantId: null,
        presenterRevokedAt: now,
        presenterRevokedBy: actor.actorId
      });
    incrementPresenterChangeMetric(action, "allowed");
    json(response, 200, { state: sanitizeSessionControlState(updated.sessionControl), presenterParticipantId: action === "grant" ? targetParticipantId : null });
    return;
  }

  const ownerTransferMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/owner\/transfer$/);
  if (method === "POST" && ownerTransferMatch) {
    const roomId = decodeURIComponent(ownerTransferMatch[1]);
    if (await legacyIdentityBoundary.minimum() < 2) return json(response, 409, { error: "identity_required", reason: "identity_upgrade_required" });
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    if (room.roomType !== "personal") return json(response, 400, { error: "personal_room_required" });
    const actor = await requireControlPlanePermission(request, response, {
      permission: "room.session-control", action: "room.owner.transfer", objectType: "room", objectId: roomId,
      targetRoomId: roomId, allowHostOwnRoom: true,
      currentHostParticipantId: defaultSessionControlState(room.sessionControl).hostParticipantId
    });
    if (!actor) return;
    if (actor.actorType !== "admin-token" && (actor.identityProtocolVersion !== 2 || actor.isOwner !== true)) {
      return json(response, 403, { error: "identity_forbidden" });
    }
    const payload = (await parseBody<{ participantId?: unknown; expectedRevision?: unknown }>(request)) ?? {};
    const targetParticipantId = normalizeParticipantId(payload.participantId);
    if (!targetParticipantId || !Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 0) {
      return json(response, 400, { error: "invalid_owner_transfer" });
    }
    try {
      const updated = await applyRoomLifecycleV2({ storage, room, actor,
        command: { type: "transfer-owner", targetParticipantId }, expectedRevision: payload.expectedRevision as number });
      return json(response, 200, { ...updated, ownerParticipantId: targetParticipantId });
    } catch (error) {
      const failure = lifecycleV2Error(error);
      if (failure) return json(response, failure.status, { error: failure.error });
      throw error;
    }
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
    const payload = (await parseBody<{ participantId?: string; expectedRevision?: number }>(request)) ?? {};
    const targetParticipantId = typeof payload.participantId === "string" ? payload.participantId.trim() : "";
    if (!targetParticipantId) {
      incrementHostActionMetric("transfer_host", "denied");
      return json(response, 400, { error: "missing_participant_id" });
    }
    if (await legacyIdentityBoundary.minimum() >= 2) {
      if (!getPresence(roomId).some(item => item.participantId === targetParticipantId)) {
        incrementHostActionMetric("transfer_host", "denied");
        return json(response, 404, { error: "participant_not_found" });
      }
      try {
        const updated = await applyRoomLifecycleV2({ storage, room, actor,
          command: { type: "transfer-host", targetParticipantId }, expectedRevision: payload.expectedRevision });
        incrementHostActionMetric("transfer_host", "allowed");
        return json(response, 200, { ...updated, hostParticipantId: targetParticipantId });
      } catch (error) {
        incrementHostActionMetric("transfer_host", "denied");
        const failure = lifecycleV2Error(error);
        if (failure) return json(response, failure.status, { error: failure.error });
        throw error;
      }
    }
    const participant = getPresence(roomId).find((item) => item.participantId === targetParticipantId);
    if (!participant || getRemovedParticipant(room, targetParticipantId)) {
      incrementHostActionMetric("transfer_host", "denied");
      return json(response, 404, { error: "participant_not_found" });
    }
    const current = defaultSessionControlState(room.sessionControl);
    const updated = await updateRoomSessionControl(storage, room, {
      ...current,
      presenterParticipantId: current.presenterParticipantId === targetParticipantId ? null : current.presenterParticipantId,
      presenterRevokedAt: current.presenterParticipantId === targetParticipantId ? new Date().toISOString() : current.presenterRevokedAt,
      presenterRevokedBy: current.presenterParticipantId === targetParticipantId ? actor.actorId : current.presenterRevokedBy,
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
    const existingRoom = await storage.getRoom(roomId);
    if (!existingRoom) return json(response, 404, { error: "room_not_found" });
    const payload = (await parseBody<{ bundleId?: string; version?: string }>(request)) ?? {};
    if (!payload.bundleId) return json(response, 400, { error: "missing_scene_bundle_id" });
    const bundle = payload.version
      ? (await storage.listSceneBundleVersions(payload.bundleId)).find((item) => item.version === payload.version) ?? null
      : await storage.getSceneBundle(payload.bundleId);
    if (!bundle) return json(response, 404, { error: "scene_bundle_not_found" });
    let room: RoomRecord | null;
    try { room = await runGuardedRoomEffect(storage, actor, existingRoom, "room.join",
      scoped => scoped.setRoomSceneBundleUrl(existingRoom.tenantId, roomId, bundle.publicUrl), { hostOrOwner: true, roomWrite: true }); } catch (error) {
      const failure = templateInputError(error);
      if (!failure) throw error;
      return json(response, failure.status, { error: failure.code });
    }
    if (!room) return json(response, 404, { error: "room_not_found" });
    json(response, 200, { ...roomResponseRecord(request, room), roomLink: createRoomLink(room.roomId, request), sceneBundle: bundle, currentVersion: getCurrentSceneBundleVersion(bundle) });
    return;
  }

  if (method === "DELETE" && roomItemMatch) {
    const roomId = decodeURIComponent(roomItemMatch[1]);
    const actor = await requireControlPlanePermission(request, response, { permission: "room.delete", action: "room.delete", objectType: "room", objectId: roomId });
    if (!actor) return;
    const room = await storage.getRoom(roomId);
    if (!room) return json(response, 404, { error: "room_not_found" });
    let deleted: boolean;
    try {
      deleted = await deleteRoomWithPluginCleanup(storage, { tenantId: room.tenantId, roomId },
        () => configuredRoomPluginBlobStorage(runtimePublicRoot, request, publicBaseUrlFromRequest));
    } catch (error) {
      const failure = roomPluginDeletionFailure(error);
      if (failure) return json(response, failure.status, { error: failure.code });
      throw error;
    }
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
    const manifest = await buildManifest(roomId, request, room);
    await releaseRoomRead(request, storage, roomId, room, () => { json(response, 200, manifest); });
    return;
  }

  const presenceListMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/presence$/);
  if (method === "GET" && presenceListMatch) {
    const roomId = decodeURIComponent(presenceListMatch[1]);
    const room = await storage.getRoom(roomId);
    // A missing room releases only the separate virtual map.
    const readPresence = room ? getPresence : virtualPresence.getPresence;
    await releaseRoomRead(request, storage, roomId, room, () => { json(response, 200, { items: readPresence(roomId) }); });
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
    const effectiveRole = session.payload.identityProtocolVersion === 2 ? session.payload.role
      : resolveEffectiveRoomRole(room, session.payload.participantId, session.payload.role);
    const blockReason = getSessionControlBlockReason(room, session.payload.participantId, effectiveRole, true);
    if (blockReason) {
      return json(response, 403, { error: "room_access_denied", reason: blockReason });
    }
    const publish = (current: RoomEffectActor | null, upsert = upsertPresence) => {
      upsert(roomId, participantId, {
        ...payload,
        participantId,
        updatedAt: new Date().toISOString(),
        role: current?.role ?? effectiveRole,
        permissions: current?.permissions ?? getRoomPermissions(effectiveRole)
      });
      json(response, 200, { ok: true });
    };
    if (session.payload.identityProtocolVersion === 2) {
      if (!room) return json(response, 404, { error: "room_not_found" });
      const actorResult = resolveControlPlaneActor(request);
      if (!actorResult.ok) return json(response, 403, { error: "forbidden" });
      // Publish before this callback resolves: remove/end must be ordered after
      // the map write, not between a returned authority snapshot and the write.
      await runGuardedRoomEffect(storage, actorResult.actor, room, "room.join", async (scoped, current) => { scoped.releaseResponse(() => { publish(current); }); });
    } else {
      if (!room) {
        // The original session deadline is checked inside the fence; the virtual map write is its sync release.
        await runLegacyVirtualRoomEffect(storage, roomId, { expiresAtSeconds: session.payload.exp },
          async scoped => { scoped.releaseResponse(() => { publish(null, virtualPresence.upsertPresence); }); });
        return;
      }
      await runLegacyRoomEffect(storage, room, {}, async scoped => { scoped.releaseResponse(() => { publish(null); }); });
    }
    return;
  }

  if (method === "DELETE" && presenceItemMatch) {
    const roomId = decodeURIComponent(presenceItemMatch[1]);
    const participantId = decodeURIComponent(presenceItemMatch[2]);
    const session = await verifyRoomSessionRequest(request, { roomId, participantId });
    if (!session.ok) return writeSessionTokenError(response, session);
    const room = await storage.getRoom(roomId);
    // Map removal happens only in the release of the fence matching the room's namespace.
    const remove = (target = deletePresence) => { target(roomId, participantId); json(response, 200, { ok: true }); };
    if (session.payload.identityProtocolVersion === 2) {
      if (!room) return json(response, 404, { error: "room_not_found" });
      const actorResult = resolveControlPlaneActor(request);
      if (!actorResult.ok) return json(response, 403, { error: "forbidden" });
      await runGuardedRoomEffect(storage, actorResult.actor, room, "room.join", async scoped => { scoped.releaseResponse(() => { remove(); }); });
    } else if (room) {
      await runLegacyRoomEffect(storage, room, {}, async scoped => { scoped.releaseResponse(() => { remove(); }); });
    } else {
      await runLegacyVirtualRoomEffect(storage, roomId, { expiresAtSeconds: session.payload.exp },
        async scoped => { scoped.releaseResponse(() => { remove(virtualPresence.deletePresence); }); });
    }
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
    const diagnostic = createDiagnosticRecord(payload, getRequestId(request));
    const room = await storage.getRoom(roomId);
    if (session.payload.identityProtocolVersion === 2) {
      if (!room) return json(response, 404, { error: "room_not_found" });
      const actorResult = resolveControlPlaneActor(request);
      if (!actorResult.ok || actorResult.actor.actorType !== "room-session"
        || actorResult.actor.identityProtocolVersion !== 2) return json(response, 403, { error: "forbidden" });
      // Serialize INSERT and retention across writers under the upfront room lock.
      await runGuardedRoomEffect(storage, actorResult.actor, room, "room.join",
        scoped => scoped.addDiagnostic(roomId, diagnostic), { roomWrite: true });
    } else if (room) {
      await runLegacyRoomEffect(storage, room, { roomWrite: true }, scoped => scoped.addDiagnostic(roomId, diagnostic));
    } else {
      await runLegacyVirtualRoomEffect(storage, roomId, { roomWrite: true, expiresAtSeconds: session.payload.exp },
        scoped => scoped.addDiagnostic(roomId, diagnostic));
    }
    publishDiagnosticRecord(roomId, diagnostic);
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
    // Select the namespace before preparing items. A missing room's DB leftovers
    // and virtual live state are released only to the verified administrator.
    const room = await storage.getRoom(roomId);
    if (!room) {
      if (actor.actorType !== "admin-token") return json(response, 404, { error: "room_not_found" });
      json(response, 200, { items: await virtualXrTelemetry.listXrTelemetry(roomId) });
      return;
    }
    // Prepare outside the fence; release only under current room authority.
    const items = await listXrTelemetry(roomId);
    const send = () => { json(response, 200, { items }); };
    await runGuardedRoomEffect(storage, actor, room, "room.join", async scoped => { scoped.releaseResponse(send); }, { hostOrOwner: true });
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
    const room = await storage.getRoom(roomId);
    // The fence writes only through scoped storage; idle still releases a no-op
    // so Memory rechecks authority. The response waits for commit and map apply.
    // Retention writers serialize up front; idle keeps the shared mode.
    const effect = async (scoped: VirtualRoomEffectStorage, record: XrTelemetryRecord, persist: boolean) => {
      if (persist) await scoped.addXrTelemetry(roomId, participantId, record as unknown as Record<string, unknown>);
      else scoped.releaseResponse(() => {});
    };
    let commit: (record: XrTelemetryRecord, persist: boolean) => Promise<void>;
    let upsert = upsertXrTelemetryWithFence;
    if (session.payload.identityProtocolVersion === 2) {
      if (!room) return json(response, 404, { error: "room_not_found" });
      const actorResult = resolveControlPlaneActor(request);
      if (!actorResult.ok || actorResult.actor.actorType !== "room-session"
        || actorResult.actor.identityProtocolVersion !== 2) return json(response, 403, { error: "forbidden" });
      const actor = actorResult.actor;
      commit = (record, persist) => runGuardedRoomEffect(storage, actor, room, "room.join",
        scoped => effect(scoped, record, persist), { roomWrite: persist });
    } else if (room) {
      commit = (record, persist) => runLegacyRoomEffect(storage, room, { roomWrite: persist }, scoped => effect(scoped, record, persist));
    } else {
      // Same FIFO, caps and commit-first order; only the live namespace differs.
      const expiresAtSeconds = session.payload.exp;
      upsert = virtualXrTelemetry.upsertXrTelemetryWithFence;
      commit = (record, persist) => runLegacyVirtualRoomEffect(storage, roomId, { roomWrite: persist, expiresAtSeconds },
        scoped => effect(scoped, record, persist));
    }
    await upsert(roomId, participantId, payload, commit);
    json(response, 200, { ok: true });
    return;
  }

  if (method === "GET" && roomItemMatch) {
    const room = await storage.getRoom(decodeURIComponent(roomItemMatch[1]));
    if (!room) return json(response, 404, { error: "room_not_found" });
    if (isRoomDisabled(room) && !canManageDisabledRoom(request)) return json(response, 403, { error: "room_access_denied", reason: "room_disabled" });
    if (!(await canReadRoomDetails(request, room))) return json(response, 404, { error: "room_not_found" });
    const metadata = { ...roomResponseRecord(request, room), roomLink: createRoomLink(room.roomId, request), manifest: await buildManifest(room.roomId, request, room) };
    const readActor = resolveControlPlaneActor(request);
    const owner: { currentOwnerParticipantId?: string | null } = readActor.ok && readActor.actor.actorType === "admin-token"
      ? { currentOwnerParticipantId: await adminCurrentOwnerParticipantId(storage, room, await legacyIdentityBoundary.minimum()) } : {};
    await releaseRoomRead(request, storage, room.roomId, room, () => { json(response, 200, { ...metadata, ...owner }); });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/state") {
    const requestPayload = await parseBody<StateTokenRequest>(request);
    if (await legacyIdentityBoundary.minimum() >= 2) {
      const v2Payload = requestPayload as V2AdmissionRequest | null;
      const roomId = requestPayload?.roomId ?? "demo-room";
      const room = await storage.getRoom(roomId);
      if (room && v2Payload?.identityProtocolVersion === 2 && v2Payload.identityCredential === undefined
        && v2Payload.waitingCredential === undefined && v2Payload.recoveryCredential === undefined
        && !await storage.reserveIdentityAdmission({ originHash: identityAdmissionOriginHash(request), kind: "room" })) {
        return json(response, 429, { error: "room_access_denied", reason: "identity_rate_limited" });
      }
      const result = await admitV2RoomSession({ storage, room, payload: v2Payload,
        bearer: getBearerToken(request), secret: getStateTokenSecret(), hashInvite: token => hashInviteToken(token) });
      return json(response, result.status, result.body);
    }
    const ttlSeconds = Number.parseInt(process.env.STATE_TOKEN_TTL_SECONDS ?? "900", 10);
    const legacyRequest = parseLegacyStateTokenRequest(requestPayload);
    if (!legacyRequest) return json(response, 400, { error: "invalid_state_token_request" });
    const { roomId } = legacyRequest;
    await legacyIdentityBoundary.assertCompatible(roomId);
    const room = await storage.getRoom(roomId);
    const requested = resolveAccessRole(legacyRequest.requestedRole);
    if (!room) {
      const { role, roleSource } = requested;
      const participantId = legacyRequest.explicitParticipantId ?? randomUUID();
      const displayName = legacyRequest.displayName ?? participantId;
      await releaseVirtualStateToken(storage, roomId, () => {
        json(response, 200, createRoomAccessTokenResponse({ room: null, roomId, participantId, displayName, role, roleSource,
          ttlSeconds, nowSeconds: Math.floor(Date.now() / 1000) }));
      });
      return;
    }
    await admitLegacyStateToken(request, response, storage, room, legacyRequest, requested, ttlSeconds, requestId);
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
    const effectiveRole = session.payload.identityProtocolVersion === 2 ? session.payload.role
      : resolveEffectiveRoomRole(room, session.payload.participantId, session.payload.role);
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
    const mediaNamespace = session.payload.identityProtocolVersion === 2
      ? await storage.identityProtocol.mediaNamespace() : null;
    if (session.payload.identityProtocolVersion === 2 && !mediaNamespace) {
      return json(response, 503, { error: "identity_authority_unavailable" });
    }
    accessToken.addGrant({
      room: roomMediaGrantName(session.payload.roomId, process.env.LIVEKIT_ROOM_PREFIX ?? "vrata-", mediaNamespace),
      roomJoin: true,
      canPublish: canPublishAudio || canPublishVideo,
      canSubscribe: true
    });
    const mediaToken = await finalizeRoomToken(request, session, payload.sessionToken, () => accessToken.toJwt());
    json(response, 200, {
      token: mediaToken,
      expiresInSeconds: Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10),
      livekitUrl: getDefaultLivekitUrl(request)
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/remote-browser-media") {
    if (!isAuthorizedRemoteBrowserRequest(request)) {
      json(response, 403, { error: "forbidden" });
      return;
    }
    if (!isRemoteBrowserFeatureEnabled()) {
      return json(response, 503, { error: "remote_browser_disabled" });
    }
    const payload = (await parseBody<RemoteBrowserMediaTokenRequest>(request)) ?? {};
    if (!payload.roomId || !payload.objectId || !payload.executorSessionId || !payload.executorInstanceId || !payload.mediaParticipantId) {
      json(response, 400, { error: "remote_browser_media_token_payload_required" });
      return;
    }
    const v2Media = await legacyIdentityBoundary.minimum() >= 2;
    if (!v2Media) await legacyIdentityBoundary.assertCompatible(payload.roomId);
    else if (!await storage.getRoom(payload.roomId)) return json(response, 404, { error: "room_not_found" });
    if (!isRemoteBrowserIdentityBinding({ objectId: payload.objectId, executorSessionId: payload.executorSessionId, executorInstanceId: payload.executorInstanceId, mediaParticipantId: payload.mediaParticipantId })) {
      return json(response, 400, { error: "invalid_session_binding" });
    }
    if (!await verifyRemoteBrowserAuthority({ roomId: payload.roomId, objectId: payload.objectId, executorSessionId: payload.executorSessionId, executorInstanceId: payload.executorInstanceId, mediaParticipantId: payload.mediaParticipantId })) {
      return json(response, 409, { error: "remote_browser_session_not_authoritative" });
    }
    const configError = getMediaTokenConfigError();
    if (configError) {
      incrementCounter(metrics.mediaJoinFailuresTotal, "livekit_config_invalid");
      return json(response, 503, { error: "livekit_config_invalid", reason: configError });
    }
    const ttlSeconds = Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECONDS ?? "900", 10);
    const { apiKey, apiSecret } = getLivekitCredentials();
    const mediaNamespace = v2Media ? await storage.identityProtocol.mediaNamespace() : null;
    if (v2Media && !mediaNamespace) return json(response, 503, { error: "identity_authority_unavailable" });
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity: payload.mediaParticipantId,
      name: `Remote Browser ${payload.objectId}`,
      ttl: `${ttlSeconds}s`
    });
    accessToken.addGrant({
      room: roomMediaGrantName(payload.roomId, process.env.LIVEKIT_ROOM_PREFIX ?? "vrata-", mediaNamespace),
      roomJoin: true,
      canPublish: true,
      canSubscribe: false
    });
    const executorToken = await accessToken.toJwt();
    if (v2Media) {
      const currentRoom = await storage.getRoom(payload.roomId);
      if (!currentRoom || isRoomDisabled(currentRoom)) return json(response, 403, { error: "room_access_denied", reason: "room_disabled" });
      const authority = await storage.roomIdentities.authority({ tenantId: currentRoom.tenantId, roomId: payload.roomId });
      if (!authority || authority.lifecycle.endedAt) return json(response, 409, { error: "remote_browser_session_not_authoritative" });
      if (!await verifyRemoteBrowserAuthority({ roomId: payload.roomId, objectId: payload.objectId,
        executorSessionId: payload.executorSessionId, executorInstanceId: payload.executorInstanceId,
        mediaParticipantId: payload.mediaParticipantId })) {
        return json(response, 409, { error: "remote_browser_session_not_authoritative" });
      }
    }
    json(response, 200, {
      token: executorToken,
      expiresInSeconds: ttlSeconds,
      livekitUrl: getRemoteBrowserLivekitUrl(request, payload),
      participantId: payload.mediaParticipantId
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/tokens/remote-browser-frame") {
    if (!isRemoteBrowserFeatureEnabled()) {
      return json(response, 503, { error: "remote_browser_disabled" });
    }
    const payload = await parseBody<RemoteBrowserFrameTokenRequest>(request);
    if (!payload?.roomId || !payload.objectId || !payload.executorSessionId || !payload.executorInstanceId || !payload.frameStreamId) {
      json(response, 400, { error: "remote_browser_frame_token_payload_required" });
      return;
    }
    if (!isRemoteBrowserIdentityBinding({ objectId: payload.objectId, executorSessionId: payload.executorSessionId, executorInstanceId: payload.executorInstanceId, frameStreamId: payload.frameStreamId })) {
      return json(response, 400, { error: "invalid_session_binding" });
    }
    const session = await verifyRoomSessionRequest(request, {
      roomId: payload.roomId,
      sessionToken: payload.sessionToken
    });
    if (!session.ok) return writeSessionTokenError(response, session);
    if (!hasRoomPermission(session.payload.permissions, "surface.view")) {
      return json(response, 403, { error: "forbidden", reason: "remote_browser_frame_not_allowed" });
    }
    if (!await verifyRemoteBrowserAuthority({ roomId: payload.roomId, objectId: payload.objectId, executorSessionId: payload.executorSessionId, executorInstanceId: payload.executorInstanceId, frameStreamId: payload.frameStreamId })) {
      return json(response, 409, { error: "remote_browser_session_not_authoritative" });
    }
    if (!getRemoteBrowserFrameTokenSecret()) {
      return json(response, 503, { error: "remote_browser_token_config_invalid" });
    }
    const ttlSeconds = resolveRemoteBrowserTokenTtlSeconds();
    const token = await finalizeRoomToken(request, session, payload.sessionToken, async () => encodeRemoteBrowserFrameToken({
      roomId: payload.roomId!, objectId: payload.objectId!, executorSessionId: payload.executorSessionId!,
      frameStreamId: payload.frameStreamId!, exp: Math.floor(Date.now() / 1000) + ttlSeconds
    }));
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
  getStateTokenSecret();
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      // A fenced response can already have queued its bytes when COMMIT fails.
      // Do not attempt a second response or throw ERR_HTTP_HEADERS_SENT.
      if (response.headersSent) {
        metrics.requestFailuresTotal += 1;
        response.destroy();
        return;
      }
      if (error instanceof InvalidSessionTokenInput) {
        json(response, 400, { error: "invalid_session_token" });
        return;
      }
      if (error instanceof IdentityBoundaryError) {
        json(response, error.status, { error: error.status === 503 ? "identity_authority_unavailable"
          : error.reason === "identity_session_expired" || error.reason === "room_state_changed" ? error.reason : "identity_required",
          reason: error.reason });
        return;
      }
      if (error instanceof RoomEffectPermissionDenied) {
        json(response, 403, { error: "forbidden", reason: "permission_denied" });
        return;
      }
      if (error instanceof RoomEffectNotFound || error instanceof InvalidVirtualRoomId) {
        json(response, 404, { error: "room_not_found" });
        return;
      }
      if (error instanceof XrTelemetryQueueFull) {
        json(response, 429, { error: "xr_telemetry_queue_full" });
        return;
      }
      if (error instanceof Error && error.message === IDENTITY_LIFECYCLE_REQUIRES_V2) {
        json(response, 409, { error: "identity_required", reason: "identity_upgrade_required" });
        return;
      }
      const requestId = attachRequestId(request, response);
      const roomDeletionFailure = isRoomDeletionRequest(request.method, request.url);
      metrics.requestFailuresTotal += 1;
      logEvent({
        service: "api",
        event: "request_failed",
        env: process.env.NODE_ENV ?? "development",
        requestId,
        errorCode: "internal_error",
        path: request.url ?? "",
        method: request.method ?? "GET",
        message: roomDeletionFailure ? "room_delete_failed" : error instanceof Error ? error.message : "unknown",
        timestamp: new Date().toISOString()
      });
      json(response, 500, roomDeletionFailure ? { error: "internal_error" } : { error: "internal_error", message: error instanceof Error ? error.message : "unknown" });
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
