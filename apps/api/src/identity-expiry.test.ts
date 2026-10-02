import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { MemoryStorage, PostgresStorage } from "./storage.js";
import type { Storage } from "./storage-contracts.js";
import { createRoomIdentityService } from "./identity/service.js";
import { IdentityStorageError, type RoomIdentityActor } from "./identity/contracts.js";
import { roomIdentityActorFromHttp, applyRoomLifecycleV2, lifecycleV2Error } from "./identity/http-lifecycle.js";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";

const adminActor = { actorType: "admin-token" as const, actorId: "verified-admin", role: "admin" as const };
const errorCode = (code: string) => (error: unknown) => error instanceof IdentityStorageError && error.code === code;

const secret = "expiry-contract-key-32-bytes-or-longer";

async function fixture(t: TestContext, postgres: boolean, personal = false) {
  let at = Date.now();
  const now = () => at;
  let storage: Storage;
  let pool: Pool | undefined;
  if (postgres) {
    assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
    const schema = `identity_expiry_${randomUUID().replaceAll("-", "")}`;
    const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
    await root.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${schema},public` });
    t.after(async () => { await pool!.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
    const adapter = new PostgresStorage(pool, now);
    await adapter.init();
    storage = adapter;
  } else storage = new MemoryStorage(now);
  at = Date.now();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Expiry contract",
    sessionControl: { hostParticipantId: "legacy-host" }, ...(personal ? { roomType: "personal" as const, ownerParticipantId: "legacy-host" } : {}) });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, secret, now);
  const recovery = await service.issueRecovery({ ...scope, issuer: adminActor, targetRole: personal ? "owner" : "host", targetParticipantId: "legacy-host",
    expiresAt: new Date(at + 120_000).toISOString() });
  const host = await service.redeemRecovery(recovery.credential, scope);
  const expiresAtSeconds = Math.floor(at / 1000) + 60;
  const actor: RoomIdentityActor = { actorType: "room-session", proof: host.identity, expiresAtSeconds };
  const invite = (who: RoomIdentityActor = actor) => ({ roomId: scope.roomId, role: "member" as const,
    tokenHash: Buffer.from(randomUUID().replaceAll("-", "")).toString("base64url"), waitingRoomEnabled: false,
    expiresAt: new Date(at + 3_600_000).toISOString(), actor: who });
  return { storage, pool, scope, actor, service, host, room, expiresAtSeconds, invite, now,
    setTime(value: number) { at = value; } };
}

test("HTTP mutation actor requires verified v2 metadata and cannot omit or widen a session deadline", async () => {
  const room = { tenantId: "tenant", roomId: "room" };
  const context = { actorType: "room-session" as const, actorId: "participant", identityProtocolVersion: 2 as const,
    participantId: "participant", identityId: "identity", authEpoch: 1, expiresAtSeconds: 100 };
  const actor = roomIdentityActorFromHttp(context, room);
  assert.equal(actor.actorType, "room-session");
  if (actor.actorType === "room-session") assert.equal(actor.expiresAtSeconds, 100);
  let storageTouched = false;
  const storage = { roomIdentities: { authority: async () => { storageTouched = true; return null; } } } as unknown as Storage;
  for (const expiry of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(applyRoomLifecycleV2({ storage, room: room as Parameters<typeof applyRoomLifecycleV2>[0]["room"],
      actor: { ...context, expiresAtSeconds: expiry }, command: { type: "lock" } }), errorCode("identity_session_expired"));
  }
  assert.equal(storageTouched, false);
  assert.throws(() => roomIdentityActorFromHttp({ ...context, identityProtocolVersion: undefined }, room), errorCode("identity_not_active"));
  assert.deepEqual(roomIdentityActorFromHttp({ actorType: "admin-token", actorId: "verified-admin" }, room), adminActor);
  assert.deepEqual(lifecycleV2Error(new IdentityStorageError("identity_session_expired")), { status: 401, error: "identity_session_expired" });
});

test("HTTP stalled bodies and private responses expire using the session deadline, then renew with the existing identity", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  const f = await fixture(t, true, true);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL!);
  connection.searchParams.set("options", f.pool!.options.options!);
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, POSTGRES_URL: connection.href, NODE_ENV: "development", API_PORT: String(port),
      STATE_TOKEN_SECRET: secret, CONTROL_PLANE_ADMIN_TOKEN: "test-admin", ROOM_ACCESS_POLICY_ENABLED: "true", FEATURE_HOST_CONTROLS: "true"
    }
  });
  let log = "";
  child.stdout!.on("data", chunk => { log += String(chunk); });
  child.stderr!.on("data", chunk => { log += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`expiry_api_start_failed:${log}`);
      ready = await fetch(`${base}/health`).then(response => response.ok).catch(() => false);
      if (ready) break;
      await delay(60);
    }
    assert.equal(ready, true);
    const codec = createRoomSessionV2Codec(secret);
    const targetInvite = await f.storage.createRoomInviteV2(f.invite(adminActor));
    const target = await f.service.admit({ ...f.scope, displayName: "Target", inviteTokenHash: targetInvite.tokenHash });
    const targetSession = await f.service.issueSession(target.credential, f.scope);
    await f.storage.roomIdentities.transition(f.scope, adminActor, 1,
      { type: "grant-presenter", targetParticipantId: target.identity.participantId });
    const stem = `/api/rooms/${f.scope.roomId}`;
    const freshShort = () => {
      const seconds = Math.floor(Date.now() / 1000);
      return { token: codec.sign(f.host.identity, { nowSeconds: seconds, lifetimeSeconds: 3 }), deadlineMs: (seconds + 3) * 1000 };
    };
    const initialAuthority = await f.storage.roomIdentities.authority(f.scope);
    const initialInvites = (await f.storage.listRoomInvites(f.scope.roomId)).length;
    const suffixes = ["session-control/lock", `participants/${target.identity.participantId}/remove`,
      `presenters/${target.identity.participantId}/grant`, `presenters/${target.identity.participantId}/revoke`,
      "host/transfer", "owner/transfer", "invites"];
    for (const suffix of suffixes) {
      await fetch(`${base}${stem}/presence/${target.identity.participantId}`, { method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${targetSession.sessionToken}` },
        body: JSON.stringify({ participantId: target.identity.participantId, displayName: "Target", updatedAt: new Date().toISOString() }) });
      const short = freshShort();
      const body = JSON.stringify({ participantId: target.identity.participantId, expectedRevision: initialAuthority!.revision,
        role: "member", expiresInSeconds: 600, expiresAtSeconds: Math.floor(Date.now() / 1000) + 86_400 });
      let finish!: (value: { status: number; body: string }) => void;
      let fail!: (error: Error) => void;
      const received = new Promise<{ status: number; body: string }>((resolve, reject) => { finish = resolve; fail = reject; });
      const request = httpRequest(`${base}${stem}/${suffix}`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${short.token}`
      } }, response => {
        let text = "";
        response.on("data", chunk => { text += String(chunk); });
        response.on("end", () => finish({ status: response.statusCode ?? 0, body: text }));
      });
      request.on("error", fail);
      request.write(body.slice(0, -1));
      await delay(Math.max(1, short.deadlineMs - Date.now() + 20));
      request.end(body.slice(-1));
      const response = await received;
      assert.equal(response.status, 401, `${suffix} must reject expiry after body admission`);
      assert.equal(JSON.parse(response.body).error, "identity_session_expired");
      assert.deepEqual(await f.storage.roomIdentities.authority(f.scope), initialAuthority);
      assert.equal((await f.storage.listRoomInvites(f.scope.roomId)).length, initialInvites);
    }
    await f.storage.upsertRoomNote({ roomId: f.scope.roomId, scope: "private", ownerParticipantId: f.host.identity.participantId,
      content: "NO-PRIVATE-DATA-AFTER-SESSION-EXPIRY" });
    const holder = await f.pool!.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select room_id from rooms where room_id=$1 for update", [f.scope.roomId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      const short = freshShort();
      pending = fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${short.token}` } });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await f.pool!.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
        if (blocked) break;
        await delay(10);
      }
      assert.equal(blocked, true);
      await delay(Math.max(1, short.deadlineMs - Date.now() + 20));
      await holder.query("commit");
      const response = await pending;
      assert.equal(response.status, 401);
      const body = await response.text();
      assert.equal(JSON.parse(body).reason, "identity_session_expired");
      assert.equal(body.includes("NO-PRIVATE-DATA-AFTER-SESSION-EXPIRY"), false);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
    const renewed = await fetch(`${base}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityProtocolVersion: 2, roomId: f.scope.roomId, identityCredential: f.host.credential }) });
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json() as { participantId: string }).participantId, f.host.identity.participantId);
    // Exercise the typed PG denial itself, not request-entry authorization:
    // unlike a personal Owner, a standard-room former Host loses invite rights.
    const standard = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Lost Host invite",
      sessionControl: { hostParticipantId: "standard-host" } });
    const standardScope = { tenantId: standard.tenantId, roomId: standard.roomId };
    const recovery = await f.service.issueRecovery({ ...standardScope, issuer: adminActor, targetRole: "host", targetParticipantId: "standard-host",
      expiresAt: new Date(f.now() + 120_000).toISOString() });
    const originalHost = await f.service.redeemRecovery(recovery.credential, standardScope);
    const successor = await f.service.admit({ ...standardScope, displayName: "Successor" });
    const validToken = codec.sign(originalHost.identity, { lifetimeSeconds: 600 });
    const beforeDenial = (await f.storage.listRoomInvites(standard.roomId)).length;
    const holderForRole = await f.pool!.connect();
    let roleRequest: Promise<Response> | undefined;
    try {
      await holderForRole.query("begin");
      await holderForRole.query("select room_id from rooms where room_id=$1 for update", [standard.roomId]);
      const pid = (await holderForRole.query("select pg_backend_pid() as pid")).rows[0].pid;
      roleRequest = fetch(`${base}/api/rooms/${standard.roomId}/invites`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${validToken}`
      }, body: JSON.stringify({ role: "member", expiresInSeconds: 600 }) });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await f.pool!.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
        if (blocked) break;
        await delay(10);
      }
      assert.equal(blocked, true);
      await holderForRole.query("update room_identity_authority_v2 set host_identity_id=$2, revision=revision+1 where room_id=$1",
        [standard.roomId, successor.identity.identityId]);
      await holderForRole.query("commit");
      const denied = await roleRequest;
      assert.equal(denied.status, 403);
      assert.equal((await denied.json() as { error: string }).error, "identity_forbidden");
      assert.equal((await f.storage.listRoomInvites(standard.roomId)).length, beforeDenial);
    } finally {
      await holderForRole.query("rollback").catch(() => undefined);
      holderForRole.release();
      if (roleRequest) await roleRequest.catch(() => undefined);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  }
});

