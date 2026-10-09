import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const codec = createRoomSessionV2Codec(AUTHOR_HTTP_SECRET);
const PRIVATE_LABEL = "fixture-private-virtual";
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Phase = Parameters<Fixture["arm"]>[0];
type Items = { items: Array<{ participantId: string }> };
interface LegacyActor { roomId: string; participantId: string; token: string; role: string; exp: number }

/** Native HTTP vocabulary for one owned fixture. Failure messages carry phases and scalars only. */
function virtualHttp(h: Fixture) {
  const stem = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
  async function issue(roomId: string = randomUUID(), extra: Record<string, unknown> = {}): Promise<LegacyActor> {
    const participantId = randomUUID();
    const response = await h.request("/api/tokens/state", "POST", {}, { roomId, participantId, displayName: "Virtual participant", ...extra });
    assert.equal(response.status, 200, "the floor-1 state token must be issued over HTTP");
    const { token, role } = response.json<{ token: string; role: string }>();
    const parts = token.split(".");
    assert.equal(parts.length === 2 && !token.startsWith("rs2."), true, "a floor-1 state token is body.signature, not a JWT or rs2 token");
    const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    assert.equal(claims.roomId === roomId && claims.participantId === participantId && Number.isSafeInteger(claims.exp), true,
      "the signed body binds the requested room and participant");
    return { roomId, participantId, token, role, exp: claims.exp as number };
  }
  async function createRoom(roomId: string, visibility: "public" | "private" = "public") {
    const response = await h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic",
      name: "Persisted legacy room", visibility, guestAllowed: visibility === "public" });
    assert.equal(response.status, 201, "the actual room must be created over HTTP");
  }
  const expiry = (actor: LegacyActor) => actor.exp * 1000 - Date.now() + 10;
  const presence = (actor: LegacyActor, method: "PUT" | "DELETE") => h.request(`${stem(actor.roomId)}/presence/${actor.participantId}`, method,
    authorHttpBearer(actor.token), method === "PUT" ? { participantId: actor.participantId, displayName: "Virtual participant", updatedAt: new Date().toISOString() } : undefined);
  const listPresence = (roomId: string, headers: Record<string, string> = {}) => h.request(`${stem(roomId)}/presence`, "GET", headers);
  const xrHistory = (roomId: string, token: string) => h.request(`${stem(roomId)}/xr-telemetry`, "GET", authorHttpBearer(token));
  const write = (actor: LegacyActor, kind: "diagnostics" | "significant" | "idle", label = PRIVATE_LABEL, requestId = randomUUID()) => kind === "diagnostics"
    ? h.request(`${stem(actor.roomId)}/diagnostics`, "POST", { ...authorHttpBearer(actor.token), "x-request-id": requestId },
      { participantId: actor.participantId, issueCode: label, note: "screenshare_started" })
    : h.request(`${stem(actor.roomId)}/xr-telemetry/${actor.participantId}`, "PUT", authorHttpBearer(actor.token),
      { statusLine: label, currentSeatId: null, ...(kind === "significant" ? { kind: "seat" } : {}), updatedAt: new Date().toISOString() });
  const has = (response: AuthorHttpResponse, value: string) => response.bytes.toString("utf8").includes(value);
  const rows = async (roomId: string) => ({ diagnostics: (await h.storage.getDiagnostics(roomId)).length, xr: (await h.storage.getXrTelemetry(roomId)).length });
  async function adminXr(roomId: string) {
    const response = await h.request(`${stem(roomId)}/xr-telemetry`, "GET", h.adminHeaders);
    assert.equal(response.status, 200); return response.json<Items>().items;
  }
  async function metrics(pattern: RegExp) {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    return response.bytes.toString("utf8").split("\n").filter(line => pattern.test(line));
  }
  const telemetryMetrics = () => metrics(/^vrata_(diagnostic_reports|screen_share_|room_join_failures)/);
  const requestFailures = async () => {
    const lines = await metrics(/^vrata_api_request_failures_total /);
    assert.equal(lines.length, 1, "exactly one request failure metric line");
    return lines;
  };
  async function presenceMetrics() {
    const lines = await metrics(/^vrata_active_(rooms|participants) /);
    const value = (name: string) => Number(lines.find(line => line.startsWith(`${name} `))?.split(" ")[1]);
    return { rooms: value("vrata_active_rooms"), participants: value("vrata_active_participants") };
  }
  function denied(response: AuthorHttpResponse, status: number, error: string, reason?: string, privateValues: string[] = []) {
    assert.equal(response.status, status, `expected ${error}; received HTTP ${response.status}`);
    const body = response.json<Record<string, unknown>>();
    assert.equal(body.error === error && (reason === undefined || body.reason === reason), true, `expected ${error}/${reason ?? "-"}`);
    for (const value of [PRIVATE_LABEL, "reportId", "\"items\"", AUTHOR_HTTP_SECRET, ...privateValues]) {
      assert.equal(has(response, value), false, "a refusal echoes no prepared content, credential or success metadata");
    }
  }
  async function noEffect(roomId: string, requestId: string, before: string[]) {
    assert.equal(await h.diagnosticPublishedCount(requestId), 0, "no diagnostic event is published");
    assert.deepEqual(await rows(roomId), { diagnostics: 0, xr: 0 });
    assert.deepEqual(await adminXr(roomId), [], "no XR live state or history");
    assert.deepEqual(await telemetryMetrics(), before, "diagnostic and screen-share metrics are unchanged");
  }
  /** Holds one request at a child phase; cleanup always resets the clock and resumes. */
  async function held<T>(phase: Phase, roomId: string, request: () => Promise<T>, change: () => Promise<unknown>, skip = 0): Promise<T> {
    const id = await h.arm(phase, roomId, skip);
    const pending = request(); void pending.catch(() => undefined);
    try { await h.phase(id, phase); await change(); await h.resume(); return await pending; }
    finally { await h.clock(0); await h.resume(); await pending.catch(() => undefined); }
  }
  return { issue, createRoom, expiry, presence, listPresence, xrHistory, write, has, rows, adminXr, telemetryMetrics, requestFailures, presenceMetrics,
    denied, noEffect, held };
}

