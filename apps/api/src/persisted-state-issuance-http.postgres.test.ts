import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";
import { AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, until, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";
import { PostgresStorage } from "./storage.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const OTHER_TENANT = "persisted-issuance-other-tenant";
const LONG_TENANT = `persisted-issuance-${"t".repeat(182)}`;
const POST_SHAPE = "access,expiresInSeconds,permissions,role,sessionId,token";
const GET_SHAPE = "access,expiresInSeconds,participant,permissions,role,state,token";
const SUCCESS = ["token", "sessionId", "permissions", "role", "access", "expiresInSeconds", "identityCredential", "isOwner"];
const V2_CLAIMS = ["identityProtocolVersion", "identityId", "authEpoch", "isOwner", "identityCredential"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTERS = ["vrata_api_legacy_state_release_completion_failures_total", "vrata_api_virtual_state_release_completion_failures_total",
  "vrata_api_request_failures_total"];
const UPGRADE = ["identity_required", "identity_upgrade_required"] as const;
const surfaceManifest = (surfaceId: string) => JSON.stringify({ schemaVersion: 1,
  mediaSurfaces: [{ surfaceId, label: "Desk", allowedObjectTypes: ["markdown-board"] }] });
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Claims = Record<string, unknown>;
type Send = () => Promise<AuthorHttpResponse>;
interface Issued { body: Claims; claims: Claims; token: string; participantId: string }

/** Native HTTP vocabulary for persisted-room floor-1 state tokens: POST /api/tokens/state and the GET
 * session-control renewal. Assertions compare decoded claims, scalars and booleans; a raw token,
 * invite or secret never reaches a failure message. */
function persisted(h: Fixture) {
  const stem = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
  const post = (body: Claims, token?: string, headers: Record<string, string> = {}) => h.request("/api/tokens/state", "POST",
    { ...(token === undefined ? {} : authorHttpBearer(token)), ...headers }, { displayName: "Persisted participant", ...body });
  const read = (roomId: string, token: string, headers: Record<string, string> = {}) =>
    h.request(`${stem(roomId)}/session-control`, "GET", { ...authorHttpBearer(token), ...headers });
  async function admin(path: string, body: unknown = {}, method = "POST") {
    const response = await h.request(path, method, h.adminHeaders, body);
    assert.equal(response.status, 200, `administrative ${method} must succeed; received HTTP ${response.status}`); return response;
  }
  async function createRoom(visibility: "public" | "private", extra: Claims = {}, roomId: string = randomUUID(), tenantId = "demo-tenant") {
    const response = await h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId, templateId: "meeting-room-basic",
      name: "Persisted issuance room", visibility, guestAllowed: visibility === "public", ...extra });
    assert.equal(response.status, 201, "the room is created over HTTP"); return roomId;
  }
  const remove = async (roomId: string) => assert.equal((await h.request(stem(roomId), "DELETE", h.adminHeaders)).status, 200);
  function verified(token: unknown, roomId: string, participantId?: string): Claims {
    const text = typeof token === "string" ? token : "";
    const parts = text.split(".");
    assert.equal(parts.length === 2 && !text.startsWith("rs2."), true, "a floor-1 state token is body.signature");
    const result = verifyRoomSessionToken(text, AUTHOR_HTTP_SECRET, { roomId, participantId });
    assert.equal(result.ok, true, `the MAC and room/participant binding verify: ${result.ok ? "ok" : result.code}`);
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Claims;
    assert.deepEqual(V2_CLAIMS.filter(key => key in claims), [], "no v2 or owner claim");
    return claims;
  }
  function issued(response: AuthorHttpResponse, shape: string, roomId: string, participantId?: string): Issued {
    assert.equal(response.status, 200, `expected a floor-1 state token; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(Object.keys(body).sort().join(), shape, "the legacy response shape is unchanged");
    const claims = verified(body.token, roomId, participantId);
    assert.equal(body.role === claims.role && body.expiresInSeconds === Number(claims.exp) - Number(claims.iat), true,
      "the reply describes the freshly signed claims");
    return { body, claims, token: body.token as string, participantId: claims.participantId as string };
  }
  const minted = (response: AuthorHttpResponse, roomId: string, participantId?: string) => issued(response, POST_SHAPE, roomId, participantId);
  function renewed(response: AuthorHttpResponse, roomId: string, participantId: string): Issued {
    const value = issued(response, GET_SHAPE, roomId, participantId);
    const participant = value.body.participant as Claims;
    assert.deepEqual([participant.status, participant.reason, participant.role === value.claims.role, "isOwner" in participant],
      ["active", null, true, false]);
    return value;
  }
  function blocked(response: AuthorHttpResponse, reason: string) {
    assert.equal(response.status, 200, `expected a blocked session read; received HTTP ${response.status}`);
    const body = response.json<Claims>(), participant = body.participant as Claims;
    assert.deepEqual([Object.keys(body).sort().join(), participant.status, participant.reason], ["participant,state", "blocked", reason],
      "a blocked read carries the fresh reason and no token");
  }
  function refused(response: AuthorHttpResponse, status: number, error: string, reason?: string) {
    assert.equal(response.status, status, `expected ${error}; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(body.error === error && body.reason === reason, true, `expected ${error}/${reason ?? "-"}`);
    assert.equal(SUCCESS.some(key => key in body) || response.bytes.toString("utf8").includes(AUTHOR_HTTP_SECRET), false,
      "a refusal carries no token or success field");
  }
  async function counters(): Promise<number[]> {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    const lines = response.bytes.toString("utf8").split("\n");
    return COUNTERS.map(name => {
      const found = lines.filter(line => line.startsWith(`${name} `));
      assert.equal(found.length, 1, `exactly one unlabelled ${name} line`);
      return Number(found[0].slice(name.length + 1));
    });
  }
  /** Holds each request at the release entry (after its initial snapshot, any known-commit admission write and its
   * surface load, before the parent fence) in FIFO order. Cleanup always resets the clock and resumes every hold. */
  async function held(roomId: string, requests: Send[], change: () => Promise<unknown>): Promise<AuthorHttpResponse[]> {
    const pending: Promise<AuthorHttpResponse>[] = [];
    try {
      for (const send of requests) {
        const id = await h.arm("telemetry-effect", roomId);
        const next = send(); void next.catch(() => undefined); pending.push(next);
        await h.phase(id, "telemetry-effect");
      }
      await change();
      for (let index = 0; index < pending.length; index++) await h.resume();
      return await Promise.all(pending);
    } finally {
      await h.clock(0);
      for (let index = 0; index < pending.length; index++) await h.resume();
      await Promise.allSettled(pending);
    }
  }
  async function settled(roomId: string) {
    const open = await h.pool.query(`select count(*)::int as open from pg_stat_activity
      where application_name=$1 and state like 'idle in transaction%'`, [h.schema]);
    assert.equal(open.rows[0].open, 0, "the fence transaction ended");
    const probe = await h.pool.connect();
    try {
      await probe.query("begin"); await probe.query("set local lock_timeout='2s'");
      assert.equal((await probe.query("select 1 from rooms where room_id=$1 for update", [roomId])).rowCount, 1, "no room row lock survives");
    } finally { await probe.query("rollback").catch(() => undefined); probe.release(); }
  }
  return { stem, post, read, admin, createRoom, remove, minted, renewed, blocked, refused, counters, held, settled };
}

test("persisted floor-1 state tokens are admitted, fenced and freshly signed over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture", async c => {
    const h = await startAuthorHttpFixture(c, 1, true);
    const p = persisted(h);
    const hostInvite = async (roomId: string) => (await h.invite(roomId, "host")).inviteToken;
    assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: OTHER_TENANT, name: "Other persisted tenant" })).status, 201);

    await c.test("each positive source releases one MAC-verified legacy token with no v2 field", async () => {
      const publicRoom = await p.createRoom("public"), privateRoom = await p.createRoom("private");
      const guest = p.minted(await p.post({ roomId: publicRoom }), publicRoom);
      assert.deepEqual([UUID.test(guest.participantId), guest.claims.role, guest.claims.roleSource], [true, "guest", "default"], "public source");
      const host = p.minted(await p.post({ roomId: publicRoom, inviteToken: await hostInvite(publicRoom) }), publicRoom);
      const proof = p.minted(await p.post({ roomId: publicRoom }, host.token), publicRoom, host.participantId);
      const member = p.minted(await p.post({ roomId: privateRoom, inviteToken: (await h.invite(privateRoom, "member")).inviteToken }), privateRoom);
      assert.deepEqual([host.claims.role, host.claims.roleSource, proof.claims.role, proof.claims.roleSource, member.claims.role, member.claims.roleSource],
        ["host", "trusted", "host", "trusted", "member", "trusted"], "invite sources; a bearer without a body ID keeps its subject");
      const owner = randomUUID();
      const personal = await p.createRoom("private", { templateId: "personal-workspace-basic", roomType: "personal", ownerParticipantId: owner });
      const owned = p.minted(await p.post({ roomId: personal, participantId: owner }), personal, owner);
      assert.deepEqual([owned.claims.role, owned.claims.roleSource], ["host", "trusted"], "personal-owner source on the raw floor-1 ID, no owner grant");
      p.refused(await p.post({ roomId: personal, participantId: randomUUID() }), 403, "room_access_denied", "invite_required");
    });

    await c.test("another subject, an invalid MAC or a foreign-tenant proof never copies the proof role", async () => {
      const publicRoom = await p.createRoom("public"), privateRoom = await p.createRoom("private"), other = randomUUID();
      const host = p.minted(await p.post({ roomId: publicRoom, inviteToken: await hostInvite(publicRoom) }), publicRoom);
      const explicit = p.minted(await p.post({ roomId: publicRoom, participantId: other }, host.token), publicRoom, other);
      const [signed] = host.token.split(".");
      const unsigned = p.minted(await p.post({ roomId: publicRoom }, `${signed}.${"A".repeat(43)}`), publicRoom);
      assert.deepEqual([explicit.claims.role, explicit.claims.roleSource, unsigned.claims.role, unsigned.claims.roleSource,
        unsigned.participantId === host.participantId, UUID.test(unsigned.participantId)], ["guest", "default", "guest", "default", false, true],
      "an explicit other subject or an invalid MAC is one fresh default guest");
      const privateHost = p.minted(await p.post({ roomId: privateRoom, inviteToken: await hostInvite(privateRoom) }), privateRoom);
      p.refused(await p.post({ roomId: privateRoom, participantId: other }, privateHost.token), 403, "room_access_denied", "invite_required");
      const invited = p.minted(await p.post({ roomId: privateRoom, participantId: other,
        inviteToken: (await h.invite(privateRoom, "member")).inviteToken }, privateHost.token), privateRoom, other);
      assert.deepEqual([invited.claims.role, invited.claims.roleSource], ["member", "trusted"], "only an independent invite admits another subject");
      // A foreign-tenant proof is refused before any fence: a held parent row cannot delay the read.
      const foreign = randomUUID();
      const early = p.minted(await p.post({ roomId: foreign }), foreign);
      await p.createRoom("public", {}, foreign, OTHER_TENANT);
      const holder = await h.pool.connect();
      try {
        await holder.query("begin"); await holder.query("select 1 from rooms where room_id=$1 for update", [foreign]);
        p.refused(await p.read(foreign, early.token), 403, "session_token_invalid", "tenant_mismatch");
      } finally { await holder.query("rollback").catch(() => undefined); holder.release(); }
      const fresh = p.minted(await p.post({ roomId: foreign }, early.token), foreign);
      assert.deepEqual([fresh.participantId === early.participantId, fresh.claims.tenantId, fresh.claims.roleSource], [false, OTHER_TENANT, "default"]);
    });

    await c.test("a saved 201-character tenant issues and renews MAC-verified legacy tokens over POST and GET", async () => {
      assert.equal(LONG_TENANT.length, 201);
      assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: LONG_TENANT, name: "Long persisted tenant" })).status, 201);
      const roomId = await p.createRoom("public", {}, randomUUID(), LONG_TENANT);
      const guest = p.minted(await p.post({ roomId }), roomId);
      const host = p.minted(await p.post({ roomId, inviteToken: await hostInvite(roomId) }), roomId);
      const proof = p.minted(await p.post({ roomId }, guest.token), roomId, guest.participantId);
      const read = p.renewed(await p.read(roomId, guest.token), roomId, guest.participantId);
      assert.deepEqual([guest, host, proof, read].map(item => item.claims.tenantId === LONG_TENANT), [true, true, true, true], "the saved tenant is signed");
      assert.deepEqual([guest.claims.roleSource, host.claims.role, host.claims.roleSource, proof.claims.role, read.claims.sessionId === guest.claims.sessionId],
        ["default", "host", "trusted", "guest", true], "public, invite and proof sources; GET keeps the proof session");
    });

    await c.test("a release held 120 s past preparation signs at the final clock with the full TTL", async () => {
      const roomId = await p.createRoom("public");
      const guest = p.minted(await p.post({ roomId }), roomId);
      const before = Math.floor(Date.now() / 1000);
      // The proof's 900 s MAC stays valid at +120 s; held resets the clock in finally, and the codec accepts a future iat.
      const [posted, read] = await p.held(roomId, [() => p.post({ roomId }, guest.token), () => p.read(roomId, guest.token)],
        () => h.clock(120_000));
      const post = p.minted(posted, roomId, guest.participantId), get = p.renewed(read, roomId, guest.participantId);
      for (const reply of [post, get]) {
        assert.deepEqual([Number(reply.claims.iat) >= before + 120, Number(reply.claims.exp) - Number(reply.claims.iat), reply.body.expiresInSeconds],
          [true, 900, 900], "signed by the final clock, not the snapshot clock");
      }
      assert.equal(get.claims.sessionId === guest.claims.sessionId, true, "GET keeps the proof session");
    });

    await c.test("a default proof is invite_required once its room is private; trusted invitees renew over POST and GET", async () => {
      const roomId = randomUUID();
      const early = p.minted(await p.post({ roomId }), roomId);
      await p.createRoom("private", {}, roomId);
      p.refused(await p.post({ roomId }, early.token), 403, "room_access_denied", "invite_required");
      p.blocked(await p.read(roomId, early.token), "invite_required");
      const publicRoom = await p.createRoom("public");
      const before = p.minted(await p.post({ roomId: publicRoom }), publicRoom);
      await p.admin(p.stem(publicRoom), { visibility: "private" }, "PATCH");
      p.refused(await p.post({ roomId: publicRoom }, before.token), 403, "room_access_denied", "invite_required");
      p.blocked(await p.read(publicRoom, before.token), "invite_required");
      const guest = p.minted(await p.post({ roomId, inviteToken: (await h.invite(roomId, "guest")).inviteToken }), roomId);
      const posted = p.minted(await p.post({ roomId }, guest.token), roomId, guest.participantId);
      const read = p.renewed(await p.read(roomId, guest.token), roomId, guest.participantId);
      assert.deepEqual([guest.claims.roleSource, posted.claims.role, posted.claims.roleSource, read.claims.role, read.claims.roleSource,
        read.claims.sessionId === guest.claims.sessionId], ["trusted", "guest", "trusted", "guest", "trusted", true], "GET keeps the proof session");
      // Waiting first: the proof subject is the one request row, approval and token; no second UUID is minted.
      const { inviteToken } = await h.invite(roomId, "member", true);
      const waits = [await p.post({ roomId, inviteToken }, early.token), await p.post({ roomId, inviteToken }, early.token)];
      for (const wait of waits) p.refused(wait, 202, "room_access_denied", "waiting_room_pending");
      const ids = waits.map(wait => wait.json<{ accessRequestId?: string }>().accessRequestId);
      assert.equal(typeof ids[0] === "string" && ids[0] === ids[1], true, "the repeated request reuses its row");
      await p.admin(`${p.stem(roomId)}/waiting-room/${String(ids[0])}/approve`);
      const approved = p.minted(await p.post({ roomId, inviteToken }, early.token), roomId, early.participantId);
      assert.deepEqual([approved.claims.role, approved.claims.roleSource], ["member", "trusted"], "waiting-approved source");
      const rows = (await h.pool.query(`select count(*)::int as count, bool_and(participant_id=$2) as subject
        from room_waiting_requests where room_id=$1`, [roomId, early.participantId])).rows[0];
      assert.deepEqual(rows, { count: 1, subject: true });
      p.renewed(await p.read(roomId, approved.token), roomId, early.participantId);
    });

    for (const [reason, path] of [["session_ended", "session-control/end"], ["participant_removed", "participants/:id/remove"],
      ["room_disabled", "disable"]] as const) {
      await c.test(`${reason} after preparation denies POST and blocks GET without a token`, async () => {
        const roomId = await p.createRoom("public");
        const guest = p.minted(await p.post({ roomId }), roomId);
        const before = await p.counters();
        const [posted, read] = await p.held(roomId, [() => p.post({ roomId }, guest.token), () => p.read(roomId, guest.token)],
          () => p.admin(`${p.stem(roomId)}/${path.replace(":id", guest.participantId)}`));
        p.refused(posted, 403, "room_access_denied", reason); p.blocked(read, reason);
        assert.deepEqual(await p.counters(), before, "a refusal before send counts nothing");
      });
    }

    await c.test("a presenter grant or host transfer after preparation is room_state_changed, never a silent role change", async () => {
      for (const target of ["presenter", "host"] as const) {
        const roomId = await p.createRoom("public");
        const subject = p.minted(await p.post(target === "presenter" ? { roomId } : { roomId, inviteToken: await hostInvite(roomId) }), roomId);
        const present = target === "presenter" ? subject : p.minted(await p.post({ roomId }), roomId);
        assert.equal((await h.request(`${p.stem(roomId)}/presence/${present.participantId}`, "PUT", authorHttpBearer(present.token),
          { participantId: present.participantId, displayName: "Present participant", updatedAt: new Date().toISOString() })).status, 200);
        const responses = await p.held(roomId, [() => p.post({ roomId }, subject.token), () => p.read(roomId, subject.token)],
          () => target === "presenter" ? p.admin(`${p.stem(roomId)}/presenters/${present.participantId}/grant`)
            : p.admin(`${p.stem(roomId)}/host/transfer`, { participantId: present.participantId }));
        for (const response of responses) p.refused(response, 409, "room_state_changed", "room_state_changed");
      }
    });

    await c.test("a revoked invite or rejected approval after preparation, or after a held invite-row wait, is refused", async () => {
      const roomId = await p.createRoom("private");
      const issued = await h.invite(roomId, "member");
      const trusted = p.minted(await p.post({ roomId, inviteToken: issued.inviteToken }), roomId);
      const [late] = await p.held(roomId, [() => p.post({ roomId, inviteToken: issued.inviteToken })],
        () => p.admin(`${p.stem(roomId)}/invites/${issued.inviteId}/revoke`));
      p.refused(late, 403, "room_access_denied", "invite_revoked");
      // Out of scope by design: revoking an invite does not revoke a trusted token it already issued.
      p.renewed(await p.read(roomId, trusted.token), roomId, trusted.participantId);
      const queued = await h.invite(roomId, "member");
      const holder = await h.pool.connect(); let waited: Promise<AuthorHttpResponse> | undefined;
      try {
        await holder.query("begin"); await holder.query("select 1 from room_invites where invite_id=$1 for update", [queued.inviteId]);
        const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        waited = p.post({ roomId, inviteToken: queued.inviteToken }); void waited.catch(() => undefined);
        await until(async () => (await h.pool.query(`select exists(select 1 from pg_stat_activity
          where application_name=$2 and $1=any(pg_blocking_pids(pid))) as blocked`, [pid, h.schema])).rows[0].blocked,
        "the release waits on the held invite row");
        // The real storage revoke runs on the holder, so it commits before the queued share lock is granted.
        assert.ok(await new PostgresStorage(h.pool, undefined, holder).revokeRoomInvite(roomId, queued.inviteId, new Date().toISOString(), "fixture-admin"));
        await holder.query("commit");
        p.refused(await waited, 403, "room_access_denied", "invite_revoked");
      } finally { await holder.query("rollback").catch(() => undefined); holder.release(); await waited?.catch(() => undefined); }
      const waiting = await h.invite(roomId, "member", true), participantId = randomUUID();
      const pending = await p.post({ roomId, participantId, inviteToken: waiting.inviteToken });
      p.refused(pending, 202, "room_access_denied", "waiting_room_pending");
      const decision = `${p.stem(roomId)}/waiting-room/${String(pending.json<Claims>().accessRequestId)}`;
      await p.admin(`${decision}/approve`);
      const [rejected] = await p.held(roomId, [() => p.post({ roomId, participantId, inviteToken: waiting.inviteToken })],
        () => p.admin(`${decision}/reject`));
      p.refused(rejected, 403, "room_access_denied", "waiting_room_rejected");
    });

    for (const [label, status, error, reason] of [["deleted", 404, "room_not_found", undefined],
      ["recreated in another tenant", 404, "room_not_found", undefined], ["bound to a v2 authority", 409, ...UPGRADE]] as const) {
      await c.test(`a room ${label} after selection refuses POST and GET with no virtual fallback`, async () => {
        const roomId = await p.createRoom("public");
        const guest = p.minted(await p.post({ roomId }), roomId);
        const before = await p.counters();
        const responses = await p.held(roomId, [() => p.post({ roomId }, guest.token), () => p.read(roomId, guest.token)], async () => {
          if (label === "bound to a v2 authority") {
            await h.storage.roomIdentities.create({ tenantId: "demo-tenant", roomId, displayName: "Binding", baseRole: "guest", provenance: { kind: "guest" } });
            return;
          }
          await p.remove(roomId);
          if (label !== "deleted") await p.createRoom("public", {}, roomId, OTHER_TENANT);
        });
        for (const response of responses) p.refused(response, status, error, reason);
        assert.deepEqual(await p.counters(), before);
      });
    }

    await c.test("a scene URL rebind after preparation is room_state_changed; a fresh read signs the new surfaces", async () => {
      const dataUrl = (surfaceId: string) => `data:application/json,${encodeURIComponent(surfaceManifest(surfaceId))}`;
      const surfaces = (claims: Claims) => (claims.sceneMediaSurfaces as Array<{ surfaceId: string }> | undefined)?.map(item => item.surfaceId).join() ?? "";
      const roomId = await p.createRoom("public", { templateId: "personal-workspace-basic", sceneBundleUrl: dataUrl("desk-before") });
      const guest = p.minted(await p.post({ roomId }), roomId);
      assert.equal(surfaces(guest.claims), "desk-before");
      const responses = await p.held(roomId, [() => p.post({ roomId }, guest.token), () => p.read(roomId, guest.token)],
        () => p.admin(p.stem(roomId), { sceneBundleUrl: dataUrl("desk-after") }, "PATCH"));
      for (const response of responses) p.refused(response, 409, "room_state_changed", "room_state_changed");
      const read = p.renewed(await p.read(roomId, guest.token), roomId, guest.participantId);
      const posted = p.minted(await p.post({ roomId }, guest.token), roomId, guest.participantId);
      assert.deepEqual([surfaces(read.claims), surfaces(posted.claims)], ["desk-after", "desk-after"], "fresh surfaces, not the old signed payload");
    });

    await c.test("a proof expiring in the body, surface-load or parent-row wait is 401 expired_token with no fallback", async () => {
      const parked: Array<() => void> = []; let holding = false;
      const manifest = createServer((_request, response) => {
        const reply = () => { response.writeHead(200, { "content-type": "application/json" }); response.end(surfaceManifest("slow-desk")); };
        if (holding) parked.push(reply); else reply();
      });
      const release = () => { holding = false; for (const reply of parked.splice(0)) reply(); };
      manifest.listen(0, "127.0.0.1"); await once(manifest, "listening");
      try {
        const scene = `http://127.0.0.1:${(manifest.address() as AddressInfo).port}/scene.json`;
        const roomId = await p.createRoom("public", { templateId: "personal-workspace-basic", sceneBundleUrl: scene });
        const foreign = await p.createRoom("public");
        const guest = p.minted(await p.post({ roomId }), roomId);
        const expire = async () => { await h.clock(Number(guest.claims.exp) * 1000 - Date.now() + 1000); };
        const before = await p.counters();
        const stalled = h.stalled("/api/tokens/state", guest.token, Buffer.from(JSON.stringify({ roomId: foreign })));
        try {
          await stalled.admitted(); await expire(); stalled.finish();
          // An authentic stale proof for another room never falls back to a fresh public guest.
          p.refused(await stalled.response, 401, "session_token_invalid", "expired_token");
          // The generic session entry keeps its own contract for an already expired bearer.
          p.refused(await p.read(roomId, guest.token), 401, "unauthorized", "expired_token");
        } finally { stalled.destroy(); await h.clock(0); }
        for (const send of [() => p.post({ roomId }, guest.token), () => p.read(roomId, guest.token)]) {
          // Step past the 5 s shared manifest cache (never the 900 s proof) so this load is parked again.
          await h.clock(6000);
          holding = true;
          const pending = send(); void pending.catch(() => undefined);
          try {
            // The loader aborts after 2 s, so the manifest is released promptly after the shift.
            await until(async () => parked.length === 1, "the surface load is parked on the owned manifest");
            await expire(); release();
            p.refused(await pending, 401, "session_token_invalid", "expired_token");
          } finally { release(); await h.clock(0); await pending.catch(() => undefined); }
          try { p.refused(await h.held(roomId, send, expire), 401, "session_token_invalid", "expired_token"); }
          finally { await h.clock(0); }
        }
        assert.deepEqual(await p.counters(), before, "pre-send expiry counts no release completion or request failure");
      } finally { manifest.closeAllConnections(); manifest.close(); }
    });

    await c.test("one manifest cache serves POST and GET; past its TTL a failing host is a retryable 503 that keeps the proof", async () => {
      const parked: Array<() => void> = []; let fetches = 0, healthy = true, holding = false, body = surfaceManifest("desk-cached");
      const manifest = createServer((_request, response) => {
        fetches += 1;
        const reply = () => { response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" }); response.end(healthy ? body : "{}"); };
        if (holding) parked.push(reply); else reply();
      });
      const release = () => { holding = false; for (const reply of parked.splice(0)) reply(); };
      const surfaces = (value: Issued) => (value.claims.sceneMediaSurfaces as Array<{ surfaceId: string }> | undefined)?.map(item => item.surfaceId).join() ?? "";
      const unavailable = (response: AuthorHttpResponse) => assert.equal(response.status === 503 && response.bytes.toString("utf8") === JSON.stringify({ error: "scene_media_surfaces_unavailable" }),
        true, `a retryable refusal with no token, URL or claim (status ${response.status})`);
      manifest.listen(0, "127.0.0.1"); await once(manifest, "listening");
      try {
        const roomId = await p.createRoom("public", { templateId: "personal-workspace-basic",
          sceneBundleUrl: `http://127.0.0.1:${(manifest.address() as AddressInfo).port}/scene.json` });
        const guest = p.minted(await p.post({ roomId }), roomId);
        const renew = async () => p.renewed(await p.read(roomId, guest.token), roomId, guest.participantId);
        assert.deepEqual([surfaces(guest), surfaces(await renew()), fetches], ["desk-cached", "desk-cached", 1], "GET reuses the POST's entry");
        // 6 s expires the 5 s cache, never the 900 s proof.
        healthy = false; await h.clock(6000);
        unavailable(await p.read(roomId, guest.token)); unavailable(await p.post({ roomId }, guest.token));
        const cold = p.minted(await p.post({ roomId }), roomId);
        assert.deepEqual([surfaces(cold), fetches], ["", 4], "failures are not cached; a cold join keeps its no-surface fallback");
        healthy = true;
        assert.deepEqual([surfaces(await renew()), fetches], ["desk-cached", 5], "the same proof renews once the host recovers");
        await h.clock(12_000); holding = true;
        const reads = [0, 1, 2].map(() => p.read(roomId, guest.token));
        for (const read of reads) void read.catch(() => undefined);
        await until(async () => parked.length === 1, "one fetch for the expired entry is parked"); release();
        for (const response of await Promise.all(reads)) assert.equal(surfaces(p.renewed(response, roomId, guest.participantId)), "desk-cached");
        assert.equal(fetches, 6, "concurrent renewals share one fetch");
        body = JSON.stringify({ schemaVersion: 1 }); await h.clock(18_000);
        const cleared = await renew();
        assert.deepEqual(["sceneMediaSurfaces" in cleared.claims, fetches], [false, 7], "a valid manifest without surfaces clears the claim");
      } finally { release(); await h.clock(0); manifest.closeAllConnections(); manifest.close(); }
    });

    await c.test("known-commit Host claim remains authorized while fresh final token release can deny", async () => {
      const roomId = await p.createRoom("public");
      const inviteToken = await hostInvite(roomId);
      const [response] = await p.held(roomId, [() => p.post({ roomId, inviteToken })], () => p.admin(`${p.stem(roomId)}/session-control/end`));
      p.refused(response, 403, "room_access_denied", "session_ended");
      const claimed = (await h.storage.getRoom(roomId))?.sessionControl?.hostParticipantId;
      assert.equal(typeof claimed === "string" && UUID.test(claimed), true, "the deferred host claim persisted although no token was released");
    });

    for (const kind of ["POST", "GET"] as const) {
      await c.test(`a released ${kind} reply completes its buffered 200 when only the COMMIT acknowledgement is lost`, async () => {
        const roomId = await p.createRoom("public");
        const guest = p.minted(await p.post({ roomId }), roomId);
        const [legacy, virtual, failures] = await p.counters();
        const holdId = randomUUID(), faultId = await h.arm("legacy-state-token-ack-loss", roomId);
        const hold = { "x-author-hold-state-reply": holdId };
        const pending = kind === "POST" ? p.post({ roomId }, guest.token, hold) : p.read(roomId, guest.token, hold);
        void pending.catch(() => undefined);
        let response!: AuthorHttpResponse;
        try {
          // send() returned with its body queued; the actual COMMIT then ran and only its reply was dropped.
          await h.stateReplyBuffered(holdId);
          await h.phase(faultId, "legacy-state-token-ack-loss");
          await until(async () => (await p.counters())[0] === legacy + 1, "the completion failure is counted while the reply is still queued");
          await h.flushStateReplies();
          response = await pending;
        } finally { await h.flushStateReplies(); await pending.catch(() => undefined); }
        const reply = kind === "POST" ? p.minted(response, roomId, guest.participantId) : p.renewed(response, roomId, guest.participantId);
        assert.equal(JSON.stringify(reply.body) === response.bytes.toString("utf8"), true, "the whole reply is exactly one serialized body");
        assert.deepEqual(await p.counters(), [legacy + 1, virtual, failures], "counted once; virtual and request failures unchanged");
        await p.settled(roomId);
      });
    }
  });

  // Activation is monotonic: each variant owns a fresh floor-1 fixture.
  for (const variant of ["renewal", "host claim"] as const) {
    await t.test(`owned floor-1 fixture: activation while a ${variant} release is held denies POST and GET`, async c => {
      const h = await startAuthorHttpFixture(c, 1, true);
      const p = persisted(h);
      const roomId = await p.createRoom("public");
      const guest = p.minted(await p.post({ roomId }), roomId);
      const claim = variant === "host claim" ? (await h.invite(roomId, "host")).inviteToken : undefined;
      const before = await p.counters();
      const responses = await p.held(roomId, [() => claim === undefined ? p.post({ roomId }, guest.token) : p.post({ roomId, inviteToken: claim }),
        () => p.read(roomId, guest.token)], () => h.storage.identityProtocol.raise(2));
      for (const response of responses) p.refused(response, 409, ...UPGRADE);
      assert.deepEqual([await h.storage.identityProtocol.minimum(), ...await p.counters()], [2, ...before]);
    });
  }
});