for (const postgres of [false, true]) test(`${postgres ? "postgres" : "memory"}: expiry is checked at the mutation boundary without revoking identity`, {
  skip: postgres && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, postgres);
  const deadline = f.expiresAtSeconds * 1000;
  f.setTime(deadline - 1);
  const locked = await f.storage.roomIdentities.transition(f.scope, f.actor, 1, { type: "lock" });
  assert.equal(locked.revision, 2);
  assert.equal(locked.lifecycle.lockedAt, new Date(deadline - 1).toISOString());
  const invited = await f.storage.createRoomInviteV2(f.invite());
  assert.equal(invited.createdAt, new Date(deadline - 1).toISOString());
  f.setTime(deadline);
  await assert.rejects(f.storage.roomIdentities.transition(f.scope, f.actor, locked.revision, { type: "unlock" }), errorCode("identity_session_expired"));
  await assert.rejects(f.storage.roomIdentities.transition(f.scope, f.actor, 0, { type: "unlock" }), errorCode("identity_session_expired"));
  await assert.rejects(f.storage.createRoomInviteV2(f.invite()), errorCode("identity_session_expired"));
  assert.equal((await f.storage.roomIdentities.authority(f.scope))!.revision, 2);
  assert.equal((await f.storage.listRoomInvites(f.scope.roomId)).length, 1);
  const renewed = await f.service.issueSession(f.host.credential, f.scope);
  assert.equal(renewed.identity.identityId, f.host.identity.identityId);
  assert.equal(renewed.role, "host", "expiry only ends the session, not the underlying possession credential");
  f.setTime(deadline + 3_600_000);
  const unblocked = await f.storage.roomIdentities.transition(f.scope, adminActor, 2, { type: "unlock" });
  assert.equal(unblocked.revision, 3);
  assert.equal((await f.storage.createRoomInviteV2(f.invite(adminActor))).createdAt, new Date(f.now()).toISOString());
  await f.storage.roomIdentities.transition(f.scope, adminActor, 3, { type: "end" });
  await assert.rejects(f.storage.roomIdentities.transition(f.scope, f.actor, 4, { type: "lock" }), errorCode("room_blocked"));
});

