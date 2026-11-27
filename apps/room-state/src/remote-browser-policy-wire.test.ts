import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import {
  REMOTE_BROWSER_PUBLIC_HTTPS_AUTHORITY_PATH, REMOTE_BROWSER_PUBLIC_HTTPS_SESSION_PATH, REMOTE_BROWSER_ROOM_POLICY_PATH,
  type RemoteBrowserPublicHttpsBinding
} from "@vrata/shared-types";
import { startRoomStateService } from "./index.js";

async function origin(server: Server) {
  if (!server.listening) await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function wait<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, "waiting for an observed fixture event");
    await delay(10);
  }
}

test("wire applies the server mode, consumes starts only once, and fences a renewal against Stop", async t => {
  const roomId = "browser-room", token = "test-task3-internal-token";
  let revision = "policy-1", apiStatus = 200;
  let holdPolicy = false, releasePolicy: (() => void) | undefined;
  const opens: RemoteBrowserPublicHttpsBinding[] = [];
  const stops: RemoteBrowserPublicHttpsBinding[] = [];
  const legacyStarts: unknown[] = [];
  const peer = createServer(async (request, response) => {
    const data: Buffer[] = [];
    for await (const chunk of request) data.push(chunk);
    const body = JSON.parse(Buffer.concat(data).toString());
    assert.equal(request.headers["x-vrata-internal-token"], token);
    if (request.url === REMOTE_BROWSER_ROOM_POLICY_PATH) {
      assert.deepEqual(body, { roomId });
      const decision = { mode: "public-https", roomId, tenantId: "tenant", policyRevision: revision, validForMs: 10000 };
      if (holdPolicy) await new Promise<void>(resolve => { releasePolicy = resolve; });
      response.writeHead(apiStatus, { "content-type": "application/json" }).end(JSON.stringify(decision));
    } else if (request.url === REMOTE_BROWSER_PUBLIC_HTTPS_SESSION_PATH) {
      (request.method === "DELETE" ? stops : opens).push(body);
      response.writeHead(200).end();
    } else {
      legacyStarts.push(body);
      response.writeHead(200).end();
    }
  }).listen(0, "127.0.0.1");
  const peerOrigin = await origin(peer);
  const env = { API_INTERNAL_URL: peerOrigin, REMOTE_BROWSER_INTERNAL_URL: peerOrigin, VRATA_INTERNAL_SERVICE_TOKEN: token,
    REMOTE_BROWSER_INTERNAL_TOKEN: token, REMOTE_BROWSER_ENABLED: "true", VRATA_DEV_ROLE_QUERY: "true" };
  const priorEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const server = startRoomStateService(0, { readIdentityPolicy: async () => ({ minimumProtocolVersion: 1, roomRequiresV2: false }) });
  const base = await origin(server);
  const socket = new WebSocket(`${base.replace("http:", "ws:")}?roomId=${roomId}&participantId=host&role=host`);
  const messages: any[] = [];
  socket.on("message", message => messages.push(JSON.parse(String(message))));
  t.after(async () => {
    releasePolicy?.();
    socket.terminate();
    await Promise.all([server, peer].map(service => new Promise<void>(resolve => service.close(() => resolve()))));
    for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const command = async (commandId: string, body: object) => {
    socket.send(JSON.stringify({ commandId, surfaceId: "debug-main", ...body }));
    return (await wait(() => messages.find(message => message.result?.commandId === commandId))).result;
  };
  const create = (commandId: string) => command(commandId, { type: "surface_create_object", objectType: "remote-browser", probeOnly: false });
  const open = (commandId: string, objectId: string, expectedRevision: number) => command(commandId, {
    type: "surface_patch_object_state", objectId, expectedRevision,
    patch: { type: "open-url", inputEventId: commandId, url: "https://controlled.test/", mode: "allowlist", policyRevision: "client-policy" }
  });
  const authorize = (binding: RemoteBrowserPublicHttpsBinding, purpose: "start" | "renew", authenticated = true) =>
    fetch(`${base}${REMOTE_BROWSER_PUBLIC_HTTPS_AUTHORITY_PATH}`, {
      method: "POST", headers: authenticated ? { "x-vrata-internal-token": token } : {}, body: JSON.stringify({ binding, purpose })
    });

  await wait(() => messages.find(message => message.type === "room_state"));
  const { objectId } = await create("create");
  assert.equal((await open("first", objectId, 0)).accepted, true);
  const first = await wait(() => opens[0]);
  assert.deepEqual(first, { roomId, tenantId: "tenant", objectId, surfaceId: "debug-main", policyRevision: "policy-1",
    sessionId: `remote-browser:${objectId}`, executorInstanceId: `remote-browser:${objectId}:instance:1` });
  assert.equal((await authorize(first, "start", false)).status, 403);
  assert.equal((await authorize({ ...first, tenantId: "other" }, "start")).status, 403);
  assert.equal((await authorize({ ...first, surfaceId: "other" }, "start")).status, 403);
  const oldBinding = await fetch(`${base}/api/internal/remote-browser/bindings/verify`, {
    method: "POST", headers: { "x-vrata-internal-token": token }, body: JSON.stringify({ ...first, executorSessionId: first.sessionId })
  });
  assert.equal(oldBinding.status, 409);

  // A withdrawal and regrant before the first executor request must not validate the old instance.
  revision = "policy-2";
  assert.equal((await authorize(first, "start")).status, 403);
  assert.equal((await open("second", objectId, 1)).accepted, true);
  const second = await wait(() => opens[1]);
  assert.equal(second.policyRevision, revision);
  const [left, right] = await Promise.all([authorize(second, "start"), authorize(second, "start")]);
  assert.deepEqual([left.status, right.status].sort(), [200, 403]);
  assert.deepEqual(await (left.ok ? left : right).json(), { binding: second, validForMs: 10000, url: "https://controlled.test/" });

  holdPolicy = true;
  const renewing = authorize(second, "renew");
  const release = await wait(() => releasePolicy);
  assert.equal((await command("stop", { type: "surface_stop_object", objectId, expectedRevision: 2 })).accepted, true);
  assert.deepEqual(await wait(() => stops[1]), second);
  holdPolicy = false;
  release();
  assert.equal((await renewing).status, 403);

  apiStatus = 503;
  const next = await create("create-after-outage");
  assert.equal((await open("during-outage", next.objectId, 0)).accepted, true);
  await wait(() => messages.find(message => message.room?.mediaObjects?.objects?.[next.objectId]?.state?.status === "failed"));
  assert.equal(opens.length, 2);
  assert.deepEqual(legacyStarts, []);
});
