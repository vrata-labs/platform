import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { MemoryStorage, PostgresStorage } from "./storage.js";
import type { Storage } from "./storage-contracts.js";
import type { RoomIdentityEffectStorage } from "./storage-contracts.js";
import { IdentityBoundaryError } from "./identity/legacy-boundary.js";
import { identityFenceUnavailable } from "./identity/fence-transaction.js";
import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { createRoomIdentityService } from "./identity/service.js";

const upgrade = (error: unknown) => error instanceof IdentityBoundaryError && error.status === 409 && error.reason === "identity_upgrade_required";

async function fixture(t: TestContext, postgres: boolean) {
  let pool: Pool | undefined;
  let storage: Storage;
  if (postgres) {
    assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
    const schema = `legacy_effect_${randomUUID().replaceAll("-", "")}`;
    const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
    await root.query(`create schema "${schema}"`);
    pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${schema},public` });
    t.after(async () => { await pool!.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
    const pg = new PostgresStorage(pool);
    await pg.init();
    storage = pg;
  } else storage = new MemoryStorage();
  const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Legacy effect",
    roomType: "personal", ownerParticipantId: "legacy-owner", sessionControl: { hostParticipantId: "legacy-owner" } });
  return { storage, pool, room, scope: { tenantId: room.tenantId, roomId: room.roomId } };
}

for (const postgres of [false, true]) test(`${postgres ? "postgres" : "memory"}: legacy facade retains floor1 semantics and denies floor2 or bound rooms`, {
  skip: postgres && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, postgres);
  let escaped!: RoomIdentityEffectStorage;
  await f.storage.withLegacyRoomEffect(f.scope, {}, async scoped => { escaped = scoped; });
  assert.throws(() => escaped.releaseResponse(() => undefined), /room_effect_scope_closed/);
  assert.throws(() => escaped.upsertRoomNote({ roomId: f.scope.roomId, scope: "shared", content: "escaped" }), /room_effect_scope_closed/);
  const invite = await f.storage.createRoomInvite({ roomId: f.scope.roomId, tokenHash: "legacy-hash", role: "member",
    protocolVersion: 1, waitingRoomEnabled: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const pending = await f.storage.createWaitingRoomRequest({ roomId: f.scope.roomId, inviteId: invite.inviteId,
    participantId: "waiting", displayName: "Waiting" });
  await f.storage.withLegacyRoomEffect(f.scope, { roomWrite: true }, async scoped => {
    assert.equal("roomIdentities" in scoped, false);
    assert.equal("identityProtocol" in scoped, false);
    assert.equal("withRoomIdentityEffect" in scoped, false);
    assert.equal((await scoped.updateWaitingRoomRequest(f.scope.roomId, pending.requestId, { status: "approved" }))!.status, "approved");
    assert.equal((await scoped.updateWaitingRoomRequest(f.scope.roomId, pending.requestId, { status: "rejected" }))!.status, "rejected",
      "a legacy scoped instance must not silently acquire v2 finalized-decision semantics");
    await scoped.updatePersonalRoomState(f.scope.tenantId, f.scope.roomId, { lastPose: null });
    let sent = false;
    scoped.releaseResponse(() => { sent = true; });
    assert.equal(sent, true);
    assert.throws(() => scoped.listRoomInvites(f.scope.roomId), /room_effect_response_released/);
  });
  await assert.rejects(f.storage.withLegacyRoomEffect(f.scope, {}, scoped => scoped.updatePersonalRoomState(f.scope.tenantId, f.scope.roomId, {})),
    /personal_state_requires_room_write_fence/);
  const other = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Bound legacy room" });
  const otherScope = { tenantId: other.tenantId, roomId: other.roomId };
  await f.storage.roomIdentities.create({ ...otherScope, displayName: "Bound identity", baseRole: "guest", provenance: { kind: "guest" } });
  await assert.rejects(f.storage.withLegacyRoomEffect(otherScope, {}, async () => undefined), upgrade);
  await f.storage.identityProtocol.raise(2);
  await assert.rejects(f.storage.withLegacyRoomEffect(f.scope, {}, scoped => scoped.upsertRoomNote({ roomId: f.scope.roomId, scope: "shared", content: "must not write" })), upgrade);
  assert.equal(await f.storage.getRoomNote(f.scope.roomId, "shared"), null);
});

test("Memory rechecks legacy mutation and response release after an await gap", async t => {
  const f = await fixture(t, false);
  let resume!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const mutation = f.storage.withLegacyRoomEffect(f.scope, { roomWrite: true }, async scoped => {
    entered(); await wait;
    return scoped.updatePersonalRoomState(f.scope.tenantId, f.scope.roomId, { lastPose: null });
  });
  const result = mutation.then(() => null, error => error);
  await started;
  await f.storage.identityProtocol.raise(2);
  resume();
  assert.ok(upgrade(await result));
  assert.deepEqual(await f.storage.getPersonalRoomState(f.scope.tenantId, f.scope.roomId), {});
  const next = await fixture(t, false);
  let sent = false;
  await assert.rejects(next.storage.withLegacyRoomEffect(next.scope, {}, async scoped => {
    await scoped.getPersonalRoomState(next.scope.tenantId, next.scope.roomId);
    await next.storage.roomIdentities.create({ ...next.scope, displayName: "Binding", baseRole: "guest", provenance: { kind: "guest" } });
    scoped.releaseResponse(() => { sent = true; });
  }), upgrade);
  assert.equal(sent, false);
});

test("Postgres legacy effect orders commit before activation and re-reads a queued raise", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, true);
  let release!: () => void;
  let ready!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const effect = f.storage.withLegacyRoomEffect(f.scope, {}, async scoped => {
    ready(); await wait;
    return scoped.upsertRoomNote({ roomId: f.scope.roomId, scope: "shared", content: "before activation" });
  });
  await entered;
  let raised = false;
  const activation = f.storage.identityProtocol.raise(2).then(value => { raised = true; return value; });
  const activationResult = activation.then(value => ({ value }), error => ({ error }));
  let queued = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    queued = (await f.pool!.query("select exists(select 1 from pg_locks where relation='room_identity_protocol_policy'::regclass and mode='ExclusiveLock' and not granted) as waiting")).rows[0].waiting;
    if (queued) break;
    await delay(10);
  }
  assert.equal(queued, true);
  assert.equal(raised, false);
  release();
  assert.equal((await effect).content, "before activation");
  const activated = await activationResult;
  assert.deepEqual(activated, { value: 2 });
  assert.equal((await f.storage.getRoomNote(f.scope.roomId, "shared"))!.content, "before activation");
  await assert.rejects(f.storage.withLegacyRoomEffect(f.scope, {}, async () => undefined), upgrade);

  const reverse = await fixture(t, true);
  const holder = await reverse.pool!.connect();
  let raisedReverse: Promise<unknown> | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    await holder.query("begin");
    await holder.query("lock table room_identity_protocol_policy in row exclusive mode");
    raisedReverse = reverse.storage.identityProtocol.raise(2);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      blocked = (await reverse.pool!.query("select exists(select 1 from pg_locks where relation='room_identity_protocol_policy'::regclass and mode='ExclusiveLock' and not granted) as waiting")).rows[0].waiting;
      if (blocked) break;
      await delay(10);
    }
    assert.equal(blocked, true);
    void raisedReverse.catch(() => undefined);
    let mutated = false;
    pending = reverse.storage.withLegacyRoomEffect(reverse.scope, {}, async scoped => {
      mutated = true;
      return scoped.upsertRoomNote({ roomId: reverse.scope.roomId, scope: "shared", content: "must not follow activation" });
    });
    const denial = pending.then(() => null, error => error);
    let readerQueued = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      readerQueued = (await reverse.pool!.query("select exists(select 1 from pg_locks where relation='room_identity_protocol_policy'::regclass and mode='RowShareLock' and not granted) as waiting")).rows[0].waiting;
      if (readerQueued) break;
      await delay(10);
    }
    assert.equal(readerQueued, true, "the new reader must queue behind the exclusive activation lock");
    assert.equal(mutated, false);
    await holder.query("commit");
    await raisedReverse;
    assert.ok(upgrade(await denial));
    assert.equal(await reverse.storage.getRoomNote(reverse.scope.roomId, "shared"), null);
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
    if (raisedReverse) await raisedReverse.catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
  }
});

test("Postgres facade never borrows another pool connection and survives an idle-fence backend exit", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, true);
  let inside = false;
  const watched = new Proxy(f.pool!, { get(target, key) {
    if (key === "connect" || key === "query") return (...args: unknown[]) => {
      assert.equal(inside, false, "a callback must use its held client, never the pool");
      return Reflect.apply(target[key], target, args);
    };
    return Reflect.get(target, key, target);
  } });
  const storage = new PostgresStorage(watched);
  await storage.withLegacyRoomEffect(f.scope, { roomWrite: true }, async scoped => {
    inside = true;
    try {
      await scoped.upsertRoomNote({ roomId: f.scope.roomId, scope: "shared", content: "scoped" });
      await scoped.updatePersonalRoomState(f.scope.tenantId, f.scope.roomId, { lastPose: null });
      await scoped.setRoomSceneBundleUrl(f.scope.tenantId, f.scope.roomId, "https://example.test/scene.json");
      await scoped.listRoomInvites(f.scope.roomId);
      await scoped.listWaitingRoomRequests(f.scope.roomId);
    } finally { inside = false; }
  });
  let sent = false;
  let observeDeath!: () => void;
  const death = new Promise<void>(resolve => { observeDeath = resolve; });
  const observePool = new Proxy(f.pool!, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect();
      client.once("error", observeDeath);
      return client;
    };
    return Reflect.get(target, key, target);
  } });
  const observed = new PostgresStorage(observePool);
  await assert.rejects(observed.withLegacyRoomEffect(f.scope, { idleTimeoutMs: 30 }, async scoped => {
    // Wait for the actual pg error event, not a sleep that can race a slow CI
    // runner. The production listener must still mark the fence as unusable.
    await Promise.race([death, delay(2000).then(() => { throw new Error("idle_fence_did_not_exit"); })]);
    scoped.releaseResponse(() => { sent = true; });
  }), error => identityFenceUnavailable(error));
  assert.equal(sent, false, "a lost transaction cannot release data under a dead fence");
  await f.storage.withLegacyRoomEffect(f.scope, {}, scoped => scoped.upsertRoomNote({ roomId: f.scope.roomId, scope: "shared", content: "still alive" }));
  assert.equal((await f.storage.getRoomNote(f.scope.roomId, "shared"))!.content, "still alive");
  assert.equal(identityFenceUnavailable({ code: "55P03" }), true);
  assert.equal(identityFenceUnavailable(new Error("room_template_binding_changed")), false);
});

test("HTTP legacy writes wait only at effect time and deny cutover/binding; lock failure is retryable 503", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  const f = await fixture(t, true);
  const url = new URL(process.env.VRATA_TEST_POSTGRES_URL!);
  url.searchParams.set("options", f.pool!.options.options!);
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const secret = "legacy-cutover-api-test-key-32-bytes-minimum";
  const token = signRoomSessionToken({ tenantId: f.scope.tenantId, roomId: f.scope.roomId,
    participantId: "legacy-owner", displayName: "Owner", role: "host", roleSource: "trusted", permissions: getRoomPermissions("host"),
    sessionId: randomUUID(), jti: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, secret);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, POSTGRES_URL: url.href, NODE_ENV: "development", API_PORT: String(port), STATE_TOKEN_SECRET: secret,
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin", ROOM_ACCESS_POLICY_ENABLED: "true", FEATURE_HOST_CONTROLS: "true"
    }
  });
  let log = "";
  child.stdout!.on("data", chunk => { log += String(chunk); });
  child.stderr!.on("data", chunk => { log += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const path = `/api/rooms/${f.scope.roomId}/notes/private`;
  const note = (x: number) => ({ content: `legacy-${x}` });
  const stalled = async (x: number, change: () => Promise<void>, targetPath = path, targetHeaders = headers) => {
    const body = JSON.stringify(note(x));
    const requestId = randomUUID();
    let finish!: (value: { status: number; body: string }) => void;
    let fail!: (error: Error) => void;
    const received = new Promise<{ status: number; body: string }>((resolve, reject) => { finish = resolve; fail = reject; });
    const request = httpRequest(`${base}${targetPath}`, { method: "PUT", headers: { ...targetHeaders, "x-request-id": requestId } }, response => {
      let text = "";
      response.on("data", chunk => { text += String(chunk); });
      response.on("end", () => finish({ status: response.statusCode ?? 0, body: text }));
    });
    request.on("error", fail);
    request.write(body.slice(0, -1));
    try {
      // This existing audit event is emitted after entry authorization and
      // before parsing the note body. Do not substitute a fixed sleep: an early
      // cutover could otherwise pass by exercising only the entry refusal.
      let admitted = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        admitted = log.split("\n").some(line => {
          try {
            const event = JSON.parse(line) as { event?: string; requestId?: string; action?: string; result?: string };
            return event.event === "room_notes_audit" && event.requestId === requestId && event.action === "notes.save" && event.result === "allowed";
          } catch { return false; }
        });
        if (admitted) break;
        await delay(10);
      }
      assert.equal(admitted, true, "the API must admit this exact legacy request before policy changes");
      await change(); request.end(body.slice(-1)); return await received;
    }
    catch (error) { request.destroy(); throw error; }
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`legacy_api_start_failed:${log}`);
      ready = await fetch(`${base}/health`).then(response => response.ok).catch(() => false);
      if (ready) break;
      await delay(60);
    }
    assert.equal(ready, true);
    const virtualRoomId = `virtual-${randomUUID()}`;
    const virtualTokenResponse = await fetch(`${base}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: virtualRoomId, participantId: "virtual-user", displayName: "Virtual" }) });
    assert.equal(virtualTokenResponse.status, 200);
    const virtualToken = (await virtualTokenResponse.json() as { token: string }).token;
    assert.equal((await fetch(`${base}/api/rooms/${virtualRoomId}/manifest`)).status, 200);
    const virtualPresence = await fetch(`${base}/api/rooms/${virtualRoomId}/presence/virtual-user`, { method: "PUT", headers: {
      "content-type": "application/json", authorization: `Bearer ${virtualToken}`
    }, body: JSON.stringify({ participantId: "virtual-user", displayName: "Virtual", updatedAt: new Date().toISOString() }) });
    assert.equal(virtualPresence.status, 200, "unpersisted v1 fallback rooms retain their API-presence path");
    const virtualList = await fetch(`${base}/api/rooms/${virtualRoomId}/presence`);
    assert.equal((await virtualList.json() as { items: unknown[] }).items.length, 1);
    assert.equal((await stalled(11, async () => undefined)).status, 201);
    const before = await f.storage.getRoomNote(f.scope.roomId, "private", "legacy-owner");
    const holder = await f.pool!.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select room_id from rooms where room_id=$1 for update", [f.scope.roomId]);
      pending = fetch(`${base}${path}`, { method: "PUT", headers, body: JSON.stringify(note(33)) });
      const response = await pending;
      assert.equal(response.status, 503, "room-lock timeout must be retryable, not an untyped 500");
      assert.equal((await response.json() as { error: string }).error, "identity_authority_unavailable");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
      if (pending) await pending.catch(() => undefined);
    }
    assert.deepEqual(await f.storage.getRoomNote(f.scope.roomId, "private", "legacy-owner"), before);
    const boundRoom = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Binding during legacy body",
      roomType: "personal", ownerParticipantId: "legacy-owner", sessionControl: { hostParticipantId: "legacy-owner" } });
    const boundScope = { tenantId: boundRoom.tenantId, roomId: boundRoom.roomId };
    const boundToken = signRoomSessionToken({ tenantId: boundScope.tenantId, roomId: boundScope.roomId, participantId: "legacy-owner",
      displayName: "Owner", role: "host", roleSource: "trusted", permissions: getRoomPermissions("host"), sessionId: randomUUID(), jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, secret);
    const boundResponse = await stalled(77, async () => {
      await f.storage.roomIdentities.create({ ...boundScope, displayName: "Binding", baseRole: "guest", provenance: { kind: "guest" } });
    }, `/api/rooms/${boundScope.roomId}/notes/private`, { ...headers, authorization: `Bearer ${boundToken}` });
    assert.equal(boundResponse.status, 409);
    assert.equal(JSON.parse(boundResponse.body).reason, "identity_upgrade_required");
    assert.equal(await f.storage.identityProtocol.minimum(), 1);
    assert.equal((await fetch(`${base}/api/rooms/${boundScope.roomId}/manifest`)).status, 409,
      "entry policy already rejects an unauthenticated bound-room reader before this new fence");
    assert.equal(await f.storage.getRoomNote(boundScope.roomId, "private", "legacy-owner"), null);
    const publicRoom = await f.storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic",
      name: "Anonymous release fence", visibility: "public" });
    const crossed = await stalled(42, async () => {
      const holdPublic = await f.pool!.connect();
      let anonymous: Promise<Response> | undefined;
      try {
        await holdPublic.query("begin");
        await holdPublic.query("select room_id from rooms where room_id=$1 for update", [publicRoom.roomId]);
        const pid = (await holdPublic.query("select pg_backend_pid() as pid")).rows[0].pid;
        anonymous = fetch(`${base}/api/rooms/${publicRoom.roomId}/manifest`);
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (await f.pool!.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
          if (blocked) break;
          await delay(10);
        }
        assert.equal(blocked, true, "anonymous request must pass entry and actually wait at its response fence");
        // Raise must finish with both the legacy note body and the anonymous
        // response unfinished. The reader has not yet taken a policy share lock.
        assert.equal(await f.storage.identityProtocol.raise(2), 2);
        await holdPublic.query("commit");
        const response = await anonymous;
        assert.equal(response.status, 409);
        const result = await response.json() as { reason: string; schemaVersion?: number; sceneBundle?: unknown };
        assert.equal(result.reason, "identity_upgrade_required");
        assert.equal(result.schemaVersion, undefined);
        assert.equal(result.sceneBundle, undefined);
      } finally {
        await holdPublic.query("rollback").catch(() => undefined);
        holdPublic.release();
        if (anonymous) await anonymous.catch(() => undefined);
      }
    });
    assert.equal(crossed.status, 409);
    assert.equal(JSON.parse(crossed.body).reason, "identity_upgrade_required");
    assert.deepEqual(await f.storage.getRoomNote(f.scope.roomId, "private", "legacy-owner"), before);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  }
});