test("PostgreSQL samples session expiry after a queued parent-room lock for transition and invite", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, true);
  for (const expireWhileWaiting of [false, true]) {
    for (const kind of ["transition", "invite"] as const) {
      const deadline = f.expiresAtSeconds * 1000;
      f.setTime(deadline - 1);
      const before = (await f.storage.roomIdentities.authority(f.scope))!;
      const beforeInvites = (await f.storage.listRoomInvites(f.scope.roomId)).length;
      const holder = await f.pool!.connect();
      let pending: Promise<unknown> | undefined;
      let settled: Promise<{ ok: boolean; value?: unknown; error?: unknown }> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select room_id from rooms where room_id=$1 for update", [f.scope.roomId]);
        const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
        pending = kind === "transition"
          ? f.storage.roomIdentities.transition(f.scope, f.actor, before.revision, { type: "lock" })
          : f.storage.createRoomInviteV2(f.invite());
        settled = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (await f.pool!.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
          if (blocked) break;
          await delay(10);
        }
        assert.equal(blocked, true);
        if (expireWhileWaiting) f.setTime(deadline);
        await holder.query("commit");
        const result = await settled;
        assert.equal(result.ok, !expireWhileWaiting, `${kind} must use the post-wait clock`);
        if (expireWhileWaiting) assert.ok(errorCode("identity_session_expired")(result.error));
        assert.equal((await f.storage.roomIdentities.authority(f.scope))!.revision,
          before.revision + (kind === "transition" && !expireWhileWaiting ? 1 : 0));
        assert.equal((await f.storage.listRoomInvites(f.scope.roomId)).length,
          beforeInvites + (kind === "invite" && !expireWhileWaiting ? 1 : 0));
      } finally {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
        if (settled) await settled;
      }
    }
  }
});
