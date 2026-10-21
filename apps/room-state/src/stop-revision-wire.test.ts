import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { startRoomStateService } from "./index.js";

test("WS advertises versioned Stop CAS, rejects malformed/stale revision and keeps legacy Stop", async t => {
  const previous = { NODE_ENV: process.env.NODE_ENV, STATE_TOKEN_SECRET: process.env.STATE_TOKEN_SECRET };
  process.env.NODE_ENV = "development"; process.env.STATE_TOKEN_SECRET = "owned-wire-cas-secret";
  const server = startRoomStateService(0, { readIdentityPolicy: async () => ({ minimumProtocolVersion: 1, roomRequiresV2: false }) });
  if (!server.listening) await once(server, "listening");
  const now = Math.floor(Date.now() / 1000), roomId = "stop-wire", participantId = "host";
  const token = signRoomSessionToken({ tenantId: "tenant", roomId, participantId, displayName: "Host", role: "host",
    permissions: getRoomPermissions("host"), sessionId: "own", iat: now, exp: now + 60, jti: "own" }, process.env.STATE_TOKEN_SECRET);
  const port = (server.address() as { port: number }).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}?roomId=${roomId}&participantId=${participantId}&accessToken=${token}`);
  const messages: any[] = []; socket.on("message", bytes => messages.push(JSON.parse(String(bytes))));
  t.after(async () => {
    socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  async function wait(predicate: (message: any) => boolean) {
    for (let i = 0; i < 200; i++) { const message = messages.find(predicate); if (message) return message; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error("stop_wire_reply_timeout");
  }
  const snapshot = await wait(message => message.type === "room_state");
  assert.deepEqual(snapshot.capabilities, { surfaceStopRevision: 1 });
  async function command(commandId: string, payload: Record<string, unknown>) {
    socket.send(JSON.stringify({ ...payload, commandId })); return (await wait(message => message.result?.commandId === commandId)).result;
  }
  const created = await command("create", { type: "surface_create_object", surfaceId: "debug-main", objectType: "markdown-board", probeOnly: false });
  assert.equal(created.accepted, true);
  const base = { surfaceId: "debug-main", objectId: created.objectId };
  const edited = await command("edit", { ...base, type: "surface_patch_object_state", expectedRevision: 0,
    patch: { type: "create-note", inputEventId: "edit", noteId: "decision", text: "Keep concurrent edits", x: .2, y: .3, width: .3, height: .22, color: "#bfdbfe" } });
  assert.equal(edited.accepted, true); assert.equal(edited.revision, 1);
  for (const [index, expectedRevision] of [0, -1, 1.5, "1", null, false, {}].entries()) {
    const denied = await command(`stale-${index}`, { ...base, type: "surface_stop_object", expectedRevision });
    assert.equal(denied.accepted, false); assert.equal(denied.blockedReason, "revision-mismatch"); assert.equal(denied.revision, 1);
  }
  const beforeStop = messages.length;
  assert.equal((await command("stop-confirmed", { ...base, type: "surface_stop_object", expectedRevision: 1 })).accepted, true);
  const stoppedMessages = messages.slice(beforeStop), snapshotIndex = stoppedMessages.findIndex(message => message.type === "room_state"
    && message.room?.mediaObjects?.surfaces?.["debug-main"]?.activeObjectId === null);
  assert.ok(snapshotIndex >= 0); assert.ok(snapshotIndex < stoppedMessages.findIndex(message => message.result?.commandId === "stop-confirmed"));
  const second = await command("create-legacy", { type: "surface_create_object", surfaceId: "debug-main", objectType: "whiteboard", probeOnly: false });
  assert.equal(second.accepted, true);
  assert.equal((await command("stop-legacy", { type: "surface_stop_object", surfaceId: "debug-main", objectId: second.objectId })).accepted, true);
});
