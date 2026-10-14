import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { getRoomPermissions } from "@vrata/shared-types";
import { startRoomStateService } from "./index.js";

test("real sockets apply a demotion before a delayed initial verification and reject conflicting authority", { timeout: 20_000 }, async () => {
  const previousEnv = { API_INTERNAL_URL: process.env.API_INTERNAL_URL, VRATA_INTERNAL_SERVICE_TOKEN: process.env.VRATA_INTERNAL_SERVICE_TOKEN };
  let revision = 5, conflict = false;
  let held: ServerResponse | undefined;
  const session = (sessionId: string, rev: number, elevated: boolean) => ({ tenantId: "tenant", roomId: "room", participantId: "speaker", identityId: "identity",
    displayName: "Speaker", authEpoch: 1, sessionId, expiresAtSeconds: Math.floor(Date.now() / 1000) + 600,
    authorityRevision: rev, role: elevated ? "presenter" : "member", permissions: getRoomPermissions(elevated ? "presenter" : "member") });
  const answer = (response: ServerResponse, body: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  const api = createServer((request, response) => {
    let body = "";
    request.on("data", bytes => { body += String(bytes); });
    request.on("end", () => {
      const token = JSON.parse(body).sessionToken as string;
      if (token === "rs2.delayed" && !held) { held = response; return; }
      answer(response, session(token, revision, revision === 5 || conflict));
    });
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  process.env.API_INTERNAL_URL = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  process.env.VRATA_INTERNAL_SERVICE_TOKEN = "owned-authority-fixture";
  const server = startRoomStateService(0, { readIdentityPolicy: async () => ({ minimumProtocolVersion: 2, roomRequiresV2: true }) });
  await once(server, "listening");
  const origin = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const connections: WebSocket[] = [];
  const wait = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(10); }
    assert.fail("socket_authority_condition_timeout");
  };
  const connect = async (token: string) => {
    const socket = new WebSocket(`${origin}?roomId=room&participantId=speaker&accessToken=${token}`);
    connections.push(socket);
    const messages: Array<{ type: string; room?: { participants: Array<{ role: string }>; mediaObjects: { objects: Record<string, unknown>; surfaces: Record<string, { activeObjectId: string | null }> } }; result?: { accepted: boolean; commandId: string } }> = [];
    socket.on("message", bytes => { messages.push(JSON.parse(String(bytes))); });
    await once(socket, "open"); return { socket, messages };
  };
  try {
    const first = await connect("rs2.first");
    await wait(() => first.messages.some(message => message.type === "room_state"));
    first.socket.send(JSON.stringify({ type: "surface_create_object", commandId: "create", surfaceId: "debug-main", objectType: "screen-share", probeOnly: false }));
    await wait(() => first.messages.some(message => message.result?.commandId === "create"));
    assert.equal(first.messages.find(message => message.result?.commandId === "create")!.result!.accepted, true);
    const delayed = await connect("rs2.delayed"); await wait(() => !!held);
    revision = 6;
    // No client role poll or voluntary stop: idle authority polling performs the retirement.
    await wait(() => first.messages.some(message => message.room?.participants[0]?.role === "member"
      && message.room.mediaObjects.surfaces["debug-main"]!.activeObjectId === null));
    answer(held!, session("rs2.delayed", 5, true));
    await wait(() => delayed.messages.some(message => message.type === "room_state"));
    const admitted = delayed.messages.find(message => message.type === "room_state")!.room!;
    assert.equal(admitted.participants[0]!.role, "member"); assert.equal(Object.keys(admitted.mediaObjects.objects).length, 0);
    delayed.socket.send(JSON.stringify({ type: "surface_create_object", commandId: "stale-create", surfaceId: "debug-main", objectType: "screen-share", probeOnly: false }));
    await wait(() => delayed.messages.some(message => message.result?.commandId === "stale-create"));
    assert.equal(delayed.messages.find(message => message.result?.commandId === "stale-create")!.type, "access_denied");
    const closed = once(first.socket, "close"); conflict = true;
    first.socket.send(JSON.stringify({ type: "surface_create_object", commandId: "conflict", surfaceId: "debug-main", objectType: "screen-share", probeOnly: false }));
    assert.equal((await closed)[0], 1013);
    assert.equal(first.messages.some(message => message.result?.commandId === "conflict"), false);
  } finally {
    held?.end();
    for (const socket of connections) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
    for (const [name, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
