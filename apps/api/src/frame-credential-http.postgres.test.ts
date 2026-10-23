import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { PoolClient } from "pg";
import { decodeRemoteBrowserFrameToken, type RemoteBrowserFrameBinding } from "@vrata/shared-types/remote-browser-frame-token";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { AUTHOR_HTTP_FRAME_SECRET, AUTHOR_HTTP_INTERNAL_TOKEN, AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, until,
  type AuthorHttpResponse, type AuthorHttpRoom, type AuthorHttpSession } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const FRAME = "/api/tokens/remote-browser-frame";
const VERIFY = "/api/internal/remote-browser/bindings/verify";
const TTL = 120;
const SHAPE = "expiresInSeconds,frameStreamUrl,token";
const KEYS = ["roomId", "objectId", "executorSessionId", "executorInstanceId", "frameStreamId"] as const;
const COUNTERS = ["vrata_api_frame_credential_release_completion_failures_total", "vrata_api_legacy_state_release_completion_failures_total",
  "vrata_api_virtual_state_release_completion_failures_total", "vrata_api_request_failures_total"];
const REQUIRED = ["remote_browser_frame_token_payload_required"];
const BINDING = ["invalid_session_binding"];
const EITHER = [...REQUIRED, ...BINDING];
const RECOVERY = [409, "identity_required", "identity_recovery_required"] as const;
const OTHER_TENANT = "frame-credential-other-tenant";
const TRANSPORTS = ["bearer", "body"] as const;
const PREFIX = "remote-browser:browser-1:instance:";
const codec = createRoomSessionV2Codec(AUTHOR_HTTP_SECRET);
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Authority = Awaited<ReturnType<typeof bindingAuthority>>;
type Transport = typeof TRANSPORTS[number];
type Claims = Record<string, unknown>;
type Send = () => Promise<AuthorHttpResponse>;

const part = (token: string, index: number) => JSON.parse(Buffer.from(token.split(".")[index] ?? "", "base64url").toString("utf8")) as Claims;
/** The original proof deadline: the RS2 expiresAtSeconds or the floor-1 MAC exp. Never printed. */
const deadline = (token: string) => Number(token.startsWith("rs2.") ? part(token, 1).expiresAtSeconds : part(token, 0).exp);
const subject = (token: string) => String(part(token, 0).participantId);
const scopeKey = (value: Claims) => JSON.stringify(KEYS.map(key => value[key]));
function scope(roomId: string, objectId = "browser-1", generation = "generation-1"): RemoteBrowserFrameBinding {
  const session = `remote-browser:${objectId}`;
  return { roomId, objectId, executorSessionId: session, executorInstanceId: `${session}:instance:${generation}`, frameStreamId: `${session}:frames` };
}

/** Refused bodies with the existing codes each may produce. A missing field is payload_required; a present but
 * mis-scoped, oversized or control-character field is invalid_session_binding; empty or mistyped values may be either. */
function malformed(roomId: string): Array<readonly [readonly string[], Claims]> {
  const valid: Claims = { ...scope(roomId) };
  const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
  const binding = (patch: Claims) => [BINDING, { ...valid, ...patch }] as const;
  return [
    [REQUIRED, {}], ...KEYS.map(key => [REQUIRED, without(key)] as const), ...KEYS.map(key => [EITHER, { ...valid, [key]: "" }] as const),
    binding({ executorSessionId: "remote-browser:browser-2" }), binding({ executorSessionId: "browser-1" }),
    binding({ frameStreamId: "remote-browser:browser-1:frame" }), binding({ frameStreamId: "remote-browser:browser-1:media" }),
    binding({ frameStreamId: "remote-browser:browser-2:frames" }), binding({ executorInstanceId: PREFIX }),
    binding({ executorInstanceId: "remote-browser:browser-2:instance:generation-1" }), binding({ executorInstanceId: "generation-1" }),
    binding({ roomId: "r".repeat(201) }), binding({ roomId: `${roomId}\u0000` }),
    binding({ executorInstanceId: `${PREFIX}${"i".repeat(513 - PREFIX.length)}` }), binding({ executorInstanceId: `${PREFIX}generation\u0007` }),
    [BINDING, { ...scope(roomId, "o".repeat(201)) }], [BINDING, { ...scope(roomId, "browser\n1") }],
    [EITHER, { ...scope(roomId, "7"), objectId: 7 }], [EITHER, { ...valid, roomId: 7 }],
    [EITHER, { ...valid, executorInstanceId: [valid.executorInstanceId] }], [EITHER, { ...valid, frameStreamId: { id: valid.frameStreamId } }]
  ];
}

