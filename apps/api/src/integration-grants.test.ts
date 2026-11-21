import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";

import { createIntegrationRoutes } from "./integration-routes.js";
import { completeGrantRevocation } from "./grant-revocation.js";
import { exchangeRoomGrant } from "./room-grant-exchange.js";
import { parseReturnTargets } from "./return-targets.js";
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

test("grant requests are bounded and allowlisted, accounts enter by visit, and a personal room admits no guests", async () => {
  const h = await harness();
  try {
    const demo = await h.room({ kind: "demo-instance", demoPolicyId: "qa-demo-v1" });
    for (const [body, message] of [
      [{ role: "member", purpose: "visit" }, /account subject/],
      [{ role: "host", purpose: "visit", subject: "acct_lowercase" }, /account subject/],
      [{ role: "guest", purpose: "visit", subject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW" }, /no subject/],
      [{ role: "member", purpose: "invite", maxUses: 2, subject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW" }, /invite grant is for guests/],
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
    assert.match((await h.call("POST", `${personal.path}/grants`, { body: { role: "host", purpose: "visit", subject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VX" }, idempotencyKey: key() })).body?.error.message, /only its owner/);

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

test("account grants: one participant per account on every device, first host only, and a revoke ends the account's access", async () => {
  const h = await harness();
  try {
    await h.storage.identityProtocol.raise(2);
    const meeting = await h.room({ kind: "reference", visibility: "unlisted" });
    const [owner, colleague] = ["acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VX"];
    const issue = async (role: string, subject: string) => {
      const grant = await h.call("POST", `${meeting.path}/grants`, { body: { role, purpose: "visit", subject }, idempotencyKey: key() });
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
      assert.deepEqual([grant.body!.role, grant.body!.subject, grant.body!.maxUses], [role, subject, 1]);
      return { grantId: grant.body!.grantId as string, code: new URL(grant.body!.entryUrl).hash.slice("#grant=".length) };
    };
    const exchange = async (code: string) => exchangeRoomGrant({ storage: h.storage, secret, requestId: "req_account", reserveAdmission: async () => true,
      payload: { roomId: meeting.roomId, code, displayName: "Account" } });
    const scope = { tenantId: meeting.tenant, roomId: meeting.roomId };

    const ownerGrant = await issue("host", owner);
    const host = await exchange(ownerGrant.code);
    assert.equal(host.status, 200, JSON.stringify(host.body));
    assert.match(host.body.participantId as string, /^acct_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual([host.body.role, JSON.stringify(host.body).includes(owner)], ["host", false], "the subject stays inside the platform");
    const laptop = await exchange((await issue("host", owner)).code);
    assert.deepEqual([laptop.body.participantId, laptop.body.role], [host.body.participantId, "host"], "a second device is the same participant");
    const member = await exchange((await issue("host", colleague)).code);
    assert.deepEqual([member.status, member.body.role], [200, "member"], "a later host grant does not take the room");
    assert.notEqual(member.body.participantId, host.body.participantId);

    // Revoking one grant of the account ends its access: both devices, and its other open grants.
    const unused = await issue("member", owner);
    const revoked = await h.call("POST", `${meeting.path}/grants/${ownerGrant.grantId}/revoke`, { body: { reason: "left the team" }, idempotencyKey: key() });
    assert.equal(revoked.status, 200);
    for (const credential of [host.body.identityCredential, laptop.body.identityCredential]) {
      const current = await h.storage.roomIdentities.resolve(createRoomIdentityCodec(secret).verify(credential, scope)!);
      assert.equal(current, null);
    }
    assert.deepEqual([(await exchange(unused.code)).status, (await h.storage.getManagedRoomGrant(unused.grantId))?.revokedAt !== null], [410, true]);
    assert.equal((await h.storage.listIncompleteManagedGrantRevocations()).every(grant => grant.grantId !== ownerGrant.grantId), true);
    assert(await h.storage.roomIdentities.resolve(createRoomIdentityCodec(secret).verify(member.body.identityCredential, scope)!), "another account keeps its access");

    // A new grant after the revoke is a new participant without the host it had.
    const back = await exchange((await issue("host", owner)).code);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.notEqual(back.body.participantId, host.body.participantId);
    assert.equal(back.body.role, "member");
  } finally {
    await h.close();
  }
});

test("a managed personal room belongs to its ownerSubject: every generation of that account owns it, no other enters", async () => {
  const h = await harness();
  try {
    await h.storage.identityProtocol.raise(2);
    const owner = "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW";
    const personal = await h.room({ kind: "reference", template: { templateId: "personal-room-basic", version: "2.0.0" }, ownerSubject: owner });
    const issue = async (subject: string) => h.call("POST", `${personal.path}/grants`, { body: { role: "host", purpose: "visit", subject }, idempotencyKey: key() });
    assert.match((await issue("acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VX")).body?.error.message, /only its owner/);
    const scope = { tenantId: personal.tenant, roomId: personal.roomId };
    const enter = async () => {
      const grant = await issue(owner);
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
      const entry = await exchangeRoomGrant({ storage: h.storage, secret, requestId: "req_owner", reserveAdmission: async () => true,
        payload: { roomId: personal.roomId, code: new URL(grant.body!.entryUrl).hash.slice("#grant=".length) } });
      assert.equal(entry.status, 200, JSON.stringify(entry.body));
      return { grantId: grant.body!.grantId as string, entry, current: (await h.storage.roomIdentities.resolve(createRoomIdentityCodec(secret).verify(entry.body.identityCredential, scope)!))! };
    };
    const first = await enter();
    assert.deepEqual([first.current.isOwner, first.current.role], [true, "host"]);
    assert.equal((await h.storage.getRoom(personal.roomId))?.ownerParticipantId ?? null, null);

    // After a revoke the owner comes back as a new participant and owns the room again; host stays an explicit change.
    assert.equal((await h.call("POST", `${personal.path}/grants/${first.grantId}/revoke`, { body: {}, idempotencyKey: key() })).status, 200);
    const again = await enter();
    assert.notEqual(again.entry.body.participantId, first.entry.body.participantId);
    assert.deepEqual([again.current.isOwner, again.current.role], [true, "member"]);
  } finally {
    await h.close();
  }
});

test("a guest of a grant never becomes host, by the host's transfer or an administrator's", async () => {
  const h = await harness();
  try {
    await h.storage.identityProtocol.raise(2);
    const meeting = await h.room({ kind: "reference", visibility: "unlisted" });
    const scope = { tenantId: meeting.tenant, roomId: meeting.roomId };
    const enter = async (body: Record<string, unknown>) => {
      const grant = await h.call("POST", `${meeting.path}/grants`, { body: { purpose: "visit", ...body }, idempotencyKey: key() });
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
      const entry = await exchangeRoomGrant({ storage: h.storage, secret, requestId: "req_host", reserveAdmission: async () => true,
        payload: { roomId: meeting.roomId, code: new URL(grant.body!.entryUrl).hash.slice("#grant=".length) } });
      assert.equal(entry.status, 200, JSON.stringify(entry.body));
      return { participantId: entry.body.participantId as string, proof: createRoomIdentityCodec(secret).verify(entry.body.identityCredential, scope)! };
    };
    const host = await enter({ role: "host", subject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW" });
    const member = await enter({ role: "member", subject: "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VX" });
    const guest = await enter({ role: "guest" });
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 600;
    const revision = (await h.storage.roomIdentities.authority(scope))!.revision;
    await assert.rejects(h.storage.roomIdentities.transferHost({ ...host.proof, expiresAtSeconds }, guest.proof.identityId, revision), /identity_forbidden/);
    for (const actor of [{ actorType: "room-session" as const, proof: host.proof, expiresAtSeconds }, { actorType: "admin-token" as const, actorId: "operator", role: "admin" as const }]) {
      await assert.rejects(h.storage.roomIdentities.transition(scope, actor, revision, { type: "transfer-host", targetParticipantId: guest.participantId }), /identity_forbidden/);
    }
    // The host hands over to an account instead.
    await h.storage.roomIdentities.transition(scope, { actorType: "room-session", proof: host.proof, expiresAtSeconds }, revision, { type: "transfer-host", targetParticipantId: member.participantId });
    assert.deepEqual([(await h.storage.roomIdentities.resolve(member.proof))!.role, (await h.storage.roomIdentities.resolve(guest.proof))!.role], ["host", "guest"]);
  } finally {
    await h.close();
  }
});

test("an account revoke has one boundary: late finishers, stalled exchanges and repeats never reach a later entry", async () => {
  const h = await harness();
  try {
    await h.storage.identityProtocol.raise(2);
    const meeting = await h.room({ kind: "reference", visibility: "unlisted" });
    const scope = { tenantId: meeting.tenant, roomId: meeting.roomId };
    const subject = "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW";
    const issue = async () => {
      const grant = await h.call("POST", `${meeting.path}/grants`, { body: { role: "member", purpose: "visit", subject }, idempotencyKey: key() });
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
      return { grantId: grant.body!.grantId as string, code: new URL(grant.body!.entryUrl).hash.slice("#grant=".length) };
    };
    const exchange = (code: string, storage = h.storage) => exchangeRoomGrant({ storage, secret, requestId: "req_boundary", reserveAdmission: async () => true,
      payload: { roomId: meeting.roomId, code } });
    const revoke = (grantId: string) => h.call("POST", `${meeting.path}/grants/${grantId}/revoke`, { body: {}, idempotencyKey: key() });
    const active = async (entry: Awaited<ReturnType<typeof exchange>>) =>
      (await h.storage.roomIdentities.resolve(createRoomIdentityCodec(secret).verify(entry.body.identityCredential, scope)!)) !== null;

    // The credentials never carry the subject.
    const first = await exchange((await issue()).code);
    for (const credential of [first.body.identityCredential, first.body.sessionToken] as string[]) {
      assert.equal(Buffer.from(credential.split(".")[1]!, "base64url").toString("utf8").includes(subject), false);
    }

    // Revoking an unused grant ends the generation at once; the finisher of the used grant comes later.
    const unused = await issue();
    assert.equal((await revoke(unused.grantId)).status, 200);
    assert.equal(await active(first), false);
    const later = await exchange((await issue()).code);
    assert.equal(later.status, 200);
    assert.notEqual(later.body.participantId, first.body.participantId);
    for (const pending of await h.storage.listIncompleteManagedGrantRevocations()) await completeGrantRevocation(h.storage, pending);
    assert.equal(await active(later), true, "a late finisher of the earlier revoke leaves the later entry");

    // A repeat of the first revoke with another key takes no grant issued since.
    const spare = await issue();
    assert.equal((await revoke(unused.grantId)).status, 200);
    assert.equal((await h.storage.getManagedRoomGrant(spare.grantId))?.revokedAt, null);

    // An exchange stalled after its grant was consumed: the revoke and a new entry happen meanwhile.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let consumed!: () => void;
    const reached = new Promise<void>(resolve => { consumed = resolve; });
    const stalling = new Proxy(h.storage, { get(target, property, receiver) {
      if (property === "consumeManagedRoomGrant") {
        return async (...args: Parameters<typeof target.consumeManagedRoomGrant>) => { const result = await target.consumeManagedRoomGrant(...args); consumed(); await gate; return result; };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as typeof h.storage;
    const stalled = exchange(spare.code, stalling);
    await reached;
    assert.equal((await revoke(spare.grantId)).status, 200);
    assert.equal(await active(later), false);
    const newest = await exchange((await issue()).code);
    release();
    assert.deepEqual([(await stalled).status, await active(newest)], [410, true], "the stalled exchange does not withdraw a generation it did not create");
    for (const pending of await h.storage.listIncompleteManagedGrantRevocations()) await completeGrantRevocation(h.storage, pending);
    assert.equal(await active(newest), true);

    // A failed link of an account entry withdraws nothing: the next device resumes the same participant.
    let failNext = true;
    const flaky = new Proxy(h.storage, { get(target, property, receiver) {
      if (property === "recordManagedRoomGrantIdentity" && failNext) return async () => { failNext = false; throw new Error("link_failed"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as typeof h.storage;
    await assert.rejects(exchange((await issue()).code, flaky), /link_failed/);
    const resumed = await exchange((await issue()).code);
    assert.deepEqual([resumed.body.participantId, await active(newest)], [newest.body.participantId, true]);
  } finally {
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

test("a grant exchange gives the way back that the portal allowlist makes of the grant's return context", async () => {
  const h = await harness();
  try {
    await h.storage.identityProtocol.raise(2);
    const demo = await h.room({ kind: "reference", visibility: "unlisted" });
    const returnTargets = parseReturnTargets(JSON.stringify({
      "catalog-entry": { ru: "https://ru.example.test/demos/{id}", en: "https://en.example.test/demos/{id}" },
      fallback: { ru: "https://ru.example.test/", en: "https://en.example.test/" }
    }));
    const enter = async (returnContext?: unknown, targets = returnTargets) => {
      const grant = await h.call("POST", `${demo.path}/grants`, { body: { role: "guest", purpose: "invite", maxUses: 1, ...(returnContext ? { returnContext } : {}) }, idempotencyKey: key() });
      assert.equal(grant.status, 201, JSON.stringify(grant.body));
      const code = new URL(grant.body!.entryUrl).hash.slice("#grant=".length);
      const entry = await exchangeRoomGrant({ storage: h.storage, secret, requestId: "req_return", reserveAdmission: async () => true, returnTargets: targets,
        payload: { roomId: demo.roomId, code } });
      assert.equal(entry.status, 200, JSON.stringify(entry.body));
      return entry.body;
    };
    const card = await enter({ kind: "catalog-entry", id: "meeting-room", locale: "ru" });
    assert.deepEqual([card.returnContext, card.returnUrls], [{ kind: "catalog-entry", id: "meeting-room", locale: "ru" },
      { ru: "https://ru.example.test/demos/meeting-room", en: "https://en.example.test/demos/meeting-room" }]);
    assert.deepEqual((await enter({ kind: "order", id: "ord_1", locale: "en" })).returnUrls, { ru: "https://ru.example.test/", en: "https://en.example.test/" });
    assert.deepEqual((await enter()).returnUrls, { ru: "https://ru.example.test/", en: "https://en.example.test/" });
    assert.equal("returnUrls" in await enter({ kind: "catalog-entry", id: "meeting-room", locale: "ru" }, parseReturnTargets(undefined)), false,
      "a platform without the portal allowlist shows no way back");
  } finally {
    await h.close();
  }
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
