import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createIntegrationRoutes, integrationRequestHash } from "./integration-routes.js";
import { MemoryStorage, type Storage } from "./storage.js";
import { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion, type IntegrationTestKey } from "./testing/integration-assertions.js";

const stage = createIntegrationTestKey("portal-stage-1", "portal:stage");
const prod = createIntegrationTestKey("portal-prod-1", "portal:prod");
process.env.VRATA_PORTAL_MANAGED = "true";
process.env.VRATA_INTEGRATION_KEYS = integrationKeysEnv([stage, prod]);

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => Array.from({ length: 26 }, () => ULID_ALPHABET[randomInt(ULID_ALPHABET.length)]).join("");
const tenantId = () => `pt_${ulid()}`;
const key = () => `key_${randomUUID().replaceAll("-", "")}`;
const future = (seconds = 3600) => new Date(Date.now() + seconds * 1000).toISOString();

async function harness(options: { storage?: Storage; leaseSeconds?: number } = {}) {
  const memory = new MemoryStorage();
  await memory.transitionReferenceTemplateCatalog("active");
  const storage = options.storage ?? memory;
  const route = createIntegrationRoutes({ getRequestId: () => `req_${randomUUID()}`, logEvent: () => undefined, operationLeaseSeconds: options.leaseSeconds });
  const server = createServer((request, response) => {
    const pending = route(request, response, request.method ?? "GET", new URL(request.url ?? "/", "http://platform.internal"), storage);
    if (!pending) return void response.writeHead(418).end();
    pending.catch(error => { if (!response.headersSent) response.writeHead(500).end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, input: { body?: unknown; idempotencyKey?: string; as?: IntegrationTestKey | null; scope?: string[]; token?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const signer = input.as === undefined ? stage : input.as;
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    else if (signer) headers.authorization = `Bearer ${signIntegrationAssertion(signer, input.scope ? { scope: input.scope } : {})}`;
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
  }
  async function managedTenant(as = stage) {
    const id = tenantId();
    const result = await call("PUT", `/integration/v1/tenants/${id}`, { body: { displayName: "Acme" }, idempotencyKey: key(), as });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return id;
  }
  const roomBody = (overrides: Record<string, unknown> = {}) => ({ kind: "reference", template: { templateId: "meeting-room-basic", version: "2.0.0" }, name: "Weekly sync", accessUntil: future(), ...overrides });
  return { storage, memory, call, managedTenant, roomBody, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("integration API authenticates every call with a fresh, scoped service assertion", async () => {
  const h = await harness();
  try {
    const path = `/integration/v1/tenants/${tenantId()}`;
    const body = { displayName: "Acme" };
    assert.equal((await h.call("PUT", path, { body, idempotencyKey: key(), as: null })).body?.error.code, "unauthenticated");
    const forged = await h.call("PUT", path, { body, idempotencyKey: key(), as: createIntegrationTestKey(stage.kid, "portal:stage") });
    assert.equal(forged.status, 401);
    assert.equal(forged.body?.error.details.reason, "invalid_signature");
    const token = signIntegrationAssertion(stage);
    assert.equal((await h.call("PUT", path, { body, idempotencyKey: key(), token })).status, 200);
    const replay = await h.call("PUT", path, { body, idempotencyKey: key(), token });
    assert.equal(replay.status, 401);
    assert.equal(replay.body?.error.details.reason, "replayed_jti");
    const scoped = await h.call("PUT", path, { body, idempotencyKey: key(), scope: ["getRoom"] });
    assert.equal(scoped.status, 403);
    assert.equal(scoped.body?.error.code, "forbidden_scope");
    for (const field of ["code", "message", "requestId", "retryable"]) assert(field in scoped.body!.error, field);
    process.env.VRATA_PORTAL_MANAGED = "false";
    try {
      assert.equal((await h.call("PUT", path, { body, idempotencyKey: key() })).status, 404);
    } finally { process.env.VRATA_PORTAL_MANAGED = "true"; }
    const saved = process.env.VRATA_INTEGRATION_KEYS;
    process.env.VRATA_INTEGRATION_KEYS = "";
    try {
      const unconfigured = await h.call("PUT", path, { body, idempotencyKey: key() });
      assert.equal(unconfigured.status, 503);
      assert.equal(unconfigured.body?.error.code, "dependency_unavailable");
    } finally { process.env.VRATA_INTEGRATION_KEYS = saved; }
  } finally { await h.close(); }
});

test("tenant upsert records managedBy, replays by key and refuses foreign or unmanaged tenants", async () => {
  const h = await harness();
  try {
    const id = tenantId();
    const path = `/integration/v1/tenants/${id}`;
    const idempotencyKey = key();
    const created = await h.call("PUT", path, { body: { displayName: "Acme" }, idempotencyKey });
    assert.deepEqual([created.status, created.body], [200, { tenantId: id, managedBy: "portal:stage", revision: 0 }]);
    const replayed = await h.call("PUT", path, { body: { displayName: "Acme" }, idempotencyKey });
    assert.deepEqual(replayed.body, created.body);
    assert.equal(replayed.headers.get("idempotency-replayed"), "true");
    const reused = await h.call("PUT", path, { body: { displayName: "Other" }, idempotencyKey });
    assert.deepEqual([reused.status, reused.body?.error.code], [409, "idempotency_key_reused"]);
    assert.equal((await h.call("PUT", path, { body: { displayName: "Acme" }, idempotencyKey: key() })).body?.revision, 0);
    assert.equal((await h.call("PUT", path, { body: { displayName: "Acme Inc" }, idempotencyKey: key() })).body?.revision, 1);
    assert.equal((await h.storage.listTenants()).find(tenant => tenant.tenantId === id)?.name, "Acme Inc");
    const foreign = await h.call("PUT", path, { body: { displayName: "Acme" }, idempotencyKey: key(), as: prod });
    assert.deepEqual([foreign.status, foreign.body?.error.code], [403, "tenant_mismatch"]);
    const unmanaged = tenantId();
    await h.storage.createTenant({ tenantId: unmanaged, name: "Created by an operator" });
    assert.equal((await h.call("PUT", `/integration/v1/tenants/${unmanaged}`, { body: { displayName: "Acme" }, idempotencyKey: key() })).body?.error.code, "tenant_mismatch");
    assert.equal((await h.call("PUT", "/integration/v1/tenants/demo-tenant", { body: { displayName: "Acme" }, idempotencyKey: key() })).status, 400);
    assert.equal((await h.call("PUT", path, { body: { displayName: "Acme" } })).body?.error.code, "invalid_request");
    assert.equal((await h.call("PUT", path, { body: { displayName: "Acme", managedBy: "portal:prod" }, idempotencyKey: key() })).status, 400);
  } finally { await h.close(); }
});

test("createRoom returns one reference room per idempotency key, even under concurrent retries", async () => {
  const h = await harness();
  try {
    const id = await h.managedTenant();
    const path = `/integration/v1/tenants/${id}/rooms`;
    const idempotencyKey = key();
    const body = h.roomBody({ graceSeconds: 120, visibility: "unlisted" });
    const created = await h.call("POST", path, { body, idempotencyKey });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const room = created.body!;
    assert.equal(room.contract, "platform-integration-v1");
    assert.match(room.roomId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual([room.tenantId, room.kind, room.status, room.visibility, room.revision, room.graceSeconds], [id, "reference", "active", "unlisted", 0, 120]);
    assert.deepEqual(room.template, { templateId: "meeting-room-basic", version: "2.0.0" });
    assert.equal(room.scene.releaseId, "meeting-room-basic@2.0.0");
    assert.match(room.scene.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Date.parse(room.effectiveCutoff) - Date.parse(room.accessUntil), 120_000);
    const replayed = await h.call("POST", path, { body, idempotencyKey });
    assert.deepEqual([replayed.status, replayed.body], [201, room]);
    assert.equal((await h.call("POST", path, { body: { ...body, name: "Other" }, idempotencyKey })).body?.error.code, "idempotency_key_reused");

    const concurrentKey = key();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.call("POST", path, { body: h.roomBody({ name: "Concurrent", accessUntil: body.accessUntil }), idempotencyKey: concurrentKey })));
    const successes = results.filter(result => result.status === 201);
    assert(successes.length >= 1);
    assert.equal(new Set(successes.map(result => result.body!.roomId)).size, 1);
    assert(results.every(result => result.status === 201 || (result.status === 409 && result.body?.error.code === "idempotency_in_progress" && result.body.error.retryable)));
    const managedRooms = (await h.storage.listRooms()).filter(item => item.tenantId === id);
    assert.equal(managedRooms.length, 2);
    assert(managedRooms.every(item => item.managed?.managedBy === "portal:stage" && item.roomId !== "demo-room"));

    const operation = await h.call("GET", `/integration/v1/operations?idempotencyKey=${idempotencyKey}`);
    assert.equal(operation.status, 200);
    assert.deepEqual([operation.body?.state, operation.body?.kind, operation.body?.result], ["succeeded", "room.create", { resourceType: "room", resourceId: room.roomId, revision: 0 }]);
    assert.equal(operation.body?.requestHash, integrationRequestHash("POST", path, body));
    assert.deepEqual((await h.call("GET", `/integration/v1/operations/${operation.body?.operationId}`)).body, operation.body);
    assert.equal((await h.call("GET", `/integration/v1/operations/${operation.body?.operationId}`, { as: prod })).status, 404);
    assert.equal((await h.call("GET", `/integration/v1/operations?idempotencyKey=${key()}`)).status, 404);
  } finally { await h.close(); }
});

test("createRoom lets the server own template, owner and scene; unsupported requests change nothing", async () => {
  const h = await harness();
  try {
    const id = await h.managedTenant();
    const path = `/integration/v1/tenants/${id}/rooms`;
    const before = (await h.storage.listRooms()).length;
    const subject = `acct_${ulid()}`;
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [h.roomBody({ kind: "demo-instance", demoPolicyId: "demo-default" }), 400, "invalid_request"],
      [h.roomBody({ kind: "custom", bundleVersionId: randomUUID() }), 400, "invalid_request"],
      [h.roomBody({ template: { templateId: "personal-room-basic", version: "2.0.0" } }), 400, "invalid_request"],
      [h.roomBody({ template: { templateId: "personal-room-basic", version: "2.0.0" }, ownerSubject: subject, visibility: "unlisted" }), 400, "invalid_request"],
      [h.roomBody({ accessUntil: new Date(Date.now() - 1000).toISOString() }), 400, "invalid_request"],
      [h.roomBody({ accessUntil: "tomorrow" }), 400, "invalid_request"],
      [h.roomBody({ graceSeconds: 86_401 }), 400, "invalid_request"],
      [h.roomBody({ sceneBundleUrl: "https://evil.example/scene.json" }), 400, "invalid_request"],
      [h.roomBody({ roomId: randomUUID() }), 400, "invalid_request"],
      [h.roomBody({ ownerSubject: "owner-1" }), 400, "invalid_request"],
      [h.roomBody({ template: { templateId: "meeting-room-basic", version: "1.0.0" } }), 422, "template_not_allowed"],
      [h.roomBody({ template: { templateId: "showroom-basic", version: "0.1.0" } }), 400, "invalid_request"]
    ];
    for (const [body, status, code] of cases) {
      const result = await h.call("POST", path, { body, idempotencyKey: key() });
      assert.deepEqual([result.status, result.body?.error.code], [status, code], JSON.stringify(body));
    }
    assert.equal((await h.storage.listRooms()).length, before);
    assert.equal((await h.call("POST", `/integration/v1/tenants/${await h.managedTenant(prod)}/rooms`, { body: h.roomBody(), idempotencyKey: key() })).body?.error.code, "tenant_mismatch");
    assert.equal((await h.call("POST", `/integration/v1/tenants/${tenantId()}/rooms`, { body: h.roomBody(), idempotencyKey: key() })).body?.error.code, "tenant_mismatch");

    const personal = await h.call("POST", path, { body: h.roomBody({ template: { templateId: "personal-room-basic", version: "2.0.0" }, ownerSubject: subject }), idempotencyKey: key() });
    assert.equal(personal.status, 201, JSON.stringify(personal.body));
    assert.equal(personal.body?.ownerSubject, subject);
    const stored = await h.storage.getRoom(personal.body!.roomId);
    assert.deepEqual([stored?.roomType, stored?.ownerParticipantId, stored?.visibility, stored?.guestAllowed], ["personal", subject, "private", false]);
    assert(stored?.sceneBundleUrl?.includes("personal-workspace-v1@"));
  } finally { await h.close(); }
});

function failingOnce<T extends keyof Storage>(storage: Storage, method: T, armed = true): { storage: Storage; failed: () => boolean; arm: () => void } {
  let failed = !armed;
  let fired = false;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== method || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        if (!failed) { failed = true; fired = true; throw new Error("simulated_crash_after_commit"); }
        return value.apply(target, args);
      };
    }
  });
  return { storage: proxy, failed: () => fired, arm: () => { failed = false; fired = false; } };
}

