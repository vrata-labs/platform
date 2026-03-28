import { createServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import type { PresenceState } from "./schema.js";
import { createRoomState, joinRoom, leaveRoom, serializeRoomState, updateParticipantState, type RoomState } from "./state.js";

export interface RoomStateServer {
  rooms: Map<string, RoomState>;
  clients: Map<string, Set<WebSocket>>;
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function createRoomStateServer(): RoomStateServer {
  return {
    rooms: new Map<string, RoomState>(),
    clients: new Map<string, Set<WebSocket>>()
  };
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

export function connectParticipant(server: RoomStateServer, roomId: string, participantId: string, socket: WebSocket): void {
  const room = ensureRoom(server, roomId);
  server.rooms.set(roomId, joinRoom(room, participantId));
  const set = server.clients.get(roomId) ?? new Set<WebSocket>();
  set.add(socket);
  server.clients.set(roomId, set);
  broadcastRoom(server, roomId);
}

export function disconnectParticipant(server: RoomStateServer, roomId: string, participantId: string, socket: WebSocket): void {
  const room = server.rooms.get(roomId);
  if (room) {
    server.rooms.set(roomId, leaveRoom(room, participantId));
  }
  const set = server.clients.get(roomId);
  set?.delete(socket);
  broadcastRoom(server, roomId);
}

export function applyParticipantUpdate(server: RoomStateServer, roomId: string, nextState: Partial<PresenceState> & { participantId: string }): void {
  const room = ensureRoom(server, roomId);
  server.rooms.set(roomId, updateParticipantState(room, nextState));
  broadcastRoom(server, roomId);
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
      const payload = JSON.parse(String(raw)) as { type?: string; participant?: Partial<PresenceState> };
      if (payload.type !== "participant_update") {
        return;
      }
      if (!payload.participant) {
        return;
      }
      applyParticipantUpdate(authority, roomId, {
        ...payload.participant,
        participantId
      });
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

if (process.env.NODE_ENV !== "test" && process.env.NOAH_DISABLE_AUTOSTART !== "1") {
  startRoomStateService();
}
