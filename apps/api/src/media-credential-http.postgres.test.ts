import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { TokenVerifier } from "livekit-server-sdk";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { AUTHOR_HTTP_MEDIA_KEY, AUTHOR_HTTP_MEDIA_SECRET, AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, until,
  type AuthorHttpResponse, type AuthorHttpRoom, type AuthorHttpSession } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const MEDIA = "/api/tokens/media", TTL = 120;
const COUNTERS = ["vrata_api_media_credential_release_completion_failures_total", "vrata_api_frame_credential_release_completion_failures_total",
  "vrata_api_legacy_state_release_completion_failures_total", "vrata_api_virtual_state_release_completion_failures_total", "vrata_api_request_failures_total"];
const RECOVERY = [409, "identity_required", "identity_recovery_required"] as const;
const TRANSPORTS = ["bearer", "body"] as const;
const codec = createRoomSessionV2Codec(AUTHOR_HTTP_SECRET);
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Claims = Record<string, unknown>;
type Transport = typeof TRANSPORTS[number];
type Send = () => Promise<AuthorHttpResponse>;
type Hold = "media-sign" | "media-prepared" | "telemetry-effect" | "room-loaded" | "media-namespace";

const part = (token: string, index: number) => JSON.parse(Buffer.from(token.split(".")[index] ?? "", "base64url").toString("utf8")) as Claims;
const deadline = (token: string) => Number(token.startsWith("rs2.") ? part(token, 1).expiresAtSeconds : part(token, 0).exp);
const subject = (token: string) => String(part(token, 0).participantId);