test("v2 retains an uncertain upload blob and rejects stale presence after room deletion", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000
}, async t => {
  const f = await fixture(t, true);
  await f.storage.identityProtocol.raise(2);
  const secret = "v2-deleted-room-presence-test-key-32-bytes";
  const service = createRoomIdentityService(f.storage.roomIdentities, secret);
  const recovery = await service.issueRecovery({ ...f.scope, targetParticipantId: "legacy-owner", targetRole: "owner",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), issuer: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
  const owner = await service.redeemRecovery(recovery.credential, f.scope);
  const session = await service.issueSession(owner.credential, f.scope);
  const url = new URL(process.env.VRATA_TEST_POSTGRES_URL!);
  url.searchParams.set("options", f.pool!.options.options!);
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const uploadRoot = await mkdtemp(join(tmpdir(), "vrata-uncertain-publication-"));
  // Test-process-only scheduling: delete in the second room read, after the
  // real entry resolver cached the valid v2 actor. Production has no test hook.
  const script = `
    const {PostgresStorage}=await import(${JSON.stringify(new URL("./storage.js", import.meta.url).href)});
    const {default:pg}=await import('pg');
    const connect=pg.Pool.prototype.connect;
    const poolQuery=pg.Pool.prototype.query;
    let uploadArmed=false,adminUploadArmed=false;
    pg.Pool.prototype.query=function(sql,...params) {
      const result=poolQuery.call(this,sql,...params);
      if(adminUploadArmed && String(sql).trim().toLowerCase().startsWith('insert into room_documents')) {
        return Promise.resolve(result).then(()=>{
          adminUploadArmed=false;throw new Error('Query read timeout');
        });
      }
      return result;
    };
    pg.Pool.prototype.connect=function(...args) {
      if(args.length) return connect.apply(this,args);
      return connect.call(this).then(client=>{
        const query=client.query.bind(client),release=client.release;
        let inserted=false;
        client.query=function(sql,...params) {
          const text=String(typeof sql==='string'?sql:sql.text).trim().toLowerCase();
          if(text.startsWith('insert into room_documents')) inserted=true;
          const result=query(sql,...params);
          if(text==='commit' && inserted && uploadArmed) {
            return Promise.resolve(result).then(()=>{
              uploadArmed=false;
              throw Object.assign(new Error('test commit acknowledgement lost'),{code:'ECONNRESET'});
            });
          }
          return result;
        };
        client.release=function(...releaseArgs){client.query=query;return release.apply(this,releaseArgs);};
        return client;
      });
    };
    const original=PostgresStorage.prototype.getRoom;
    let armed=false,reads=0;
    PostgresStorage.prototype.getRoom=async function(id) {
      const room=await original.call(this,id);
      if(armed && id===${JSON.stringify(f.scope.roomId)} && ++reads===2) {
        await this.deleteRoom(id); return null;
      }
      return room;
    };
    process.on('message',message=>{
      if(message==='arm'){armed=true;reads=0;process.send('armed');}
      if(message==='arm-upload'){uploadArmed=true;process.send('upload-armed');}
      if(message==='arm-admin-upload'){adminUploadArmed=true;process.send('admin-upload-armed');}
    });
    await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      ...process.env, POSTGRES_URL: url.href, NODE_ENV: "development", API_PORT: String(port), STATE_TOKEN_SECRET: secret,
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin", ROOM_ACCESS_POLICY_ENABLED: "true", FEATURE_HOST_CONTROLS: "true",
      DOCUMENT_LOCAL_UPLOAD_ROOT: uploadRoot
    }
  });
  let log = "";
  child.stdout!.on("data", chunk => { log += String(chunk); });
  child.stderr!.on("data", chunk => { log += String(chunk); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${session.sessionToken}`, "content-type": "application/json" };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`v2_missing_room_test_start_failed:${log}`);
      ready = await fetch(`${base}/health`).then(response => response.ok).catch(() => false);
      if (ready) break;
      await delay(60);
    }
    assert.equal(ready, true);
    const uploadArmed = once(child, "message");
    child.send("arm-upload");
    assert.equal((await uploadArmed)[0], "upload-armed");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWISW+z1H4QBAAAA///iIMP1AAAABklEQVQDAA/LBAeJ81I+AAAAAElFTkSuQmCC", "base64");
    const form = new FormData();
    form.set("document", new Blob([new Uint8Array(image)], { type: "image/png" }), "uncertain.png");
    const upload = await fetch(`${base}/api/rooms/${f.scope.roomId}/documents`, { method: "POST",
      headers: { authorization: `Bearer ${session.sessionToken}` }, body: form });
    assert.equal(upload.status, 503);
    const documents = await f.storage.listRoomDocuments(f.scope.roomId);
    assert.equal(documents.length, 1, "the fixture really committed before losing the acknowledgement");
    assert.deepEqual(await readFile(join(uploadRoot, documents[0]!.storageKey)), image,
      "an uncertain HTTP publication must not delete a blob referenced by its committed document row");
    const adminArmed = once(child, "message");
    child.send("arm-admin-upload");
    assert.equal((await adminArmed)[0], "admin-upload-armed");
    const adminForm = new FormData();
    adminForm.set("document", new Blob([new Uint8Array(image)], { type: "image/png" }), "uncertain-admin.png");
    assert.equal((await fetch(`${base}/api/rooms/${f.scope.roomId}/documents`, { method: "POST",
      headers: { "x-vrata-admin-token": "test-admin" }, body: adminForm })).status, 503);
    const adminDocument = (await f.storage.listRoomDocuments(f.scope.roomId)).find(document => document.filename === "uncertain-admin.png");
    assert.ok(adminDocument, "the fixture completed its real autocommit write before reporting a timeout");
    assert.deepEqual(await readFile(join(uploadRoot, adminDocument.storageKey)), image);
    const presencePath = `${base}/api/rooms/${f.scope.roomId}/presence`;
    assert.equal((await fetch(`${presencePath}/${owner.identity.participantId}`, { method: "PUT", headers,
      body: JSON.stringify({ participantId: owner.identity.participantId, displayName: "REMAINING-PRESENCE", updatedAt: new Date().toISOString() }) })).status, 200);
    const visible = await fetch(presencePath, { headers });
    assert.ok((await visible.text()).includes("REMAINING-PRESENCE"));
    const armed = once(child, "message");
    child.send("arm");
    assert.deepEqual(await armed, ["armed", undefined]);
    const denied = await fetch(presencePath, { headers });
    assert.equal(denied.status, 404);
    const body = await denied.text();
    assert.equal(JSON.parse(body).error, "room_not_found");
    assert.equal(body.includes("REMAINING-PRESENCE"), false);
    assert.equal(await f.storage.getRoom(f.scope.roomId), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await rm(uploadRoot, { recursive: true, force: true });
  }
});