test("floor-1 virtual rooms and their persisted neighbours are fenced end to end over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture; activation is its last case", async c => {
    const h = await startAuthorHttpFixture(c, 1, true);
    const v = virtualHttp(h);

    await c.test("virtual presence round-trips and is counted by the aggregate metrics", async () => {
      const actor = await v.issue(); const before = await v.presenceMetrics();
      assert.equal((await v.presence(actor, "PUT")).status, 200);
      const listed = await v.listPresence(actor.roomId);
      assert.deepEqual([listed.status, listed.json<Items>().items.map(item => item.participantId)], [200, [actor.participantId]]);
      assert.deepEqual(await v.presenceMetrics(), { rooms: before.rooms + 1, participants: before.participants + 1 });
      assert.equal((await v.presence(actor, "DELETE")).status, 200);
      assert.deepEqual((await v.listPresence(actor.roomId)).json(), { items: [] });
      assert.deepEqual(await v.presenceMetrics(), before);
      assert.equal(await h.storage.getRoom(actor.roomId), null, "virtual presence never materializes a room");
    });

    for (const kind of ["diagnostics", "significant", "idle"] as const) {
      await c.test(`${kind}: the v1 deadline passing after HTTP verification denies at the virtual fence entry`, async () => {
        const actor = await v.issue(); const before = await v.telemetryMetrics(); const requestId = randomUUID();
        const response = await v.held("telemetry-effect", actor.roomId, () => v.write(actor, kind, PRIVATE_LABEL, requestId), () => h.clock(v.expiry(actor)));
        v.denied(response, 401, "identity_session_expired", "identity_session_expired", [actor.token]);
        await v.noEffect(actor.roomId, requestId, before);
      });
    }

    for (const kind of ["diagnostics", "significant"] as const) {
      await c.test(`${kind}: expiry after the actual virtual INSERT rolls back before COMMIT`, async () => {
        const actor = await v.issue(); const before = await v.telemetryMetrics(); const requestId = randomUUID();
        const response = await v.held("telemetry-written", actor.roomId, () => v.write(actor, kind, PRIVATE_LABEL, requestId), async () => {
          assert.deepEqual(await v.rows(actor.roomId), { diagnostics: 0, xr: 0 }, "the uncommitted row is invisible to another connection");
          await h.clock(v.expiry(actor));
        });
        v.denied(response, 401, "identity_session_expired", "identity_session_expired", [actor.token]);
        await v.noEffect(actor.roomId, requestId, before);
      });
    }

    await c.test("idle XR: a call queued behind a held first call is not applied after the deadline passes", async () => {
      const actor = await v.issue();
      let first: Promise<AuthorHttpResponse> | undefined, queued: Promise<AuthorHttpResponse> | undefined;
      try {
        // Hold the second call after entry verification (state-token tenant lookup, then the handler's lookup).
        const loaded = await h.arm("room-loaded", actor.roomId, 1);
        queued = v.write(actor, "idle", "fixture-queued-idle"); void queued.catch(() => undefined);
        await h.phase(loaded, "room-loaded");
        const entered = await h.arm("telemetry-effect", actor.roomId);
        first = v.write(actor, "idle"); void first.catch(() => undefined);
        await h.phase(entered, "telemetry-effect");
        // FIFO: the verified second call joins the pair queue in microtasks, before the clock command is handled.
        await h.resume(); await h.clock(v.expiry(actor)); await h.resume();
        v.denied(await first, 401, "identity_session_expired", "identity_session_expired", [actor.token]);
        v.denied(await queued, 401, "identity_session_expired", "identity_session_expired", [actor.token, "fixture-queued-idle"]);
      } finally { await h.clock(0); await h.resume(); await h.resume(); await Promise.allSettled([first, queued]); }
      assert.deepEqual(await v.adminXr(actor.roomId), [], "neither idle record reaches the virtual live map");
    });

    await h.pool.query(`create function virtual_http_commit_fault() returns trigger language plpgsql as $$ begin
      if coalesce(new.payload->>'issueCode',new.payload->>'statusLine')='fixture-reject-commit' then raise exception 'fixture_commit_rejected'; end if;
      return null; end $$`);
    for (const table of ["runtime_diagnostics", "xr_telemetry"]) await h.pool.query(`create constraint trigger virtual_http_commit_fault
      after insert on ${table} deferrable initially deferred for each row execute function virtual_http_commit_fault()`);
    for (const kind of ["diagnostics", "significant"] as const) {
      await c.test(`${kind}: a server-rejected virtual COMMIT fails without live state, publication or metrics`, async () => {
        const actor = await v.issue(); const before = await v.telemetryMetrics(); const requestId = randomUUID();
        const response = await v.write(actor, kind, "fixture-reject-commit", requestId);
        assert.equal(response.status === 500 && !v.has(response, "reportId") && !v.has(response, actor.token), true,
          `expected a bare HTTP 500; received ${response.status}`);
        await v.noEffect(actor.roomId, requestId, before);
      });
      await c.test(`${kind}: an injected lost virtual COMMIT acknowledgement is uncertain and never publishes`, async () => {
        const actor = await v.issue(); const before = await v.telemetryMetrics(); const requestId = randomUUID();
        await h.arm("telemetry-ack-loss", actor.roomId);
        const response = await v.write(actor, kind, PRIVATE_LABEL, requestId);
        v.denied(response, 503, "identity_authority_unavailable", "identity_authority_unavailable", [actor.token]);
        assert.equal(await h.diagnosticPublishedCount(requestId), 0);
        assert.deepEqual(await v.rows(actor.roomId), kind === "diagnostics" ? { diagnostics: 1, xr: 0 } : { diagnostics: 0, xr: 1 }, "the actual COMMIT landed");
        assert.deepEqual(await v.telemetryMetrics(), before);
      });
    }

    await c.test("an actual room created after a v1 write chose the virtual branch denies at the fence and hides the old entry", async () => {
      const actor = await v.issue(); assert.equal((await v.presence(actor, "PUT")).status, 200);
      const before = await v.telemetryMetrics(); const requestId = randomUUID();
      const response = await v.held("telemetry-effect", actor.roomId, () => v.write(actor, "diagnostics", PRIVATE_LABEL, requestId),
        () => v.createRoom(actor.roomId));
      v.denied(response, 409, "room_state_changed", "room_state_changed", [actor.token]);
      await v.noEffect(actor.roomId, requestId, before);
      const listed = await v.listPresence(actor.roomId);
      assert.equal(listed.status === 200 && !v.has(listed, actor.participantId), true, "the persisted namespace never releases the virtual entry");
    });

    await c.test("a trusted legacy host token reads no XR history once its persisted room is deleted", async () => {
      const roomId = randomUUID(); await v.createRoom(roomId, "private");
      const host = await v.issue(roomId, { inviteToken: (await h.invite(roomId, "host")).inviteToken });
      assert.equal(host.role, "host", "a real private invitation issued a trusted host token");
      assert.equal((await v.write(host, "significant")).status, 200);
      assert.equal((await v.xrHistory(roomId, host.token)).status, 200, "the host reads history while the room exists");
      assert.equal((await h.request(`/api/rooms/${roomId}`, "DELETE", h.adminHeaders)).status, 200);
      v.denied(await v.xrHistory(roomId, host.token), 404, "room_not_found", undefined, [host.participantId, host.token]);
      // A default guest may be refused by permission before the missing room is observed.
      const refused = await v.xrHistory(roomId, (await v.issue(roomId)).token);
      assert.equal([403, 404].includes(refused.status) && !v.has(refused, host.participantId), true, `guest received HTTP ${refused.status}`);
      assert.deepEqual((await v.adminXr(roomId)).map(item => item.participantId), [host.participantId], "the administrator still reads DB leftovers");
    });

    await c.test("virtual-data ids the namespace cannot hold are a bare 404 before session, boundary or room lookups", async () => {
      // Compatibility baseline: an exact-limit id keeps its fallbacks, including a real v1 write.
      const exact = "v".repeat(200);
      const member = await v.issue(exact);
      assert.equal((await v.presence(member, "PUT")).status, 200, "exact-limit virtual presence write");
      assert.equal((await h.request(`/api/rooms/${exact}/manifest`)).status, 200, "exact-limit virtual manifest");
      const listed = await v.listPresence(exact);
      assert.equal(listed.status === 200 && v.has(listed, member.participantId), true, "exact-limit virtual presence read");
      assert.equal((await v.presence(member, "DELETE")).status, 200, "exact-limit virtual presence removal");

      // A real token for the over-limit id: the refusal cannot depend on a missing or forged credential.
      const holder = await v.issue("v".repeat(201));
      const bearer = authorHttpBearer(holder.token);
      const requestIds: string[] = [];
      type Probe = [route: string, path: string, method: string, headers: Record<string, string>, body?: unknown];
      const probes = (room: string, participant = holder.participantId): Probe[] => {
        const stem = `/api/rooms/${room}`, requestId = randomUUID(); requestIds.push(requestId);
        return [["manifest", `${stem}/manifest`, "GET", {}], ["admin manifest", `${stem}/manifest`, "GET", h.adminHeaders],
          ["presence list", `${stem}/presence`, "GET", {}], ["admin presence list", `${stem}/presence`, "GET", h.adminHeaders],
          ["presence write", `${stem}/presence/${participant}`, "PUT", bearer,
            { participantId: holder.participantId, displayName: "Virtual participant", updatedAt: new Date().toISOString() }],
          ["presence removal", `${stem}/presence/${participant}`, "DELETE", bearer],
          ["admin diagnostics", `${stem}/diagnostics`, "GET", h.adminHeaders],
          ["diagnostic report", `${stem}/diagnostics`, "POST", { ...bearer, "x-request-id": requestId },
            { participantId: holder.participantId, issueCode: PRIVATE_LABEL, note: "screenshare_started" }],
          ["admin XR history", `${stem}/xr-telemetry`, "GET", h.adminHeaders], ["session XR history", `${stem}/xr-telemetry`, "GET", bearer],
          ["XR write", `${stem}/xr-telemetry/${participant}`, "PUT", bearer,
            { statusLine: PRIVATE_LABEL, currentSeatId: null, kind: "seat", updatedAt: new Date().toISOString() }]];
      };
      // Raw path segments: fetch keeps each escape as written, so only the server decodes it.
      const rooms = [["over-limit", "v".repeat(201)], ["NUL", "virtual%00room"], ["LF", "virtual%0Aroom"],
        ["malformed escape", "virtual%ZZroom"], ["truncated UTF-8", "virtual%E0%A4room"]] as const;
      const cases = [...rooms.flatMap(([segment, room]) => probes(room).map(probe => [segment, ...probe] as const)),
        ...probes(exact, "virtual%ZZparticipant").filter(([, path]) => path.includes("%ZZ"))
          .map(probe => ["malformed participant escape", ...probe] as const)];
      const bare = (response: AuthorHttpResponse) => {
        try { return response.status === 404 && JSON.stringify(response.json()) === JSON.stringify({ error: "room_not_found" }); }
        catch { return false; }
      };
      const totals = async () => (await h.pool.query(`select (select count(*) from rooms)::int as rooms,
        (select count(*) from runtime_diagnostics)::int as diagnostics, (select count(*) from xr_telemetry)::int as xr`)).rows[0] as unknown;
      const before = [await v.requestFailures(), await v.telemetryMetrics(), await v.presenceMetrics(), await totals()];
      for (const [segment, route, path, method, headers, body] of cases) {
        const response = await h.request(path, method, headers, body);
        assert.equal(bare(response), true, `${segment} ${route}: expected a bare 404 room_not_found; received HTTP ${response.status}`);
      }
      // An unchanged failure counter also means no request_failed event logged the raw path.
      assert.deepEqual([await v.requestFailures(), await v.telemetryMetrics(), await v.presenceMetrics(), await totals()], before,
        "no internal failure, telemetry metric, live presence or database row");
      for (const requestId of requestIds) assert.equal(await h.diagnosticPublishedCount(requestId), 0, "no diagnostic event is published");
    });

    await c.test("activation while a public virtual read, a persisted presence DELETE and a native body wait are held denies all three", async () => {
      const visitor = await v.issue(); assert.equal((await v.presence(visitor, "PUT")).status, 200);
      const roomId = randomUUID(); await v.createRoom(roomId);
      const member = await v.issue(roomId); assert.equal((await v.presence(member, "PUT")).status, 200);
      const writer = await v.issue();
      const body = new TextEncoder().encode(JSON.stringify({ participantId: writer.participantId, issueCode: PRIVATE_LABEL, note: "screenshare_started" }));
      const upload = h.stalled(`/api/rooms/${writer.roomId}/diagnostics`, writer.token, body);
      let read: Promise<AuthorHttpResponse> | undefined, removal: Promise<AuthorHttpResponse> | undefined;
      try {
        await upload.admitted();
        const readId = await h.arm("telemetry-effect", visitor.roomId);
        read = v.listPresence(visitor.roomId); void read.catch(() => undefined);
        await h.phase(readId, "telemetry-effect");
        // The DELETE has verified its v1 session and resolved the persisted room before this pause.
        const removalId = await h.arm("telemetry-effect", roomId);
        removal = v.presence(member, "DELETE"); void removal.catch(() => undefined);
        await h.phase(removalId, "telemetry-effect");
        await h.storage.identityProtocol.raise(2);
        upload.finish(); await h.resume(); await h.resume();
        v.denied(await read, 409, "identity_required", "identity_upgrade_required", [visitor.participantId]);
        v.denied(await removal, 409, "identity_required", "identity_upgrade_required", [member.token]);
        v.denied(await upload.response, 409, "identity_required", "identity_upgrade_required", [writer.token]);
      } finally {
        await h.resume(); await h.resume(); upload.destroy();
        await Promise.allSettled([read, removal, upload.response]);
      }
      assert.deepEqual(await v.rows(writer.roomId), { diagnostics: 0, xr: 0 });
      for (const [target, participantId] of [[visitor.roomId, visitor.participantId], [roomId, member.participantId]]) {
        const observed = await v.listPresence(target, h.adminHeaders);
        assert.equal(observed.status === 200 && v.has(observed, participantId), true, "the administrator fallback still sees the unremoved entry");
      }
      v.denied(await v.listPresence(visitor.roomId), 409, "identity_required", "identity_upgrade_required", [visitor.participantId]);
    });
  });

  await t.test("owned floor-2 fixture: persisted v2 presence", async c => {
    const h = await startAuthorHttpFixture(c, 2, true);
    const v = virtualHttp(h);
    const presencePath = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/presence`;
    const cases = [["room-read", 1, 404, "room_not_found", undefined],
      ["telemetry-effect", 0, 409, "identity_required", "identity_recovery_required"]] as const;
    for (const [phase, skip, status, error, reason] of cases) {
      await c.test(`a verified v2 presence read whose room is deleted at ${phase} fails closed with ${status}`, async () => {
        const f = await h.room(); await h.present(f.room.roomId, f.host);
        // room-read skip 1: the entry middleware's lookup verifies the session; the handler's lookup observes the deletion.
        const response = await v.held(phase, f.room.roomId, () => h.request(presencePath(f.room.roomId), "GET", authorHttpBearer(f.host.token)),
          async () => assert.equal((await h.request(`/api/rooms/${f.room.roomId}`, "DELETE", h.adminHeaders)).status, 200), skip);
        v.denied(response, status, error, reason, [f.host.participantId, f.host.token, f.host.identityCredential]);
      });
    }

    await c.test("a v2 presence DELETE held before its fence is denied after revocation and keeps the entry", async () => {
      const f = await h.room(); await h.present(f.room.roomId, f.host);
      const response = await v.held("telemetry-effect", f.room.roomId,
        () => h.request(`${presencePath(f.room.roomId)}/${f.host.participantId}`, "DELETE", authorHttpBearer(f.host.token)), async () => {
          const proof = codec.verify(f.host.token, f.room); assert.ok(proof);
          await h.storage.roomIdentities.revoke(f.room, proof.identityId, proof.authEpoch);
        });
      v.denied(response, 409, "identity_required", undefined, [f.host.token]);
      const observed = await h.request(presencePath(f.room.roomId), "GET", h.adminHeaders);
      assert.equal(observed.status === 200 && v.has(observed, f.host.participantId), true, "the presence entry was not removed");
    });
  });
});
