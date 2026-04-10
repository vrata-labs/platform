import { createServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import type { PresenceState } from "./schema.js";
import { claimSeat, createRoomState, joinRoom, leaveRoom, releaseSeat, serializeRoomState, updateParticipantState, type RoomState } from "./state.js";

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
  socketParticipants: Map<WebSocket, { roomId: string; participantId: string }>;
  pendingDisconnects: Map<string, Map<string, ReturnType<typeof setTimeout>>>;
}

const DISCONNECT_GRACE_MS = 1500;

export interface SeatClaimResultPayload {
  seatId: string;
  accepted: boolean;
  occupantId: string | null;
  previousSeatId: string | null;
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function createRoomStateServer(): RoomStateServer {
  return {
    rooms: new Map<string, RoomState>(),
    clients: new Map<string, Set<WebSocket>>(),
    avatarReliableStates: new Map<string, Map<string, AvatarReliableStatePayload>>(),
    socketParticipants: new Map<WebSocket, { roomId: string; participantId: string }>(),
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

export function connectParticipant(server: RoomStateServer, roomId: string, participantId: string, socket: WebSocket): void {
  cancelPendingDisconnect(server, roomId, participantId);
  const room = ensureRoom(server, roomId);
  server.rooms.set(roomId, joinRoom(room, participantId));
  const set = server.clients.get(roomId) ?? new Set<WebSocket>();
  set.add(socket);
  server.clients.set(roomId, set);
  server.socketParticipants.set(socket, { roomId, participantId });
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
  server.rooms.set(roomId, updateParticipantState(room, nextState));
  broadcastRoom(server, roomId);
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

export function startRoomStateService(port = Number.parseInt(process.env.ROOM_STATE_PORT ?? "2567", 10)) {
  const authority = createRoomStateServer();
  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
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
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
    const roomId = url.searchParams.get("roomId") ?? "demo-room";
    const participantId = url.searchParams.get("participantId") ?? crypto.randomUUID();

    connectParticipant(authority, roomId, participantId, socket);

    socket.on("message", (raw) => {
      try {
        const payload = JSON.parse(String(raw)) as {
          type?: string;
          participant?: Partial<PresenceState>;
          reliableState?: unknown;
          poseFrame?: unknown;
          seatId?: unknown;
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
