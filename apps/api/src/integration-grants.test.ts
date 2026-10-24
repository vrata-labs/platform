import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createIntegrationRoutes } from "./integration-routes.js";
import { completeGrantRevocation } from "./grant-revocation.js";
import { exchangeRoomGrant } from "./room-grant-exchange.js";
import { MemoryStorage } from "./storage.js";
import { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion, type IntegrationTestKey } from "./testing/integration-assertions.js";

const stage = createIntegrationTestKey("portal-stage-1", "portal:stage");
const prod = createIntegrationTestKey("portal-prod-1", "portal:prod");
const secret = "integration-grants-state-secret-0123456789";
process.env.VRATA_PORTAL_MANAGED = "true";
process.env.VRATA_INTEGRATION_KEYS = integrationKeysEnv([stage, prod]);
process.env.VRATA_DEMO_POLICIES = JSON.stringify([{ policyId: "qa-demo-v1", templates: ["meeting-room-basic"], absoluteLifetimeSeconds: 1800, idleTimeoutSeconds: 600,
  maxParticipants: 2, features: { voice: true, screenShare: false, documents: false, upload: false, remoteBrowser: false } }]);
process.env.RUNTIME_BASE_URL = "https://app.example.test";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const tenantId = () => `pt_${Array.from({ length: 26 }, () => ULID_ALPHABET[randomInt(ULID_ALPHABET.length)]).join("")}`;
const key = () => `key_${randomUUID().replaceAll("-", "")}`;
const future = (seconds = 1200) => new Date(Date.now() + seconds * 1000).toISOString();

