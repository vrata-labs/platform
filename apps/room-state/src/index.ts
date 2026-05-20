import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";
import {
  REMOTE_BROWSER_OBJECT_TYPE,
  getRoomPermissions,
  hasRoomPermission,
  isRoomRole,
  parseRoomRole,
  type MediaObjectCommandResult,
  type RemoteBrowserObjectState,
  type RemoteBrowserPatch,
  type RoomPermission,
  type RoomRole
} from "@noah/shared-types";

import type { PresenceState } from "./schema.js";
import {
  claimSeat,
  createMediaObject,
  createRoomState,
  joinRoom,
  leaveRoom,
  patchMediaObjectState,
  patchRemoteBrowserExecutorState,
  releaseSeat,
  serializeRoomState,
  setSurfaceMediaAudioEnabled,
  stopMediaObject,
  updateParticipantState,
  type ParticipantAccessState,
  type RoomState
} from "./state.js";

interface AvatarReliableStatePayload {
  participantId: string;
  avatarId: string;
  recipeVersion: 1;
  inputMode: string;
  seated: boolean;
  seatId?: string;
  muted: boolean;
  audioActive: boolean;
  updatedAt: string;
}

interface CompactPoseFramePayload {
  seq: number;
  sentAtMs: number;
  flags: number;
  root: { x: number; y: number; z: number; yaw: number; vx: number; vz: number };
  head: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
  leftHand: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; gesture: number };
  rightHand: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; gesture: number };
  locomotion: { mode: number; speed: number; angularVelocity: number };
}

export interface RoomStateServer {
  rooms: Map<string, RoomState>;
  clients: Map<string, Set<WebSocket>>;
  avatarReliableStates: Map<string, Map<string, AvatarReliableStatePayload>>;
  socketParticipants: Map<WebSocket, { roomId: string; participantId: string; access: ParticipantAccessState }>;
  pendingDisconnects: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
}

interface RoomAccessTokenPayload {
  roomId: string;
  participantId: string;
  displayName: string;
  role: RoomRole;
  permissions: RoomPermission[];
  exp: number;
}

const DISCONNECT_GRACE_MS = 1500;

export interface SeatClaimResultPayload {
  seatId: string;
  accepted: boolean;
  occupantId: string | null;
  previousSeatId: string | null;
}

export interface PrivilegedRoomCommandResultPayload {
  accepted: boolean;
  permission: RoomPermission;
  role: RoomRole;
}

export type MediaObjectCommandResultPayload = MediaObjectCommandResult;

interface RemoteBrowserExecutorPatchRequest {
  roomId?: string;
  surfaceId?: string;
  objectId?: string;
  commandId?: string;
  patch?: unknown;
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

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
      if (bytes > 64 * 1024) {
        reject(new Error("payload_too_large"));
        request.destroy();
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
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function getInternalServiceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.NOAH_INTERNAL_SERVICE_TOKEN?.trim() || env.REMOTE_BROWSER_INTERNAL_TOKEN?.trim() || "";
  return token || null;
}

function isAuthorizedInternalRequest(request: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  const token = getInternalServiceToken(env);
  if (!token) {
    return true;
  }
  const provided = request.headers["x-noah-internal-token"];
  return typeof provided === "string" && safeEqual(provided, token);
}

function getInternalFetchHeaders(): Record<string, string> {
  const token = getInternalServiceToken();
  return {
    "content-type": "application/json",
    ...(token ? { "x-noah-internal-token": token } : {})
  };
}

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
  const explicit = isEnabledEnvValue(env.NOAH_DEV_ROLE_QUERY ?? env.FEATURE_DEV_ROLE_QUERY);
  if (explicit !== null) {
    return explicit;
  }
  return env.NODE_ENV !== "production";
}

function defaultAccess(role: RoomRole = "guest"): ParticipantAccessState {
  return {
    role,
    permissions: getRoomPermissions(role)
  };
}