test("a retry after a crash between commit and response returns the committed room and revision", async () => {
  const base = new MemoryStorage();
  await base.transitionReferenceTemplateCatalog("active");
  const crash = failingOnce(base, "completeIntegrationOperation");
  const h = await harness({ storage: crash.storage });
  try {
    const id = tenantId();
    await base.upsertIntegrationTenant({ tenantId: id, managedBy: "portal:stage", displayName: "Acme" });
    const path = `/integration/v1/tenants/${id}/rooms`;
    const body = h.roomBody();
    const idempotencyKey = key();
    const lost = await h.call("POST", path, { body, idempotencyKey });
    assert(crash.failed());
    assert.deepEqual([lost.status, lost.body?.error.code, lost.body?.error.retryable], [503, "dependency_unavailable", true]);
    const committed = (await base.listRooms()).filter(room => room.tenantId === id);
    assert.equal(committed.length, 1);
    const retried = await h.call("POST", path, { body, idempotencyKey });
    assert.equal(retried.status, 201);
    assert.equal(retried.body?.roomId, committed[0]!.roomId);
    assert.equal((await base.listRooms()).filter(room => room.tenantId === id).length, 1);
    assert.equal((await base.findIntegrationOperation("portal:stage", idempotencyKey))?.state, "succeeded");
  } finally { await h.close(); }

  const access = new MemoryStorage();
  await access.transitionReferenceTemplateCatalog("active");
  const accessCrash = failingOnce(access, "completeIntegrationOperation", false);
  const g = await harness({ storage: accessCrash.storage });
  try {
    const id = tenantId();
    await access.upsertIntegrationTenant({ tenantId: id, managedBy: "portal:stage", displayName: "Acme" });
    const room = await g.call("POST", `/integration/v1/tenants/${id}/rooms`, { body: g.roomBody(), idempotencyKey: key() });
    assert.equal(room.status, 201);
    const accessPath = `/integration/v1/tenants/${id}/rooms/${room.body!.roomId}/access`;
    const patch = { expectedRevision: 0, status: "paused", reason: "billing" };
    const idempotencyKey = key();
    accessCrash.arm();
    const lost = await g.call("PATCH", accessPath, { body: patch, idempotencyKey });
    assert(accessCrash.failed());
    assert.equal(lost.status, 503);
    assert.deepEqual([(await access.getRoom(room.body!.roomId))?.managed?.revision, (await access.getRoom(room.body!.roomId))?.managed?.status], [1, "paused"]);
    // Without the operation marker this retry would see revision 1 and answer revision_mismatch.
    const retried = await g.call("PATCH", accessPath, { body: patch, idempotencyKey });
    assert.deepEqual([retried.status, retried.body?.revision, retried.body?.status], [200, 1, "paused"]);
    const replayed = await g.call("PATCH", accessPath, { body: patch, idempotencyKey });
    assert.deepEqual(replayed.body, retried.body);
    assert.equal((await access.getRoom(room.body!.roomId))?.managed?.revision, 1);
  } finally { await g.close(); }
});