async function harness() {
  const storage = new MemoryStorage();
  await storage.transitionReferenceTemplateCatalog("active");
  const accessChanged: string[] = [];
  const route = createIntegrationRoutes({ getRequestId: () => `req_${randomUUID()}`, logEvent: () => undefined, stateSecret: () => secret,
    accessChanged: roomId => accessChanged.push(roomId) });
  const server = createServer((request, response) => {
    const pending = route(request, response, request.method ?? "GET", new URL(request.url ?? "/", "http://platform.internal"), storage);
    if (!pending) return void response.writeHead(418).end();
    pending.catch(error => { if (!response.headersSent) response.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, input: { body?: unknown; idempotencyKey?: string; as?: IntegrationTestKey; scope?: string[] } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json",
      authorization: `Bearer ${signIntegrationAssertion(input.as ?? stage, input.scope ? { scope: input.scope } : {})}` };
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
  }
  async function room(body: Record<string, unknown>, as = stage) {
    const tenant = tenantId();
    assert.equal((await call("PUT", `/integration/v1/tenants/${tenant}`, { body: { displayName: "Acme" }, idempotencyKey: key(), as })).status, 200);
    const created = await call("POST", `/integration/v1/tenants/${tenant}/rooms`, { body: { template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Room", accessUntil: future(), ...body }, idempotencyKey: key(), as });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { tenant, roomId: created.body!.roomId as string, room: created.body!, path: `/integration/v1/tenants/${tenant}/rooms/${created.body!.roomId}` };
  }
  return { storage, call, room, accessChanged, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("grant requests are guest-only, bounded and allowlisted, and a personal room admits no guests", async () => {
  const h = await harness();
  try {
    const demo = await h.room({ kind: "demo-instance", demoPolicyId: "qa-demo-v1" });
    for (const [body, message] of [
      [{ role: "member", purpose: "visit", subject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW" }, /Only guest grants/],
      [{ role: "guest", purpose: "preview-review" }, /preview-review/],
      [{ role: "guest", purpose: "visit", maxUses: 2 }, /exactly one use/],
      [{ role: "guest", purpose: "invite", maxUses: 51 }, /maxUses/],
      [{ role: "guest", purpose: "invite", displayName: "x".repeat(41) }, /displayName/],
      [{ role: "guest", purpose: "invite", returnContext: { kind: "url", id: "x", locale: "ru" } }, /returnContext/],
      [{ role: "guest", purpose: "invite", returnContext: { kind: "catalog-entry", id: "meeting", locale: "de" } }, /returnContext/],
      [{ role: "guest", purpose: "invite", expiresAt: "tomorrow" }, /expiresAt/],
      [{ role: "guest", purpose: "invite", extra: true }, /Unexpected fields/]
    ] as const) {
      const refused = await h.call("POST", `${demo.path}/grants`, { body, idempotencyKey: key() });
      assert.deepEqual([refused.status, refused.body?.error.code], [400, "invalid_request"], JSON.stringify(body));
      assert.match(refused.body!.error.message, message);
    }
    const personal = await h.room({ kind: "reference", template: { templateId: "personal-room-basic", version: "2.0.0" }, ownerSubject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW" });
    assert.match((await h.call("POST", `${personal.path}/grants`, { body: { role: "guest", purpose: "visit" }, idempotencyKey: key() })).body?.error.message, /personal room/);

    const scoped = await h.call("POST", `${demo.path}/grants`, { body: { role: "guest", purpose: "visit" }, idempotencyKey: key(), scope: ["createRoom"] });
    assert.deepEqual([scoped.status, scoped.body?.error.code], [403, "forbidden_scope"]);

    const issued = await h.call("POST", `${demo.path}/grants`, { body: { role: "guest", purpose: "invite", maxUses: 1, returnContext: { kind: "catalog-entry", id: "meeting-room", locale: "ru" } }, idempotencyKey: key() });
    assert.equal(issued.status, 201);

    process.env.RUNTIME_BASE_URL = "http://app.example.test";
    const unconfigured = await h.call("POST", `${demo.path}/grants`, { body: { role: "guest", purpose: "visit" }, idempotencyKey: key() });
    assert.deepEqual([unconfigured.status, unconfigured.body?.error.code], [503, "dependency_unavailable"]);
  } finally {
    process.env.RUNTIME_BASE_URL = "https://app.example.test";
    await h.close();
  }
});

test("close and revoke are idempotent, tenant-bound and signal the enforcer; usage reads only an owned tenant", async () => {
  const h = await harness();
  try {
    const demo = await h.room({ kind: "demo-instance", demoPolicyId: "qa-demo-v1" });
    const other = await h.room({ kind: "demo-instance", demoPolicyId: "qa-demo-v1" });
    const grant = await h.call("POST", `${other.path}/grants`, { body: { role: "guest", purpose: "visit" }, idempotencyKey: key() });
    const foreign = await h.call("POST", `${demo.path}/grants/${grant.body!.grantId}/revoke`, { body: {}, idempotencyKey: key() });
    assert.deepEqual([foreign.status, foreign.body?.error.code], [404, "grant_invalid"]);
    const revokeKey = key();
    const revoked = await h.call("POST", `${other.path}/grants/${grant.body!.grantId}/revoke`, { body: { reason: "test" }, idempotencyKey: revokeKey });
    assert.deepEqual([revoked.status, revoked.body?.entryUrl], [200, undefined]);
    assert.equal((await h.call("POST", `${other.path}/grants/${grant.body!.grantId}/revoke`, { body: { reason: "test" }, idempotencyKey: revokeKey })).headers.get("idempotency-replayed"), "true");

    const closeKey = key();
    const closed = await h.call("POST", `${demo.path}/close`, { body: { expectedRevision: 0 }, idempotencyKey: closeKey });
    assert.deepEqual([closed.status, closed.body?.status, closed.body?.graceSeconds], [200, "closed", 0]);
    const replayed = await h.call("POST", `${demo.path}/close`, { body: { expectedRevision: 0 }, idempotencyKey: closeKey });
    assert.deepEqual([replayed.headers.get("idempotency-replayed"), replayed.body], ["true", closed.body]);
    assert.deepEqual(h.accessChanged, [other.roomId, demo.roomId]);
    assert.equal((await h.call("POST", `${demo.path}/close`, { body: { expectedRevision: "0" }, idempotencyKey: key() })).body?.error.code, "invalid_request");
    const intruder = await h.call("POST", `${demo.path}/close`, { body: { expectedRevision: 1 }, idempotencyKey: key(), as: prod });
    assert.equal(intruder.body?.error.code, "tenant_mismatch");

    const usage = await h.call("GET", `/integration/v1/tenants/${demo.tenant}/usage?day=2026-10-23`);
    assert.deepEqual(usage.body, { tenantId: demo.tenant, day: "2026-10-23", participantSeconds: 0 });
    assert.equal((await h.call("GET", `/integration/v1/tenants/${demo.tenant}/usage?day=2026-10-23`, { as: prod })).body?.error.code, "tenant_mismatch");
    assert.equal((await h.call("GET", `/integration/v1/tenants/${demo.tenant}/usage`)).body?.error.code, "invalid_request");
  } finally {
    await h.close();
  }
});

test("a grant exchange needs identity v2, a valid body and admission budget", async () => {
  const storage = new MemoryStorage();
  const base = { storage, secret, requestId: "req_exchange_test", reserveAdmission: async () => true };
  const roomId = "3f2b8c1e-5a6d-4e7f-9a1b-2c3d4e5f6a7b";
  const code = "A".repeat(43);
  assert.equal((await exchangeRoomGrant({ ...base, payload: { roomId, code } })).status, 503, "no grant exchange before identity v2");
  await storage.identityProtocol.raise(2);
  for (const payload of [null, [], { roomId: "room", code }, { roomId, code: "short" }, { roomId, code, displayName: " " }, { roomId, code, extra: 1 }]) {
    assert.equal((await exchangeRoomGrant({ ...base, payload })).status, 400, JSON.stringify(payload));
  }
  assert.equal((await exchangeRoomGrant({ ...base, payload: { roomId, code } })).status, 404);
  const room = await storage.createManagedRoom({ roomId, tenantId: "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", name: "Demo", visibility: "private" }, {
    managedBy: "portal:stage", kind: "demo-instance", accessUntil: future(), graceSeconds: 0, operationId: randomUUID(), maxParticipants: 2 });
  const limited = await exchangeRoomGrant({ ...base, reserveAdmission: async () => false, payload: { roomId: room.roomId, code } });
  assert.deepEqual([limited.status, limited.retryAfterSeconds, (limited.body.error as { code: string }).code], [429, 60, "rate_limited"]);
  assert.equal(((await exchangeRoomGrant({ ...base, payload: { roomId: room.roomId, code } })).body.error as { code: string }).code, "grant_invalid");
});

test("finishing a revoke skips identities already revoked meanwhile and still asks for the new epoch", async () => {
  const storage = new MemoryStorage();
  await storage.identityProtocol.raise(2);
  const room = await storage.createManagedRoom({ roomId: randomUUID(), tenantId: "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", name: "Demo", visibility: "private" }, {
    managedBy: "portal:stage", kind: "demo-instance", accessUntil: future(), graceSeconds: 0, operationId: randomUUID(), maxParticipants: 4 });
  const grant = (await storage.issueManagedRoomGrant({ grantId: randomUUID(), roomId: room.roomId, role: "guest", purpose: "invite", maxUses: 3,
    expiresAt: future(), codeHash: "c".repeat(64), operationId: randomUUID() }))!;
  assert(typeof grant !== "string");
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  const identities = [];
  for (let index = 0; index < 2; index++) {
    assert.equal((await storage.consumeManagedRoomGrant(room.roomId, "c".repeat(64))).ok, true);
    const identity = await storage.roomIdentities.create({ ...scope, displayName: `Guest ${index}`, baseRole: "guest", provenance: { kind: "grant", grantId: grant.grantId, role: "guest" } });
    await storage.recordManagedRoomGrantIdentity(grant.grantId, identity.identityId);
    identities.push(identity);
  }
  // An exchange withdrew its own identity at the same time as the revoke.
  await storage.roomIdentities.revoke(scope, identities[0]!.identityId, identities[0]!.authEpoch);
  const revoked = (await storage.revokeManagedRoomGrant(grant.grantId, null, randomUUID()))!;
  await completeGrantRevocation(storage, revoked);
  assert((await storage.roomIdentities.get(scope, identities[1]!.identityId))?.revokedAt);
  assert.equal((await storage.listIncompleteManagedGrantRevocations()).length, 0);
  assert((await storage.listManagedRoomsForEnforcement()).some(record => record.roomId === room.roomId && record.rotateRequestedAt));
});

test("a revoke finished twice (the route and the enforcer at once) asks for one new epoch", async () => {
  const storage = new MemoryStorage();
  const room = await storage.createManagedRoom({ roomId: randomUUID(), tenantId: "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", name: "Demo", visibility: "private" }, {
    managedBy: "portal:stage", kind: "demo-instance", accessUntil: future(), graceSeconds: 0, operationId: randomUUID(), maxParticipants: 4 });
  const grant = (await storage.issueManagedRoomGrant({ grantId: randomUUID(), roomId: room.roomId, role: "guest", purpose: "visit", maxUses: 1,
    expiresAt: future(), codeHash: "d".repeat(64), operationId: randomUUID() }))!;
  assert(typeof grant !== "string");
  assert.equal((await storage.consumeManagedRoomGrant(room.roomId, "d".repeat(64))).ok, true);
  const revoked = (await storage.revokeManagedRoomGrant(grant.grantId, null, randomUUID()))!;
  await completeGrantRevocation(storage, revoked);
  const first = (await storage.listManagedRoomsForEnforcement()).find(record => record.roomId === room.roomId)!;
  assert(first.rotateRequestedAt);
  await storage.rotateManagedRoomEpoch(room.roomId, first.accessEpoch, null);
  await completeGrantRevocation(storage, revoked);
  const after = (await storage.listManagedRoomsForEnforcement()).find(record => record.roomId === room.roomId);
  assert.equal(after?.rotateRequestedAt ?? null, null, "the late finisher asks for nothing");
});
