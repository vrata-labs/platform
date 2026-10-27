import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";

test("deleting a room removes its document objects and a recreated room starts without its documents", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "vrata-room-delete-documents-"));
  const env = { VRATA_DISABLE_AUTOSTART: "1", CONTROL_PLANE_ADMIN_TOKEN: "owned-room-delete-admin",
    STATE_TOKEN_SECRET: "owned-room-delete-state-secret", DOCUMENT_LOCAL_UPLOAD_ROOT: root };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const { startApiServer } = await import("./index.js");
  const server = startApiServer(0); if (!server.listening) await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, roomId = "owned-room-delete-documents";
  const admin = { "content-type": "application/json", "x-vrata-admin-token": env.CONTROL_PLANE_ADMIN_TOKEN };
  const create = () => fetch(`${origin}/api/rooms`, { method: "POST", headers: admin,
    body: JSON.stringify({ roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Owned room deletion" }) });
  assert.equal((await create()).status, 201);
  const now = Math.floor(Date.now() / 1000);
  const host = { authorization: `Bearer ${signRoomSessionToken({ tenantId: "demo-tenant", roomId, participantId: "owned-host",
    displayName: "Owned host", role: "host", roleSource: "trusted", permissions: getRoomPermissions("host"), sessionId: "owned-host-session",
    iat: now, exp: now + 600, jti: "owned-host-jti" }, env.STATE_TOKEN_SECRET)}` };
  const upload = async (name: string) => {
    const form = new FormData(); form.set("document", new File([new Uint8Array(16).fill(120)], name, { type: "text/plain" }));
    const response = await fetch(`${origin}/api/rooms/${roomId}/documents`, { method: "POST", headers: host, body: form });
    assert.equal(response.status, 201);
    return (await response.json() as { document: { documentId: string } }).document.documentId;
  };
  const kept = await upload("agenda.txt"), tombstoned = await upload("draft.txt");
  // A tombstone is the deletion intent; its object is removed here or, after a failed cleanup, with the room.
  assert.equal((await fetch(`${origin}/api/rooms/${roomId}/documents/${tombstoned}`, { method: "DELETE", headers: host })).status, 200);
  const folder = join(root, "documents", "demo-tenant", roomId);
  assert.deepEqual(await readdir(join(folder, tombstoned)), []);
  assert.deepEqual(await readdir(join(folder, kept)), ["agenda.txt"]);

  const deleted = await fetch(`${origin}/api/rooms/${roomId}`, { method: "DELETE", headers: admin });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await readdir(join(folder, kept)), [], "the deleted room's document object is removed");
  assert.equal((await create()).status, 201);
  const listed = await fetch(`${origin}/api/rooms/${roomId}/documents`, { headers: { "x-vrata-admin-token": env.CONTROL_PLANE_ADMIN_TOKEN } });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as { items: unknown[] }).items, [], "a recreated room does not inherit documents");
});