test("a crashed request keeps its key leased, then a retry finishes the same operation", async () => {
  const base = new MemoryStorage();
  await base.transitionReferenceTemplateCatalog("active");
  const id = tenantId();
  await base.upsertIntegrationTenant({ tenantId: id, managedBy: "portal:stage", displayName: "Acme" });
  const h = await harness({ storage: base, leaseSeconds: 1 });
  try {
    const path = `/integration/v1/tenants/${id}/rooms`;
    // accessUntil passes while the key is leased; the retry must still return the committed room.
    const body = h.roomBody({ accessUntil: future(1) });
    const idempotencyKey = key();
    // A process that died after committing the room and before writing the operation result.
    const begun = await base.beginIntegrationOperation({ operationId: randomUUID(), principal: "portal:stage", idempotencyKey, kind: "room.create", requestHash: integrationRequestHash("POST", path, body), resourceType: "room", resourceId: randomUUID(), leaseSeconds: 1 });
    await base.createManagedRoom({ roomId: begun.operation.resourceId!, tenantId: id, templateId: "meeting-room-basic", name: "Weekly sync", visibility: "private", guestAllowed: false }, { managedBy: "portal:stage", kind: "reference", accessUntil: body.accessUntil as string, graceSeconds: 0, operationId: begun.operation.operationId });
    const busy = await h.call("POST", path, { body, idempotencyKey });
    assert.deepEqual([busy.status, busy.body?.error.code, busy.body?.error.details.operationId], [409, "idempotency_in_progress", begun.operation.operationId]);
    const pending = await h.call("GET", `/integration/v1/operations?idempotencyKey=${idempotencyKey}`);
    assert.equal(pending.body?.state, "running");
    assert(!("result" in pending.body!));
    await new Promise(resolve => setTimeout(resolve, 1100));
    const finished = await h.call("POST", path, { body, idempotencyKey });
    assert.deepEqual([finished.status, finished.body?.roomId], [201, begun.operation.resourceId]);
    assert.equal((await base.listRooms()).filter(room => room.tenantId === id).length, 1);
  } finally { await h.close(); }
});

