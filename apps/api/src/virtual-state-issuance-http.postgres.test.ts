import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";
import { AUTHOR_HTTP_SECRET, startAuthorHttpFixture, until, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const OTHER_TENANT = "issuance-other-tenant";
const SHAPE = "access,expiresInSeconds,permissions,role,sessionId,token";
const SUCCESS = ["token", "sessionId", "permissions", "role", "access", "expiresInSeconds", "identityCredential", "isOwner"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELEASE_FAILURES = "vrata_api_virtual_state_release_completion_failures_total";
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Phase = Parameters<Fixture["arm"]>[0];
type Claims = Record<string, unknown>;
interface RoomLock { pid: number; mode: string; granted: boolean; blockers: number[] }

/** Native HTTP vocabulary for one owned fixture. Assertions compare decoded claims,
 * scalars and booleans; the raw token never reaches a failure message. */
function issuance(h: Fixture) {
  const post = (body: unknown) => h.request("/api/tokens/state", "POST", {}, body);
  const createRoom = (roomId: string, visibility: "public" | "private", tenantId = "demo-tenant") => h.request("/api/rooms", "POST", h.adminHeaders,
    { roomId, tenantId, templateId: "meeting-room-basic", name: "Persisted issuance room", visibility, guestAllowed: visibility === "public" });
  function minted(response: AuthorHttpResponse, roomId: string, participantId?: string): { body: Claims; claims: Claims } {
    assert.equal(response.status, 200, `expected a floor-1 state token; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(Object.keys(body).sort().join(), SHAPE, "the legacy response shape is unchanged");
    const token = typeof body.token === "string" ? body.token : "";
    const parts = token.split(".");
    assert.equal(parts.length === 2 && !token.startsWith("rs2."), true, "a floor-1 state token is body.signature");
    const verified = verifyRoomSessionToken(token, AUTHOR_HTTP_SECRET, { roomId, participantId });
    assert.equal(verified.ok, true, `the MAC and room/participant binding verify: ${verified.ok ? "ok" : verified.code}`);
    return { body, claims: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Claims };
  }
  function refused(response: AuthorHttpResponse, status: number, error: string, reason?: string) {
    assert.equal(response.status, status, `expected ${error}; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(body.error === error && body.reason === reason, true, `expected ${error}/${reason ?? "-"}`);
    const text = response.bytes.toString("utf8");
    assert.equal(SUCCESS.some(key => key in body) || text.includes("rs2.") || text.includes(AUTHOR_HTTP_SECRET) || "set-cookie" in response.headers,
      false, "a refusal carries no token, credential or success field");
  }
  const bare = (response: AuthorHttpResponse, status: number, error: string) => {
    try { return response.status === status && JSON.stringify(response.json()) === JSON.stringify({ error }); }
    catch { return false; }
  };
  const totals = async () => (await h.pool.query(`select (select count(*) from rooms)::int as rooms,
    (select count(*) from room_identity_authority_v2)::int as authorities,
    (select count(*) from runtime_diagnostics)::int as diagnostics, (select count(*) from xr_telemetry)::int as xr`)).rows[0] as Claims;
  async function metricLines() {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    const lines = response.bytes.toString("utf8").split("\n");
    assert.equal(lines.filter(line => line.startsWith("vrata_api_request_failures_total ")).length, 1, "exactly one request failure metric line");
    return lines.filter(line => /^vrata_(api_request_failures_total|rooms_total|room_access_denied_total|personal_room_)/.test(line));
  }
  async function releaseFailures() {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    const lines = response.bytes.toString("utf8").split("\n").filter(line => line.startsWith(`${RELEASE_FAILURES} `));
    assert.equal(lines.length, 1, "exactly one unlabelled release completion metric line");
    return Number(lines[0].slice(RELEASE_FAILURES.length + 1));
  }
  /** Holds one request at a child phase; cleanup always resets the clock and resumes. */
  async function held(phase: Phase, roomId: string, request: () => Promise<AuthorHttpResponse>, change: () => Promise<unknown>) {
    const id = await h.arm(phase, roomId);
    const pending = request(); void pending.catch(() => undefined);
    try { await h.phase(id, phase); await change(); await h.resume(); return await pending; }
    finally { await h.clock(0); await h.resume(); await pending.catch(() => undefined); }
  }
  const backend = async (client: PoolClient) => (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;
  const roomLocks = async () => (await h.pool.query(`select pid, mode, granted, pg_blocking_pids(pid) as blockers from pg_locks
    where locktype='relation' and relation='rooms'::regclass
      and database=(select oid from pg_database where datname=current_database())`)).rows as RoomLock[];
  /** The backend whose rooms lock is in this state and which pg_blocking_pids reports blocked by blocker. */
  async function lockedBy(blocker: number, mode: string, granted: boolean, what: string): Promise<number> {
    let pid = 0;
    await until(async () => {
      pid = (await roomLocks()).find(lock => lock.mode === mode && lock.granted === granted && lock.blockers.includes(blocker))?.pid ?? 0;
      return pid > 0;
    }, what);
    return pid;
  }
  return { post, createRoom, minted, refused, bare, totals, metricLines, releaseFailures, held, backend, lockedBy };
}

test("floor-1 virtual state-token issuance is validated, pinned and freshly signed over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture", async c => {
    const h = await startAuthorHttpFixture(c, 1, true);
    const i = issuance(h);
    assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: OTHER_TENANT, name: "Other issuance tenant" })).status, 201);

    await c.test("a virtual room releases one MAC-verified legacy token with captured, untrusted claims and no storage effect", async () => {
      const roomId = randomUUID(), participantId = randomUUID();
      const before = [await i.metricLines(), await i.totals()];
      const { body, claims } = i.minted(await i.post({ roomId, participantId, displayName: "Captured participant" }), roomId, participantId);
      assert.deepEqual([body.role, claims.role, claims.roleSource, claims.tenantId, claims.displayName],
        ["guest", "guest", "default", "demo-tenant", "Captured participant"], "default guest; no requested or trusted host upgrade");
      assert.equal(claims.sessionId === body.sessionId && JSON.stringify(claims.permissions) === JSON.stringify(body.permissions), true,
        "the response describes the signed claims");
      assert.deepEqual(["identityProtocolVersion", "identityId", "authEpoch", "isOwner", "roomTemplate", "sceneMediaSurfaces"].filter(key => key in claims), [],
        "no v2, owner or persisted-room claim");
      const defaulted = i.minted(await i.post({ roomId, participantId: null, displayName: null, requestedRole: null }), roomId).claims;
      assert.deepEqual([UUID.test(String(defaulted.participantId)), defaulted.displayName === defaulted.participantId, defaulted.role, defaulted.roleSource],
        [true, true, "guest", "default"], "nullish claims keep their defaults");
      assert.equal(await h.storage.getRoom(roomId), null, "issuance never materializes a room");
      assert.deepEqual([await i.metricLines(), await i.totals()], before, "no room, binding, telemetry row or metric change");
    });

    await c.test("a release held 600 s at the fence entry signs with the clock at release, not a prepared token", async () => {
      const roomId = randomUUID(), participantId = randomUUID();
      const before = Math.floor(Date.now() / 1000);
      const response = await i.held("telemetry-effect", roomId, () => i.post({ roomId, participantId, displayName: "Delayed participant" }),
        () => h.clock(600_000));
      const { body, claims } = i.minted(response, roomId, participantId);
      const iat = Number(claims.iat), exp = Number(claims.exp);
      assert.deepEqual([iat >= before + 600, exp - iat, body.expiresInSeconds], [true, 900, 900], "fresh iat; unchanged 900 s lifetime");
    });

    await c.test("a COMMIT acknowledgement lost after release completes the buffered 200 and counts only the release completion", async () => {
      const roomId = randomUUID(), participantId = randomUUID(), holdId = randomUUID();
      const before = [await i.metricLines(), await i.totals()];
      const completions = await i.releaseFailures();
      const faultId = await h.arm("state-token-ack-loss", roomId);
      const pending = h.request("/api/tokens/state", "POST", { "x-author-hold-state-reply": holdId },
        { roomId, participantId, displayName: "Buffered participant" });
      void pending.catch(() => undefined);
      let response!: AuthorHttpResponse;
      try {
        // send() returned with its body queued; the actual COMMIT then ran and only its reply was dropped.
        await h.stateReplyBuffered(holdId);
        await h.phase(faultId, "state-token-ack-loss");
        await until(async () => await i.releaseFailures() === completions + 1,
          "the post-release completion failure is handled while the reply is still queued");
        await h.flushStateReplies();
        response = await pending;
      } finally { await h.flushStateReplies(); await pending.catch(() => undefined); }
      const { body } = i.minted(response, roomId, participantId);
      assert.equal(JSON.stringify(body) === response.bytes.toString('utf8'), true, "the whole reply is exactly one serialized token body");
      assert.equal(await i.releaseFailures(), completions + 1, "counted once");
      const followRoom = randomUUID();
      i.minted(await i.post({ roomId: followRoom, participantId: randomUUID(), displayName: "Follow-up participant" }), followRoom);
      assert.deepEqual([await i.metricLines(), await i.totals()], before, "no request failure, room, binding or telemetry row");
      const open = await h.pool.query(`select count(*)::int as open from pg_stat_activity
        where application_name=$1 and state like 'idle in transaction%'`, [h.schema]);
      assert.equal(open.rows[0].open, 0, "the pinned transaction ended");
      assert.equal((await i.createRoom(roomId, "public")).status, 201, "rooms SHARE ended with the transaction");
    });

    await c.test("invalid bodies are a bare 404 or 400 before any room or authority read, without state or failure metrics", async () => {
      const room = randomUUID();
      const notFound: unknown[] = [{ roomId: "r".repeat(201) }, { roomId: "room\u0000id" }, { roomId: "room\nid" }, { roomId: "" },
        { roomId: 7 }, { roomId: {} }, { roomId: false }];
      const malformed: unknown[] = [[], "room", 7, false,
        ...["p".repeat(201), "p\u0000id", "p\nid", "", 7, {}].map(participantId => ({ roomId: room, participantId, displayName: "Invalid" })),
        ...[7, {}, false].map(displayName => ({ roomId: room, participantId: randomUUID(), displayName }))];
      const before = [await i.metricLines(), await i.totals()];
      const holder = await h.pool.connect();
      try {
        await holder.query("begin");
        // A rooms or binding read would queue behind ACCESS EXCLUSIVE and time out instead of answering.
        await holder.query("lock table rooms, room_identity_authority_v2 in access exclusive mode");
        for (const [status, error, bodies] of [[404, "room_not_found", notFound], [400, "invalid_state_token_request", malformed]] as const) {
          for (const [index, body] of bodies.entries()) {
            assert.equal(i.bare(await i.post(body), status, error), true, `${error} case ${index}: expected a bare HTTP ${status}`);
          }
        }
      } finally { await holder.query("rollback").catch(() => undefined); holder.release(); }
      assert.deepEqual([await i.metricLines(), await i.totals()], before, "no failure metric, access denial or database row");
      const exactRoom = "r".repeat(200), exactParticipant = "p".repeat(200);
      i.minted(await i.post({ roomId: exactRoom, participantId: exactParticipant, displayName: "Exact participant" }), exactRoom, exactParticipant);
      assert.deepEqual(await i.totals(), before[1], "the exact-limit virtual issuance writes nothing");
    });

    for (const [label, visibility, tenantId] of [["public", "public", "demo-tenant"], ["private", "private", "demo-tenant"],
      ["other-tenant", "public", OTHER_TENANT]] as const) {
      await c.test(`a ${label} room created after the null snapshot denies issuance with room_state_changed`, async () => {
        const roomId = randomUUID();
        const response = await i.held("room-loaded", roomId, () => i.post({ roomId, participantId: randomUUID(), displayName: "Late participant" }),
          async () => assert.equal((await i.createRoom(roomId, visibility, tenantId)).status, 201, "the actual room is created over HTTP"));
        i.refused(response, 409, "room_state_changed", "room_state_changed");
        if (visibility === "private") {
          i.refused(await i.post({ roomId, participantId: randomUUID(), displayName: "Retry" }), 403, "room_access_denied", "invite_required");
        }
      });
    }

    await c.test("a policy FOR UPDATE holder parks issuance with rooms SHARE granted; a private admin creation queues behind it", async () => {
      const roomId = randomUUID(), participantId = randomUUID(), order: string[] = [];
      const holder = await h.pool.connect();
      let issued: Promise<AuthorHttpResponse> | undefined, created: Promise<AuthorHttpResponse> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select 1 from room_identity_protocol_policy where singleton=true for update");
        const holderPid = await i.backend(holder);
        issued = i.post({ roomId, participantId, displayName: "Policy waiter" }).then(value => { order.push("issued"); return value; });
        void issued.catch(() => undefined);
        const issuerPid = await i.lockedBy(holderPid, "ShareLock", true, "issuance holds rooms SHARE while it waits on the policy row");
        created = i.createRoom(roomId, "private").then(value => { order.push("created"); return value; });
        void created.catch(() => undefined);
        const creatorPid = await i.lockedBy(issuerPid, "RowExclusiveLock", false, "the creation queues rooms RowExclusive behind issuance");
        assert.equal(new Set([holderPid, issuerPid, creatorPid]).size, 3, "three distinct backends");
        assert.equal(await h.storage.getRoom(roomId), null, "the creation has not inserted");
        await holder.query("commit");
        i.minted(await issued, roomId, participantId);
        assert.equal((await created).status, 201, "the creation proceeds after the issuance COMMIT");
        assert.deepEqual(order, ["issued", "created"]);
      } finally {
        await holder.query("rollback").catch(() => undefined); holder.release();
        await Promise.allSettled([issued, created]);
      }
      i.refused(await i.post({ roomId, participantId: randomUUID(), displayName: "Retry" }), 403, "room_access_denied", "invite_required");
    });

    await c.test("an uncommitted creation holding rooms RowExclusive queues issuance on SHARE, which then sees the room", async () => {
      const roomId = randomUUID();
      const holder = await h.pool.connect();
      let created: Promise<AuthorHttpResponse> | undefined, issued: Promise<AuthorHttpResponse> | undefined;
      try {
        await holder.query("begin");
        // As in the storage suite: the creation's INSERT waits here after taking rooms RowExclusive.
        await holder.query("select 1 from templates where template_id='meeting-room-basic' for no key update");
        const holderPid = await i.backend(holder);
        created = i.createRoom(roomId, "private"); void created.catch(() => undefined);
        const creatorPid = await i.lockedBy(holderPid, "RowExclusiveLock", true, "the creation holds rooms RowExclusive inside its INSERT");
        issued = i.post({ roomId, participantId: randomUUID(), displayName: "Queued participant" }); void issued.catch(() => undefined);
        await i.lockedBy(creatorPid, "ShareLock", false, "issuance queues rooms SHARE behind the uncommitted creation");
        await holder.query("commit");
        assert.equal((await created).status, 201);
        i.refused(await issued, 409, "room_state_changed", "room_state_changed");
      } finally {
        await holder.query("rollback").catch(() => undefined); holder.release();
        await Promise.allSettled([created, issued]);
      }
      assert.equal((await h.storage.getRoom(roomId))?.roomId === roomId, true, "the new room is visible");
      i.refused(await i.post({ roomId, participantId: randomUUID(), displayName: "Retry" }), 403, "room_access_denied", "invite_required");
    });

    await c.test("ordinary persisted public and private host-invite issuance keeps the legacy 200 shape", async () => {
      const publicRoom = randomUUID(), privateRoom = randomUUID();
      assert.equal((await i.createRoom(publicRoom, "public")).status, 201);
      const guest = i.minted(await i.post({ roomId: publicRoom, participantId: randomUUID(), displayName: "Public guest" }), publicRoom);
      assert.deepEqual([guest.body.role, guest.claims.roleSource], ["guest", "default"]);
      assert.equal((await i.createRoom(privateRoom, "private")).status, 201);
      const { inviteToken } = await h.invite(privateRoom, "host");
      const host = i.minted(await i.post({ roomId: privateRoom, participantId: randomUUID(), displayName: "Invited host", inviteToken }), privateRoom);
      assert.deepEqual([host.body.role, host.claims.role, host.claims.roleSource], ["host", "host", "trusted"]);
    });
  });

  // Activation is monotonic: each held phase owns a fresh floor-1 fixture.
  for (const phase of ["room-loaded", "telemetry-effect"] as const) {
    await t.test(`owned floor-1 fixture: activation while issuance is held at ${phase} denies the legacy mint`, async c => {
      const h = await startAuthorHttpFixture(c, 1, true);
      const i = issuance(h);
      const roomId = randomUUID();
      const response = await i.held(phase, roomId, () => i.post({ roomId, participantId: randomUUID(), displayName: "Cutover participant" }),
        () => h.storage.identityProtocol.raise(2));
      i.refused(response, 409, "identity_required", "identity_upgrade_required");
      assert.deepEqual([await h.storage.identityProtocol.minimum(), await h.storage.getRoom(roomId)], [2, null]);
    });
  }
});
