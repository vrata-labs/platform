import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

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
const internalToken = "integration-postgres-internal-token";
const key = createIntegrationTestKey("portal-stage-1", "portal:stage");
const demoPolicy = {
  policyId: "qa-demo-v1", templates: ["meeting-room-basic", "presentation-room-basic"], absoluteLifetimeSeconds: 1800, idleTimeoutSeconds: 600,
  maxParticipants: 4, maxConcurrentInstances: 5, creationRateLimit: { perIpPerHour: 3, perBrowserPerHour: 3 },
  features: { voice: true, screenShare: false, documents: false, upload: false, remoteBrowser: false },
  killSwitch: { creationEnabled: true }, mediaBudget: { alertAtParticipantMinutesPerDay: 600, stopCreationAtParticipantMinutesPerDay: 1200 }
};

test("portal-managed rooms on PostgreSQL: grants, exchange, cutoff, close, epochs, crash recovery and restart", {
  skip: postgresUrl ? false : "VRATA_TEST_POSTGRES_URL is not set; skipping PostgreSQL integration API test",
  timeout: 240_000
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
    VRATA_INTERNAL_SERVICE_TOKEN: internalToken,
    VRATA_PORTAL_MANAGED: "true",
    VRATA_INTEGRATION_KEYS: integrationKeysEnv([key]),
    VRATA_DEMO_POLICIES: JSON.stringify([demoPolicy, { ...demoPolicy, policyId: "qa-meeting-only", templates: ["meeting-room-basic"] }]),
    VRATA_MANAGED_ENFORCER_INTERVAL_MS: "300",
    RUNTIME_BASE_URL: "https://app.example.test",
    LIVEKIT_URL: ""
  };
  let api: ApiProcess | null = null;
  try {
    await admin.query(`create schema "${schema}"`);
    const storage = new PostgresStorage(pool);
    await storage.init();
    await storage.transitionReferenceTemplateCatalog("active");
    await storage.identityProtocol.raise(2);
    api = await startApiProcess(env);
    const call = async (method: string, path: string, input: { body?: unknown; key?: string; token?: string; headers?: Record<string, string> } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", ...input.headers };
      if (!input.headers?.["x-vrata-admin-token"] && !path.startsWith("/api/")) headers.authorization = `Bearer ${input.token ?? signIntegrationAssertion(key)}`;
      if (input.key) headers["idempotency-key"] = input.key;
      const response = await fetch(`${api!.baseUrl}${path}`, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
    };
    const exchange = (roomId: string, code: string) => call("POST", "/api/room-grants/exchange", { body: { roomId, code, displayName: "Guest" } });
    const renew = (roomId: string, identityCredential: string) => call("POST", "/api/tokens/state", { body: { identityProtocolVersion: 2, roomId, identityCredential } });
    const verify = (roomId: string, participantId: string, sessionToken: string) =>
      call("POST", "/api/internal/identity-session/verify", { body: { roomId, participantId, sessionToken }, headers: { "x-vrata-internal-token": internalToken } });
    const codeOf = (entryUrl: string) => new URL(entryUrl).hash.slice("#grant=".length);

    const tenant = tenantId();
    assert.equal((await call("PUT", `/integration/v1/tenants/${tenant}`, { body: { displayName: "Acme" }, key: idempotencyKey() })).status, 200, api.logs());
    const roomsPath = `/integration/v1/tenants/${tenant}/rooms`;
    const createBody = { kind: "reference", template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Weekly", visibility: "unlisted", accessUntil: new Date(Date.now() + 3_600_000).toISOString() };
    const createKey = idempotencyKey();
    const created = await call("POST", roomsPath, { body: createBody, key: createKey });
    assert.equal(created.status, 201, `${JSON.stringify(created.body)}\n${api.logs()}`);
    const referenceId = created.body!.roomId as string;

    const concurrentKey = idempotencyKey();
    const concurrentBody = { ...createBody, name: "Concurrent" };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => call("POST", roomsPath, { body: concurrentBody, key: concurrentKey })));
    assert.equal(new Set(concurrent.filter(result => result.status === 201).map(result => result.body!.roomId)).size, 1);
    assert(concurrent.every(result => result.status === 201 || result.body?.error.code === "idempotency_in_progress"));

    // An unlisted managed room no longer admits anonymous guests or public participant ids: only grants enter.
    const anonymous = await call("POST", "/api/tokens/state", { body: { identityProtocolVersion: 2, roomId: referenceId, displayName: "Guest" } });
    assert.deepEqual([anonymous.status, anonymous.body?.reason], [403, "grant_required"]);

    const adminHeaders = { "x-vrata-admin-token": adminToken };
    for (const [method, path, body] of [
      ["PATCH", `/api/rooms/${referenceId}`, { name: "Renamed" }],
      ["DELETE", `/api/rooms/${referenceId}`, undefined],
      ["POST", `/api/rooms/${referenceId}/disable`, {}],
      ["POST", `/api/rooms/${referenceId}/invites`, { role: "guest" }]
    ] as const) {
      const result = await call(method, path, { body, headers: adminHeaders });
      assert.deepEqual([result.status, result.body?.reason], [403, "managed_resource"], `${method} ${path}`);
    }

    // A demo instance follows its policy.
    const demoBody = { kind: "demo-instance", template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Demo meeting", accessUntil: new Date(Date.now() + 1_500_000).toISOString(), demoPolicyId: "qa-demo-v1" };
    for (const [body, code] of [
      [{ ...demoBody, demoPolicyId: "unknown-policy" }, "invalid_request"],
      [{ ...demoBody, demoPolicyId: "qa-meeting-only", template: { templateId: "presentation-room-basic", version: "2.0.0" } }, "template_not_allowed"],
      [{ ...demoBody, ownerSubject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW" }, "invalid_request"],
      [{ ...demoBody, accessUntil: new Date(Date.now() + 7_200_000).toISOString() }, "invalid_request"]
    ] as const) {
      const refused = await call("POST", roomsPath, { body, key: idempotencyKey() });
      assert.equal(refused.body?.error.code, code, JSON.stringify(body));
    }
    const demo = await call("POST", roomsPath, { body: demoBody, key: idempotencyKey() });
    assert.deepEqual([demo.status, demo.body?.kind, demo.body?.demoPolicyId, demo.body?.visibility], [201, "demo-instance", "qa-demo-v1", "private"], JSON.stringify(demo.body));
    const demoId = demo.body!.roomId as string;
    const grantsPath = `/integration/v1/tenants/${tenant}/rooms/${demoId}/grants`;

    // The code is shown once: the replay of the same request answers without it, and only its hash is stored.
    const visitKey = idempotencyKey();
    const visitBody = { role: "guest", purpose: "visit", maxUses: 1 };
    const visit = await call("POST", grantsPath, { body: visitBody, key: visitKey });
    assert.equal(visit.status, 201, JSON.stringify(visit.body));
    assert.match(visit.body!.entryUrl, new RegExp(`^https://app\\.example\\.test/rooms/${demoId}#grant=[A-Za-z0-9_-]{43}$`));
    assert.equal(visit.body!.expiresAt, demo.body!.effectiveCutoff, "a grant never outlives the room cutoff");
    const visitCode = codeOf(visit.body!.entryUrl);
    const replayedGrant = await call("POST", grantsPath, { body: visitBody, key: visitKey });
    assert.deepEqual([replayedGrant.status, replayedGrant.body?.grantId, replayedGrant.body?.entryUrl], [201, visit.body!.grantId, undefined]);
    const stored = await pool.query(`select (select string_agg(row_to_json(g)::text, '') from integration_grants g) as grants,
      (select string_agg(row_to_json(o)::text, '') from integration_operations o) as operations`);
    assert(!stored.rows[0].grants.includes(visitCode) && !stored.rows[0].operations.includes(visitCode), "the grant code is stored only as a hash");

    const host = await exchange(demoId, visitCode);
    assert.equal(host.status, 200, JSON.stringify(host.body));
    assert.match(host.body!.participantId, /^[0-9a-f-]{36}$/);
    assert.match(host.body!.sessionToken, /^rs2\./);
    assert.match(host.body!.identityCredential, /^ri2\./);
    assert.equal(host.body!.cutoff, demo.body!.effectiveCutoff);
    assert.equal((await exchange(demoId, visitCode)).body?.error.code, "grant_invalid", "a visit grant has one use");
    assert.equal((await exchange(referenceId, visitCode)).body?.error.code, "grant_invalid", "a code of room A does not open room B");

    // visit (1) + invite (3) fill the four places; a further invite finds the room full.
    const invite = await call("POST", grantsPath, { body: { role: "guest", purpose: "invite", maxUses: 3 }, key: idempotencyKey() });
    const inviteCode = codeOf(invite.body!.entryUrl);
    const guests = await Promise.all([1, 2, 3].map(() => exchange(demoId, inviteCode)));
    assert.deepEqual(guests.map(guest => guest.status), [200, 200, 200], JSON.stringify(guests.map(guest => guest.body)));
    assert.equal((await exchange(demoId, inviteCode)).body?.error.code, "grant_invalid");
    const extra = await call("POST", grantsPath, { body: { role: "guest", purpose: "invite", maxUses: 2 }, key: idempotencyKey() });
    const full = await exchange(demoId, codeOf(extra.body!.entryUrl));
    assert.deepEqual([full.status, full.body?.error.code, full.headers.get("retry-after")], [503, "capacity_full", "60"]);

    const renewed = await renew(demoId, host.body!.identityCredential);
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert(renewed.body!.expiresInSeconds <= 900);
    assert.equal((await verify(demoId, host.body!.participantId, renewed.body!.token)).status, 200);
    // No LiveKit API here: a managed room refuses media instead of letting LiveKit create rooms on demand.
    const media = await call("POST", "/api/tokens/media", { body: { roomId: demoId, participantId: host.body!.participantId, canPublishAudio: true, canPublishVideo: false }, headers: { authorization: `Bearer ${renewed.body!.token}` } });
    assert.deepEqual([media.status, media.body?.error], [503, "media_unavailable"], JSON.stringify(media.body));

    // Pause: sockets lose verification, renewals stop, and the enforcer rotates the media epoch.
    const epochBefore = (await pool.query("select access_epoch::text as epoch from integration_rooms where room_id = $1", [demoId])).rows[0].epoch;
    const accessPath = `/integration/v1/tenants/${tenant}/rooms/${demoId}/access`;
    assert.equal((await call("PATCH", accessPath, { body: { expectedRevision: 0, status: "paused" }, key: idempotencyKey() })).body?.status, "paused");
    assert.deepEqual([(await verify(demoId, host.body!.participantId, renewed.body!.token)).status, (await renew(demoId, host.body!.identityCredential)).status], [403, 423]);
    let rotated: { epoch: string; retired: string[]; block: string } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      rotated = (await pool.query("select access_epoch::text as epoch, retired_epochs::text[] as retired, enforced_block as block from integration_rooms where room_id = $1", [demoId])).rows[0];
      if (rotated?.block === "room_paused") break;
      await delay(100);
    }
    assert.notEqual(rotated!.epoch, epochBefore);
    assert.deepEqual([rotated!.retired, rotated!.block], [[epochBefore], "room_paused"], "the old epoch waits for LiveKit");
    assert.match(api.logs(), /managed_media_control_unavailable/);
    assert.equal((await call("PATCH", accessPath, { body: { expectedRevision: 1, status: "active" }, key: idempotencyKey() })).body?.status, "active");

    // Revoking the invite revokes everyone who came in with it; the creator stays.
    const guestCredential = guests[0]!.body!.identityCredential as string;
    const revoked = await call("POST", `${grantsPath}/${invite.body!.grantId}/revoke`, { body: { reason: "test" }, key: idempotencyKey() });
    assert.deepEqual([revoked.status, typeof revoked.body?.revokedAt], [200, "string"]);
    assert.equal((await renew(demoId, guestCredential)).status, 409);
    assert.equal((await renew(demoId, host.body!.identityCredential)).status, 200);
    assert.equal((await call("POST", `${grantsPath}/${randomUUID()}/revoke`, { body: {}, key: idempotencyKey() })).body?.error.code, "grant_invalid");

    // Usage: room-state verifications are counted as participant-seconds of the tenant.
    const session = (await renew(demoId, host.body!.identityCredential)).body!;
    for (let index = 0; index < 5; index++) {
      assert.equal((await verify(demoId, host.body!.participantId, session.token)).status, 200);
      await delay(150);
    }
    await delay(700);
    const day = new Date().toISOString().slice(0, 10);
    const usage = await call("GET", `/integration/v1/tenants/${tenant}/usage?day=${day}`);
    assert.equal(usage.status, 200, JSON.stringify(usage.body));
    assert.deepEqual([usage.body!.tenantId, usage.body!.day], [tenant, day]);
    assert(usage.body!.participantSeconds > 0, JSON.stringify(usage.body));
    assert.equal((await call("GET", `/integration/v1/tenants/${tenant}/usage?day=2026-13-40`)).body?.error.code, "invalid_request");

    // Close is a tombstone: every path answers 410, nothing reopens it, and a repeated close returns the same room.
    const closePath = `/integration/v1/tenants/${tenant}/rooms/${demoId}/close`;
    assert.equal((await call("POST", closePath, { body: { expectedRevision: 0 }, key: idempotencyKey() })).body?.error.code, "revision_mismatch");
    const closed = await call("POST", closePath, { body: { expectedRevision: 2, reason: "ended" }, key: idempotencyKey() });
    assert.deepEqual([closed.status, closed.body?.status, closed.body?.revision], [200, "closed", 3], JSON.stringify(closed.body));
    assert(Date.parse(closed.body!.accessUntil) <= Date.parse(closed.body!.closedAt), "an older build sees the closed room as expired");
    const closedAgain = await call("POST", closePath, { body: { expectedRevision: 0 }, key: idempotencyKey() });
    assert.deepEqual([closedAgain.status, closedAgain.body?.closedAt], [200, closed.body!.closedAt]);
    assert.equal((await exchange(demoId, codeOf(extra.body!.entryUrl))).body?.error.code, "room_closed");
    assert.deepEqual([(await renew(demoId, host.body!.identityCredential)).status, (await verify(demoId, host.body!.participantId, session.token)).status], [410, 403]);
    assert.equal((await call("GET", `/api/rooms/${demoId}/presence`, { headers: { authorization: `Bearer ${session.token}` } })).status, 410);
    assert.equal((await call("PATCH", accessPath, { body: { expectedRevision: 3, accessUntil: new Date(Date.now() + 600_000).toISOString() }, key: idempotencyKey() })).body?.error.code, "room_closed");
    assert.equal((await call("POST", grantsPath, { body: visitBody, key: idempotencyKey() })).body?.error.code, "room_closed");

    // The access window applies to sessions of a room that expires.
    const expiring = await call("POST", roomsPath, { body: { ...createBody, name: "Expiring", accessUntil: new Date(Date.now() + 5_000).toISOString() }, key: idempotencyKey() });
    const expiringId = expiring.body!.roomId as string;
    const expiringGrant = await call("POST", `/integration/v1/tenants/${tenant}/rooms/${expiringId}/grants`, { body: visitBody, key: idempotencyKey() });
    const expiringGuest = await exchange(expiringId, codeOf(expiringGrant.body!.entryUrl));
    assert.equal(expiringGuest.status, 200, JSON.stringify(expiringGuest.body));
    assert(Date.parse(expiringGuest.body!.sessionExpiresAt) <= Date.parse(expiring.body!.effectiveCutoff), "a session never outlives the cutoff");
    await delay(Math.max(0, Date.parse(expiring.body!.effectiveCutoff) - Date.now()) + 300);
    const expiredRenewal = await renew(expiringId, expiringGuest.body!.identityCredential);
    assert.deepEqual([expiredRenewal.status, expiredRenewal.body?.reason], [410, "access_expired"]);

    // A request that committed its room and died before recording the result.
    const lostKey = idempotencyKey();
    const lostBody = { ...createBody, name: "Lost response" };
    const begun = await storage.beginIntegrationOperation({ operationId: randomUUID(), principal: "portal:stage", idempotencyKey: lostKey, kind: "room.create", requestHash: integrationRequestHash("POST", roomsPath, lostBody), resourceType: "room", resourceId: randomUUID(), leaseSeconds: 1 });
    await storage.createManagedRoom({ roomId: begun.operation.resourceId!, tenantId: tenant, templateId: "meeting-room-basic", templateVersion: "2.0.0", name: "Lost response", visibility: "unlisted", guestAllowed: true }, { managedBy: "portal:stage", kind: "reference", accessUntil: lostBody.accessUntil, graceSeconds: 0, operationId: begun.operation.operationId });
    assert.equal((await call("POST", roomsPath, { body: lostBody, key: lostKey })).body?.error.code, "idempotency_in_progress");
    await delay(1_200);
    const recovered = await call("POST", roomsPath, { body: lostBody, key: lostKey });
    assert.deepEqual([recovered.status, recovered.body?.roomId], [201, begun.operation.resourceId]);

    const usedAssertion = signIntegrationAssertion(key);
    assert.equal((await call("GET", `/integration/v1/tenants/${tenant}/rooms/${referenceId}`, { token: usedAssertion })).status, 200);
    await api.stop();
    api = await startApiProcess(env);
    const replayed = await call("POST", roomsPath, { body: createBody, key: createKey });
    assert.deepEqual([replayed.status, replayed.headers.get("idempotency-replayed"), replayed.body], [201, "true", created.body]);
    const operation = await call("GET", `/integration/v1/operations?idempotencyKey=${createKey}`);
    assert.deepEqual([operation.body?.state, operation.body?.result?.resourceId], ["succeeded", referenceId]);
    const replayedAssertion = await call("GET", `/integration/v1/tenants/${tenant}/rooms/${referenceId}`, { token: usedAssertion });
    assert.deepEqual([replayedAssertion.status, replayedAssertion.body?.error.details.reason], [401, "replayed_jti"]);
    assert.equal((await call("GET", `/integration/v1/tenants/${tenant}/rooms/${demoId}`)).body?.status, "closed");
  } finally {
    await api?.stop();
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});