test("access updates use CAS, replay by key and stay inside the principal's tenant", async () => {
  const h = await harness();
  try {
    const id = await h.managedTenant();
    const created = await h.call("POST", `/integration/v1/tenants/${id}/rooms`, { body: h.roomBody(), idempotencyKey: key() });
    const roomId = created.body!.roomId as string;
    const accessPath = `/integration/v1/tenants/${id}/rooms/${roomId}/access`;
    const extendedUntil = future(7200);
    const extendKey = key();
    const extended = await h.call("PATCH", accessPath, { body: { expectedRevision: 0, accessUntil: extendedUntil, graceSeconds: 60 }, idempotencyKey: extendKey });
    assert.equal(extended.status, 200);
    assert.deepEqual([extended.body?.revision, extended.body?.accessUntil, extended.body?.graceSeconds], [1, new Date(extendedUntil).toISOString(), 60]);
    const stale = await h.call("PATCH", accessPath, { body: { expectedRevision: 0, status: "paused" }, idempotencyKey: key() });
    assert.deepEqual([stale.status, stale.body?.error.code, stale.body?.error.details.currentRevision], [409, "revision_mismatch", 1]);
    assert.equal((await h.storage.getRoom(roomId))?.managed?.status, "active");
    const paused = await h.call("PATCH", accessPath, { body: { expectedRevision: 1, status: "paused" }, idempotencyKey: key() });
    assert.deepEqual([paused.body?.status, paused.body?.revision], ["paused", 2]);
    const replay = await h.call("PATCH", accessPath, { body: { expectedRevision: 0, accessUntil: extendedUntil, graceSeconds: 60 }, idempotencyKey: extendKey });
    assert.deepEqual(replay.body, extended.body);
    assert.equal((await h.call("GET", `/integration/v1/tenants/${id}/rooms/${roomId}`)).body?.revision, 2);
    for (const body of [{ expectedRevision: 2 }, { expectedRevision: -1, status: "active" }, { expectedRevision: 2, status: "closed" }, { expectedRevision: 2, status: "active", extra: true }]) {
      assert.equal((await h.call("PATCH", accessPath, { body, idempotencyKey: key() })).status, 400, JSON.stringify(body));
    }

    const sibling = await h.managedTenant();
    assert.equal((await h.call("GET", `/integration/v1/tenants/${sibling}/rooms/${roomId}`)).body?.error.code, "room_not_found");
    assert.equal((await h.call("PATCH", `/integration/v1/tenants/${sibling}/rooms/${roomId}/access`, { body: { expectedRevision: 2, status: "active" }, idempotencyKey: key() })).status, 404);
    assert.equal((await h.call("GET", `/integration/v1/tenants/${id}/rooms/${roomId}`, { as: prod })).body?.error.code, "tenant_mismatch");
    assert.equal((await h.call("GET", `/integration/v1/tenants/${id}/rooms/demo-room`)).status, 400);
    assert.equal((await h.call("GET", `/integration/v1/tenants/${id}/rooms/${randomUUID()}`)).status, 404);
    assert.equal((await h.call("DELETE", `/integration/v1/tenants/${id}/rooms/${roomId}`)).status, 404);
  } finally { await h.close(); }
});
