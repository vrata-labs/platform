import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";
import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";

import { integrationRequestHash } from "./integration-routes.js";
import { PostgresStorage } from "./storage.js";
import { startApiProcess, type ApiProcess } from "./testing/api-process.js";
import { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion } from "./testing/integration-assertions.js";

const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const tenantId = () => `pt_${Array.from({ length: 26 }, () => ULID_ALPHABET[randomInt(ULID_ALPHABET.length)]).join("")}`;
const idempotencyKey = () => `key_${randomUUID().replaceAll("-", "")}`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const stateSecret = "integration-postgres-state-secret-0123456789";
const adminToken = "integration-postgres-admin";
const key = createIntegrationTestKey("portal-stage-1", "portal:stage");

test("portal-managed rooms on PostgreSQL: idempotent create, cutoff on every token path, crash recovery and restart", {
  skip: postgresUrl ? false : "VRATA_TEST_POSTGRES_URL is not set; skipping PostgreSQL integration API test",
  timeout: 180_000
}, async () => {
  assert.ok(postgresUrl);
  const schema = `vrata_integration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: postgresUrl });
  const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema},public` });
  const connectionUrl = new URL(postgresUrl);
  connectionUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const env = {
    POSTGRES_URL: connectionUrl.toString(),
    CONTROL_PLANE_ADMIN_TOKEN: adminToken,
    STATE_TOKEN_SECRET: stateSecret,
    VRATA_PORTAL_MANAGED: "true",
    VRATA_INTEGRATION_KEYS: integrationKeysEnv([key])
  };
  let api: ApiProcess | null = null;
  try {
    await admin.query(`create schema "${schema}"`);
    const storage = new PostgresStorage(pool);
    await storage.init();
    await storage.transitionReferenceTemplateCatalog("active");
    api = await startApiProcess(env);
    const call = async (method: string, path: string, input: { body?: unknown; key?: string; token?: string; headers?: Record<string, string> } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", ...input.headers };
      if (!input.headers?.["x-vrata-admin-token"] && !path.startsWith("/api/")) headers.authorization = `Bearer ${input.token ?? signIntegrationAssertion(key)}`;
      if (input.key) headers["idempotency-key"] = input.key;
      const response = await fetch(`${api!.baseUrl}${path}`, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
    };

    const tenant = tenantId();
    assert.equal((await call("PUT", `/integration/v1/tenants/${tenant}`, { body: { displayName: "Acme" }, key: idempotencyKey() })).status, 200, api.logs());
    const roomsPath = `/integration/v1/tenants/${tenant}/rooms`;
    const accessUntil = new Date(Date.now() + 4_000).toISOString();
    const createBody = { kind: "reference", template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Expiring", visibility: "unlisted", accessUntil };
    const createKey = idempotencyKey();
    const created = await call("POST", roomsPath, { body: createBody, key: createKey });
    assert.equal(created.status, 201, `${JSON.stringify(created.body)}\n${api.logs()}`);
    const roomId = created.body!.roomId as string;

    const concurrentKey = idempotencyKey();
    const concurrentBody = { ...createBody, name: "Concurrent", accessUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => call("POST", roomsPath, { body: concurrentBody, key: concurrentKey })));
    assert.equal(new Set(concurrent.filter(result => result.status === 201).map(result => result.body!.roomId)).size, 1);
    assert(concurrent.every(result => result.status === 201 || result.body?.error.code === "idempotency_in_progress"));
    assert.equal((await pool.query("select count(*)::int as count from integration_rooms where tenant_id = $1", [tenant])).rows[0].count, 2);

    const state = await call("POST", "/api/tokens/state", { body: { roomId, participantId: "guest-1", displayName: "Guest" } });
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const session = verifyRoomSessionToken(state.body!.token, stateSecret, { roomId });
    assert(session.ok);
    assert(session.payload.exp <= Math.floor(Date.parse(accessUntil) / 1000));
    assert(state.body!.expiresInSeconds <= 4);

    const adminHeaders = { "x-vrata-admin-token": adminToken };
    for (const [method, path, body] of [
      ["PATCH", `/api/rooms/${roomId}`, { name: "Renamed" }],
      ["DELETE", `/api/rooms/${roomId}`, undefined],
      ["POST", `/api/rooms/${roomId}/disable`, {}],
      ["POST", `/api/rooms/${roomId}/invites`, { role: "guest" }],
      ["POST", `/api/rooms/${roomId}/bind-scene-bundle`, { bundleId: "any" }]
    ] as const) {
      const result = await call(method, path, { body, headers: adminHeaders });
      assert.deepEqual([result.status, result.body?.reason], [403, "managed_resource"], `${method} ${path}`);
    }
    await assert.rejects(pool.query("delete from rooms where room_id = $1", [roomId]), /foreign key/);

    await delay(Math.max(0, Date.parse(accessUntil) - Date.now()) + 300);
    const expired = await call("POST", "/api/tokens/state", { body: { roomId, participantId: "guest-2" } });
    assert.deepEqual([expired.status, expired.body?.reason], [410, "access_expired"]);
    const renewal = await call("POST", "/api/tokens/state", { body: { roomId, participantId: "guest-1" }, headers: { authorization: `Bearer ${state.body!.token}` } });
    assert.equal(renewal.status, 410);
    const media = await call("POST", "/api/tokens/media", { body: { roomId, participantId: "guest-1", canPublishAudio: true, canPublishVideo: false, sessionToken: state.body!.token } });
    assert.notEqual(media.status, 200);

    const accessPath = `/integration/v1/tenants/${tenant}/rooms/${roomId}/access`;
    const extended = await call("PATCH", accessPath, { body: { expectedRevision: 0, accessUntil: new Date(Date.now() + 3_600_000).toISOString() }, key: idempotencyKey() });
    assert.deepEqual([extended.status, extended.body?.revision], [200, 1]);
    const reopened = await call("POST", "/api/tokens/state", { body: { roomId, participantId: "guest-3" } });
    assert.equal(reopened.status, 200);
    const activeSession = reopened.body!.token as string;
    const reopenedMedia = await call("POST", "/api/tokens/media", { body: { roomId, participantId: "guest-3", canPublishAudio: true, canPublishVideo: false, sessionToken: activeSession } });
    assert.equal(reopenedMedia.status, 200, JSON.stringify(reopenedMedia.body));
    assert.equal((await call("PATCH", accessPath, { body: { expectedRevision: 1, status: "paused" }, key: idempotencyKey() })).body?.status, "paused");
    const paused = await call("POST", "/api/tokens/state", { body: { roomId, participantId: "guest-4" } });
    assert.deepEqual([paused.status, paused.body?.reason], [423, "room_paused"]);
    const pausedMedia = await call("POST", "/api/tokens/media", { body: { roomId, participantId: "guest-3", canPublishAudio: true, canPublishVideo: false, sessionToken: activeSession } });
    assert.deepEqual([pausedMedia.status, pausedMedia.body?.reason], [423, "room_paused"]);
    const pausedPresence = await call("PUT", `/api/rooms/${roomId}/presence/guest-3`, { body: { displayName: "Guest" }, headers: { authorization: `Bearer ${activeSession}` } });
    assert.equal(pausedPresence.status, 423);

    // A request that committed its room and died before recording the result.
    const lostKey = idempotencyKey();
    const lostBody = { ...createBody, name: "Lost response", accessUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const begun = await storage.beginIntegrationOperation({ operationId: randomUUID(), principal: "portal:stage", idempotencyKey: lostKey, kind: "room.create", requestHash: integrationRequestHash("POST", roomsPath, lostBody), resourceType: "room", resourceId: randomUUID(), leaseSeconds: 1 });
    await storage.createManagedRoom({ roomId: begun.operation.resourceId!, tenantId: tenant, templateId: "meeting-room-basic", templateVersion: "2.0.0", name: "Lost response", visibility: "unlisted", guestAllowed: true }, { managedBy: "portal:stage", kind: "reference", accessUntil: lostBody.accessUntil, graceSeconds: 0, operationId: begun.operation.operationId });
    assert.equal((await call("POST", roomsPath, { body: lostBody, key: lostKey })).body?.error.code, "idempotency_in_progress");
    await delay(1_200);
    const recovered = await call("POST", roomsPath, { body: lostBody, key: lostKey });
    assert.deepEqual([recovered.status, recovered.body?.roomId], [201, begun.operation.resourceId]);

    const usedAssertion = signIntegrationAssertion(key);
    assert.equal((await call("GET", `/integration/v1/tenants/${tenant}/rooms/${roomId}`, { token: usedAssertion })).status, 200);
    await api.stop();
    api = await startApiProcess(env);
    const replayed = await call("POST", roomsPath, { body: createBody, key: createKey });
    assert.deepEqual([replayed.status, replayed.headers.get("idempotency-replayed"), replayed.body], [201, "true", created.body]);
    const operation = await call("GET", `/integration/v1/operations?idempotencyKey=${createKey}`);
    assert.deepEqual([operation.body?.state, operation.body?.result?.resourceId], ["succeeded", roomId]);
    const replayedAssertion = await call("GET", `/integration/v1/tenants/${tenant}/rooms/${roomId}`, { token: usedAssertion });
    assert.deepEqual([replayedAssertion.status, replayedAssertion.body?.error.details.reason], [401, "replayed_jti"]);
    assert.equal((await call("GET", `/integration/v1/tenants/${tenant}/rooms/${roomId}`)).body?.revision, 2);
    assert.equal((await pool.query("select count(*)::int as count from rooms where tenant_id = $1", [tenant])).rows[0].count, 3);
  } finally {
    await api?.stop();
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});
