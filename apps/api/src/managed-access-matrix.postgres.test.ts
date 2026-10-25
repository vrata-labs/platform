import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { PostgresStorage } from "./storage.js";
import { startApiProcess, type ApiProcess } from "./testing/api-process.js";
import { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion } from "./testing/integration-assertions.js";

// T12 entry-point matrix: every room-scoped route of a portal-managed room against every kind of caller, straight
// at the API (no ingress). A caller outside the room never gets its data or changes it; host operations need the host;
// routes closed for managed rooms stay closed. The registry is checked against the routes in the built sources, so a
// new room route without a row fails here.

const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => Array.from({ length: 26 }, () => ULID_ALPHABET[randomInt(ULID_ALPHABET.length)]).join("");
const idempotencyKey = () => `key_${randomUUID().replaceAll("-", "")}`;
const adminToken = "matrix-admin";
const internalToken = "matrix-internal-token";
const key = createIntegrationTestKey("portal-stage-1", "portal:stage");
const SHARED_SECRET = "SECRET-A-SHARED-NOTE";
const PRIVATE_SECRET = "SECRET-A-PRIVATE-NOTE";

type Caller = "anonymous" | "otherTenant" | "otherRoom" | "revoked" | "guest" | "member" | "host";
const OUTSIDERS: readonly Caller[] = ["anonymous", "otherTenant", "otherRoom", "revoked"];
const INSIDERS: readonly Caller[] = ["guest", "member", "host"];

/**
 * Every caller outside the room is refused (4xx) on every route but public and telemetry ones, and no answer to it
 * carries the room's data. On top of that: room — the host reaches it (a read); restricted — what roles inside may
 * do is the route's own permission; host — guests and members are refused too; closed — managed rooms refuse it to
 * everyone; public — boot metadata without customer data; telemetry — accepted from anyone, it reads nothing.
 */
type Policy = "public" | "room" | "restricted" | "host" | "closed" | "telemetry";

interface Fixture { roomId: string; hostId: string; memberId: string; guestId: string }
/** `skip`: callers that do not run a probe, because the probe would change the room's own data for them. */
interface Probe { method: string; path: (f: Fixture) => string; body?: (f: Fixture) => unknown; policy: Policy; skip?: readonly Caller[] }
interface Route { pattern: string; probes: Probe[] }

