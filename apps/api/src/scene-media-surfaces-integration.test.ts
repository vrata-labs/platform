import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";

test("join token binds only stored scene surfaces, never client-proposed surface definitions", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "surface-integration-admin";
  process.env.STATE_TOKEN_SECRET = "surface-integration-secret";
  const { startApiServer } = await import("./index.js");
  const server = startApiServer(0);
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const surfaces = [{ surfaceId: "desk-aux", label: "Desk", allowedObjectTypes: ["markdown-board"] }];
    const created = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json", "x-vrata-admin-token": "surface-integration-admin" }, body: JSON.stringify({ tenantId: "demo-tenant", templateId: "personal-workspace-basic", name: "Surface integration", sceneBundleUrl: `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: 1, mediaSurfaces: surfaces }))}` }) });
    assert.equal(created.status, 201);
    const { roomId } = await created.json() as { roomId: string };
    const joined = await fetch(`${origin}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId, participantId: "observer", sceneMediaSurfaces: [{ surfaceId: "forged", label: "forged", allowedObjectTypes: ["remote-browser"] }] }) });
    assert.equal(joined.status, 200);
    const { token } = await joined.json() as { token: string };
    const verified = verifyRoomSessionToken(token, "surface-integration-secret", { roomId, participantId: "observer" });
    assert.ok(verified.ok);
    assert.deepEqual(verified.payload.sceneMediaSurfaces, surfaces);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.STATE_TOKEN_SECRET;
  }
});
