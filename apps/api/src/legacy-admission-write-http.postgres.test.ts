import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";
import { AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const LONG_TENANT = `admission-write-${"t".repeat(185)}`;
const POST_SHAPE = "access,expiresInSeconds,permissions,role,sessionId,token";
const SUCCESS = ["token", "sessionId", "permissions", "role", "access", "expiresInSeconds", "identityCredential", "isOwner"];
const V2_CLAIMS = ["identityProtocolVersion", "identityId", "authEpoch", "isOwner", "identityCredential"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNAVAILABLE = JSON.stringify({ error: "identity_authority_unavailable", reason: "identity_authority_unavailable" });
const UPGRADE = ["identity_required", "identity_upgrade_required"] as const;
const CHANGED = ["room_state_changed", "room_state_changed"] as const;
// Past every 3600 s fixture invite; a 900 s MAC is lapsed from its own signed exp instead.
const PAST_INVITE = 3_700_000;
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Claims = Record<string, unknown>;
type Send = () => Promise<AuthorHttpResponse>;
type Hold = "admission-write" | "admission-written" | "room-loaded" | "telemetry-effect";
interface Issued { claims: Claims; token: string; participantId: string }
interface WaitingRows { count: number; id: string | null; status: string | null; name: string | null; created: string | null; decided: boolean | null }

/** Native HTTP vocabulary for the guarded floor-1 admission write behind POST /api/tokens/state. Assertions read decoded
 * claims, statuses, reasons and private fixture rows; a raw token, invite or secret never reaches a failure message.
 * Without an explicit ID or valid scoped bearer a request mints a new subject; either stable source can reconcile. */
function admissions(h: Fixture) {
  const stem = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
  const post = (body: Claims, token?: string) => h.request("/api/tokens/state", "POST",
    token === undefined ? {} : authorHttpBearer(token), { displayName: "Admission participant", ...body });
  async function admin(path: string, body: unknown = {}, method = "POST") {
    const response = await h.request(path, method, h.adminHeaders, body);
    assert.equal(response.status, 200, `administrative ${method} must succeed; received HTTP ${response.status}`); return response;
  }
  async function createRoom(visibility: "public" | "private", extra: Claims = {}, roomId: string = randomUUID(), tenantId = "demo-tenant") {
    const response = await h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId, templateId: "meeting-room-basic",
      name: "Admission write room", visibility, guestAllowed: visibility === "public", ...extra });
    assert.equal(response.status, 201, "the room is created over HTTP"); return roomId;
  }
  const bind = (roomId: string) => h.storage.roomIdentities.create({ tenantId: "demo-tenant", roomId, displayName: "Binding",
    baseRole: "guest", provenance: { kind: "guest" } });
  function minted(response: AuthorHttpResponse, roomId: string, participantId?: string): Issued {
    assert.equal(response.status, 200, `expected a floor-1 state token; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(Object.keys(body).sort().join(), POST_SHAPE, "the legacy response shape is unchanged");
    const token = typeof body.token === "string" ? body.token : "", parts = token.split(".");
    assert.equal(parts.length === 2 && !token.startsWith("rs2."), true, "a floor-1 state token is body.signature");
    const result = verifyRoomSessionToken(token, AUTHOR_HTTP_SECRET, { roomId, participantId });
    assert.equal(result.ok, true, `the MAC and room/participant binding verify: ${result.ok ? "ok" : result.code}`);
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Claims;
    assert.deepEqual(V2_CLAIMS.filter(key => key in claims), [], "no v2 or owner claim");
    assert.equal(body.role === claims.role, true, "the reply describes the freshly signed claims");
    return { claims, token, participantId: claims.participantId as string };
  }
  function refused(response: AuthorHttpResponse, status: number, error: string, reason?: string) {
    assert.equal(response.status, status, `expected ${error}/${reason ?? "-"}; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(body.error === error && body.reason === reason, true, `expected ${error}/${reason ?? "-"}`);
    assert.equal(SUCCESS.some(key => key in body) || response.bytes.toString("utf8").includes(AUTHOR_HTTP_SECRET), false,
      "a refusal carries no token or success field");
  }
  function pending(response: AuthorHttpResponse): string {
    refused(response, 202, "room_access_denied", "waiting_room_pending");
    const id = response.json<Claims>().accessRequestId;
    assert.equal(typeof id === "string" && UUID.test(id), true, "a pending reply names its request"); return id as string;
  }
  function unavailable(response: AuthorHttpResponse) {
    assert.equal(response.status === 503 && response.bytes.toString("utf8") === UNAVAILABLE, true,
      `one fixed 503 with no token, request ID or driver detail (status ${response.status})`);
  }
  async function roomRow(roomId: string) {
    const row = (await h.pool.query(`select to_jsonb(r) - 'session_control' as columns, r.session_control - 'hostParticipantId' as control,
      r.session_control->>'hostParticipantId' as host from "${h.schema}".rooms r where room_id=$1`, [roomId])).rows[0];
    assert.ok(row, "the fixture room exists"); return row as { columns: Claims; control: Claims; host: string | null };
  }
  const seat = async (roomId: string) => (await roomRow(roomId)).host;
  const rows = async (roomId: string, participantId: string) => (await h.pool.query(`select count(*)::int as count, min(request_id) as id,
    min(status) as status, min(display_name) as name, min(created_at)::text as created, bool_or(decided_at is not null) as decided
    from "${h.schema}".room_waiting_requests where room_id=$1 and participant_id=$2`, [roomId, participantId])).rows[0] as WaitingRows;
  const bindings = async (roomId: string) => (await h.pool.query(`select count(*)::int as count
    from "${h.schema}".room_identity_authority_v2 where room_id=$1`, [roomId])).rows[0].count as number;
  /** Fixture-only: no floor-1 route vacates a seat, so the store clears just the host key for a bearer-source claim. */
  async function vacate(roomId: string) {
    const room = await h.storage.getRoom(roomId); assert.ok(room, "the fixture room exists");
    await h.storage.updateRoom(roomId, { sessionControl: { ...room.sessionControl, hostParticipantId: null } });
    assert.equal(await seat(roomId), null, "the fixture vacated only the seat");
  }
  async function present(roomId: string, actor: Issued) {
    const response = await h.request(`${stem(roomId)}/presence/${actor.participantId}`, "PUT", authorHttpBearer(actor.token),
      { participantId: actor.participantId, displayName: "Present participant", updatedAt: new Date().toISOString() });
    assert.equal(response.status, 200, "the transfer target needs real HTTP presence");
  }
  async function metric(name: string, label: string, value: string): Promise<number> {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    const prefix = `${name}{${label}="${value}"} `;
    const found = response.bytes.toString("utf8").split("\n").filter(line => line.startsWith(prefix));
    assert.equal(found.length <= 1, true, `at most one ${name} line per label`);
    return found.length ? Number(found[0].slice(prefix.length)) : 0;
  }
  async function allowedUses(participantId: string): Promise<number> {
    const response = await h.request("/api/audit/control-plane", "GET", h.adminHeaders); assert.equal(response.status, 200);
    return response.json<{ items: Array<{ action?: string; result?: string; actor?: { actorId?: string } }> }>().items
      .filter(item => item.action === "invite.use" && item.result === "allowed" && item.actor?.actorId === participantId).length;
  }
  /** Holds each request at phase in FIFO order, runs change, then resumes all. Cleanup always resets the clock and resumes. */
  async function held(phase: Hold, roomId: string, sends: Send[], change: () => Promise<unknown> = async () => undefined) {
    const queued: Promise<AuthorHttpResponse>[] = [];
    try {
      for (const send of sends) {
        const id = await h.arm(phase, roomId);
        const next = send(); void next.catch(() => undefined); queued.push(next);
        await h.phase(id, phase);
      }
      await change();
      for (let index = 0; index < queued.length; index++) await h.resume();
      return await Promise.all(queued);
    } finally {
      await h.clock(0);
      for (let index = 0; index < queued.length; index++) await h.resume();
      await Promise.allSettled(queued);
    }
  }
  /** The armed room's guarded write commits for real; only its acknowledgement is dropped. */
  async function ackLost(roomId: string, send: Send) {
    const id = await h.arm("admission-ack-loss", roomId);
    unavailable(await send());
    await h.phase(id, "admission-ack-loss");
  }
  async function settled() {
    const open = await h.pool.query(`select count(*)::int as open from pg_stat_activity
      where application_name=$1 and state like 'idle in transaction%'`, [h.schema]);
    assert.equal(open.rows[0].open, 0, "no admission fence stays open");
  }
  return { stem, post, admin, createRoom, bind, minted, refused, pending, unavailable, roomRow, seat, rows, bindings, vacate, present,
    metric, allowedUses, held, ackLost, settled };
}

test("floor-1 admission writes are guarded, acknowledged and reconciled over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture", async c => {
    const h = await startAuthorHttpFixture(c, 1, true), a = admissions(h);

    await c.test("trusted host sources seat a vacant host before release; default and dev roles never claim", async () => {
      const invited = await a.createRoom("public"), host = randomUUID();
      const viaInvite = a.minted(await a.post({ roomId: invited, participantId: host, inviteToken: (await h.invite(invited, "host")).inviteToken }), invited, host);
      assert.deepEqual([await a.seat(invited), await a.allowedUses(host)], [host, 1], "seated, then audited once after the ACK");
      await a.vacate(invited);
      const viaBearer = a.minted(await a.post({ roomId: invited }, viaInvite.token), invited, host);
      const waitingRoom = await a.createRoom("private"), waiter = randomUUID();
      const waitingInvite = (await h.invite(waitingRoom, "host", true)).inviteToken;
      const requestId = a.pending(await a.post({ roomId: waitingRoom, participantId: waiter, inviteToken: waitingInvite }));
      assert.equal(await a.seat(waitingRoom), null, "a pending request claims nothing");
      await a.admin(`${a.stem(waitingRoom)}/waiting-room/${requestId}/approve`);
      const viaApproval = a.minted(await a.post({ roomId: waitingRoom, participantId: waiter, inviteToken: waitingInvite }), waitingRoom, waiter);
      const owner = randomUUID();
      const personal = await a.createRoom("private", { templateId: "personal-workspace-basic", roomType: "personal", ownerParticipantId: owner });
      const opens = await a.metric("vrata_personal_room_opens_total", "result", "owner");
      assert.equal(await a.seat(personal), null, "the personal room starts vacant");
      const viaOwner = a.minted(await a.post({ roomId: personal, participantId: owner }), personal, owner);
      assert.deepEqual([viaInvite, viaBearer, viaApproval, viaOwner].map(value => `${value.claims.role}/${value.claims.roleSource}`),
        Array(4).fill("host/trusted"), "every trusted host source is one MAC-verified legacy host token");
      assert.deepEqual([await a.seat(invited), await a.seat(waitingRoom), await a.seat(personal),
        await a.metric("vrata_personal_room_opens_total", "result", "owner"), await a.bindings(personal)], [host, waiter, owner, opens + 1, 0],
      "each seat is its own subject; the raw owner ID gains no v2 binding");
      const open = await a.createRoom("public");
      const defaulted = a.minted(await a.post({ roomId: open }), open);
      const dev = a.minted(await a.post({ roomId: open, requestedRole: "host" }), open);
      assert.deepEqual([defaulted.claims.roleSource, dev.claims.roleSource === "trusted", await a.seat(open)], ["default", false, null],
        "a default or dev-query role never claims the seat");
    });

    await c.test("the seat write sets only the host key: a lock, an unknown raw key and every room column survive", async () => {
      const roomId = await a.createRoom("public"), host = randomUUID();
      await a.admin(`${a.stem(roomId)}/session-control/lock`);
      // Fixture-only: a raw key no API path writes must survive the claim untouched.
      await h.pool.query(`update "${h.schema}".rooms set session_control = session_control || '{"fixtureSpare":{"kept":true}}'::jsonb
        where room_id=$1`, [roomId]);
      const before = await a.roomRow(roomId);
      const claimed = a.minted(await a.post({ roomId, participantId: host, inviteToken: (await h.invite(roomId, "host")).inviteToken }), roomId, host);
      const after = await a.roomRow(roomId);
      assert.deepEqual([before.host, after.host, claimed.claims.role, typeof after.control.lockedAt === "string",
        (after.control.fixtureSpare as Claims | undefined)?.kept], [null, host, "host", true, true], "a locked room still seats its trusted host");
      assert.deepEqual(after.control, before.control, "no other session-control key changed");
      assert.deepEqual(after.columns, before.columns, "no other room column changed");
    });

    await c.test("lifecycle, host or binding drift after the initial snapshot refuses the held claim with no seat write", async () => {
      const expected = { end: [403, "room_access_denied", "session_ended"], remove: [403, "room_access_denied", "participant_removed"],
        disable: [403, "room_access_denied", "room_disabled"], transfer: [409, ...CHANGED], bind: [409, ...UPGRADE] } as const;
      for (const drift of ["end", "remove", "disable", "transfer", "bind"] as const) {
        const roomId = await a.createRoom("public"), host = randomUUID(), { inviteToken } = await h.invite(roomId, "host");
        const other = drift === "transfer" ? a.minted(await a.post({ roomId }), roomId) : undefined;
        if (other) await a.present(roomId, other);
        const [response] = await a.held("admission-write", roomId, [() => a.post({ roomId, participantId: host, inviteToken })], () => {
          if (drift === "end") return a.admin(`${a.stem(roomId)}/session-control/end`);
          if (drift === "remove") return a.admin(`${a.stem(roomId)}/participants/${host}/remove`);
          if (drift === "disable") return a.admin(`${a.stem(roomId)}/disable`);
          if (other) return a.admin(`${a.stem(roomId)}/host/transfer`, { participantId: other.participantId });
          return a.bind(roomId);
        });
        const [status, error, reason] = expected[drift];
        a.refused(response, status, error, reason);
        assert.equal(await a.seat(roomId), other?.participantId ?? null, `${drift}: the held claim never overwrote the seat`);
      }
    });

    await c.test("concurrent claims seat exactly one subject; the same subject claiming twice is idempotent", async () => {
      const roomId = await a.createRoom("public"), { inviteToken } = await h.invite(roomId, "host"), subjects = [randomUUID(), randomUUID()];
      const raced = await a.held("admission-write", roomId, subjects.map(participantId => () => a.post({ roomId, participantId, inviteToken })));
      const winner = raced.findIndex(response => response.status === 200);
      assert.equal(winner >= 0, true, "one claimer is seated");
      a.minted(raced[winner], roomId, subjects[winner]);
      a.refused(raced[1 - winner], 409, ...CHANGED);
      assert.equal(await a.seat(roomId), subjects[winner], "the loser never steals the seat");
      const same = await a.createRoom("public"), subject = randomUUID(), sameInvite = (await h.invite(same, "host")).inviteToken;
      const twice = await a.held("admission-write", same, [0, 1].map(() => () => a.post({ roomId: same, participantId: subject, inviteToken: sameInvite })));
      assert.deepEqual(twice.map(response => a.minted(response, same, subject).claims.role), ["host", "host"], "both replies verify as the one host");
      assert.equal(await a.seat(same), subject);
    });

    await c.test("concurrent and repeated waiting requests keep one canonical pending row", async () => {
      const roomId = await a.createRoom("private"), participantId = randomUUID(), { inviteToken } = await h.invite(roomId, "member", true);
      const counted = await a.metric("vrata_room_access_denied_total", "reason", "waiting_room_pending");
      const raced = await a.held("admission-write", roomId,
        ["First", "Second"].map(displayName => () => a.post({ roomId, participantId, inviteToken, displayName })));
      const ids = raced.map(response => a.pending(response));
      const row = await a.rows(roomId, participantId);
      assert.deepEqual([ids[0] === ids[1], row.id === ids[0], row.count, row.status, row.decided, ["First", "Second"].includes(String(row.name))],
        [true, true, 1, "pending", false, true], "the natural-key race lands on one row and one ID");
      const repeated = a.pending(await a.post({ roomId, participantId, inviteToken, displayName: "Renamed" }));
      const kept = await a.rows(roomId, participantId);
      assert.deepEqual([repeated === row.id, kept.count, kept.name === row.name, kept.created === row.created, kept.status],
        [true, 1, true, true, "pending"], "a repeat never overwrites the display name, status or creation");
      assert.equal(await a.metric("vrata_room_access_denied_total", "reason", "waiting_room_pending"), counted + 3, "each 202 counts once, after its ACK");
    });

    await c.test("an approval, rejection, revocation or binding after the snapshot refuses the held pending write with no reset", async () => {
      const expected = { approve: [409, ...CHANGED], reject: [403, "room_access_denied", "waiting_room_rejected"],
        revoke: [403, "room_access_denied", "invite_revoked"], bind: [409, ...UPGRADE] } as const;
      for (const drift of ["approve", "reject", "revoke", "bind"] as const) {
        const roomId = await a.createRoom("private"), participantId = randomUUID(), invite = await h.invite(roomId, "member", true);
        const send = () => a.post({ roomId, participantId, inviteToken: invite.inviteToken });
        const requestId = a.pending(await send());
        const [response] = await a.held("admission-write", roomId, [send], () => drift === "bind" ? a.bind(roomId)
          : a.admin(drift === "revoke" ? `${a.stem(roomId)}/invites/${invite.inviteId}/revoke` : `${a.stem(roomId)}/waiting-room/${requestId}/${drift}`));
        const [status, error, reason] = expected[drift];
        a.refused(response, status, error, reason);
        const row = await a.rows(roomId, participantId);
        assert.deepEqual([row.count, row.id === requestId, row.status], [1, true, drift === "approve" ? "approved" : drift === "reject" ? "rejected" : "pending"],
          `${drift}: no stale 202, and the decision is never reset or duplicated`);
        if (drift === "approve") assert.equal(a.minted(await send(), roomId, participantId).claims.role, "member", "the approved retry keeps the invite role");
        if (drift === "reject") a.refused(await send(), 403, "room_access_denied", "waiting_room_rejected");
      }
    });

    await c.test("a waiting invite lapsing after the body, the pool snapshot or the write entry is invite_expired with no row", async () => {
      for (const stage of ["body", "pool", "entry"] as const) {
        const roomId = await a.createRoom("private"), participantId = randomUUID(), { inviteToken } = await h.invite(roomId, "member", true);
        const payload = { roomId, participantId, inviteToken, displayName: "Admission participant" };
        let response!: AuthorHttpResponse;
        if (stage === "body") {
          const stalled = h.stalled("/api/tokens/state", {}, Buffer.from(JSON.stringify(payload)));
          try { await stalled.admitted(); await h.clock(PAST_INVITE); stalled.finish(); response = await stalled.response; }
          finally { stalled.destroy(); await h.clock(0); }
        } else [response] = await a.held(stage === "pool" ? "room-loaded" : "admission-write", roomId, [() => a.post(payload)], () => h.clock(PAST_INVITE));
        a.refused(response, 403, "room_access_denied", "invite_expired");
        assert.equal((await a.rows(roomId, participantId)).count, 0, `${stage}: no receipt and no row`);
      }
    });

    await c.test("a lease lapsing after the actual write SQL rolls it back; an extended invite never widens the plan", async () => {
      const lapsed = async (roomId: string, send: Send, offset: () => number) =>
        (await a.held("admission-written", roomId, [send], () => h.clock(offset())))[0];
      const pastMac = (value: Issued) => () => Number(value.claims.exp) * 1000 - Date.now() + 1000;
      const bearerRoom = await a.createRoom("public"), host = randomUUID();
      const proof = a.minted(await a.post({ roomId: bearerRoom, participantId: host, inviteToken: (await h.invite(bearerRoom, "host")).inviteToken }), bearerRoom, host);
      await a.vacate(bearerRoom);
      a.refused(await lapsed(bearerRoom, () => a.post({ roomId: bearerRoom }, proof.token), pastMac(proof)), 401, "session_token_invalid", "expired_token");
      assert.equal(await a.seat(bearerRoom), null, "the original host proof lapsed after the UPDATE: rolled back");
      for (const waiting of [false, true]) {
        const roomId = await a.createRoom("private"), participantId = randomUUID();
        const { inviteToken } = await h.invite(roomId, waiting ? "member" : "host", waiting);
        a.refused(await lapsed(roomId, () => a.post({ roomId, participantId, inviteToken }), () => PAST_INVITE), 403, "room_access_denied", "invite_expired");
        // A default MAC minted before the room existed is the subject's presented lease beside a long-valid invite.
        const early = randomUUID(), presented = a.minted(await a.post({ roomId: early }), early);
        await a.createRoom("private", {}, early);
        const longInvite = (await h.invite(early, waiting ? "member" : "host", waiting)).inviteToken;
        a.refused(await lapsed(early, () => a.post({ roomId: early, inviteToken: longInvite }, presented.token), pastMac(presented)),
          401, "session_token_invalid", "expired_token");
        assert.deepEqual([await a.seat(roomId), (await a.rows(roomId, participantId)).count, await a.seat(early),
          (await a.rows(early, presented.participantId)).count], [null, 0, null, 0], `${waiting ? "pending" : "host"}: nothing survives a lapse`);
      }
      a.minted(await a.post({ roomId: bearerRoom }, proof.token), bearerRoom, host);
      assert.equal(await a.seat(bearerRoom), host, "the same proof reclaims at the real clock");
      const roomId = await a.createRoom("public"), participantId = randomUUID(), invite = await h.invite(roomId, "host");
      let response: Promise<AuthorHttpResponse> | undefined;
      try {
        const entry = await h.arm("admission-write", roomId);
        response = a.post({ roomId, participantId, inviteToken: invite.inviteToken }); void response.catch(() => undefined);
        await h.phase(entry, "admission-write");
        // Fixture-only: no route extends an invite; the lease planned from the initial snapshot still bounds the write.
        await h.pool.query(`update "${h.schema}".room_invites set expires_at = expires_at + interval '1 day' where invite_id=$1`, [invite.inviteId]);
        const written = await h.arm("admission-written", roomId);
        await h.resume(); await h.phase(written, "admission-written");
        await h.clock(PAST_INVITE); await h.resume();
        a.refused(await response, 403, "room_access_denied", "invite_expired");
      } finally { await h.clock(0); await h.resume(); await h.resume(); await response?.catch(() => undefined); }
      assert.equal(await a.seat(roomId), null, "an extended invite never widened the planned lease");
      await a.settled();
    });

    await c.test("a lost COMMIT acknowledgement is one fixed 503 with no success sink; the same subject reconciles freshly", async () => {
      const roomId = await a.createRoom("public"), host = randomUUID(), invite = await h.invite(roomId, "host");
      const claim = () => a.post({ roomId, participantId: host, inviteToken: invite.inviteToken });
      await a.ackLost(roomId, claim);
      assert.deepEqual([await a.seat(roomId), await a.allowedUses(host)], [host, 0], "the actual COMMIT seated the subject; nothing was audited");
      const reconciled = a.minted(await claim(), roomId, host);
      assert.deepEqual([reconciled.claims.role, reconciled.claims.roleSource, await a.allowedUses(host)], ["host", "trusted", 1],
        "the seated subject's fresh read-only release is its first success");
      await a.admin(`${a.stem(roomId)}/invites/${invite.inviteId}/revoke`);
      a.refused(await claim(), 403, "room_access_denied", "invite_revoked");
      assert.equal(await a.seat(roomId), host, "a persisted seat never authorizes a revoked invite");
      const waitingRoom = await a.createRoom("private"), participantId = randomUUID(), { inviteToken } = await h.invite(waitingRoom, "member", true);
      const wait = () => a.post({ roomId: waitingRoom, participantId, inviteToken });
      const counted = () => a.metric("vrata_room_access_denied_total", "reason", "waiting_room_pending"), before = await counted();
      await a.ackLost(waitingRoom, wait);
      const lost = await a.rows(waitingRoom, participantId);
      assert.deepEqual([lost.count, lost.status, await counted()], [1, "pending", before], "the row committed; no 202 was counted");
      const reconciledId = a.pending(await wait());
      const kept = await a.rows(waitingRoom, participantId);
      assert.deepEqual([reconciledId === lost.id, kept.count, kept.created === lost.created, await counted()], [true, 1, true, before + 1],
        "the same subject reconciles to the same row with no duplicate or reset");
      try { await h.clock(PAST_INVITE); a.refused(await wait(), 403, "room_access_denied", "invite_expired"); } finally { await h.clock(0); }
      assert.equal((await a.rows(waitingRoom, participantId)).count, 1, "an expired invite is refused despite the persisted row");
      await a.settled();
    });

    await c.test("a COMMIT rejected by a deferred constraint is one 503 that keeps nothing; the same request then succeeds", async () => {
      const reject = `"${h.schema}".admission_fixture_reject`, armed: string[] = [];
      // Fixture-only: an owned deferred constraint trigger makes the real COMMIT answer P0001 for one room.
      await h.pool.query(`create function ${reject}() returns trigger language plpgsql as $$ begin
        raise exception using errcode = 'P0001', message = 'admission_fixture_rejected'; end $$`);
      try {
        for (const waiting of [false, true]) {
          const roomId = await a.createRoom(waiting ? "private" : "public"), participantId = randomUUID();
          assert.match(roomId, UUID);
          const { inviteToken } = await h.invite(roomId, waiting ? "member" : "host", waiting);
          const table = `"${h.schema}".${waiting ? "room_waiting_requests" : "rooms"}`;
          await h.pool.query(`create constraint trigger admission_fixture_reject after ${waiting ? "insert" : "update"} on ${table}
            deferrable initially deferred for each row when (new.room_id = '${roomId}') execute function ${reject}()`);
          armed.push(table);
          const send = () => a.post({ roomId, participantId, inviteToken });
          a.unavailable(await send());
          assert.deepEqual([await a.seat(roomId), (await a.rows(roomId, participantId)).count], [null, 0], "the rejected COMMIT kept no seat and no row");
          await h.pool.query(`drop trigger admission_fixture_reject on ${armed.pop()}`);
          if (waiting) a.pending(await send()); else a.minted(await send(), roomId, participantId);
          assert.deepEqual([await a.seat(roomId), (await a.rows(roomId, participantId)).count], waiting ? [null, 1] : [participantId, 0]);
        }
      } finally {
        for (const table of armed) await h.pool.query(`drop trigger if exists admission_fixture_reject on ${table}`);
        await h.pool.query(`drop function if exists ${reject}()`);
      }
    });

    await c.test("a saved 201-character tenant seats its host and queues its waiting request through the guarded write", async () => {
      assert.equal(LONG_TENANT.length, 201);
      assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: LONG_TENANT, name: "Long admission tenant" })).status, 201);
      const hostRoom = await a.createRoom("public", {}, randomUUID(), LONG_TENANT), host = randomUUID();
      const claimed = a.minted(await a.post({ roomId: hostRoom, participantId: host, inviteToken: (await h.invite(hostRoom, "host")).inviteToken }), hostRoom, host);
      const waitingRoom = await a.createRoom("private", {}, randomUUID(), LONG_TENANT), participantId = randomUUID();
      const id = a.pending(await a.post({ roomId: waitingRoom, participantId, inviteToken: (await h.invite(waitingRoom, "member", true)).inviteToken }));
      assert.deepEqual([claimed.claims.tenantId === LONG_TENANT, await a.seat(hostRoom) === host, (await a.rows(waitingRoom, participantId)).id === id],
        [true, true, true], "the long tenant selects, seats and queues");
    });
  });

  // Activation is monotonic and runs last: each case owns a fresh floor-1 fixture.
  for (const variant of ["host claim", "existing pending"] as const) {
    await t.test(`owned floor-1 fixture: activation while a ${variant} write is held refuses it with no write`, async c => {
      const h = await startAuthorHttpFixture(c, 1, true), a = admissions(h);
      const waiting = variant === "existing pending", roomId = await a.createRoom(waiting ? "private" : "public"), participantId = randomUUID();
      const { inviteToken } = await h.invite(roomId, waiting ? "member" : "host", waiting);
      const send = () => a.post({ roomId, participantId, inviteToken });
      const existing = waiting ? a.pending(await send()) : null;
      const [response] = await a.held("admission-write", roomId, [send], () => h.storage.identityProtocol.raise(2));
      a.refused(response, 409, ...UPGRADE);
      const row = await a.rows(roomId, participantId);
      assert.deepEqual([await h.storage.identityProtocol.minimum(), await a.seat(roomId), row.count, row.id === existing, row.status],
        [2, null, waiting ? 1 : 0, true, waiting ? "pending" : null], "the fresh guard wrote nothing and released no stale 202");
    });
  }

  await t.test("owned floor-1 fixture: activation after a known COMMIT keeps the acknowledged writes; the fresh release refuses", async c => {
    const h = await startAuthorHttpFixture(c, 1, true), a = admissions(h);
    const waitingRoom = await a.createRoom("private"), waiter = randomUUID();
    const accessRequestId = a.pending(await a.post({ roomId: waitingRoom, participantId: waiter,
      inviteToken: (await h.invite(waitingRoom, "member", true)).inviteToken }));
    const hostRoom = await a.createRoom("public"), host = randomUUID(), { inviteToken } = await h.invite(hostRoom, "host");
    // The release entry follows the claim's known COMMIT; activation lands between them.
    const [response] = await a.held("telemetry-effect", hostRoom, [() => a.post({ roomId: hostRoom, participantId: host, inviteToken })],
      () => h.storage.identityProtocol.raise(2));
    a.refused(response, 409, ...UPGRADE);
    const row = await a.rows(waitingRoom, waiter);
    assert.deepEqual([await h.storage.identityProtocol.minimum(), row.id === accessRequestId, row.status, await a.seat(hostRoom)],
      [2, true, "pending", host], "acknowledged writes may persist; only the fresh read-only release is refused");
  });
});