/** The owned room-state binding authority: a loopback server answering the exact verify RPC with 200, parked on demand.
 * It records booleans and the binding scope only, never the service token header. */
async function bindingAuthority(t: TestContext) {
  const parked: Array<() => void> = [];
  const seen: Array<{ post: boolean; authorized: boolean; scope: string }> = [];
  let holding = false, other = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const reply = () => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); };
      if (request.url !== VERIFY) { other += 1; reply(); return; }
      let body: Claims = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Claims; } catch { body = {}; }
      seen.push({ post: request.method === "POST", authorized: request.headers["x-vrata-internal-token"] === AUTHOR_HTTP_INTERNAL_TOKEN,
        scope: scopeKey(body) });
      if (holding) parked.push(reply); else reply();
    });
  });
  const release = () => { holding = false; for (const reply of parked.splice(0)) reply(); };
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, other: () => other,
    hold: () => { holding = true; }, parked: () => parked.length, release };
}

/** Native HTTP vocabulary for one owned fixture. Assertions compare decoded claims, scalars and booleans;
 * a raw token, URL, invite or secret never reaches a failure message. */
function frames(h: Fixture, authority: Authority) {
  let offset = 0;
  const clock = async (ms: number) => { offset = ms; await h.clock(ms); };
  /** The child clock in whole seconds; the parent shifts it only through clock(). */
  const now = () => Math.floor((Date.now() + offset) / 1000);
  const expire = (token: string) => clock(deadline(token) * 1000 - Date.now() + 1000);
  const remaining = (token: string, seconds: number) => clock(deadline(token) * 1000 - Date.now() - seconds * 1000);
  const stem = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
  const send = (transport: Transport, token: string, body: unknown, headers: Record<string, string> = {}) => h.request(FRAME, "POST",
    { ...(transport === "bearer" ? authorHttpBearer(token) : {}), ...headers }, transport === "body" ? { ...(body as Claims), sessionToken: token } : body);
  async function admin(path: string, body: unknown = {}, method = "POST") {
    const response = await h.request(path, method, h.adminHeaders, body);
    assert.equal(response.status, 200, `administrative ${method} must succeed; received HTTP ${response.status}`); return response;
  }
  async function createRoom(visibility: "public" | "private", roomId: string = randomUUID(), tenantId = "demo-tenant") {
    const response = await h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId, templateId: "meeting-room-basic",
      name: "Frame credential room", visibility, guestAllowed: visibility === "public" });
    assert.equal(response.status, 201, "the room is created over HTTP"); return roomId;
  }
  const remove = async (roomId: string) => assert.equal((await h.request(stem(roomId), "DELETE", h.adminHeaders)).status, 200, "the room is deleted over HTTP");
  async function stateToken(body: Claims): Promise<string> {
    const response = await h.request("/api/tokens/state", "POST", {}, { displayName: "Frame viewer", ...body });
    assert.equal(response.status, 200, `the floor-1 proof is issued over HTTP; received HTTP ${response.status}`);
    const token = response.json<Claims>().token;
    assert.equal(typeof token === "string" && token.split(".").length === 2 && !token.startsWith("rs2."), true, "a floor-1 MAC proof");
    return token as string;
  }
  async function present(roomId: string, token: string) {
    const participantId = subject(token);
    assert.equal((await h.request(`${stem(roomId)}/presence/${participantId}`, "PUT", authorHttpBearer(token),
      { participantId, displayName: "Present viewer", updatedAt: new Date().toISOString() })).status, 200, "the target needs real HTTP presence");
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
  /** One released credential: reply shape, the same URL token, the real decoder under the dedicated secret only, the exact
   * binding verified by the owned authority, and exp = min(signing clock + TTL, original proof exp). */
  async function issued(request: Send, binding: RemoteBrowserFrameBinding, proofExp: number) {
    const calls = authority.seen.length, before = now();
    const response = await request();
    const after = now();
    assert.equal(response.status, 200, `expected a frame credential; received HTTP ${response.status}`);
    const body = response.json<Claims>();
    assert.equal(Object.keys(body).sort().join(), SHAPE, "the frame reply shape is unchanged");
    assert.equal(JSON.stringify(body) === response.bytes.toString("utf8"), true, "the whole reply is exactly one serialized body");
    const token = typeof body.token === "string" ? body.token : "";
    let streamToken: string | null;
    try { streamToken = new URL(String(body.frameStreamUrl)).searchParams.get("token"); } catch { streamToken = null; }
    assert.equal(token.length > 0 && streamToken === token, true, "the stream URL carries exactly the released token");
    for (const key of [AUTHOR_HTTP_SECRET, "dev-remote-browser-secret"]) {
      assert.equal(decodeRemoteBrowserFrameToken(token, key, { nowSeconds: before }), null, "only the dedicated frame secret verifies");
    }
    const claims = decodeRemoteBrowserFrameToken(token, AUTHOR_HTTP_FRAME_SECRET, { nowSeconds: before });
    assert.ok(claims, "the shared v2 decoder accepts the MAC under the dedicated fixture secret");
    assert.deepEqual({ ...claims, exp: 0 }, { v: 2, ...binding, exp: 0 }, "exactly the requested binding; no role, owner or identity claim");
    const lifetime = Number(body.expiresInSeconds), signedAt = claims.exp - lifetime;
    assert.equal(Number.isSafeInteger(lifetime) && lifetime >= 1 && lifetime <= TTL, true, "a bounded integer lifetime");
    assert.equal(signedAt >= before && signedAt <= after, true, "expiresInSeconds is the remaining lifetime at the signing clock");
    assert.equal(claims.exp === Math.min(signedAt + TTL, proofExp), true, "exp = min(signing clock + TTL, original proof exp)");
    const verified = authority.seen.slice(calls);
    assert.equal(verified.length > 0 && verified.every(call => call.post && call.authorized && call.scope === scopeKey({ ...binding })), true,
      "the owned authority verified this exact binding with the fixture service token");
    return { exp: claims.exp, lifetime };
  }
  async function both(roomId: string, token: string) {
    for (const transport of TRANSPORTS) {
      const binding = scope(roomId, "browser-1", `generation-${transport}`);
      const { lifetime } = await issued(() => send(transport, token, binding), binding, deadline(token));
      assert.equal(lifetime, TTL, "a fresh proof gets the full configured TTL");
    }
  }
  async function clipped(roomId: string, token: string) {
    for (const transport of TRANSPORTS) {
      try {
        await remaining(token, 7);
        const binding = scope(roomId);
        const { exp, lifetime } = await issued(() => send(transport, token, binding), binding, deadline(token));
        assert.equal(exp === deadline(token) && lifetime <= 7, true, "exp is the original proof exp; expiresInSeconds is its remainder");
      } finally { await clock(0); }
    }
  }
  function refused(response: AuthorHttpResponse, status: number, error?: string, reason?: string) {
    assert.equal(response.status, status, `expected HTTP ${status}${error === undefined ? "" : ` ${error}`}; received HTTP ${response.status}`);
    const text = response.bytes.toString("utf8");
    let body: Claims;
    try { body = JSON.parse(text) as Claims; } catch { body = {}; }
    if (error !== undefined) assert.equal(body.error === error, true, `expected error ${error}`);
    if (reason !== undefined) assert.equal(body.reason === reason, true, `expected reason ${reason}`);
    assert.equal(["token", "frameStreamUrl", "expiresInSeconds"].some(key => key in body) || text.includes("?token=")
      || text.includes(AUTHOR_HTTP_FRAME_SECRET) || text.includes(AUTHOR_HTTP_INTERNAL_TOKEN), false, "a refusal carries no frame credential or fixture secret");
  }
  async function rejectsMalformed(roomId: string, token: string) {
    const before = [authority.seen.length, ...await counters()];
    for (const [index, [expected, body]] of malformed(roomId).entries()) {
      for (const transport of TRANSPORTS) {
        const response = await send(transport, token, body); refused(response, 400);
        assert.equal(expected.includes(String(response.json<Claims>().error)), true, `case ${index} (${transport}): expected ${expected.join(" or ")}`);
      }
    }
    for (const [index, body] of ([[], "frame", 7, true, null] as const).entries()) {
      const response = await send("bearer", token, body); refused(response, 400);
      assert.equal(EITHER.includes(String(response.json<Claims>().error)), true, `non-object case ${index}`);
    }
    assert.deepEqual([authority.seen.length, ...await counters()], before, "no binding RPC, completion or request failure");
  }
  /** Parks the body after the server observed it, applies change, then delivers the last byte. */
  async function heldBody(transport: Transport, token: string, binding: RemoteBrowserFrameBinding, change: () => Promise<unknown>) {
    const stalled = h.stalled(FRAME, transport === "bearer" ? token : {},
      Buffer.from(JSON.stringify(transport === "body" ? { ...binding, sessionToken: token } : binding)));
    try { await stalled.admitted(); await change(); stalled.finish(); return await stalled.response; }
    finally { stalled.destroy(); await clock(0); }
  }
  /** Parks the actual binding RPC on the owned authority; release and clock reset always run. */
  async function rpc(request: Send, change: () => Promise<unknown>) {
    authority.hold();
    const pending = request(); void pending.catch(() => undefined);
    try {
      // The API aborts the RPC after 5 s, so change must be prompt.
      await until(async () => authority.parked() === 1, "the binding RPC is parked on the owned authority");
      await change(); authority.release(); return await pending;
    } finally { authority.release(); await clock(0); await pending.catch(() => undefined); }
  }
  /** Holds one request at its release entry (after classification and the binding RPC, before the fence). */
  async function fenced(roomId: string, request: Send, change: () => Promise<unknown>) {
    const id = await h.arm("telemetry-effect", roomId);
    const pending = request(); void pending.catch(() => undefined);
    try { await h.phase(id, "telemetry-effect"); await change(); await h.resume(); return await pending; }
    finally { await clock(0); await h.resume(); await pending.catch(() => undefined); }
  }
  /** The final fence queues behind an actual parent-row FOR UPDATE; change runs on the holder before its COMMIT. */
  async function pgWait(roomId: string, request: Send, change: (holder: PoolClient) => Promise<void>) {
    try { return await h.held(roomId, request, change); } finally { await clock(0); }
  }
  /** Arms an actual-COMMIT acknowledgement loss, queues the 200 reply's end() and returns it once flushed. */
  async function ackLost(phase: "legacy-state-token-ack-loss" | "state-token-ack-loss" | "frame-credential-ack-loss", roomId: string, token: string,
    binding: RemoteBrowserFrameBinding) {
    const [frame] = await counters();
    const holdId = randomUUID(), faultId = await h.arm(phase, roomId);
    const pending = send("bearer", token, binding, { "x-author-hold-state-reply": holdId }); void pending.catch(() => undefined);
    try {
      // send() returned with its body queued; the actual COMMIT then ran and only its reply was dropped.
      await h.stateReplyBuffered(holdId); await h.phase(faultId, phase);
      await until(async () => (await counters())[0] === frame + 1, "the frame completion failure is counted while the reply is still queued");
      await h.flushStateReplies(); return await pending;
    } finally { await h.flushStateReplies(); await pending.catch(() => undefined); }
  }
  /** A one-shot signer fault under the fixture frame key only: the state MAC still signs while it is armed. */
  async function signFault(roomId: string, token: string, mintState: () => Promise<unknown>) {
    const before = await counters();
    const id = await h.arm("frame-sign-fault", roomId);
    try {
      await mintState();
      const response = await send("bearer", token, scope(roomId));
      refused(response, 500, "internal_error");
      await h.phase(id, "frame-sign-fault");
    } finally { await h.arm("room-read", `disarmed-${randomUUID()}`); }
    assert.deepEqual(await counters(), [before[0], before[1], before[2], before[3] + 1],
      "a pre-send signer failure is one request failure, never a post-send completion");
  }
  async function settled(roomId: string, persisted: boolean) {
    const open = await h.pool.query(`select count(*)::int as open from pg_stat_activity
      where application_name=$1 and state like 'idle in transaction%'`, [h.schema]);
    assert.equal(open.rows[0].open, 0, "the release transaction ended");
    const probe = await h.pool.connect();
    try {
      await probe.query("begin"); await probe.query("set local lock_timeout='2s'");
      if (persisted) assert.equal((await probe.query("select 1 from rooms where room_id=$1 for update", [roomId])).rowCount, 1, "no room row lock survives");
      // EXCLUSIVE conflicts with a surviving virtual SHARE pin.
      else await probe.query("lock table rooms in exclusive mode");
    } finally { await probe.query("rollback").catch(() => undefined); probe.release(); }
  }
  return { clock, expire, stem, send, admin, createRoom, remove, stateToken, present, counters, issued, both, clipped, refused,
    rejectsMalformed, heldBody, rpc, fenced, pgWait, ackLost, signFault, settled };
}