function signAccessTokenBody(body: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.STATE_TOKEN_SECRET ?? "dev-state-secret";
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseAccessTokenPayload(input: unknown): RoomAccessTokenPayload | null {
  if (!isObjectRecord(input)) {
    return null;
  }
  const permissions = Array.isArray(input.permissions) ? input.permissions : [];
  if (typeof input.roomId !== "string"
    || typeof input.participantId !== "string"
    || typeof input.displayName !== "string"
    || !isRoomRole(input.role)
    || typeof input.exp !== "number"
    || !permissions.every((permission) => typeof permission === "string")) {
    return null;
  }
  return {
    roomId: input.roomId,
    participantId: input.participantId,
    displayName: input.displayName,
    role: input.role,
    permissions: getRoomPermissions(input.role),
    exp: input.exp
  };
}

function decodeAccessToken(token: string | null, env: NodeJS.ProcessEnv = process.env): RoomAccessTokenPayload | null {
  if (!token) {
    return null;
  }
  const [body, signature] = token.split(".");
  if (!body || !signature || !safeEqual(signAccessTokenBody(body, env), signature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const parsed = parseAccessTokenPayload(payload);
    if (!parsed || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveConnectionAccess(url: URL, roomId: string, participantId: string, env: NodeJS.ProcessEnv = process.env): ParticipantAccessState {
  const tokenAccess = decodeAccessToken(url.searchParams.get("accessToken"), env);
  if (tokenAccess?.roomId === roomId && tokenAccess.participantId === participantId) {
    return defaultAccess(tokenAccess.role);
  }
  if (isDevRoleQueryAllowed(env)) {
    return defaultAccess(parseRoomRole(url.searchParams.get("role"), "guest"));
  }
  return defaultAccess("guest");
}

export function createRoomStateServer(): RoomStateServer {
  return {
    rooms: new Map<string, RoomState>(),
    clients: new Map<string, Set<WebSocket>>(),
    avatarReliableStates: new Map<string, Map<string, AvatarReliableStatePayload>>(),
    socketParticipants: new Map<WebSocket, { roomId: string; participantId: string; access: ParticipantAccessState }>(),
    pendingDisconnects: new Map<string, Map<string, ReturnType<typeof setTimeout>>>()
  };
}

function cancelPendingDisconnect(server: RoomStateServer, roomId: string, participantId: string): void {
  const roomTimers = server.pendingDisconnects.get(roomId);
  const timer = roomTimers?.get(participantId);
  if (timer) {
    clearTimeout(timer);
    roomTimers?.delete(participantId);
  }
  if (roomTimers && roomTimers.size === 0) {
    server.pendingDisconnects.delete(roomId);
  }
}

function scheduleDisconnectCleanup(server: RoomStateServer, roomId: string, participantId: string): void {
  cancelPendingDisconnect(server, roomId, participantId);
  const roomTimers = server.pendingDisconnects.get(roomId) ?? new Map<string, ReturnType<typeof setTimeout>>();
  const timer = setTimeout(() => {
    const room = server.rooms.get(roomId);
    if (room) {
      for (const object of Object.values(room.mediaObjects.objects)) {
        if (object.type === REMOTE_BROWSER_OBJECT_TYPE && object.ownerParticipantId === participantId) {
          stopRemoteBrowserSession((object.state as RemoteBrowserObjectState).executorSessionId);
        }
      }
      server.rooms.set(roomId, leaveRoom(room, participantId));
    }
    getRoomReliableStates(server, roomId).delete(participantId);
    const nextRoomTimers = server.pendingDisconnects.get(roomId);
    nextRoomTimers?.delete(participantId);
    if (nextRoomTimers && nextRoomTimers.size === 0) {
      server.pendingDisconnects.delete(roomId);
    }
    broadcastRoom(server, roomId);
  }, DISCONNECT_GRACE_MS);
  roomTimers.set(participantId, timer);
  server.pendingDisconnects.set(roomId, roomTimers);
}

function hasOtherParticipantSocket(server: RoomStateServer, roomId: string, participantId: string, excludedSocket: WebSocket): boolean {
  for (const client of server.clients.get(roomId) ?? []) {
    if (client === excludedSocket) {
      continue;
    }
    const metadata = server.socketParticipants.get(client);
    if (metadata?.roomId === roomId && metadata.participantId === participantId) {
      return true;
    }
  }
  return false;
}

function isObjectRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object";
}

function isCompactPoseFramePayload(input: unknown): input is CompactPoseFramePayload {
  if (!isObjectRecord(input)) {
    return false;
  }
  const root = input.root;
  const head = input.head;
  const leftHand = input.leftHand;
  const rightHand = input.rightHand;
  const locomotion = input.locomotion;
  return isObjectRecord(root)
    && isObjectRecord(head)
    && isObjectRecord(leftHand)
    && isObjectRecord(rightHand)
    && isObjectRecord(locomotion)
    && typeof input.seq === "number"
    && typeof input.sentAtMs === "number"
    && typeof input.flags === "number"
    && typeof root.x === "number"
    && typeof root.y === "number"
    && typeof root.z === "number"
    && typeof root.yaw === "number"
    && typeof root.vx === "number"
    && typeof root.vz === "number"
    && typeof head.x === "number"
    && typeof head.y === "number"
    && typeof head.z === "number"
    && typeof leftHand.x === "number"
    && typeof leftHand.y === "number"
    && typeof leftHand.z === "number"
    && typeof leftHand.gesture === "number"
    && typeof rightHand.x === "number"
    && typeof rightHand.y === "number"
    && typeof rightHand.z === "number"
    && typeof rightHand.gesture === "number"
    && typeof locomotion.mode === "number"
    && typeof locomotion.speed === "number"
    && typeof locomotion.angularVelocity === "number";
}

function isAvatarReliableStatePayload(input: unknown): input is AvatarReliableStatePayload {
  if (!isObjectRecord(input)) {
    return false;
  }
  return typeof input.participantId === "string"
    && typeof input.avatarId === "string"
    && input.recipeVersion === 1
    && typeof input.inputMode === "string"
    && typeof input.seated === "boolean"
    && typeof input.muted === "boolean"
    && typeof input.audioActive === "boolean"
    && typeof input.updatedAt === "string";
}

function ensureRoom(server: RoomStateServer, roomId: string): RoomState {
  const existing = server.rooms.get(roomId);
  if (existing) {
    return existing;
  }
  const room = createRoomState(roomId);
  server.rooms.set(roomId, room);
  return room;
}

function broadcastRoom(server: RoomStateServer, roomId: string): void {
  const room = server.rooms.get(roomId);
  const payload = JSON.stringify({ type: "room_state", room: room ? serializeRoomState(room) : null });
  for (const client of server.clients.get(roomId) ?? []) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function getRoomReliableStates(server: RoomStateServer, roomId: string): Map<string, AvatarReliableStatePayload> {
  const existing = server.avatarReliableStates.get(roomId);
  if (existing) {
    return existing;
  }
  const created = new Map<string, AvatarReliableStatePayload>();
  server.avatarReliableStates.set(roomId, created);
  return created;
}

function sendToSocket(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcastToRoom(server: RoomStateServer, roomId: string, payload: unknown): void {
  for (const client of server.clients.get(roomId) ?? []) {
    sendToSocket(client, payload);
  }
}

export function connectParticipant(server: RoomStateServer, roomId: string, participantId: string, socket: WebSocket, access: ParticipantAccessState = defaultAccess()): void {
  cancelPendingDisconnect(server, roomId, participantId);
  const room = ensureRoom(server, roomId);
  server.rooms.set(roomId, joinRoom(room, participantId, access));
  const set = server.clients.get(roomId) ?? new Set<WebSocket>();
  set.add(socket);
  server.clients.set(roomId, set);
  server.socketParticipants.set(socket, { roomId, participantId, access });
  broadcastRoom(server, roomId);
  for (const reliableState of getRoomReliableStates(server, roomId).values()) {
    sendToSocket(socket, {
      type: "avatar_reliable_state",
      reliableState
    });
  }
}

export function disconnectParticipant(server: RoomStateServer, roomId: string, participantId: string, socket: WebSocket): void {
  const set = server.clients.get(roomId);
  set?.delete(socket);
  server.socketParticipants.delete(socket);
  if (!hasOtherParticipantSocket(server, roomId, participantId, socket)) {
    scheduleDisconnectCleanup(server, roomId, participantId);
    return;
  }
  broadcastRoom(server, roomId);
}

export function applyParticipantUpdate(server: RoomStateServer, roomId: string, nextState: Partial<PresenceState> & { participantId: string }): void {
  const room = ensureRoom(server, roomId);
  server.rooms.set(roomId, updateParticipantState(room, {
    ...nextState,
    serverTimeMs: Date.now()
  }));
  broadcastRoom(server, roomId);
}

export function applyPrivilegedRoomCommand(server: RoomStateServer, roomId: string, participantId: string, permission: RoomPermission): PrivilegedRoomCommandResultPayload {
  const room = ensureRoom(server, roomId);
  const participant = room.participants.find((item) => item.participantId === participantId);
  const role = participant?.role ?? "guest";
  const permissions = participant?.permissions ?? getRoomPermissions(role);
  return {
    accepted: hasRoomPermission(permissions, permission),
    permission,
    role
  };
}

export function applyMediaObjectCreateCommand(server: RoomStateServer, roomId: string, participantId: string, input: {
  commandId?: string;
  surfaceId?: string;
  objectType?: string;
}): MediaObjectCommandResultPayload {
  const room = ensureRoom(server, roomId);
  const result = createMediaObject(room, participantId, {
    commandId: input.commandId?.trim() || randomUUID(),
    surfaceId: input.surfaceId?.trim() || "debug-main",
    objectType: input.objectType?.trim() || "surface-test-card",
    objectId: randomUUID(),
    nowMs: Date.now()
  });
  server.rooms.set(roomId, result.room);
  if (result.result.accepted) {
    broadcastRoom(server, roomId);
  }
  return result.result;
}

export function applyMediaObjectStopCommand(server: RoomStateServer, roomId: string, participantId: string, input: {
  commandId?: string;
  surfaceId?: string;
  objectId?: string;
}): MediaObjectCommandResultPayload {
  const room = ensureRoom(server, roomId);
  const objectId = input.objectId?.trim() || "";
  const remoteBrowserSessionId = getRemoteBrowserObjectState(server, roomId, objectId)?.executorSessionId ?? null;
  const result = stopMediaObject(room, participantId, {
    commandId: input.commandId?.trim() || randomUUID(),
    surfaceId: input.surfaceId?.trim() || "debug-main",
    objectId
  });
  server.rooms.set(roomId, result.room);
  if (result.result.accepted) {
    if (result.result.objectType === REMOTE_BROWSER_OBJECT_TYPE) {
      stopRemoteBrowserSession(remoteBrowserSessionId);
    }
    broadcastRoom(server, roomId);
  }
  return result.result;
}

export function applyMediaObjectPatchCommand(server: RoomStateServer, roomId: string, participantId: string, input: {
  commandId?: string;
  surfaceId?: string;
  objectId?: string;
  expectedRevision?: number;
  patch?: unknown;
}): MediaObjectCommandResultPayload {
  const room = ensureRoom(server, roomId);
  const result = patchMediaObjectState(room, participantId, {
    commandId: input.commandId?.trim() || randomUUID(),
    surfaceId: input.surfaceId?.trim() || "debug-main",
    objectId: input.objectId?.trim() || "",
    expectedRevision: typeof input.expectedRevision === "number" ? input.expectedRevision : -1,
    patch: input.patch,
    nowMs: Date.now()
  });
  server.rooms.set(roomId, result.room);
  if (result.result.accepted) {
    if (result.result.objectType === REMOTE_BROWSER_OBJECT_TYPE) {
      forwardRemoteBrowserPatch(server, roomId, result.result.objectId, input.patch);
    }
    broadcastRoom(server, roomId);
  }
  return result.result;
}

export function applyRemoteBrowserExecutorPatchCommand(server: RoomStateServer, input: {
  roomId?: string;
  surfaceId?: string;
  objectId?: string;
  executorSessionId?: string;
  commandId?: string;
  patch?: unknown;
}): MediaObjectCommandResultPayload {
  const roomId = input.roomId?.trim() || "demo-room";
  const room = ensureRoom(server, roomId);
  const result = patchRemoteBrowserExecutorState(room, {
    commandId: input.commandId?.trim() || randomUUID(),
    surfaceId: input.surfaceId?.trim() || "debug-main",
    objectId: input.objectId?.trim() || "",
    executorSessionId: input.executorSessionId?.trim() || "",
    patch: input.patch,
    nowMs: Date.now()
  });
  server.rooms.set(roomId, result.room);
  if (result.result.accepted) {
    broadcastRoom(server, roomId);
  }
  return result.result;
}

export function applySurfaceMediaAudioCommand(server: RoomStateServer, roomId: string, participantId: string, input: {
  commandId?: string;
  surfaceId?: string;
  enabled?: boolean;
}): MediaObjectCommandResultPayload {
  const room = ensureRoom(server, roomId);
  const result = setSurfaceMediaAudioEnabled(room, participantId, {
    commandId: input.commandId?.trim() || randomUUID(),
    surfaceId: input.surfaceId?.trim() || "debug-main",
    enabled: input.enabled === true
  });
  server.rooms.set(roomId, result.room);
  if (result.result.accepted) {
    broadcastRoom(server, roomId);
  }
  return result.result;
}

export function applyAvatarReliableState(server: RoomStateServer, roomId: string, participantId: string, reliableState: unknown): void {
  if (!isAvatarReliableStatePayload(reliableState)) {
    throw new Error("invalid_avatar_reliable_state");
  }
  const sanitizedState: AvatarReliableStatePayload = {
    ...reliableState,
    participantId
  };
  getRoomReliableStates(server, roomId).set(participantId, sanitizedState);
  broadcastToRoom(server, roomId, {
    type: "avatar_reliable_state",
    reliableState: sanitizedState
  });
}

export function applySeatClaim(server: RoomStateServer, roomId: string, participantId: string, seatId: string): SeatClaimResultPayload {
  if (typeof seatId !== "string" || seatId.trim().length === 0) {
    throw new Error("invalid_seat_claim");
  }
  const room = ensureRoom(server, roomId);
  const result = claimSeat(room, participantId, seatId.trim());
  server.rooms.set(roomId, result.room);
  if (result.accepted) {
    broadcastRoom(server, roomId);
  }
  return {
    seatId: result.seatId,
    accepted: result.accepted,
    occupantId: result.occupantId,
    previousSeatId: result.previousSeatId
  };
}

export function applySeatRelease(server: RoomStateServer, roomId: string, participantId: string, seatId?: string): string | null {
  if (seatId !== undefined && (typeof seatId !== "string" || seatId.trim().length === 0)) {
    throw new Error("invalid_seat_release");
  }
  const room = ensureRoom(server, roomId);
  const result = releaseSeat(server.rooms.get(roomId) ?? room, participantId, seatId?.trim());
  server.rooms.set(roomId, result.room);
  if (result.releasedSeatId) {
    broadcastRoom(server, roomId);
  }
  return result.releasedSeatId;
}

export function relayAvatarPoseFrame(server: RoomStateServer, roomId: string, participantId: string, poseFrame: unknown): void {
  if (!isCompactPoseFramePayload(poseFrame)) {
    throw new Error("invalid_avatar_pose_preview");
  }
  broadcastToRoom(server, roomId, {
    type: "avatar_pose_preview",
    participantId,
    poseFrame
  });
}

function getRemoteBrowserInternalUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.REMOTE_BROWSER_INTERNAL_URL?.trim();
  return url && /^https?:\/\//.test(url) ? url.replace(/\/$/, "") : null;
}

function getRemoteBrowserObjectState(server: RoomStateServer, roomId: string, objectId?: string | null): RemoteBrowserObjectState | null {
  if (!objectId) {
    return null;
  }
  const object = server.rooms.get(roomId)?.mediaObjects.objects[objectId];
  if (object?.type !== REMOTE_BROWSER_OBJECT_TYPE) {
    return null;
  }
  return object.state as RemoteBrowserObjectState;
}

function forwardRemoteBrowserPatch(server: RoomStateServer, roomId: string, objectId: string | null | undefined, patch: unknown): void {
  const baseUrl = getRemoteBrowserInternalUrl();
  if (!baseUrl || !patch || typeof patch !== "object") {
    return;
  }
  const state = getRemoteBrowserObjectState(server, roomId, objectId);
  if (!state?.executorSessionId || !state.mediaParticipantId) {
    return;
  }
  const remotePatch = patch as RemoteBrowserPatch;
  const request = remotePatch.type === "open-url"
    ? fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: getInternalFetchHeaders(),
      body: JSON.stringify({
        sessionId: state.executorSessionId,
        frameStreamId: state.frameStreamId,
        mediaParticipantId: state.mediaParticipantId,
        roomId,
        objectId,
        url: remotePatch.url
      })
    })
    : remotePatch.type === "pointer" || remotePatch.type === "scroll" || remotePatch.type === "keyboard"
      ? fetch(`${baseUrl}/api/sessions/${encodeURIComponent(state.executorSessionId)}/input`, {
        method: "POST",
        headers: getInternalFetchHeaders(),
        body: JSON.stringify(remotePatch)
      })
      : null;
  if (!request) {
    return;
  }
  request.then((response) => {
    if (response.ok) {
      return;
    }
    logEvent({
      service: "room-state",
      env: process.env.NODE_ENV ?? "development",
      errorCode: "remote_browser_forward_rejected",
      roomId,
      objectId,
      patchType: remotePatch.type,
      status: response.status,
      timestamp: new Date().toISOString()
    });
  }).catch((error: unknown) => {
    logEvent({
      service: "room-state",
      env: process.env.NODE_ENV ?? "development",
      errorCode: "remote_browser_forward_failed",
      roomId,
      objectId,
      message: error instanceof Error ? error.message : "unknown",
      timestamp: new Date().toISOString()
    });
  });
}

function stopRemoteBrowserSession(sessionId: string | null | undefined): void {
  const baseUrl = getRemoteBrowserInternalUrl();
  if (!baseUrl || !sessionId) {
    return;
  }
  fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: getInternalFetchHeaders() }).catch((error: unknown) => {
    logEvent({
      service: "room-state",
      env: process.env.NODE_ENV ?? "development",
      errorCode: "remote_browser_stop_failed",
      sessionId,
      message: error instanceof Error ? error.message : "unknown",
      timestamp: new Date().toISOString()
    });
  });
}

export function startRoomStateService(port = Number.parseInt(process.env.ROOM_STATE_PORT ?? "2567", 10)) {
  const authority = createRoomStateServer();
  const httpServer = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          status: "ok",
          service: "room-state",
          env: process.env.NODE_ENV ?? "development",
          port,
          timestamp: new Date().toISOString(),
          dependencies: {
            websocketServer: true
          },
          featureFlags: {
            realtimeEnabled: process.env.FEATURE_ROOM_STATE_REALTIME !== "false"
          }
        });
        return;
      }
      const remoteBrowserSessionMatch = url.pathname.match(/^\/api\/internal\/remote-browser\/sessions\/([^/]+)$/);
      if (request.method === "POST" && remoteBrowserSessionMatch) {
        if (!isAuthorizedInternalRequest(request)) {
          json(response, 403, { error: "forbidden" });
          return;
        }
        const payload = await parseBody<RemoteBrowserExecutorPatchRequest>(request);
        const result = applyRemoteBrowserExecutorPatchCommand(authority, {
          roomId: payload?.roomId,
          surfaceId: payload?.surfaceId,
          objectId: payload?.objectId,
          commandId: payload?.commandId,
          executorSessionId: decodeURIComponent(remoteBrowserSessionMatch[1] ?? ""),
          patch: payload?.patch
        });
        json(response, result.accepted ? 200 : 409, { result });
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      json(response, 500, { error: "room_state_error", message: error instanceof Error ? error.message : "unknown" });
    });
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
    const roomId = url.searchParams.get("roomId") ?? "demo-room";
    const participantId = url.searchParams.get("participantId") ?? crypto.randomUUID();
    const access = resolveConnectionAccess(url, roomId, participantId);

    connectParticipant(authority, roomId, participantId, socket, access);

    socket.on("message", (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as {
          type?: string;
          participant?: Partial<PresenceState>;
          reliableState?: unknown;
          poseFrame?: unknown;
          seatId?: unknown;
          commandId?: unknown;
          surfaceId?: unknown;
          objectType?: unknown;
          objectId?: unknown;
          expectedRevision?: unknown;
          patch?: unknown;
          enabled?: unknown;
          probeOnly?: unknown;
        };
        if (payload.type === "participant_update") {
          if (!payload.participant) {
            return;
          }
          applyParticipantUpdate(authority, roomId, {
            ...payload.participant,
            participantId
          });
          return;
        }
        if (payload.type === "avatar_reliable_state") {
          applyAvatarReliableState(authority, roomId, participantId, payload.reliableState);
          return;
        }
        if (payload.type === "avatar_pose_preview") {
          relayAvatarPoseFrame(authority, roomId, participantId, payload.poseFrame);
          return;
        }
        if (payload.type === "seat_claim") {
          const result = applySeatClaim(authority, roomId, participantId, typeof payload.seatId === "string" ? payload.seatId : "");
          sendToSocket(socket, {
            type: "seat_claim_result",
            seatClaimResult: result
          });
          return;
        }
        if (payload.type === "seat_release") {
          applySeatRelease(authority, roomId, participantId, typeof payload.seatId === "string" ? payload.seatId : undefined);
          return;
        }
        if (payload.type === "surface_create_object") {
          const result = payload.probeOnly !== false
            ? applyPrivilegedRoomCommand(authority, roomId, participantId, "surface.create-object")
            : applyMediaObjectCreateCommand(authority, roomId, participantId, {
              commandId: typeof payload.commandId === "string" ? payload.commandId : undefined,
              surfaceId: typeof payload.surfaceId === "string" ? payload.surfaceId : undefined,
              objectType: typeof payload.objectType === "string" ? payload.objectType : undefined
            });
          sendToSocket(socket, {
            type: result.accepted ? "surface_command_result" : "access_denied",
            result
          });
          return;
        }
        if (payload.type === "surface_stop_object") {
          const result = applyMediaObjectStopCommand(authority, roomId, participantId, {
            commandId: typeof payload.commandId === "string" ? payload.commandId : undefined,
            surfaceId: typeof payload.surfaceId === "string" ? payload.surfaceId : undefined,
            objectId: typeof payload.objectId === "string" ? payload.objectId : undefined
          });
          sendToSocket(socket, {
            type: result.accepted ? "surface_command_result" : "access_denied",
            result
          });
          return;
        }
        if (payload.type === "surface_patch_object_state") {
          const result = applyMediaObjectPatchCommand(authority, roomId, participantId, {
            commandId: typeof payload.commandId === "string" ? payload.commandId : undefined,
            surfaceId: typeof payload.surfaceId === "string" ? payload.surfaceId : undefined,
            objectId: typeof payload.objectId === "string" ? payload.objectId : undefined,
            expectedRevision: typeof payload.expectedRevision === "number" ? payload.expectedRevision : undefined,
            patch: payload.patch
          });
          sendToSocket(socket, {
            type: result.accepted ? "surface_command_result" : "access_denied",
            result
          });
          return;
        }
        if (payload.type === "surface_set_media_audio") {
          const result = applySurfaceMediaAudioCommand(authority, roomId, participantId, {
            commandId: typeof payload.commandId === "string" ? payload.commandId : undefined,
            surfaceId: typeof payload.surfaceId === "string" ? payload.surfaceId : undefined,
            enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined
          });
          sendToSocket(socket, {
            type: result.accepted ? "surface_command_result" : "access_denied",
            result
          });
          return;
        }
      } catch (error) {
        logEvent({
          service: "room-state",
          env: process.env.NODE_ENV ?? "development",
          errorCode: "avatar_payload_rejected",
          roomId,
          participantId,
          message: error instanceof Error ? error.message : "unknown_avatar_payload_error",
          timestamp: new Date().toISOString()
        });
      }
    });

    socket.on("close", () => {
      disconnectParticipant(authority, roomId, participantId, socket);
    });

    socket.on("error", (error) => {
      logEvent({
        service: "room-state",
        env: process.env.NODE_ENV ?? "development",
        errorCode: "socket_error",
        roomId,
        participantId,
        message: error.message,
        timestamp: new Date().toISOString()
      });
    });
  });

  return httpServer.listen(port, () => {
    process.stdout.write(`room-state listening on ${port}\n`);
  });
}

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1" && !process.execArgv.includes("--test")) {
  startRoomStateService();
}
