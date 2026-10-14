import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import type { RoomNoteRecord, RoomNoteVersionRecord } from "./storage.js";

test("composed API keeps notes routing, authentication, exports, outer errors and unrelated routes", async (t) => {
  const changes = { VRATA_DISABLE_AUTOSTART: "1", STATE_TOKEN_SECRET: "notes-http-test-secret", FEATURE_NOTES: "true" };
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const { startApiServer } = await import("./index.js");
  const server = startApiServer(0);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  if (!server.listening) await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = `${base}/api/rooms/demo-room/notes`;
  const token = signRoomSessionToken({ tenantId: "demo-tenant", roomId: "demo-room", participantId: "notes-http-member",
    displayName: "Notes", role: "guest", roleSource: "trusted", permissions: ["notes.view"],
    sessionId: "notes-http-session", iat: 100, exp: 4_102_444_800, jti: "notes-http-jti"
  }, changes.STATE_TOKEN_SECRET);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-request-id": "notes-http-request" };
  assert.equal((await fetch(`${root}/private`)).status, 401);
  assert.equal((await fetch(`${root}/private?participantId=other`, { headers })).status, 403);
  const created = await fetch(`${root}/private`, { method: "PUT", headers, body: JSON.stringify({ content: "http note" }) });
  assert.equal(created.status, 201); assert.equal(created.headers.get("x-request-id"), "notes-http-request");
  const saved = await created.json() as { note: RoomNoteRecord };
  assert.equal(saved.note.ownerParticipantId, "notes-http-member");
  const versions = await (await fetch(`${root}/private/versions`, { headers })).json() as { items: RoomNoteVersionRecord[] };
  assert.equal(versions.items.length, 1);
  assert.equal((await fetch(`${root}/private`, { method: "DELETE", headers })).status, 200);
  const restored = await fetch(`${root}/private/restore`, { method: "POST", headers, body: JSON.stringify({ versionId: versions.items[0]!.versionId }) });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as { note: RoomNoteRecord }).note.content, "http note");
  const exported = await fetch(`${root}/private/export?format=json`, { headers });
  assert.equal(exported.status, 200); assert.match(exported.headers.get("content-disposition")!, /private-notes\.json/);
  assert.equal((await exported.json() as { note: RoomNoteRecord }).note.content, "http note");
  const zip = await fetch(`${root}/export?format=zip`, { headers });
  assert.equal(zip.status, 200); assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  assert.equal((await fetch(`${root}/shared`, { method: "PUT", headers, body: '{"content":"no"}' })).status, 403);
  for (const method of ["POST", "PATCH"]) {
    const r = await fetch(`${root}/shared`, { method, headers });
    assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: "not_found", path: "/api/rooms/demo-room/notes/shared" });
  }
  assert.equal((await fetch(`${root}/private`, { method: "OPTIONS" })).status, 204);
  const malformed = await fetch(`${root}/private`, { method: "PUT", headers, body: "{broken" });
  assert.equal(malformed.status, 500); assert.equal((await malformed.json() as { error: string }).error, "internal_error");
  assert.equal((await fetch(`${base}/api/rooms/%/notes/shared`, { headers })).status, 500);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /vrata_api_request_failures_total 2/);
  process.env.FEATURE_NOTES = "false";
  const disabled = await fetch(`${root}/private`, { headers });
  assert.equal(disabled.status, 404); assert.deepEqual(await disabled.json(), { error: "notes_disabled" });
});