test("remote-browser frame credentials are bound, fenced and freshly signed over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture", async c => {
    const authority = await bindingAuthority(c);
    const h = await startAuthorHttpFixture(c, 1, true, false, { authorityUrl: authority.url });
    const f = frames(h, authority);
    assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: OTHER_TENANT, name: "Other frame tenant" })).status, 201);

    await c.test("public guest, private trusted Host and Member, and virtual guest proofs mint over Bearer and body", async () => {
      const publicRoom = await f.createRoom("public"), privateRoom = await f.createRoom("private"), virtualRoom = randomUUID();
      const proofs: Array<[string, string]> = [
        [publicRoom, await f.stateToken({ roomId: publicRoom })],
        [privateRoom, await f.stateToken({ roomId: privateRoom, inviteToken: (await h.invite(privateRoom, "host")).inviteToken })],
        [privateRoom, await f.stateToken({ roomId: privateRoom, inviteToken: (await h.invite(privateRoom, "member")).inviteToken })],
        [virtualRoom, await f.stateToken({ roomId: virtualRoom, participantId: randomUUID() })]];
      assert.deepEqual(proofs.map(([, token]) => [part(token, 0).role, part(token, 0).roleSource]),
        [["guest", "default"], ["host", "trusted"], ["member", "trusted"], ["guest", "default"]], "the four floor-1 proof sources");
      for (const [roomId, token] of proofs) await f.both(roomId, token);
      const edge = scope(publicRoom, "o".repeat(200), "i".repeat(512 - `remote-browser:${"o".repeat(200)}:instance:`.length));
      assert.equal(edge.executorInstanceId.length, 512);
      await f.issued(() => f.send("bearer", proofs[0][1], edge), edge, deadline(proofs[0][1]));
      assert.equal(await h.storage.getRoom(virtualRoom), null, "a virtual frame credential never materializes a room");
    });

    await c.test("a genuine proof with 7 s left clips exp to its original MAC exp over Bearer and body", async () => {
      const roomId = await f.createRoom("public"), virtualRoom = randomUUID();
      await f.clipped(roomId, await f.stateToken({ roomId }));
      await f.clipped(virtualRoom, await f.stateToken({ roomId: virtualRoom, participantId: randomUUID() }));
    });

    await c.test("malformed scope, namespace, controls, lengths and types are 400 before any binding RPC", async () => {
      const roomId = await f.createRoom("public");
      await f.rejectsMalformed(roomId, await f.stateToken({ roomId }));
    });

    await c.test("a proof expiring in the held body, the held binding RPC or the parent-row wait is 401 expired_token", async () => {
      const roomId = await f.createRoom("public"), virtualRoom = randomUUID();
      const guest = await f.stateToken({ roomId });
      const proofs: Array<[string, string]> = [[roomId, guest], [virtualRoom, await f.stateToken({ roomId: virtualRoom, participantId: randomUUID() })]];
      const before = await f.counters();
      for (const [room, token] of proofs) for (const transport of TRANSPORTS) {
        f.refused(await f.heldBody(transport, token, scope(room), () => f.expire(token)), 401, undefined, "expired_token");
        f.refused(await f.rpc(() => f.send(transport, token, scope(room)), () => f.expire(token)), 401, undefined, "expired_token");
      }
      for (const transport of TRANSPORTS) {
        f.refused(await f.pgWait(roomId, () => f.send(transport, guest, scope(roomId)), () => f.expire(guest)), 401, undefined, "expired_token");
      }
      assert.deepEqual(await f.counters(), before, "pre-send expiry counts no completion or request failure");
      await f.settled(roomId, true);
    });

    await c.test("an uncommitted session end on the held parent row is observed by the final release", async () => {
      const roomId = await f.createRoom("public"), guest = await f.stateToken({ roomId });
      f.refused(await f.pgWait(roomId, () => f.send("bearer", guest, scope(roomId)), async holder => {
        await holder.query(`update rooms set session_control=coalesce(session_control,'{}'::jsonb) || jsonb_build_object('endedAt',$2::text)
          where room_id=$1`, [roomId, new Date().toISOString()]);
      }), 403, "room_access_denied", "session_ended");
      await f.settled(roomId, true);
    });

    for (const [reason, path] of [["room_disabled", "disable"], ["session_ended", "session-control/end"],
      ["participant_removed", "participants/:id/remove"]] as const) {
      await c.test(`${reason} while the release is held before its fence denies 403 with no credential`, async () => {
        for (const transport of TRANSPORTS) {
          const roomId = await f.createRoom("public"), guest = await f.stateToken({ roomId });
          const before = await f.counters();
          f.refused(await f.fenced(roomId, () => f.send(transport, guest, scope(roomId)),
            () => f.admin(`${f.stem(roomId)}/${path.replace(":id", subject(guest))}`)), 403, "room_access_denied", reason);
          assert.deepEqual(await f.counters(), before, "a refusal before send counts nothing");
        }
      });
    }

    await c.test("a current Host or Presenter drift while held before the fence is 409 room_state_changed", async () => {
      for (const target of ["presenter", "host"] as const) {
        const roomId = await f.createRoom("public");
        const held = await f.stateToken(target === "presenter" ? { roomId } : { roomId, inviteToken: (await h.invite(roomId, "host")).inviteToken });
        const other = target === "presenter" ? held : await f.stateToken({ roomId });
        await f.present(roomId, other);
        f.refused(await f.fenced(roomId, () => f.send("bearer", held, scope(roomId)), () => target === "presenter"
          ? f.admin(`${f.stem(roomId)}/presenters/${subject(other)}/grant`)
          : f.admin(`${f.stem(roomId)}/host/transfer`, { participantId: subject(other) })), 409, "room_state_changed", "room_state_changed");
      }
    });

    await c.test("a room created, deleted, replaced or made private during the binding RPC is refused with no fallback", async () => {
      const before = await f.counters();
      const virtualRoom = randomUUID(), early = await f.stateToken({ roomId: virtualRoom, participantId: randomUUID() });
      f.refused(await f.rpc(() => f.send("bearer", early, scope(virtualRoom)), () => f.createRoom("private", virtualRoom)),
        409, "room_state_changed", "room_state_changed");
      f.refused(await f.send("body", early, scope(virtualRoom)), 403, "room_access_denied", "invite_required");
      const deleted = await f.createRoom("public"), guest = await f.stateToken({ roomId: deleted });
      f.refused(await f.rpc(() => f.send("body", guest, scope(deleted)), () => f.remove(deleted)), 404, "room_not_found");
      assert.equal(await h.storage.getRoom(deleted), null, "no virtual fallback materialized the deleted room");
      const replaced = await f.createRoom("public"), tenantGuest = await f.stateToken({ roomId: replaced });
      f.refused(await f.rpc(() => f.send("bearer", tenantGuest, scope(replaced)), async () => {
        await f.remove(replaced); await f.createRoom("public", replaced, OTHER_TENANT);
      }), 404, "room_not_found");
      const closing = await f.createRoom("public"), defaultGuest = await f.stateToken({ roomId: closing });
      f.refused(await f.rpc(() => f.send("bearer", defaultGuest, scope(closing)), () => f.admin(f.stem(closing), { visibility: "private" }, "PATCH")),
        403, "room_access_denied", "invite_required");
      assert.deepEqual(await f.counters(), before, "no completion or request failure");
    });

    await c.test("a trusted private proof still renews after its invite is revoked (explicit deferral, not proof revocation)", async () => {
      const roomId = await f.createRoom("private"), issued = await h.invite(roomId, "member");
      const member = await f.stateToken({ roomId, inviteToken: issued.inviteToken });
      await f.admin(`${f.stem(roomId)}/invites/${issued.inviteId}/revoke`);
      await f.both(roomId, member);
    });

    for (const kind of ["persisted", "virtual"] as const) {
      await c.test(`a released ${kind} frame reply completes its buffered 200 when only the COMMIT acknowledgement is lost`, async () => {
        const roomId = kind === "persisted" ? await f.createRoom("public") : randomUUID();
        const token = await f.stateToken(kind === "persisted" ? { roomId } : { roomId, participantId: randomUUID() });
        const binding = scope(roomId), [frame, legacy, virtual, failures] = await f.counters();
        await f.issued(() => f.ackLost(kind === "persisted" ? "legacy-state-token-ack-loss" : "state-token-ack-loss", roomId, token, binding),
          binding, deadline(token));
        assert.deepEqual(await f.counters(), [frame + 1, legacy, virtual, failures], "only the frame completion counter moved, once");
        await f.settled(roomId, kind === "persisted");
      });
    }

    await c.test("a pre-send frame signer failure is a request failure, never a counted post-send completion", async () => {
      for (const kind of ["persisted", "virtual"] as const) {
        const roomId = kind === "persisted" ? await f.createRoom("public") : randomUUID();
        const stateBody = () => kind === "persisted" ? { roomId } : { roomId, participantId: randomUUID() };
        await f.signFault(roomId, await f.stateToken(stateBody()), () => f.stateToken(stateBody()));
        await f.settled(roomId, kind === "persisted");
        await f.both(roomId, await f.stateToken(stateBody()));
      }
    });
  });

  await t.test("owned floor-2 fixture", async c => {
    const authority = await bindingAuthority(c);
    const h = await startAuthorHttpFixture(c, 2, true, false, { authorityUrl: authority.url });
    const f = frames(h, authority);
    async function admitted(roomId: string, identityCredential: string): Promise<AuthorHttpSession> {
      const response = await h.admit(roomId, { identityCredential });
      assert.equal(response.status, 200, "the RS2 proof is issued over the real token route");
      return response.json<AuthorHttpSession>();
    }
    async function personal(): Promise<AuthorHttpRoom> {
      const created = await h.request("/api/personal-room", "POST", {}, { identityProtocolVersion: 2, displayName: "Frame owner" });
      assert.equal(created.status, 201, "the personal room is created over HTTP");
      const owned = created.json<{ room: AuthorHttpRoom["room"]; identityCredential: string }>();
      return { room: owned.room, host: await admitted(owned.room.roomId, owned.identityCredential) };
    }

    await c.test("bound Host and Member and a personal Owner as Host or as Member mint over Bearer and body", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId);
      const owned = await personal(), heir = await h.session(owned.room.roomId);
      assert.deepEqual([bound.host.role, bound.host.isOwner, member.role, member.isOwner, owned.host.role, owned.host.isOwner],
        ["host", false, "member", false, "host", true], "native roles and ownership");
      for (const [roomId, token] of [[bound.room.roomId, bound.host.token], [bound.room.roomId, member.token], [owned.room.roomId, owned.host.token]]) {
        await f.both(roomId, token);
      }
      await h.transition(owned, "host/transfer", heir);
      const demoted = await admitted(owned.room.roomId, owned.host.identityCredential);
      assert.deepEqual([demoted.role, demoted.isOwner], ["member", true], "ownership is independent of the Host role");
      await f.both(owned.room.roomId, demoted.token);
    });

    await c.test("an RS2 proof with 7 s left clips exp to its original deadline over Bearer and body", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId);
      await f.clipped(bound.room.roomId, member.token);
    });

    await c.test("malformed scope, namespace, controls, lengths and types are 400 before any binding RPC", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId);
      await f.rejectsMalformed(bound.room.roomId, member.token);
    });

    await c.test("an RS2 deadline reached in the held body, the held binding RPC or the parent-row wait is 401 identity_session_expired", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      const before = await f.counters();
      for (const transport of TRANSPORTS) {
        f.refused(await f.heldBody(transport, member.token, scope(roomId), () => f.expire(member.token)), 401, "identity_session_expired", "identity_session_expired");
        f.refused(await f.rpc(() => f.send(transport, member.token, scope(roomId)), () => f.expire(member.token)),
          401, "identity_session_expired", "identity_session_expired");
        f.refused(await f.pgWait(roomId, () => f.send(transport, member.token, scope(roomId)), () => f.expire(member.token)),
          401, "identity_session_expired", "identity_session_expired");
      }
      assert.deepEqual(await f.counters(), before, "pre-send expiry counts no completion or request failure");
      const response = await f.pgWait(roomId, () => f.send("bearer", member.token, scope(roomId)), async holder => {
        await holder.query("update rooms set status='disabled', disabled_at=now() where room_id=$1", [roomId]);
      });
      assert.equal(response.status === 403 || response.status === 409, true, `an uncommitted disable is observed; received HTTP ${response.status}`);
      f.refused(response, response.status);
      await f.settled(roomId, true);
    });

    await c.test("a role, Owner or epoch change after the binding RPC is 409 recovery although surface.view survives", async () => {
      const granted = await h.room(), member = await h.session(granted.room.roomId);
      f.refused(await f.rpc(() => f.send("bearer", member.token, scope(granted.room.roomId)),
        () => h.transition(granted, `presenters/${member.participantId}/grant`, member)), ...RECOVERY);
      // Not a permission loss: a new request resolves the live Presenter role and mints from the same proof.
      await f.both(granted.room.roomId, member.token);
      const transferred = await h.room(), next = await h.session(transferred.room.roomId);
      f.refused(await f.rpc(() => f.send("body", transferred.host.token, scope(transferred.room.roomId)),
        () => h.transition(transferred, "host/transfer", next)), ...RECOVERY);
      const owned = await personal(), heir = await h.session(owned.room.roomId);
      f.refused(await f.rpc(() => f.send("bearer", owned.host.token, scope(owned.room.roomId)), async () => {
        const current = await h.storage.roomIdentities.authority(owned.room); assert.ok(current);
        assert.equal((await h.request(`${f.stem(owned.room.roomId)}/owner/transfer`, "POST", h.adminHeaders,
          { participantId: heir.participantId, expectedRevision: current.revision })).status, 200, "the real Owner handoff succeeds");
      }), ...RECOVERY);
      const revoked = await h.room(), victim = await h.session(revoked.room.roomId);
      const proof = codec.verify(victim.token, revoked.room); assert.ok(proof, "the fixture RS2 verifies");
      f.refused(await f.rpc(() => f.send("body", victim.token, scope(revoked.room.roomId)),
        () => h.storage.roomIdentities.revoke(revoked.room, proof.identityId, proof.authEpoch)), ...RECOVERY);
    });

    for (const change of ["remove", "end", "disable"] as const) {
      await c.test(`a ${change} after the binding RPC is refused through the existing 403 or 409 map with no credential`, async () => {
        const bound = await h.room(), member = await h.session(bound.room.roomId), before = await f.counters();
        const response = await f.rpc(() => f.send("bearer", member.token, scope(bound.room.roomId)), () => change === "remove"
          ? h.transition(bound, `participants/${member.participantId}/remove`, member)
          : change === "end" ? h.transition(bound, "session-control/end") : f.admin(`${f.stem(bound.room.roomId)}/disable`));
        assert.equal(response.status === 403 || response.status === 409, true, `expected 403 or 409; received HTTP ${response.status}`);
        f.refused(response, response.status);
        assert.deepEqual(await f.counters(), before, "a refusal before send counts nothing");
      });
    }

    await c.test("a pre-send RS2 frame signer failure is a request failure, never a counted post-send completion", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId);
      await f.signFault(bound.room.roomId, member.token, () => admitted(bound.room.roomId, member.identityCredential));
      await f.settled(bound.room.roomId, true);
      await f.both(bound.room.roomId, member.token);
    });

    await c.test("a released RS2 frame reply completes its buffered 200 when only the COMMIT acknowledgement is lost", async () => {
      const bound = await h.room(), member = await h.session(bound.room.roomId), roomId = bound.room.roomId;
      const binding = scope(roomId), [frame, legacy, virtual, failures] = await f.counters();
      await f.issued(() => f.ackLost("frame-credential-ack-loss", roomId, member.token, binding), binding, deadline(member.token));
      assert.deepEqual(await f.counters(), [frame + 1, legacy, virtual, failures], "only the frame completion counter moved, once");
      await f.settled(roomId, true);
    });
  });

  // A fresh schema per case: once raised, the floor-1 MAC is refused before any later release could be held.
  for (const [kind, transport] of [["persisted", "bearer"], ["virtual", "body"]] as const) {
    await t.test(`owned floor-1 fixture raised to floor 2 during the held binding RPC refuses the ${kind} release`, async c => {
      const authority = await bindingAuthority(c);
      const h = await startAuthorHttpFixture(c, 1, true, false, { authorityUrl: authority.url });
      const f = frames(h, authority);
      const roomId = kind === "persisted" ? await f.createRoom("public") : randomUUID();
      const token = await f.stateToken(kind === "persisted" ? { roomId } : { roomId, participantId: randomUUID() });
      const before = await f.counters();
      f.refused(await f.rpc(() => f.send(transport, token, scope(roomId)), () => h.storage.identityProtocol.raise(2)),
        409, "identity_required", "identity_upgrade_required");
      assert.equal(await h.storage.identityProtocol.minimum(), 2, "the owned schema floor was raised by the native activation");
      assert.deepEqual(await f.counters(), before, "a refusal before send counts nothing");
      if (kind === "virtual") assert.equal(await h.storage.getRoom(roomId), null, "no room materialized");
      await f.settled(roomId, kind === "persisted");
    });
  }
});
