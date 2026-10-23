import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { signRoomSessionToken, verifyRoomSessionToken } from "@vrata/shared-types/session-token";
import { PostgresStorage } from "./storage.js";

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error("identity_boundary_wait_timeout"); await delay(25); }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
}

test("activated boundary rejects legacy issuance and refreshes while requiring proof for v2", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
}, async () => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const rollbackEntry = process.env.VRATA_IDENTITY_ROLLBACK_API_ENTRY;
  if (process.env.CI) assert.ok(rollbackEntry, "CI requires the exact pre-boundary API build");
  const schema = `identity_boundary_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  const apiPort = await freePort(), statePort = await freePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const adminToken = "identity-boundary-test-admin", internalToken = "identity-boundary-test-internal";
  const rootSecret = "identity-boundary-test-state-secret-32-bytes";
  const headers = { "content-type": "application/json", "x-vrata-admin-token": adminToken };
  const children: ChildProcess[] = [], sockets: WebSocket[] = [];
  const logs: string[] = [];
  const request = (path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  });
  const start = (entry: URL, extra: Record<string, string>) => {
    const child = spawn(process.execPath, [fileURLToPath(entry)], { env: { ...process.env, NODE_ENV: "development", POSTGRES_URL: connection.href,
      VRATA_DISABLE_AUTOSTART: "0", NOAH_DISABLE_AUTOSTART: "0", CONTROL_PLANE_ADMIN_TOKEN: adminToken,
      VRATA_INTERNAL_SERVICE_TOKEN: internalToken, REMOTE_BROWSER_INTERNAL_TOKEN: internalToken,
      STATE_TOKEN_SECRET: rootSecret, API_INTERNAL_URL: base, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    child.stdout?.on("data", data => logs.push(String(data))); child.stderr?.on("data", data => logs.push(String(data)));
    return child;
  };
  const connect = (roomId: string, participantId: string, token?: string) => {
    const url = new URL(`ws://127.0.0.1:${statePort}`);
    url.searchParams.set("roomId", roomId); url.searchParams.set("participantId", participantId);
    if (token) url.searchParams.set("accessToken", token); else url.searchParams.set("role", "host");
    const socket = new WebSocket(url); sockets.push(socket);
    const messages: Array<{ type?: string; result?: { accepted?: boolean } }> = [];
    socket.addEventListener("message", event => { messages.push(JSON.parse(String(event.data))); });
    const closed = new Promise<{ code: number; reason: string }>(resolve => socket.addEventListener("close", event => resolve({ code: event.code, reason: event.reason }), { once: true }));
    return { socket, messages, closed };
  };
  try {
    await adminPool.query(`create schema "${schema}"`);
    const storage = new PostgresStorage(pool); await storage.init();
    const rooms = await Promise.all([false, true].map(personal => storage.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant",
      templateId: "meeting-room-basic", name: "Rollback boundary", roomType: personal ? "personal" : "standard",
      ownerParticipantId: personal ? "legacy-owner" : null, sessionControl: { hostParticipantId: personal ? "legacy-owner" : "legacy-host" } })));
    await storage.upsertRoomNote({ roomId: rooms[1].roomId, scope: "private", ownerParticipantId: "legacy-owner", content: "Preserve private material" });
    const tokens: string[] = [];
    if (rollbackEntry) {
      const old = start(pathToFileURL(rollbackEntry), { API_PORT: String(apiPort) });
      await until(async () => {
        assert.equal(old.exitCode, null, logs.join(""));
        try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
      }, 60_000);
      for (const [index, room] of rooms.entries()) {
        const response = await request("/api/tokens/state", undefined, { roomId: room.roomId, participantId: index ? "legacy-owner" : "legacy-host", requestedRole: "host" });
        assert.equal(response.status, 200, "the released API remains usable before activation");
        tokens.push((await response.json() as { token: string }).token);
      }
      await stop(old);
    }
    const api = start(new URL("./index.js", import.meta.url), { API_PORT: String(apiPort) });
    await until(async () => {
      assert.equal(api.exitCode, null, logs.join(""));
      try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
    }, 60_000);
    const state = start(new URL("../../room-state/dist/index.js", import.meta.url), { ROOM_STATE_PORT: String(statePort) });
    await until(async () => {
      assert.equal(state.exitCode, null, logs.join(""));
      try { return (await fetch(`http://127.0.0.1:${statePort}/health`)).ok; } catch { return false; }
    });
    assert.equal((await request("/api/internal/identity-policy")).status, 403, "internal policy requires server authentication");
    for (const [index, room] of rooms.entries()) {
      const response = await request("/api/tokens/state", undefined, { roomId: room.roomId, participantId: index ? "legacy-owner" : "legacy-host", requestedRole: "host" });
      assert.equal(response.status, 200);
      const current = (await response.json() as { token: string }).token;
      tokens[index] ??= current;
    }
    assert.equal((await request(`/api/rooms/${rooms[1].roomId}/notes/private`, tokens[1])).status, 200);
    const claims = verifyRoomSessionToken(tokens[0], rootSecret);
    assert.ok(claims.ok);
    const oldDevelopmentSession = signRoomSessionToken(claims.payload, "dev-state-secret");
    assert.equal((await request("/api/tokens/state", oldDevelopmentSession, { roomId: rooms[0].roomId, participantId: "legacy-host" })).status, 409);
    assert.equal((await request(`/api/rooms/${rooms[0].roomId}/session-control`, oldDevelopmentSession)).status, 409);
    assert.equal((await request("/api/tokens/media", undefined, { roomId: rooms[0].roomId, participantId: "legacy-host", sessionToken: oldDevelopmentSession })).status, 409);
    const obsoleteSocket = connect(rooms[0].roomId, "legacy-host", oldDevelopmentSession);
    await until(() => obsoleteSocket.socket.readyState === WebSocket.CLOSED);
    assert.deepEqual(await obsoleteSocket.closed, { code: 4406, reason: "identity_upgrade_required" });
    assert.equal(obsoleteSocket.messages.length, 0);
    await pool.query("alter table room_identity_protocol_policy rename to temporarily_unavailable_policy");
    try {
      assert.equal((await request("/api/tokens/state", undefined, { roomId: rooms[0].roomId })).status, 503);
      const unavailable = connect(rooms[0].roomId, "legacy-host", tokens[0]);
      await until(() => unavailable.socket.readyState === WebSocket.CLOSED);
      assert.equal((await unavailable.closed).code, 1013);
      assert.equal(unavailable.messages.length, 0);
    } finally { await pool.query("alter table temporarily_unavailable_policy rename to room_identity_protocol_policy"); }
    const live = connect(rooms[0].roomId, "legacy-host", tokens[0]);
    await until(() => live.messages.some(message => message.type === "room_state"));
    const idleToken = await (await request("/api/tokens/state", undefined, { roomId: rooms[0].roomId, participantId: "idle-participant" })).json() as { token: string };
    const idle = connect(rooms[0].roomId, "idle-participant", idleToken.token);
    await until(() => idle.messages.some(message => message.type === "room_state"));
    const bound = await storage.roomIdentities.create({ tenantId: "demo-tenant", roomId: rooms[1].roomId, displayName: "Prepared", baseRole: "guest", provenance: { kind: "guest" } });
    assert.equal((await request("/api/tokens/state", tokens[1], { roomId: rooms[1].roomId, participantId: "legacy-owner" })).status, 409);
    assert.equal((await request(`/api/rooms/${rooms[1].roomId}/session-control`, tokens[1])).status, 409);
    const executorToken = await fetch(`${base}/api/tokens/remote-browser-media`, {
      method: "POST", headers: { "content-type": "application/json", "x-vrata-internal-token": internalToken },
      body: JSON.stringify({ roomId: rooms[1].roomId, objectId: "previous-object", executorSessionId: "previous-session", executorInstanceId: "previous-instance", mediaParticipantId: "previous-media" })
    });
    assert.equal(executorToken.status, 409, "a retained service binding cannot mint media for a bound room at minimum one");
    const boundLegacy = connect(rooms[1].roomId, "legacy-owner", tokens[1]);
    await until(() => boundLegacy.socket.readyState === WebSocket.CLOSED);
    assert.equal((await boundLegacy.closed).code, 4406);
    const before = (await pool.query("select room_id,session_control,owner_participant_id from rooms order by room_id")).rows;
    await storage.identityProtocol.raise(2);
    if (live.socket.readyState === WebSocket.OPEN) live.socket.send(JSON.stringify({ type: "surface_create_object", probeOnly: true }));
    await until(() => live.socket.readyState === WebSocket.CLOSED);
    assert.deepEqual(await live.closed, { code: 4406, reason: "identity_upgrade_required" });
    assert.equal(live.messages.some(message => message.result?.accepted), false);
    await until(() => idle.socket.readyState === WebSocket.CLOSED);
    assert.deepEqual(await idle.closed, { code: 4406, reason: "identity_upgrade_required" });
    for (const [index, room] of rooms.entries()) {
      const participantId = index ? "legacy-owner" : "legacy-host";
      for (const [path, body, method] of [
        ["/api/tokens/state", { roomId: room.roomId, participantId }, "POST"],
        ["/api/tokens/state", { roomId: room.roomId, participantId, inviteToken: "legacy-waiting-invite-credential" }, "POST"],
        [`/api/rooms/${room.roomId}/session-control`, undefined, "GET"],
        [`/api/rooms/${room.roomId}/notes/private`, undefined, "GET"],
        [`/api/rooms/${room.roomId}/documents`, undefined, "GET"],
        [`/api/rooms/${room.roomId}/presence/${participantId}`, { participantId }, "PUT"],
        ["/api/tokens/media", { roomId: room.roomId, participantId, sessionToken: tokens[index] }, "POST"],
        ["/api/tokens/remote-browser-frame", { roomId: room.roomId, sessionToken: tokens[index] }, "POST"],
        ["/api/personal-room", { participantId }, "POST"]
      ] as const) {
        const response = await request(path, tokens[index], body, method);
        assert.equal(response.status, path === "/api/tokens/state" ? 426 : 409, path);
        assert.deepEqual(await response.json(), { error: "identity_required", reason: "identity_upgrade_required" });
      }
      for (const token of [tokens[index], undefined]) {
        const denied = connect(room.roomId, participantId, token);
        await until(() => denied.socket.readyState === WebSocket.CLOSED);
        assert.equal((await denied.closed).code, 4406);
        assert.equal(denied.messages.length, 0);
      }
    }
    const credential = createRoomIdentityCodec(rootSecret).sign(bound);
    const proven = await request("/api/tokens/state", undefined, { roomId: rooms[1].roomId, identityProtocolVersion: 2,
      participantId: "legacy-owner", requestedRole: "host", identityCredential: credential });
    assert.equal(proven.status, 200);
    const adopted = await proven.json() as { identityProtocolVersion: number; participantId: string; role: string; token: string };
    assert.equal(adopted.identityProtocolVersion, 2);
    assert.equal(adopted.participantId, bound.participantId);
    assert.equal(adopted.role, "guest");
    assert.equal(adopted.token.startsWith("rs2."), true);
    assert.equal((await request("/api/tokens/state", tokens[1], { roomId: rooms[1].roomId, identityProtocolVersion: 2,
      identityCredential: credential })).status, 426, "legacy JWT must not accompany a v2 exchange");
    for (const path of ["/api/tokens/state", "/api/personal-room"]) {
      assert.equal((await fetch(`${base}${path}`, { method: "POST", headers, body: "{}" })).status,
        path === "/api/tokens/state" ? 426 : 409, "administrator token never silently converts an old client");
    }
    assert.equal((await fetch(`${base}/api/control-plane/session`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await storage.getRoomNote(rooms[1].roomId, "private", "legacy-owner"))?.content, "Preserve private material");
    assert.deepEqual((await pool.query("select room_id,session_control,owner_participant_id from rooms order by room_id")).rows, before);
    assert.deepEqual(await storage.roomIdentities.get({ tenantId: bound.tenantId, roomId: bound.roomId }, bound.identityId), bound);
    await stop(api);
    if (rollbackEntry) {
      const logStart = logs.length;
      const old = start(pathToFileURL(rollbackEntry), { API_PORT: String(apiPort) });
      await until(() => old.exitCode !== null || logs.slice(logStart).some(line => line.includes("room_identity_guard_mismatch")), 60_000);
      assert.match(logs.slice(logStart).join(""), /room_identity_guard_mismatch/, "the pre-boundary API must not start against activated data");
      let healthy = false;
      try { healthy = (await fetch(`${base}/health`)).ok; } catch { /* Failed startup is expected. */ }
      assert.equal(healthy, false);
      await stop(old);
    }
    const restarted = start(new URL("./index.js", import.meta.url), { API_PORT: String(apiPort) });
    await until(async () => {
      assert.equal(restarted.exitCode, null, logs.join(""));
      try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
    }, 60_000);
    assert.equal((await request("/api/tokens/state", undefined, { roomId: rooms[0].roomId })).status, 426, "restart preserves the database floor");
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    await Promise.all(children.map(stop));
    await pool.end();
    await adminPool.query(`drop schema if exists "${schema}" cascade`); await adminPool.end();
  }
});
