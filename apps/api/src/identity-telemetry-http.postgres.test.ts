import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, until,
  type AuthorHttpRoom, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 180_000 };
const codec = createRoomSessionV2Codec(AUTHOR_HTTP_SECRET);
const expiryOffset = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).expiresAtSeconds * 1000 - Date.now() + 10;

test("persisted HTTP telemetry releases writes after commit and private XR history under fresh authority", postgres, async t => {
  const h = await startAuthorHttpFixture(t, 2, true);
  const stem = (f: AuthorHttpRoom) => `/api/rooms/${f.room.roomId}`;
  const diagnostic = (f: AuthorHttpRoom, issueCode = "fixture-ok") => ({ participantId: f.host.participantId, issueCode,
    note: "screenshare_started", sceneDebug: { screenshot: { dataUrl: "data:image/png;base64,ZXhhbXBsZQ==", width: 1 } } });
  const write = (f: AuthorHttpRoom, kind: "diagnostics" | "significant" | "idle", label = "fixture-private-xr", requestId = randomUUID()) => kind === "diagnostics"
    ? h.request(`${stem(f)}/diagnostics`, "POST", { ...authorHttpBearer(f.host.token), "x-request-id": requestId }, diagnostic(f, label))
    : h.request(`${stem(f)}/xr-telemetry/${f.host.participantId}`, "PUT", authorHttpBearer(f.host.token),
      { participantId: "payload-impostor", roomId: "payload-room", statusLine: label, currentSeatId: null,
        ...(kind === "significant" ? { kind: "seat" } : {}), updatedAt: new Date().toISOString() });
  const list = (f: AuthorHttpRoom, token = f.host.token) => h.request(`${stem(f)}/xr-telemetry`, "GET", authorHttpBearer(token));
  const rows = async (f: AuthorHttpRoom) => ({ diagnostics: await h.storage.getDiagnostics(f.room.roomId), xr: await h.storage.getXrTelemetry(f.room.roomId) });
  const metrics = async () => {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    return response.bytes.toString().split("\n").filter(line => /^vrata_(diagnostic_reports|screen_share_|room_join_failures)/.test(line));
  };
  const denied = (response: AuthorHttpResponse, status: number, error: string) => {
    assert.equal(response.status, status); assert.equal(response.json<{ error: string }>().error, error);
    for (const value of ["fixture-private-xr", "reportId", "identityCredential", "rs2."]) {
      assert.equal(response.bytes.toString().includes(value), false, "refusal contains no prepared telemetry or success metadata");
    }
  };
  const revoke = async (f: AuthorHttpRoom) => {
    const proof = codec.verify(f.host.token, f.room); assert.ok(proof);
    await h.storage.roomIdentities.revoke(f.room, proof.identityId, proof.authEpoch);
  };
  async function paused(f: AuthorHttpRoom, phase: "telemetry-effect" | "telemetry-written" | "telemetry-read",
    request: () => Promise<AuthorHttpResponse>, change: () => Promise<unknown>) {
    const id = await h.arm(phase, f.room.roomId);
    const pending = request(); void pending.catch(() => undefined);
    try { await h.phase(id, phase); await change(); await h.resume(); return await pending; }
    finally { await h.resume(); await pending.catch(() => undefined); }
  }

  await t.test("successful reports publish sanitized diagnostics and idle XR without an extra persisted event", async () => {
    const f = await h.room(); const before = await metrics();
    const report = await write(f, "diagnostics"); assert.equal(report.status, 201);
    assert.equal(await h.diagnosticPublishedCount(report.headers["x-request-id"]), 1);
    const stored = await rows(f); assert.equal(stored.diagnostics.length, 1);
    assert.equal(stored.diagnostics[0].sceneDebug?.screenshot?.dataUrl, undefined);
    assert.notDeepEqual(await metrics(), before);
    assert.equal((await write(f, "significant")).status, 200);
    assert.equal((await write(f, "idle", "idle-latest")).status, 200);
    const response = await list(f); assert.equal(response.status, 200);
    const [entry] = response.json<{ items: Array<{ roomId: string; participantId: string; statusLine: string; history: unknown[] }> }>().items;
    assert.deepEqual([entry.roomId, entry.participantId, entry.statusLine, entry.history.length], [f.room.roomId, f.host.participantId, "idle-latest", 1]);
    assert.equal((await rows(f)).xr.length, 1);
  });

  for (const kind of ["diagnostics", "significant", "idle"] as const) for (const change of ["expiry", "revoke"] as const) {
    await t.test(`${kind}: authority lost after HTTP admission prevents persistence and projections (${change})`, async () => {
      const f = await h.room(); const before = await rows(f); const beforeMetrics = await metrics();
      const response = await paused(f, "telemetry-effect", () => write(f, kind), () => change === "expiry" ? h.clock(expiryOffset(f.host.token)) : revoke(f));
      await h.clock(0);
      denied(response, change === "expiry" ? 401 : 409, change === "expiry" ? "identity_session_expired" : "identity_required");
      if (kind === "diagnostics") assert.equal(await h.diagnosticPublishedCount(response.headers["x-request-id"]), 0);
      assert.deepEqual(await rows(f), before); assert.deepEqual(await metrics(), beforeMetrics);
      const observed = await h.request(`${stem(f)}/xr-telemetry`, "GET", h.adminHeaders);
      assert.deepEqual(observed.json(), { items: [] });
    });
  }

  for (const kind of ["diagnostics", "significant"] as const) {
    await t.test(`${kind}: expiry after actual SQL rolls back and never publishes before COMMIT`, async () => {
      const f = await h.room(); const before = await rows(f); const beforeMetrics = await metrics();
      const requestId = randomUUID();
      const response = await paused(f, "telemetry-written", () => write(f, kind, "fixture-private-xr", requestId), async () => {
        if (kind === "diagnostics") assert.equal(await h.diagnosticPublishedCount(requestId), 0);
        assert.deepEqual(await rows(f), before, "uncommitted rows are invisible on the other connection");
        assert.deepEqual(await metrics(), beforeMetrics, "diagnostic metrics and screen-share map stay unchanged before commit");
        const observed = await h.request(`${stem(f)}/xr-telemetry`, "GET", h.adminHeaders);
        assert.deepEqual(observed.json(), { items: [] });
        await h.clock(expiryOffset(f.host.token));
      });
      await h.clock(0); denied(response, 401, "identity_session_expired");
      if (kind === "diagnostics") assert.equal(await h.diagnosticPublishedCount(requestId), 0);
      assert.deepEqual(await rows(f), before); assert.deepEqual(await metrics(), beforeMetrics);
    });
    await t.test(`${kind}: original deadline is rechecked after a real telemetry table lock wait`, async () => {
      const f = await h.room(); const before = await metrics(); const holder = await h.pool.connect();
      let pending: Promise<AuthorHttpResponse> | undefined;
      try {
        await holder.query("begin");
        await holder.query(`lock table ${kind === "diagnostics" ? "runtime_diagnostics" : "xr_telemetry"} in access exclusive mode`);
        const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
        pending = write(f, kind); void pending.catch(() => undefined);
        await until(async () => (await h.pool.query(`select exists(select 1 from pg_stat_activity
          where application_name=$2 and $1=any(pg_blocking_pids(pid))) as waiting`, [pid, h.schema])).rows[0].waiting,
        "the actual telemetry SQL must wait behind the owned table lock");
        await h.clock(expiryOffset(f.host.token)); await holder.query("commit");
        denied(await pending, 401, "identity_session_expired");
        await h.clock(0); assert.deepEqual(await rows(f), { diagnostics: [], xr: [] }); assert.deepEqual(await metrics(), before);
      } finally { await holder.query("rollback").catch(() => undefined); holder.release(); await h.clock(0); await pending?.catch(() => undefined); }
    });
  }

  await t.test("a committed diagnostic is ordered before a revoke waiting on its parent fence", async () => {
    const f = await h.room(); let removal: Promise<void> | undefined;
    const requestId = randomUUID();
    const response = await paused(f, "telemetry-written", () => write(f, "diagnostics", "fixture-private-xr", requestId), async () => {
      assert.equal(await h.diagnosticPublishedCount(requestId), 0);
      removal = revoke(f); void removal.catch(() => undefined);
      await until(async () => (await h.pool.query(`select exists(select 1 from pg_stat_activity
        where application_name=$1 and cardinality(pg_blocking_pids(pid))>0) as waiting`, [h.schema])).rows[0].waiting,
      "revocation must be waiting on the guarded writer's actual parent lock");
    });
    assert.equal(response.status, 201); await removal;
    assert.equal(await h.diagnosticPublishedCount(requestId), 1);
    assert.equal((await rows(f)).diagnostics.length, 1);
    denied(await write(f, "diagnostics"), 409, "identity_required");
  });

  await h.pool.query(`create function telemetry_http_commit_fault() returns trigger language plpgsql as $$ begin
    if coalesce(new.payload->>'issueCode',new.payload->>'statusLine')='fixture-reject-commit' then raise exception 'fixture_commit_rejected'; end if;
    if coalesce(new.payload->>'issueCode',new.payload->>'statusLine')='fixture-uncertain-commit' then raise exception 'fixture_commit_unconfirmed' using errcode='08006'; end if;
    return null; end $$`);
  for (const table of ["runtime_diagnostics", "xr_telemetry"]) await h.pool.query(`create constraint trigger telemetry_http_commit_fault
    after insert on ${table} deferrable initially deferred for each row execute function telemetry_http_commit_fault()`);
  for (const kind of ["diagnostics", "significant"] as const) for (const fault of ["reject", "uncertain"] as const) {
    await t.test(`${kind}: ${fault} COMMIT returns failure without live state or diagnostic metric changes`, async () => {
      const f = await h.room(); const before = await metrics();
      const response = await write(f, kind, `fixture-${fault}-commit`);
      assert.equal(response.status, fault === "uncertain" ? 503 : 500);
      assert.equal(response.bytes.toString().includes("reportId"), false);
      if (kind === "diagnostics") assert.equal(await h.diagnosticPublishedCount(response.headers["x-request-id"]), 0);
      assert.deepEqual(await rows(f), { diagnostics: [], xr: [] }); assert.deepEqual(await metrics(), before);
      assert.deepEqual((await list(f)).json(), { items: [] });
    });
  }

  for (const change of ["transfer", "revoke", "expiry"] as const) await t.test(`prepared XR history denies after ${change}`, async () => {
    const f = await h.room(); const successor = await h.session(f.room.roomId);
    assert.equal((await write(f, "significant")).status, 200);
    const response = await paused(f, "telemetry-read", () => list(f), () => change === "expiry" ? h.clock(expiryOffset(f.host.token))
      : change === "revoke" ? revoke(f) : h.transition(f, "host/transfer", successor));
    await h.clock(0);
    denied(response, change === "transfer" ? 403 : change === "expiry" ? 401 : 409,
      change === "transfer" ? "forbidden" : change === "expiry" ? "identity_session_expired" : "identity_required");
    if (change === "transfer") assert.equal((await list(f, successor.token)).status, 200);
  });
});