const room = (suffix: string) => (f: Fixture) => `/api/rooms/${f.roomId}${suffix}`;
const ROUTES: Route[] = [
  // Scope helpers of the request boundary, not routes: the room and participant of a path, the routes it may defer.
  { pattern: String.raw`^\/api\/rooms\/([^/]+)(?:\/|$)`, probes: [] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)`, probes: [] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/(?:manifest|diagnostics|(?:presence|xr-telemetry)(?:\/([^/]+))?)$`, probes: [] },
  { pattern: String.raw`^\/api\/rooms\/[^/]+\/(?:presence|xr-telemetry)\/([^/]+)$`, probes: [] },
  { pattern: String.raw`^\/api\/rooms\/[^/]+\/presence\/([^/]+)$`, probes: [] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)$`, probes: [
    { method: "GET", path: room(""), policy: "room" },
    { method: "PATCH", path: room(""), body: () => ({ name: "Renamed" }), policy: "closed" },
    { method: "DELETE", path: room(""), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/bind-scene-bundle$`, probes: [{ method: "POST", path: room("/bind-scene-bundle"), body: () => ({ bundleId: "x" }), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/diagnostics$`, probes: [{ method: "POST", path: room("/diagnostics"), body: () => ({ kind: "probe" }), policy: "telemetry" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/(disable|enable)$`, probes: [{ method: "POST", path: room("/disable"), body: () => ({}), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/documents$`, probes: [
    { method: "GET", path: room("/documents"), policy: "room" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/documents\/([^/]+)(?:\/(download|presentation|content|surface))?$`, probes: [
    { method: "GET", path: room(`/documents/${randomUUID()}/download`), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/host\/transfer$`, probes: [{ method: "POST", path: room("/host/transfer"), body: f => ({ participantId: f.memberId, expectedRevision: 9999 }), policy: "host" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/identity-recovery$`, probes: [{ method: "POST", path: room("/identity-recovery"), body: f => ({ participantId: f.hostId, role: "host" }), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/invites$`, probes: [{ method: "POST", path: room("/invites"), body: () => ({ role: "guest" }), policy: "closed" }, { method: "GET", path: room("/invites"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/invites\/([^/]+)\/revoke$`, probes: [{ method: "POST", path: room(`/invites/${randomUUID()}/revoke`), body: () => ({}), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/manifest$`, probes: [{ method: "GET", path: room("/manifest"), policy: "public" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/notes\/export$`, probes: [{ method: "GET", path: room("/notes/export"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/notes\/(shared|private)$`, probes: [
    { method: "GET", path: room("/notes/shared"), policy: "room" },
    { method: "GET", path: room("/notes/private"), policy: "room" },
    { method: "PUT", path: room("/notes/shared"), body: () => ({ content: "overwritten" }), policy: "restricted", skip: INSIDERS },
    { method: "DELETE", path: room("/notes/shared"), policy: "restricted", skip: INSIDERS }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/export$`, probes: [{ method: "GET", path: room("/notes/shared/export"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/restore$`, probes: [{ method: "POST", path: room("/notes/shared/restore"), body: () => ({ version: 1 }), policy: "restricted", skip: INSIDERS }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/versions$`, probes: [{ method: "GET", path: room("/notes/shared/versions"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/owner\/transfer$`, probes: [{ method: "POST", path: room("/owner/transfer"), body: f => ({ participantId: f.memberId }), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/participants\/([^/]+)\/remove$`, probes: [{ method: "POST", path: f => `/api/rooms/${f.roomId}/participants/${f.guestId}/remove`, body: () => ({ expectedRevision: 9999 }), policy: "host" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/personal-state$`, probes: [{ method: "GET", path: room("/personal-state"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/presence\/([^/]+)$`, probes: [
    // Only the host's own presence: a guest or a member writing it is refused, the host itself does not run it.
    { method: "PUT", path: f => `/api/rooms/${f.roomId}/presence/${f.hostId}`, body: () => ({ displayName: "Spoof", mode: "desktop" }), policy: "host", skip: ["host"] },
    { method: "DELETE", path: f => `/api/rooms/${f.roomId}/presence/${f.hostId}`, policy: "host", skip: ["host"] }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/presence$`, probes: [{ method: "GET", path: room("/presence"), policy: "room" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/presenters\/([^/]+)\/(grant|revoke)$`, probes: [{ method: "POST", path: f => `/api/rooms/${f.roomId}/presenters/${f.memberId}/grant`, body: () => ({ expectedRevision: 9999 }), policy: "host" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/session-control$`, probes: [{ method: "GET", path: room("/session-control"), policy: "room" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/session-control\/(lock|unlock|end)$`, probes: [{ method: "POST", path: room("/session-control/lock"), body: () => ({ expectedRevision: 9999 }), policy: "host" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/spaces$`, probes: [{ method: "GET", path: room("/spaces"), policy: "room" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/waiting-room$`, probes: [{ method: "GET", path: room("/waiting-room"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/waiting-room\/([^/]+)\/(approve|reject)$`, probes: [{ method: "POST", path: room(`/waiting-room/${randomUUID()}/approve`), body: () => ({}), policy: "closed" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/xr-telemetry\/([^/]+)$`, probes: [{ method: "PUT", path: f => `/api/rooms/${f.roomId}/xr-telemetry/${f.hostId}`, body: () => ({ samples: [] }), policy: "host", skip: ["host"] }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/xr-telemetry$`, probes: [{ method: "GET", path: room("/xr-telemetry"), policy: "restricted" }] },
  { pattern: String.raw`^\/api\/rooms\/([^/]+)\/plugins(?:\/(.*))?$`, probes: [
    { method: "GET", path: room("/plugins/runtime"), policy: "room" },
    { method: "GET", path: room("/plugins/packages"), policy: "restricted" }] }
];

/** Room route regexes in the built handlers: `/^\/api\/rooms\/…/` literals, character classes kept whole. */
function builtRoomRoutePatterns(): Set<string> {
  const found = new Set<string>();
  for (const file of ["index.js", "room-notes-routes.js", "plugins/http.js"]) {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
    for (const match of source.matchAll(/\/(\^\\\/api\\\/rooms\\\/(?:\\.|\[[^\]\n]*\]|[^/\n\\[])*)\//g)) found.add(match[1]!);
  }
  return found;
}


test("managed room entry points refuse every caller outside the room, its role or the managed rules", {
  skip: postgresUrl ? false : "VRATA_TEST_POSTGRES_URL is not set; skipping the managed access matrix",
  timeout: 240_000
}, async () => {
  const registered = new Set(ROUTES.map(route => route.pattern));
  const built = builtRoomRoutePatterns();
  assert.deepEqual([...built].filter(pattern => !registered.has(pattern)).sort(), [], "a room route in the build has no row in the matrix");
  assert.deepEqual([...registered].filter(pattern => !built.has(pattern)).sort(), [], "a row of the matrix names a route the build no longer has");

  assert.ok(postgresUrl);
  const schema = `vrata_matrix_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: postgresUrl });
  const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema},public` });
  const connectionUrl = new URL(postgresUrl);
  connectionUrl.searchParams.set("options", `-c search_path=${schema},public`);
  let api: ApiProcess | null = null;
  try {
    await admin.query(`create schema "${schema}"`);
    const storage = new PostgresStorage(pool);
    await storage.init();
    await storage.transitionReferenceTemplateCatalog("active");
    await storage.identityProtocol.raise(2);
    api = await startApiProcess({
      POSTGRES_URL: connectionUrl.toString(), CONTROL_PLANE_ADMIN_TOKEN: adminToken, STATE_TOKEN_SECRET: "matrix-state-secret-0123456789abcdef",
      VRATA_INTERNAL_SERVICE_TOKEN: internalToken, VRATA_PORTAL_MANAGED: "true", VRATA_INTEGRATION_KEYS: integrationKeysEnv([key]),
      RUNTIME_BASE_URL: "https://app.example.test", LIVEKIT_URL: ""
    });
    const call = async (method: string, path: string, input: { body?: unknown; headers?: Record<string, string>; integration?: boolean } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", ...input.headers };
      if (input.integration) { headers.authorization = `Bearer ${signIntegrationAssertion(key)}`; headers["idempotency-key"] = idempotencyKey(); }
      const response = await fetch(`${api!.baseUrl}${path}`, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
      const text = await response.text();
      let body: Record<string, any> | null = null;
      try { body = text ? JSON.parse(text) as Record<string, any> : null; } catch { body = { raw: text }; }
      return { status: response.status, text, body };
    };
    const tenant = async () => {
      const id = `pt_${ulid()}`;
      assert.equal((await call("PUT", `/integration/v1/tenants/${id}`, { body: { displayName: "Acme" }, integration: true })).status, 200, api!.logs());
      return id;
    };
    const createRoom = async (tenantId: string, name: string) => {
      const created = await call("POST", `/integration/v1/tenants/${tenantId}/rooms`, { integration: true, body: { kind: "reference",
        template: { templateId: "meeting-room-basic", version: "2.0.0" }, name, visibility: "unlisted", accessUntil: new Date(Date.now() + 3_600_000).toISOString() } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body!.roomId as string;
    };
    const enter = async (tenantId: string, roomId: string, grant: Record<string, unknown>) => {
      const issued = await call("POST", `/integration/v1/tenants/${tenantId}/rooms/${roomId}/grants`, { integration: true, body: { purpose: "visit", ...grant } });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      const entry = await call("POST", "/api/room-grants/exchange", { body: { roomId, code: new URL(issued.body!.entryUrl).hash.slice("#grant=".length), displayName: "Caller" } });
      assert.equal(entry.status, 200, JSON.stringify(entry.body));
      return { grantId: issued.body!.grantId as string, participantId: entry.body!.participantId as string, token: entry.body!.sessionToken as string };
    };

    const tenantA = await tenant(), tenantB = await tenant();
    const roomA = await createRoom(tenantA, "Board meeting of A"), roomA2 = await createRoom(tenantA, "Second room"), roomB = await createRoom(tenantB, "Other tenant");
    const host = await enter(tenantA, roomA, { role: "host", subject: `acct_${ulid()}` });
    const member = await enter(tenantA, roomA, { role: "member", subject: `acct_${ulid()}` });
    const guest = await enter(tenantA, roomA, { role: "guest" });
    const revoked = await enter(tenantA, roomA, { role: "member", subject: `acct_${ulid()}` });
    assert.equal((await call("POST", `/integration/v1/tenants/${tenantA}/rooms/${roomA}/grants/${revoked.grantId}/revoke`, { integration: true, body: {} })).status, 200);
    const otherRoom = await enter(tenantA, roomA2, { role: "host", subject: `acct_${ulid()}` });
    const otherTenant = await enter(tenantB, roomB, { role: "host", subject: `acct_${ulid()}` });
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const callers: Record<Caller, Record<string, string>> = {
      anonymous: {}, otherTenant: bearer(otherTenant.token), otherRoom: bearer(otherRoom.token), revoked: bearer(revoked.token),
      guest: bearer(guest.token), member: bearer(member.token), host: bearer(host.token)
    };

    // The room's own data: a shared note, a private note of the member, the host's presence.
    assert.equal((await call("PUT", `/api/rooms/${roomA}/notes/shared`, { body: { content: SHARED_SECRET }, headers: callers.host })).status, 201);
    assert.ok([200, 201].includes((await call("PUT", `/api/rooms/${roomA}/notes/private`, { body: { content: PRIVATE_SECRET }, headers: callers.member })).status));
    assert.equal((await call("PUT", `/api/rooms/${roomA}/presence/${host.participantId}`, { body: { displayName: "Host", mode: "desktop" }, headers: callers.host })).status, 200);
    const secrets = [SHARED_SECRET, PRIVATE_SECRET, host.participantId, member.participantId, guest.participantId, "Board meeting of A"];

    const fixture: Fixture = { roomId: roomA, hostId: host.participantId, memberId: member.participantId, guestId: guest.participantId };
    const failures: string[] = [];
    const seen: string[] = [];
    // Insiders change the room only through host and room routes the matrix accepts; destructive host probes carry a
    // stale revision, so nothing an insider does here changes the room either.
    for (const route of ROUTES) {
      for (const probe of route.probes) {
        for (const caller of [...OUTSIDERS, ...INSIDERS]) {
          if (probe.skip?.includes(caller)) continue;
          const path = probe.path(fixture);
          const result = await call(probe.method, path, { headers: callers[caller], ...(probe.body ? { body: probe.body(fixture) } : {}) });
          const line = `${probe.method} ${path.replace(roomA, "{A}")} ${caller} → ${result.status} ${result.body?.reason ?? result.body?.error?.code ?? result.body?.error ?? ""}`;
          seen.push(line);
          const refused = result.status >= 400;
          const outsider = OUTSIDERS.includes(caller);
          if (outsider && probe.policy !== "public" && probe.policy !== "telemetry" && !refused) failures.push(`outsider got through: ${line}`);
          if (outsider && secrets.some(secret => result.text.includes(secret))) failures.push(`outsider saw room data: ${line}`);
          if (probe.policy === "closed" && !refused) failures.push(`closed route answered: ${line}`);
          if (probe.policy === "host" && (caller === "guest" || caller === "member") && !refused) failures.push(`host route for a ${caller}: ${line}`);
          if (probe.policy === "room" && caller === "host" && refused) failures.push(`the host cannot reach it: ${line}`);
        }
      }
    }
    if (process.env.VRATA_MATRIX_PRINT === "1") console.log(seen.join("\n"));
    assert.deepEqual(failures, [], seen.join("\n"));

    // Body-scoped entries: a foreign session never mints room-state or media for room A.
    for (const caller of OUTSIDERS) {
      const state = await call("POST", "/api/tokens/state", { body: { identityProtocolVersion: 2, roomId: roomA }, headers: callers[caller] });
      assert.equal(state.status >= 400 && !secrets.some(secret => state.text.includes(secret)), true, `tokens/state ${caller}: ${state.status} ${state.text}`);
      const media = await call("POST", "/api/tokens/media", { body: { roomId: roomA, participantId: host.participantId, canPublishAudio: true, canPublishVideo: false }, headers: callers[caller] });
      assert.equal(media.status >= 400 && !secrets.some(secret => media.text.includes(secret)), true, `tokens/media ${caller}: ${media.status} ${media.text}`);
      const verified = await call("POST", "/api/internal/identity-session/verify", { body: { roomId: roomA, participantId: host.participantId,
        sessionToken: callers[caller].authorization?.slice("Bearer ".length) ?? "rs2.x.y" }, headers: { "x-vrata-internal-token": internalToken } });
      assert.notEqual(verified.status, 200, `verify ${caller}`);
    }

    // Nothing an outsider tried changed the room: the shared note, the member's private note and the host's presence stand.
    assert.equal((await call("GET", `/api/rooms/${roomA}/notes/shared`, { headers: callers.host })).text.includes(SHARED_SECRET), true);
    assert.equal(JSON.stringify((await call("GET", `/api/rooms/${roomA}/notes/private`, { headers: callers.member })).body).includes(PRIVATE_SECRET), true);
    assert.equal((await call("GET", `/api/rooms/${roomA}/presence`, { headers: callers.host })).body?.items?.some((item: { participantId: string; displayName: string }) =>
      item.participantId === host.participantId && item.displayName === "Host"), true);
  } finally {
    await api?.stop();
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await admin.end();
  }
});
