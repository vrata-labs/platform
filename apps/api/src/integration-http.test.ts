import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test from "node:test";

import { startApiProcess } from "./testing/api-process.js";
import { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion } from "./testing/integration-assertions.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const tenantId = () => `pt_${Array.from({ length: 26 }, () => ULID_ALPHABET[randomInt(ULID_ALPHABET.length)]).join("")}`;
const adminToken = "integration-http-admin";
const key = createIntegrationTestKey("portal-stage-1", "portal:stage");

const productionEnv = {
  NODE_ENV: "production",
  CONTROL_PLANE_ADMIN_TOKEN: "test-admin-token",
  ROOM_STATE_PUBLIC_URL: "ws://127.0.0.1:2567",
  RUNTIME_BASE_URL: "http://127.0.0.1:4000",
  STATE_TOKEN_SECRET: "state-token-secret-0123456789abcdef",
  LIVEKIT_URL: "ws://127.0.0.1:7880",
  LIVEKIT_API_KEY: "local-livekit-key",
  LIVEKIT_API_SECRET: "local-livekit-secret-0123456789abcdef",
  VRATA_ALLOW_INSECURE_PRODUCTION_URLS: "true"
};

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test("API startup refuses a portal-managed deployment without valid integration keys", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  try {
    const module = await import("./index.js");
    assert.doesNotThrow(() => module.validateProductionApiEnv(productionEnv));
    assert.throws(() => module.validateProductionApiEnv({ ...productionEnv, VRATA_PORTAL_MANAGED: "true" }), /invalid_portal_managed_config:integration_keys_required/);
    assert.throws(() => module.validateProductionApiEnv({ ...productionEnv, VRATA_PORTAL_MANAGED: "true", VRATA_INTEGRATION_KEYS: "[{}]" }), /invalid_integration_keys/);
    const managed = { ...productionEnv, VRATA_PORTAL_MANAGED: "true", VRATA_INTEGRATION_KEYS: integrationKeysEnv([key]) };
    assert.doesNotThrow(() => module.validateProductionApiEnv(managed));
    assert.doesNotThrow(() => module.validateProductionApiEnv({ ...managed, VRATA_ADHOC_ROOMS: "true" }));
  } finally {
    delete process.env.VRATA_DISABLE_AUTOSTART;
  }
});

test("a portal-managed API serves no ad-hoc rooms and keeps direct paths off managed tenants", { timeout: 120_000 }, async () => {
  const api = await startApiProcess({ CONTROL_PLANE_ADMIN_TOKEN: adminToken, VRATA_PORTAL_MANAGED: "true", VRATA_INTEGRATION_KEYS: integrationKeysEnv([key]) });
  try {
    const health = await (await fetch(`${api.baseUrl}/health`)).json() as { features: Record<string, unknown> };
    assert.deepEqual([health.features.portalManaged, health.features.adhocRoomsEnabled], [true, false]);

    assert.equal((await post(api.baseUrl, "/api/tokens/state", { roomId: "no-such-room", participantId: "guest-1" })).status, 404);
    for (const path of ["/api/rooms/no-such-room/manifest", "/api/rooms/no-such-room/spaces", "/api/rooms/no-such-room/presence", "/api/rooms/no-such-room/session-control"]) {
      const response = await fetch(`${api.baseUrl}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal((await response.json() as { error: string }).error, "room_not_found");
    }
    const presence = await fetch(`${api.baseUrl}/api/rooms/no-such-room/presence/guest-1`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(presence.status, 404);
    assert.equal((await post(api.baseUrl, "/api/tokens/state", { roomId: "demo-room", participantId: "guest-1" })).status, 200, api.logs());

    const managedTenant = tenantId();
    const upsert = await fetch(`${api.baseUrl}/integration/v1/tenants/${managedTenant}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${signIntegrationAssertion(key)}`, "idempotency-key": "tenant-upsert-0001" },
      body: JSON.stringify({ displayName: "Acme" })
    });
    assert.equal(upsert.status, 200, api.logs());

    const admin = { "x-vrata-admin-token": adminToken };
    const denied = async (method: string, path: string, body?: unknown, headers: Record<string, string> = admin) => {
      const response = await fetch(`${api.baseUrl}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json() as { reason?: string };
      assert.deepEqual([response.status, payload.reason], [403, "managed_resource"], `${method} ${path}`);
    };
    await denied("PATCH", `/api/tenants/${managedTenant}`, { name: "Renamed" });
    await denied("DELETE", `/api/tenants/${managedTenant}`);
    await denied("POST", "/api/tenants", { tenantId: tenantId(), name: "Squatter" });
    await denied("POST", "/api/rooms", { tenantId: managedTenant, templateId: "meeting-room-basic", name: "Side door" });
    await denied("POST", "/api/personal-room", { tenantId: managedTenant, participantId: "anonymous-1" }, {});
    const tenants = await (await fetch(`${api.baseUrl}/api/tenants`, { headers: admin })).json() as { items: Array<{ tenantId: string; name: string }> };
    assert.equal(tenants.items.find(tenant => tenant.tenantId === managedTenant)?.name, "Acme");

    // The managed tenant, its name and its assets are no public catalogue: only the admin token lists them.
    assert.equal((await post(api.baseUrl, "/api/assets", { tenantId: managedTenant, kind: "scene", url: "https://cdn.example.test/acme.glb" }, admin)).status, 201);
    const listed = async (path: string, headers: Record<string, string> = {}) =>
      (await (await fetch(`${api.baseUrl}${path}`, { headers })).json() as { items: Array<{ tenantId: string }> }).items.map(item => item.tenantId);
    assert.deepEqual([(await listed("/api/tenants")).includes(managedTenant), (await listed("/api/tenants")).includes("demo-tenant")], [false, true]);
    assert.equal((await listed("/api/assets")).includes(managedTenant), false);
    assert.equal((await listed("/api/assets", admin)).includes(managedTenant), true);

    assert.equal((await post(api.baseUrl, "/api/rooms", { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Operator room" }, admin)).status, 201);
    assert.equal((await post(api.baseUrl, "/api/tenants", { tenantId: "operator-tenant", name: "Operator" }, admin)).status, 201);
  } finally {
    await api.stop();
  }
});

test("a self-hosted API keeps ad-hoc rooms and exposes no integration API", { timeout: 120_000 }, async () => {
  const api = await startApiProcess({ CONTROL_PLANE_ADMIN_TOKEN: adminToken });
  try {
    const health = await (await fetch(`${api.baseUrl}/health`)).json() as { features: Record<string, unknown> };
    assert.deepEqual([health.features.portalManaged, health.features.adhocRoomsEnabled], [false, true]);
    assert.equal((await post(api.baseUrl, "/api/tokens/state", { roomId: "adhoc-room", participantId: "guest-1" })).status, 200);
    assert.equal((await fetch(`${api.baseUrl}/api/rooms/adhoc-room/manifest`)).status, 200);
    const integration = await fetch(`${api.baseUrl}/integration/v1/tenants/${tenantId()}`, { method: "PUT", headers: { authorization: `Bearer ${signIntegrationAssertion(key)}` } });
    assert.equal(integration.status, 404);
  } finally {
    await api.stop();
  }
});