/** Native HTTP/SDK vocabulary: genuine state MACs and LiveKit JWT signatures; assertions expose no token, URL or secret. */
function media(h: Fixture) {
  let offset = 0;
  const clock = async (ms: number) => { offset = ms; await h.clock(ms); };
  const now = () => Math.floor((Date.now() + offset) / 1000);
  const expire = (token: string) => clock(deadline(token) * 1000 - Date.now() + 1000);
  const stem = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
  const send = (roomId: string, participantId: string, token: string, transport: Transport = "bearer", extra: Claims = {}, headers: Record<string, string> = {}) =>
    h.request(MEDIA, "POST", { ...(transport === "bearer" ? authorHttpBearer(token) : {}), ...headers },
      { roomId, participantId, canPublishAudio: true, canPublishVideo: false, ...(transport === "body" ? { sessionToken: token } : {}), ...extra });
  async function admin(path: string, body: unknown = {}, method = "POST") {
    const response = await h.request(path, method, h.adminHeaders, body);
    assert.equal(response.status, 200, `administrative ${method} succeeds (HTTP ${response.status})`); return response;
  }
  async function createRoom(visibility: "public" | "private", roomId: string = randomUUID(), tenantId = "demo-tenant") {
    const response = await h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId, templateId: "meeting-room-basic",
      name: "Media credential room", visibility, guestAllowed: visibility === "public" });
    assert.equal(response.status, 201, "the owned room is created over HTTP"); return roomId;
  }
  async function state(body: Claims) {
    const response = await h.request("/api/tokens/state", "POST", {}, { displayName: "Media listener", ...body });
    assert.equal(response.status, 200, `the original floor-1 state proof is issued (HTTP ${response.status})`);
    const token = response.json<Claims>().token;
    assert.equal(typeof token === "string" && token.split(".").length === 2, true, "a floor-1 state MAC");
    return { token: token as string, participantId: subject(token as string) };
  }
  async function present(roomId: string, session: { token: string; participantId: string }) {
    assert.equal((await h.request(`${stem(roomId)}/presence/${session.participantId}`, "PUT", authorHttpBearer(session.token),
      { participantId: session.participantId, displayName: "Present listener", updatedAt: new Date().toISOString() })).status, 200);
  }
  async function counters() {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    const lines = response.bytes.toString("utf8").split("\n");
    return COUNTERS.map(name => {
      const found = lines.filter(line => line.startsWith(`${name} `));
      assert.equal(found.length, 1, `one unlabelled ${name}`); return Number(found[0].slice(name.length + 1));
    });
  }
  async function issued(request: Send, roomId: string, participantId: string, proof: string, v2 = false) {
    const before = now(), response = await request(), after = now();
    assert.equal(response.status, 200, `a fresh media credential is released (HTTP ${response.status})`);
    const body = response.json<Claims>();
    assert.equal(Object.keys(body).sort().join(), "expiresInSeconds,livekitUrl,token", "the public response shape stays compatible");
    assert.equal(JSON.stringify(body) === response.bytes.toString("utf8"), true, "exactly one complete JSON reply");
    assert.equal(typeof body.livekitUrl === "string", true, "a captured endpoint is returned");
    const verified = await new TokenVerifier(AUTHOR_HTTP_MEDIA_KEY, AUTHOR_HTTP_MEDIA_SECRET).verify(String(body.token), 0).catch(() => null);
    assert.ok(verified, "the actual SDK verifies the JWT signature under only the fixture media key");
    const jwt = part(String(body.token), 1), grant = jwt.video as Claims;
    assert.equal(jwt.sub === participantId && jwt.iss === AUTHOR_HTTP_MEDIA_KEY && jwt.nbf === 0 && typeof jwt.name === "string", true,
      "the signed subject, issuer, not-before and display name are the intended values");
    assert.equal(Object.keys(jwt).sort().join(), "exp,iss,name,nbf,sub,video", "no extra identity, metadata or grant claims");
    assert.equal(Object.keys(grant).sort().join(), "canPublish,canSubscribe,room,roomJoin", "source grants remain a separate gate");
    assert.equal(grant.roomJoin === true && grant.canPublish === true && grant.canSubscribe === true, true, "the existing voice grant remains enabled");
    const namespace = v2 ? await h.storage.identityProtocol.mediaNamespace() : null;
    assert.equal(grant.room === (v2 ? `vrata-v2:${namespace}:${roomId}` : `vrata-${roomId}`), true, "the actual activation namespace is preserved");
    const exp = Number(jwt.exp), lifetime = Number(body.expiresInSeconds), releaseClock = exp - lifetime;
    assert.equal(Number.isSafeInteger(exp) && exp <= deadline(proof) && Number.isSafeInteger(lifetime) && lifetime >= 1 && lifetime <= TTL, true,
      "neither the signed deadline nor the reported remainder widens the original proof");
    assert.equal(releaseClock >= before && releaseClock <= after, true, "expiresInSeconds describes the final release clock");
    assert.equal(exp >= Math.min(before + TTL, deadline(proof)) && exp <= Math.min(after + TTL, deadline(proof)), true,
      "absolute exp was selected from one signing clock before release");
    return { exp, lifetime };
  }
  async function both(roomId: string, session: { token: string; participantId: string }, v2 = false) {
    for (const transport of TRANSPORTS) await issued(() => send(roomId, session.participantId, session.token, transport), roomId, session.participantId, session.token, v2);
  }
  async function clipped(roomId: string, session: { token: string; participantId: string }, v2 = false) {
    for (const transport of TRANSPORTS) {
      try {
        await clock(deadline(session.token) * 1000 - Date.now() - 7_000);
        const result = await issued(() => send(roomId, session.participantId, session.token, transport), roomId, session.participantId, session.token, v2);
        assert.equal(result.exp === deadline(session.token) && result.lifetime <= 7, true, "a seven-second proof is never extended");
      } finally { await clock(0); }
    }
  }
  function refused(response: AuthorHttpResponse, status: number, error?: string, reason?: string) {
    assert.equal(response.status, status, `expected HTTP ${status}${error ? ` ${error}` : ""}; got ${response.status}`);
    const body = response.json<Claims>();
    if (error !== undefined) assert.equal(body.error === error, true, `expected ${error}`);
    if (reason !== undefined) assert.equal(body.reason === reason, true, `expected ${reason}`);
    const text = response.bytes.toString("utf8");
    assert.equal(["token", "expiresInSeconds", "livekitUrl"].some(key => key in body) || text.includes(AUTHOR_HTTP_MEDIA_SECRET)
      || text.includes(AUTHOR_HTTP_SECRET), false, "a refusal contains no credential, endpoint or signing secret");
  }
  async function held(phase: Hold, roomId: string, request: Send, change: () => Promise<unknown>) {
    const id = await h.arm(phase, roomId), pending = request(); void pending.catch(() => undefined);
    try { await h.phase(id, phase); await change(); await h.resume(); return await pending; }
    finally { await clock(0); await h.resume(); await pending.catch(() => undefined); }
  }
  async function body(roomId: string, session: { token: string; participantId: string }, transport: Transport, change: () => Promise<unknown>) {
    const stalled = h.stalled(MEDIA, transport === "bearer" ? session.token : {}, Buffer.from(JSON.stringify({ roomId,
      participantId: session.participantId, canPublishAudio: true, canPublishVideo: false,
      ...(transport === "body" ? { sessionToken: session.token } : {}) })));
    try { await stalled.admitted(); await change(); stalled.finish(); return await stalled.response; }
    finally { stalled.destroy(); await clock(0); }
  }
  async function pgWait(roomId: string, request: Send, change: (holder: PoolClient) => Promise<void>) {
    // Acquire the actual parent lock only after the genuine SDK JWT exists, then let its final release queue behind it.
    const id = await h.arm("media-prepared", roomId), pending = request(); void pending.catch(() => undefined);
    try {
      await h.phase(id, "media-prepared");
      return await h.held(roomId, () => { void h.resumePhase(id).catch(() => undefined); return pending; }, change);
    } finally { await clock(0); await h.resumePhase(id); await pending.catch(() => undefined); }
  }
  async function ackLost(phase: "legacy-state-token-ack-loss" | "state-token-ack-loss" | "media-credential-ack-loss", roomId: string,
    session: { token: string; participantId: string }) {
    const before = await counters(), holdId = randomUUID(), faultId = await h.arm(phase, roomId);
    const pending = send(roomId, session.participantId, session.token, "bearer", {}, { "x-author-hold-state-reply": holdId }); void pending.catch(() => undefined);
    try {
      await h.stateReplyBuffered(holdId); await h.phase(faultId, phase);
      await until(async () => (await counters())[0] === before[0] + 1, "only the post-release media completion failed");
      await h.flushStateReplies(); const response = await pending;
      assert.deepEqual(await counters(), [before[0] + 1, ...before.slice(1)], "one media completion and no other counter");
      return response;
    } finally { await h.flushStateReplies(); await pending.catch(() => undefined); }
  }
  async function signFault(roomId: string, session: { token: string; participantId: string }) {
    const before = await counters(), id = await h.arm("media-sign-fault", roomId);
    try { refused(await send(roomId, session.participantId, session.token), 500, "internal_error"); await h.phase(id, "media-sign-fault"); }
    finally { await h.arm("room-read", `disarmed-${randomUUID()}`); }
    assert.deepEqual(await counters(), [...before.slice(0, 4), before[4] + 1], "signer failure is not a post-release failure");
  }
  async function settled(roomId: string, persisted: boolean) {
    const open = await h.pool.query("select count(*)::int as open from pg_stat_activity where application_name=$1 and state like 'idle in transaction%'", [h.schema]);
    assert.equal(open.rows[0].open, 0, "no read-only transaction stays open");
    const holder = await h.pool.connect();
    try {
      await holder.query("begin"); await holder.query("set local lock_timeout='2s'");
      if (persisted) assert.equal((await holder.query("select 1 from rooms where room_id=$1 for update", [roomId])).rowCount, 1);
      else await holder.query("lock table rooms in exclusive mode");
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); }
  }
  return { clock, now, expire, stem, send, admin, createRoom, state, present, counters, issued, both, clipped, refused, held, body, pgWait, ackLost, signFault, settled };
}

test("user media credentials retain the original proof and fresh authority over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture", async c => {
    const h = await startAuthorHttpFixture(c, 1, true, false, undefined, { ttlSeconds: TTL }), f = media(h);
    await c.test("public guest, private trusted Host/Member and virtual guest keep the genuine SDK grant over both transports", async () => {
      const publicRoom = await f.createRoom("public"), privateRoom = await f.createRoom("private"), virtual = randomUUID();
      const sessions = [[publicRoom, await f.state({ roomId: publicRoom })],
        [privateRoom, await f.state({ roomId: privateRoom, inviteToken: (await h.invite(privateRoom, "host")).inviteToken })],
        [privateRoom, await f.state({ roomId: privateRoom, inviteToken: (await h.invite(privateRoom, "member")).inviteToken })],
        [virtual, await f.state({ roomId: virtual })]] as const;
      for (const [roomId, session] of sessions) await f.both(roomId, session);
    });
    await c.test("persisted and virtual seven-second proofs clip absolute exp and actual remainder", async () => {
      for (const persisted of [true, false]) {
        const roomId = persisted ? await f.createRoom("public") : randomUUID();
        await f.clipped(roomId, await f.state({ roomId }));
      }
    });
    await c.test("a proof lapsing in body, before/after actual signing or in the final entry is expired_token", async () => {
      for (const persisted of [true, false]) {
        const roomId = persisted ? await f.createRoom("public") : randomUUID(), session = await f.state({ roomId });
        for (const transport of TRANSPORTS) {
          f.refused(await f.body(roomId, session, transport, () => f.expire(session.token)), 401, "session_token_invalid", "expired_token");
          for (const phase of ["media-sign", "media-prepared", "telemetry-effect"] as const) {
            f.refused(await f.held(phase, roomId, () => f.send(roomId, session.participantId, session.token, transport), () => f.expire(session.token)),
              401, "session_token_invalid", "expired_token");
          }
        }
        await f.settled(roomId, persisted);
      }
    });
    await c.test("an expired prepared JWT with a still-live proof is retryable, not identity expiry", async () => {
      const roomId = await f.createRoom("public"), session = await f.state({ roomId });
      f.refused(await f.held("media-prepared", roomId, () => f.send(roomId, session.participantId, session.token), () => f.clock((TTL + 2) * 1000)),
        503, "media_credential_preparation_expired");
      await f.both(roomId, session);
    });
    for (const change of ["disable", "end", "remove"] as const) {
      await c.test(`${change} after real signing refuses the captured role and no credential escapes`, async () => {
        const roomId = await f.createRoom("public"), session = await f.state({ roomId });
        const response = await f.held("media-prepared", roomId, () => f.send(roomId, session.participantId, session.token), () =>
          f.admin(`${f.stem(roomId)}/${change === "disable" ? "disable" : change === "end" ? "session-control/end" : `participants/${session.participantId}/remove`}`));
        f.refused(response, 403, "room_access_denied", change === "disable" ? "room_disabled" : change === "end" ? "session_ended" : "participant_removed");
      });
    }
    await c.test("locking does not remove an existing listener's admission", async () => {
      const roomId = await f.createRoom("public"), session = await f.state({ roomId });
      await f.issued(() => f.held("media-prepared", roomId, () => f.send(roomId, session.participantId, session.token), () => f.admin(`${f.stem(roomId)}/session-control/lock`)),
        roomId, session.participantId, session.token);
    });
    await c.test("Host transfer and Presenter grant after signing are role drift even while audio permission survives", async () => {
      const roomId = await f.createRoom("public"), host = await f.state({ roomId, inviteToken: (await h.invite(roomId, "host")).inviteToken });
      const next = await f.state({ roomId }); await f.present(roomId, next);
      f.refused(await f.held("media-prepared", roomId, () => f.send(roomId, host.participantId, host.token), () =>
        f.admin(`${f.stem(roomId)}/host/transfer`, { participantId: next.participantId })), 409, "room_state_changed", "room_state_changed");
      const other = await f.createRoom("public"), member = await f.state({ roomId: other }); await f.present(other, member);
      f.refused(await f.held("media-prepared", other, () => f.send(other, member.participantId, member.token), () =>
        f.admin(`${f.stem(other)}/presenters/${member.participantId}/grant`)), 409, "room_state_changed", "room_state_changed");
      await f.both(other, member);
    });
    await c.test("fresh private provenance denies a default proof while trusted proof survives invite revocation", async () => {
      const roomId = await f.createRoom("public"), guest = await f.state({ roomId });
      f.refused(await f.held("media-prepared", roomId, () => f.send(roomId, guest.participantId, guest.token), () =>
        f.admin(f.stem(roomId), { visibility: "private" }, "PATCH")), 403, "room_access_denied", "invite_required");
      const privateRoom = await f.createRoom("private"), invite = await h.invite(privateRoom, "member"), trusted = await f.state({ roomId: privateRoom, inviteToken: invite.inviteToken });
      await f.issued(() => f.held("media-prepared", privateRoom, () => f.send(privateRoom, trusted.participantId, trusted.token), () =>
        f.admin(`${f.stem(privateRoom)}/invites/${invite.inviteId}/revoke`)), privateRoom, trusted.participantId, trusted.token);
    });
    await c.test("deleted persisted, changed tenant and appeared virtual namespaces never fall back", async () => {
      assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: "media-other-tenant", name: "Other media tenant" })).status, 201);
      for (const change of ["delete", "tenant"] as const) {
        const roomId = await f.createRoom("public"), session = await f.state({ roomId });
        f.refused(await f.held("media-prepared", roomId, () => f.send(roomId, session.participantId, session.token), async () => {
          await f.admin(f.stem(roomId), {}, "DELETE");
          if (change === "tenant") await f.createRoom("public", roomId, "media-other-tenant");
        }), 404, "room_not_found");
      }
      const virtual = randomUUID(), proof = await f.state({ roomId: virtual });
      f.refused(await f.held("media-prepared", virtual, () => f.send(virtual, proof.participantId, proof.token), () => f.createRoom("public", virtual)),
        409, "room_state_changed", "room_state_changed");
      const changed = randomUUID(), heldProof = await f.state({ roomId: changed });
      f.refused(await f.held("room-loaded", changed, () => f.send(changed, heldProof.participantId, heldProof.token), () =>
        f.createRoom("public", changed, "media-other-tenant")), 403, "session_token_invalid", "tenant_mismatch");
      const disagreement = randomUUID(), original = await f.state({ roomId: disagreement });
      await f.createRoom("public", disagreement, "media-other-tenant");
      f.refused(await f.held("room-loaded", disagreement, () => f.send(disagreement, original.participantId, original.token), async () => {
        await f.admin(f.stem(disagreement), {}, "DELETE"); await f.createRoom("public", disagreement);
      }), 409, "room_state_changed", "room_state_changed");
    });
    await c.test("the actual parent-row lock observes original expiry and uncommitted lifecycle", async () => {
      const roomId = await f.createRoom("public"), session = await f.state({ roomId });
      f.refused(await f.pgWait(roomId, () => f.send(roomId, session.participantId, session.token), () => f.expire(session.token)),
        401, "session_token_invalid", "expired_token");
      f.refused(await f.pgWait(roomId, () => f.send(roomId, session.participantId, session.token), async holder => {
        await holder.query("update rooms set session_control=session_control || jsonb_build_object('endedAt',now()::text) where room_id=$1", [roomId]);
      }), 403, "room_access_denied", "session_ended");
      await f.settled(roomId, true);
    });
    await c.test("both read-only COMMIT ACK losses preserve a queued genuine JWT and only count media completion", async () => {
      for (const persisted of [true, false]) {
        const roomId = persisted ? await f.createRoom("public") : randomUUID(), session = await f.state({ roomId });
        await f.issued(() => f.ackLost(persisted ? "legacy-state-token-ack-loss" : "state-token-ack-loss", roomId, session), roomId, session.participantId, session.token);
        await f.settled(roomId, persisted);
      }
    });
    await c.test("a pre-send SDK signer fault remains one request failure", async () => {
      for (const persisted of [true, false]) {
        const roomId = persisted ? await f.createRoom("public") : randomUUID(), session = await f.state({ roomId });
        await f.signFault(roomId, session); await f.settled(roomId, persisted); await f.both(roomId, session);
      }
    });
    await c.test("missing proof and a mismatched explicit subject keep their codec denial", async () => {
      const roomId = await f.createRoom("public"), session = await f.state({ roomId });
      f.refused(await h.request(MEDIA, "POST", {}, { roomId, participantId: session.participantId }), 401, "session_token_required", "missing_token");
      f.refused(await f.send(roomId, randomUUID(), session.token), 403, "session_token_invalid", "participant_mismatch");
      f.refused(await f.send(roomId, session.participantId, session.token, "bearer", { canPublishAudio: false }), 403, "forbidden", "media_publish_not_allowed");
    });
  });

  await t.test("owned floor-2 fixture", async c => {
    const h = await startAuthorHttpFixture(c, 2, true, false, undefined, { ttlSeconds: TTL }), f = media(h);
    async function personal(): Promise<AuthorHttpRoom> {
      const response = await h.request("/api/personal-room", "POST", {}, { identityProtocolVersion: 2, displayName: "Media owner" });
      assert.equal(response.status, 201);
      const owned = response.json<{ room: AuthorHttpRoom["room"]; identityCredential: string }>();
      const session = await h.admit(owned.room.roomId, { identityCredential: owned.identityCredential }); assert.equal(session.status, 200);
      return { room: owned.room, host: session.json<AuthorHttpSession>() };
    }
    await c.test("Host, Member and personal Owner keep namespaced grants and original RS2 deadlines over both transports", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), owned = await personal();
      for (const [roomId, session] of [[bound.room.roomId, bound.host], [bound.room.roomId, member], [owned.room.roomId, owned.host]] as const) {
        await f.both(roomId, session, true); await f.clipped(roomId, session, true);
      }
    });
    await c.test("a still-live RS2 proof whose prepared JWT expired is retryable", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      f.refused(await f.held("media-prepared", roomId, () => f.send(roomId, member.participantId, member.token), () => f.clock((TTL + 2) * 1000)),
        503, "media_credential_preparation_expired", "media_credential_preparation_expired");
      await f.both(roomId, member, true);
    });
    await c.test("video-only Host is supported while video-only Member is refused", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      await f.issued(() => f.send(roomId, bound.host.participantId, bound.host.token, "body", { canPublishAudio: false, canPublishVideo: true }),
        roomId, bound.host.participantId, bound.host.token, true);
      f.refused(await f.send(roomId, member.participantId, member.token, "bearer", { canPublishAudio: false, canPublishVideo: true }),
        403, "forbidden", "media_publish_not_allowed");
    });
    await c.test("RS2 expiry in body, actual signing and the final parent lock is identity_session_expired", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      for (const transport of TRANSPORTS) {
        f.refused(await f.body(roomId, member, transport, () => f.expire(member.token)), 401, "identity_session_expired", "identity_session_expired");
        for (const phase of ["media-sign", "media-prepared", "telemetry-effect"] as const) {
          f.refused(await f.held(phase, roomId, () => f.send(roomId, member.participantId, member.token, transport), () => f.expire(member.token)),
            401, "identity_session_expired", "identity_session_expired");
        }
        f.refused(await f.pgWait(roomId, () => f.send(roomId, member.participantId, member.token, transport), () => f.expire(member.token)),
          401, "identity_session_expired", "identity_session_expired");
      }
      await f.settled(roomId, true);
    });
    await c.test("RS2 lapse during awaited namespace resolution reaches the HTTP no-sign branch", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      const before = await h.mediaSignCount();
      f.refused(await f.held("media-namespace", roomId, () => f.send(roomId, member.participantId, member.token), () => f.expire(member.token)),
        401, "identity_session_expired", "identity_session_expired");
      assert.equal(await h.mediaSignCount(), before, "no call to the real SDK signer once the original proof has already lapsed");
    });
    await c.test("role/Owner drift after signing is recovery even though audio permission survives", async () => {
      const granted = await h.room(), member = await h.session(granted.room.roomId);
      f.refused(await f.held("media-prepared", granted.room.roomId, () => f.send(granted.room.roomId, member.participantId, member.token), () =>
        h.transition(granted, `presenters/${member.participantId}/grant`, member)), ...RECOVERY);
      await f.both(granted.room.roomId, member, true);
      const transferred = await h.room(), next = await h.session(transferred.room.roomId);
      f.refused(await f.held("media-prepared", transferred.room.roomId, () => f.send(transferred.room.roomId, transferred.host.participantId, transferred.host.token), () =>
        h.transition(transferred, "host/transfer", next)), ...RECOVERY);
      const owned = await personal(), heir = await h.session(owned.room.roomId);
      f.refused(await f.held("media-prepared", owned.room.roomId, () => f.send(owned.room.roomId, owned.host.participantId, owned.host.token), async () => {
        const current = await h.storage.roomIdentities.authority(owned.room); assert.ok(current);
        await f.admin(`${f.stem(owned.room.roomId)}/owner/transfer`, { participantId: heir.participantId, expectedRevision: current.revision });
      }), ...RECOVERY);
    });
    await c.test("an epoch revoke or deletion after signing never releases the prepared JWT", async () => {
      const bound = await h.room(), victim = await h.session(bound.room.roomId), proof = codec.verify(victim.token, bound.room); assert.ok(proof);
      f.refused(await f.held("media-prepared", bound.room.roomId, () => f.send(bound.room.roomId, victim.participantId, victim.token), () =>
        h.storage.roomIdentities.revoke(bound.room, proof.identityId, proof.authEpoch)), ...RECOVERY);
      const deleted = await h.room(), member = await h.session(deleted.room.roomId);
      f.refused(await f.held("media-prepared", deleted.room.roomId, () => f.send(deleted.room.roomId, member.participantId, member.token), () =>
        f.admin(f.stem(deleted.room.roomId), {}, "DELETE")), ...RECOVERY);
    });
    for (const change of ["disable", "end", "remove"] as const) {
      await c.test(`v2 ${change} after signing keeps its lifecycle refusal without a credential`, async () => {
        const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
        const response = await f.held("media-prepared", roomId, () => f.send(roomId, member.participantId, member.token), () =>
          change === "disable" ? f.admin(`${f.stem(roomId)}/disable`) : h.transition(bound, change === "end" ? "session-control/end" : `participants/${member.participantId}/remove`, member));
        f.refused(response, ...RECOVERY);
      });
    }
    await c.test("an RS2 read-only COMMIT ACK loss finishes its queued 200", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      await f.issued(() => f.ackLost("media-credential-ack-loss", roomId, member), roomId, member.participantId, member.token, true);
      await f.settled(roomId, true);
    });
    await c.test("RS2 pre-send signer failure counts no media completion", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId);
      await f.signFault(bound.room.roomId, member); await f.both(bound.room.roomId, member, true);
    });
  });

  for (const persisted of [true, false]) {
    await t.test(`owned floor-1 activation after real signing refuses ${persisted ? "persisted" : "virtual"} media`, async c => {
      const h = await startAuthorHttpFixture(c, 1, true, false, undefined, { ttlSeconds: TTL }), f = media(h);
      const roomId = persisted ? await f.createRoom("public") : randomUUID(), session = await f.state({ roomId });
      f.refused(await f.held("media-prepared", roomId, () => f.send(roomId, session.participantId, session.token), () => h.storage.identityProtocol.raise(2)),
        409, "identity_required", "identity_upgrade_required");
      assert.equal(await h.storage.identityProtocol.minimum(), 2, "only this disposable schema activated");
      await f.settled(roomId, persisted);
    });
  }
  for (const ttlSeconds of [0, 1.5, 86_401]) {
    await t.test(`owned floor-1 invalid configured TTL ${ttlSeconds} is a fixed 503, not a signer exception`, async c => {
      const h = await startAuthorHttpFixture(c, 1, true, false, undefined, { ttlSeconds }), f = media(h);
      const roomId = await f.createRoom("public"), session = await f.state({ roomId }), before = await f.counters();
      f.refused(await f.send(roomId, session.participantId, session.token), 503, "livekit_config_invalid", "media_token_ttl_invalid");
      assert.deepEqual(await f.counters(), before, "invalid config releases no credential and creates no unhandled signer or completion failure");
    });
  }
});
