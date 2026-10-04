import assert from "node:assert/strict";
import { spawn, type Serializable } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { PostgresStorage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";

const secret = "activation-progress-http-test-key-32-bytes";
const adminActor = { actorType: "admin-token" as const, actorId: "verified-admin", role: "admin" as const };

test("HTTP v2 reopen fences prepared replies; expired sessions are renewable without authenticating revoked or foreign proof", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `activation_progress_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool);
  await storage.init();
  await storage.identityProtocol.raise(2);
  const service = createRoomIdentityService(storage.roomIdentities, secret, Date.now, { identityLifetimeSeconds: 86_400 });
  const codec = createRoomIdentityCodec(secret);
  const sessions = createRoomSessionV2Codec(secret);
  const owned = async () => {
    const created = await storage.createPersonalOwnedRoom({ tenantId: "demo-tenant", templateId: "personal-workspace-basic", displayName: "Owner" });
    return { ...created, scope: { tenantId: created.room.tenantId, roomId: created.room.roomId }, credential: codec.sign(created.identity) };
  };
  const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  // Test-process IPC observes real parser/preparation boundaries and controls
  // the authorization clock. No production hooks or additional HTTP endpoints.
  const script = `
    const {IncomingMessage}=await import('node:http');
    const {Pool}=await import('pg');
    const connect=Pool.prototype.connect;
    Pool.prototype.connect=function(...args){this.options.max=1;return connect.apply(this,args);};
    const {PostgresStorage}=await import(${JSON.stringify(new URL("./storage.js", import.meta.url).href)});
    const release=PostgresStorage.prototype.releasePersonalRoomOwnerResponse,on=IncomingMessage.prototype.on;
    let pause=false,resume,body=false,clock;
    const realNow=Date.now;Date.now=()=>clock??realNow();
    PostgresStorage.prototype.releasePersonalRoomOwnerResponse=async function(...args){
      if(pause){pause=false;process.send('prepared');await new Promise(r=>resume=r);}
      return release.apply(this,args);
    };
    IncomingMessage.prototype.on=function(event,...args){
      const result=on.call(this,event,...args);
      if(body&&event==='end'&&(this.method==='POST'||this.method==='PUT')){body=false;setImmediate(()=>process.send('body-wait'));}
      return result;
    };
    process.on('message',m=>{
      if(m==='arm-preparation'){pause=true;process.send('preparation-armed');}
      if(m==='resume'){resume?.();}
      if(m==='arm-body'){body=true;process.send('body-armed');}
      if(m?.type==='clock'){clock=m.at;process.send('clock-set');}
    });
    await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      ...process.env, POSTGRES_URL: connection.href, NODE_ENV: "development", API_PORT: String(port),
      STATE_TOKEN_SECRET: secret, CONTROL_PLANE_ADMIN_TOKEN: "test-admin", VRATA_INTERNAL_SERVICE_TOKEN: "test-internal",
      VRATA_DISABLE_AUTOSTART: "0", NOAH_DISABLE_AUTOSTART: "0", FEATURE_PERSONAL_ROOMS: "true", FEATURE_HOST_CONTROLS: "true",
      LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-secret", LIVEKIT_URL: "ws://127.0.0.1:7880",
      PRESENCE_TTL_MS: "600000", REMOTE_BROWSER_ENABLED: "true"
    }
  });
  let logs = "";
  child.stdout!.on("data", data => { logs += String(data); }); child.stderr!.on("data", data => { logs += String(data); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  });
  const wait = (expected: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error(`ipc_timeout:${expected}:${logs}`)); }, 5000);
    const receive = (message: unknown) => { if (message === expected) { clearTimeout(timer); child.off("message", receive); resolve(); } };
    child.on("message", receive);
  });
  const command = (message: Serializable, expected: string) => { const ready = wait(expected); child.send(message); return ready; };
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`api_start_failed:${logs}`);
    ready = await fetch(`${base}/health`).then(response => response.ok).catch(() => false);
    if (ready) break;
    await delay(60);
  }
  assert.equal(ready, true, logs);
  const post = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const reopen = (owner: Awaited<ReturnType<typeof owned>>, credential = owner.credential) => post("/api/personal-room",
    { identityProtocolVersion: 2, roomId: owner.room.roomId, identityCredential: credential });
  const noOwnerData = async (response: Response) => {
    const text = await response.text();
    assert.equal(text.includes("identityCredential"), false);
    assert.equal(text.includes("roomLink"), false);
    assert.equal(text.includes("personalState"), false);
    return JSON.parse(text) as { error: string; reason?: string };
  };
  const transfer = async (owner: Awaited<ReturnType<typeof owned>>) => {
    const invite = await storage.createRoomInviteV2({ roomId: owner.room.roomId, role: "member", waitingRoomEnabled: false,
      tokenHash: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + 600_000).toISOString(), actor: adminActor });
    const successor = await service.admit({ ...owner.scope, displayName: "Successor", inviteTokenHash: invite.tokenHash });
    const authority = await storage.roomIdentities.authority(owner.scope);
    await storage.roomIdentities.transition(owner.scope, adminActor, authority!.revision,
      { type: "transfer-owner", targetParticipantId: successor.identity.participantId });
    return successor;
  };
  const control = await owned();
  const successful = await reopen(control);
  assert.equal(successful.status, 200);
  const result = await successful.json() as { identityCredential: string; participantId: string; room: Record<string, unknown> };
  const renewed = codec.verify(result.identityCredential, control.scope)!;
  assert.ok(renewed);
  assert.equal(renewed.expiresAtSeconds - renewed.issuedAtSeconds, 86_400);
  assert.equal(renewed.identityId, control.identity.identityId);
  assert.equal(renewed.authEpoch, control.identity.authEpoch);
  assert.equal(result.participantId, control.identity.participantId);
  assert.equal("personalState" in result.room, false);
  const bearerOnly = await post("/api/personal-room", { identityProtocolVersion: 2, roomId: control.room.roomId }, sessions.sign(control.identity));
  assert.equal(bearerOnly.status, 426); await noOwnerData(bearerOnly);
  const activeWrongRoom = await fetch(`${base}/api/rooms/${randomUUID()}/manifest`, {
    headers: { authorization: `Bearer ${sessions.sign(control.identity)}` }
  });
  assert.equal(activeWrongRoom.status, 403, "active-session foreign-room denial retains its established contract");
  assert.equal((await noOwnerData(activeWrongRoom)).reason, "room_mismatch");
  for (const stopped of ["disable", "end"] as const) {
    const owner = await owned();
    if (stopped === "disable") await storage.updateRoom(owner.room.roomId, { status: "disabled", disabledAt: new Date().toISOString() });
    else await storage.roomIdentities.transition(owner.scope, adminActor, 1, { type: "end" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await reopen(owner);
      assert.equal(response.status, 403, `already-${stopped} owner access is a room refusal, not credential recovery`);
      assert.deepEqual(await noOwnerData(response), { error: "room_access_denied", reason: stopped === "disable" ? "room_disabled" : "session_ended" });
    }
    assert.ok(codec.verify(owner.credential, owner.scope), "the tab can retain its original RI2 after room refusal");
    const identity = await storage.roomIdentities.get(owner.scope, owner.identity.identityId);
    assert.equal(identity!.authEpoch, owner.identity.authEpoch);
    assert.equal(identity!.revokedAt, null);
    assert.equal((await storage.roomIdentities.authority(owner.scope))!.ownerIdentityId, owner.identity.identityId);
    if (stopped === "disable") {
      await storage.updateRoom(owner.room.roomId, { status: "active", disabledAt: null });
      const restored = await reopen(owner);
      assert.equal(restored.status, 200, "reenabling the room permits the original RI2 without recovery");
      const body = await restored.json() as { participantId: string; identityCredential: string };
      assert.equal(body.participantId, owner.identity.participantId);
      assert.equal(codec.verify(body.identityCredential, owner.scope)!.identityId, owner.identity.identityId);
    }
  }
  for (const change of ["transfer", "revoke", "delete", "disable", "end", "expiry"] as const) {
    const owner = await owned();
    const seconds = Math.floor(Date.now() / 1000);
    const credential = change === "expiry" ? codec.sign(owner.identity, { nowSeconds: seconds, lifetimeSeconds: 60 }) : owner.credential;
    await command("arm-preparation", "preparation-armed");
    const prepared = wait("prepared");
    const pending = reopen(owner, credential);
    await prepared;
    const successor = change === "transfer" ? await transfer(owner) : undefined;
    if (change === "revoke") await storage.roomIdentities.revoke(owner.scope, owner.identity.identityId, 1);
    if (change === "delete") await storage.deleteRoom(owner.room.roomId);
    if (change === "disable") await storage.updateRoom(owner.room.roomId, { status: "disabled", disabledAt: new Date().toISOString() });
    if (change === "end") await storage.roomIdentities.transition(owner.scope, adminActor, 1, { type: "end" });
    if (change === "expiry") await command({ type: "clock", at: (seconds + 60) * 1000 }, "clock-set");
    child.send("resume");
    const response = await pending;
    assert.equal(response.status, change === "disable" || change === "end" ? 403 : 409, change);
    const body = await noOwnerData(response);
    assert.equal(body.reason, change === "disable" ? "room_disabled" : change === "end" ? "session_ended" : "identity_recovery_required");
    if (successor) {
      const reopened = await reopen(owner, successor.credential);
      assert.equal(reopened.status, 200);
      const transferred = await reopened.json() as { participantId: string; identityCredential: string; room: { ownerParticipantId: string } };
      assert.equal(transferred.participantId, successor.identity.participantId);
      assert.equal(transferred.room.ownerParticipantId, successor.identity.participantId);
      assert.equal(codec.verify(transferred.identityCredential, owner.scope)!.identityId, successor.identity.identityId);
    }
    await command({ type: "clock", at: null }, "clock-set");
  }
  const heldResponse = async (roomId: string, request: () => Promise<Response>, change: (holder: PoolClient) => Promise<void>) => {
    const holder = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select room_id from rooms where room_id=$1 for update", [roomId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      pending = request();
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (await pool.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
        if (blocked) break;
        await delay(10);
      }
      assert.equal(blocked, true, "response must reach the actual room lock wait");
      await change(holder); await holder.query("commit");
      return await pending;
    } finally { await holder.query("rollback").catch(() => undefined); holder.release(); if (pending) await pending.catch(() => undefined); }
  };
  const queued = await owned();
  const deniedQueued = await heldResponse(queued.room.roomId, () => reopen(queued), async holder => {
    await holder.query("update room_identities_v2 set auth_epoch=auth_epoch+1 where room_id=$1", [queued.room.roomId]);
  });
  assert.equal(deniedQueued.status, 409); await noOwnerData(deniedQueued);

  const bodyWait = async (path: string, body: unknown, during: () => Promise<void>, token?: string, method: "POST" | "PUT" = "POST") => {
    await command("arm-body", "body-armed");
    const observed = wait("body-wait");
    const received = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`${base}${path}`, { method, headers: {
        "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {})
      } }, response => {
        let text = ""; response.on("data", data => { text += String(data); });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      request.on("error", reject);
      const json = JSON.stringify(body); request.write(json.slice(0, -1));
      void observed.then(during).then(() => request.end(json.slice(-1))).catch(error => { request.destroy(); reject(error); });
    });
    return received;
  };
  const bodyOwner = await owned();
  const bodyDenied = await bodyWait("/api/personal-room", { identityProtocolVersion: 2, roomId: bodyOwner.room.roomId,
    identityCredential: bodyOwner.credential }, async () => { await transfer(bodyOwner); });
  assert.equal(bodyDenied.status, 409); assert.equal(bodyDenied.body.includes("identityCredential"), false);

  const expiryOwner = await owned();
  const seconds = Math.floor(Date.now() / 1000);
  const session = sessions.sign(expiryOwner.identity, { nowSeconds: seconds, lifetimeSeconds: 60 });
  const deadline = (seconds + 60) * 1000;
  const stem = `/api/rooms/${expiryOwner.room.roomId}`;
  const lateMutation = await bodyWait(`${stem}/session-control/lock`, { expectedRevision: 1, expiresAtSeconds: seconds + 86_400 },
    () => command({ type: "clock", at: deadline }, "clock-set"), session);
  assert.equal(lateMutation.status, 401); assert.equal(JSON.parse(lateMutation.body).error, "identity_session_expired");
  await command({ type: "clock", at: deadline - 1 }, "clock-set");
  const latePrivate = await heldResponse(expiryOwner.room.roomId,
    () => fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${session}` } }),
    async () => { await command({ type: "clock", at: deadline }, "clock-set"); });
  assert.equal(latePrivate.status, 401); assert.equal((await noOwnerData(latePrivate)).error, "identity_session_expired");
  const expiredEntry = await fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${session}` } });
  assert.equal(expiredEntry.status, 401); assert.equal((await noOwnerData(expiredEntry)).error, "identity_session_expired");
  const bodyToken = await post("/api/tokens/media", { roomId: expiryOwner.room.roomId, participantId: expiryOwner.identity.participantId, sessionToken: session });
  assert.equal(bodyToken.status, 401); assert.equal((await noOwnerData(bodyToken)).error, "identity_session_expired");
  const scopedTokenRequest = (path: string, payload: Record<string, unknown>, token: string, bearer: boolean) =>
    post(path, bearer ? payload : { ...payload, sessionToken: token }, bearer ? token : undefined);
  await t.test("media Bearer and body proofs classify expiry only after room and participant binding", async () => {
    for (const bearer of [true, false]) {
      for (const [roomId, participantId, expected] of [
        [expiryOwner.room.roomId, expiryOwner.identity.participantId, 401],
        [control.room.roomId, expiryOwner.identity.participantId, 409],
        [expiryOwner.room.roomId, "wrong-participant", 409],
        [control.room.roomId, "wrong-participant", 409]
      ] as const) {
        const response = await scopedTokenRequest("/api/tokens/media", { roomId, participantId }, session, bearer);
        assert.equal(response.status, expected, `${bearer ? "Bearer" : "body"}:${roomId}:${participantId}`);
        const body = await noOwnerData(response);
        assert.deepEqual(body, expected === 401 ? { error: "identity_session_expired", reason: "identity_session_expired" }
          : { error: "identity_required", reason: "identity_recovery_required" });
        assert.equal("token" in body, false);
      }
    }
    // Both proof transports still reach the normal main-path issuer for an
    // active bound session; parsing is not duplicated or waiting on a phantom cache.
    await command({ type: "clock", at: deadline - 1 }, "clock-set");
    for (const bearer of [true, false]) {
      const response = await scopedTokenRequest("/api/tokens/media", { roomId: expiryOwner.room.roomId,
        participantId: expiryOwner.identity.participantId }, session, bearer);
      assert.equal(response.status, 200);
      assert.equal(typeof (await response.json() as { token: string }).token, "string");
    }
    await command({ type: "clock", at: deadline }, "clock-set");
  });
  await t.test("frame Bearer and body proofs use the parsed room before expiry refusal", async () => {
    for (const bearer of [true, false]) for (const roomId of [expiryOwner.room.roomId, control.room.roomId]) {
      const response = await scopedTokenRequest("/api/tokens/remote-browser-frame", { roomId, objectId: "browser-1",
        executorSessionId: "remote-browser:browser-1", executorInstanceId: "remote-browser:browser-1:instance:generation-1",
        frameStreamId: "remote-browser:browser-1:frames" }, session, bearer);
      assert.equal(response.status, roomId === expiryOwner.room.roomId ? 401 : 409);
      const body = await noOwnerData(response);
      assert.equal(body.reason, roomId === expiryOwner.room.roomId ? "identity_session_expired" : "identity_recovery_required");
      assert.equal("token" in body, false);
    }
  });
  const peerInvite = await storage.createRoomInviteV2({ roomId: expiryOwner.room.roomId, role: "member", waitingRoomEnabled: false,
    tokenHash: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + 600_000).toISOString(), actor: adminActor });
  const peer = await service.admit({ ...expiryOwner.scope, displayName: "Presence peer", inviteTokenHash: peerInvite.tokenHash });
  const peerToken = sessions.sign(peer.identity, { nowSeconds: seconds, lifetimeSeconds: 600 });
  const longOwnerToken = sessions.sign(expiryOwner.identity, { nowSeconds: seconds, lifetimeSeconds: 600 });
  const presencePath = (participantId: string) => `${stem}/presence/${encodeURIComponent(participantId)}`;
  const presencePayload = (participantId: string, seq: number) => ({ participantId, displayName: "Presence", mode: "desktop",
    rootTransform: { x: 0, y: 0, z: 0 }, muted: true, activeMedia: { audio: false, screenShare: false }, seq });
  const writePresence = (path: string, token: string, participantId: string, seq: number) => fetch(`${base}${path}`, { method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(presencePayload(participantId, seq)) });
  const readPresence = async () => {
    const response = await fetch(`${base}${stem}/presence`, { headers: { authorization: `Bearer ${peerToken}` } });
    assert.equal(response.status, 200);
    return await response.json() as { items: Array<{ participantId: string; seq: number }> };
  };
  let presenceBefore: Awaited<ReturnType<typeof readPresence>>;
  await t.test("expired presence URL participant and room mismatches deny recovery without deleting or overwriting peers", async () => {
    assert.equal((await writePresence(presencePath(expiryOwner.identity.participantId), longOwnerToken, expiryOwner.identity.participantId, 1)).status, 200);
    assert.equal((await writePresence(presencePath(peer.identity.participantId), peerToken, peer.identity.participantId, 2)).status, 200);
    presenceBefore = await readPresence();
    assert.equal(presenceBefore.items.length, 2);
    for (const [path, method, participantId, expected] of [
      [presencePath(expiryOwner.identity.participantId), "DELETE", expiryOwner.identity.participantId, 401],
      [presencePath(peer.identity.participantId), "DELETE", peer.identity.participantId, 409],
      [presencePath(expiryOwner.identity.participantId), "PUT", expiryOwner.identity.participantId, 401],
      [presencePath(peer.identity.participantId), "PUT", peer.identity.participantId, 409],
      [`/api/rooms/${control.room.roomId}/presence/${expiryOwner.identity.participantId}`, "DELETE", expiryOwner.identity.participantId, 409]
    ] as const) {
      const response = method === "PUT" ? await writePresence(path, session, participantId, 999)
        : await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${session}` } });
      assert.equal(response.status, expected, `${method}:${path}`);
      assert.equal((await noOwnerData(response)).reason, expected === 401 ? "identity_session_expired" : "identity_recovery_required");
      assert.deepEqual(await readPresence(), presenceBefore);
    }
    const foreignActive = await fetch(`${base}/api/rooms/${control.room.roomId}/presence/${peer.identity.participantId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${longOwnerToken}` }
    });
    assert.equal(foreignActive.status, 403, "valid foreign-room scope denial retains precedence over participant mismatch");
    assert.equal((await noOwnerData(foreignActive)).reason, "room_mismatch");
    assert.deepEqual(await readPresence(), presenceBefore);
  });
  const internal = await fetch(`${base}/api/internal/identity-session/verify`, { method: "POST", headers: {
    "content-type": "application/json", "x-vrata-internal-token": "test-internal"
  }, body: JSON.stringify({ roomId: expiryOwner.room.roomId, participantId: expiryOwner.identity.participantId, sessionToken: session }) });
  assert.equal(internal.status, 401); assert.equal((await noOwnerData(internal)).error, "identity_session_expired");
  const wrongRoom = await fetch(`${base}/api/rooms/${control.room.roomId}/notes/private`, { headers: { authorization: `Bearer ${session}` } });
  assert.equal(wrongRoom.status, 409); assert.equal((await noOwnerData(wrongRoom)).reason, "identity_recovery_required");
  const parts = session.split(".");
  const forgedClaims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  forgedClaims.expiresAtSeconds--;
  const forgedSession = `rs2.${Buffer.from(JSON.stringify(forgedClaims)).toString("base64url")}.${parts[2]}`;
  for (const badToken of [forgedSession, createRoomSessionV2Codec(`${secret}-foreign-mac`).sign(expiryOwner.identity,
    { nowSeconds: seconds, lifetimeSeconds: 60 }), sessions.sign(expiryOwner.identity, { nowSeconds: seconds + 91, lifetimeSeconds: 60 })]) {
    const denied = await fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${badToken}` } });
    assert.equal(denied.status, 409); assert.equal((await noOwnerData(denied)).reason, "identity_recovery_required");
  }
  const wrongParticipant = await post("/api/tokens/media", { roomId: expiryOwner.room.roomId, participantId: "wrong-participant", sessionToken: session });
  assert.equal(wrongParticipant.status, 409); assert.equal((await noOwnerData(wrongParticipant)).reason, "identity_recovery_required");
  const fresh = await post("/api/tokens/state", { identityProtocolVersion: 2, roomId: expiryOwner.room.roomId, identityCredential: expiryOwner.credential });
  assert.equal(fresh.status, 200); assert.equal((await fresh.json() as { participantId: string }).participantId, expiryOwner.identity.participantId);
  const recovery = await service.issueRecovery({ ...expiryOwner.scope, issuer: adminActor, targetRole: "owner",
    targetParticipantId: expiryOwner.identity.participantId, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const rotated = await service.redeemRecovery(recovery.credential, expiryOwner.scope);
  const staleEpochExpired = await fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${session}` } });
  assert.equal(staleEpochExpired.status, 409); assert.equal((await noOwnerData(staleEpochExpired)).reason, "identity_recovery_required");
  const rotatedExpired = sessions.sign(rotated.identity, { nowSeconds: seconds, lifetimeSeconds: 60 });
  const activeEpochExpired = await fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${rotatedExpired}` } });
  assert.equal(activeEpochExpired.status, 401); assert.equal((await noOwnerData(activeEpochExpired)).error, "identity_session_expired");
  await storage.roomIdentities.revoke(expiryOwner.scope, rotated.identity.identityId, rotated.identity.authEpoch);
  const revokedExpired = await fetch(`${base}${stem}/notes/private`, { headers: { authorization: `Bearer ${rotatedExpired}` } });
  assert.equal(revokedExpired.status, 409); assert.equal((await noOwnerData(revokedExpired)).reason, "identity_recovery_required");
  await t.test("expired epoch and revoked proofs retain recovery precedence for both media transports and presence", async () => {
    for (const token of [session, rotatedExpired]) {
      for (const bearer of [true, false]) {
        const response = await scopedTokenRequest("/api/tokens/media", { roomId: expiryOwner.room.roomId,
          participantId: expiryOwner.identity.participantId }, token, bearer);
        assert.equal(response.status, 409);
        const body = await noOwnerData(response);
        assert.equal(body.reason, "identity_recovery_required");
        assert.equal("token" in body, false);
      }
      const response = await fetch(`${base}${presencePath(expiryOwner.identity.participantId)}`, {
        method: "DELETE", headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 409); assert.equal((await noOwnerData(response)).reason, "identity_recovery_required");
      assert.deepEqual(await readPresence(), presenceBefore!);
    }
  });
  await command({ type: "clock", at: null }, "clock-set");
  await t.test("diagnostics body participant binds expired v2 proof without weakening foreign-room URL refusals", async () => {
    const owner = await owned();
    const seconds = Math.floor(Date.now() / 1000);
    const token = sessions.sign(owner.identity, { nowSeconds: seconds, lifetimeSeconds: 60 });
    const longToken = sessions.sign(owner.identity, { nowSeconds: seconds, lifetimeSeconds: 600 });
    await command({ type: "clock", at: (seconds + 60) * 1000 }, "clock-set");
    const before = await storage.getDiagnostics(owner.room.roomId);
    for (const [roomId, participantId, expected] of [
      [owner.room.roomId, owner.identity.participantId, 401],
      [owner.room.roomId, "wrong-participant", 409],
      [control.room.roomId, owner.identity.participantId, 409]
    ] as const) {
      const response = await post(`/api/rooms/${roomId}/diagnostics`, { participantId, issueCode: "AUTH_FRESHNESS_TEST" }, token);
      assert.equal(response.status, expected);
      assert.equal((await noOwnerData(response)).reason, expected === 401 ? "identity_session_expired" : "identity_recovery_required");
      assert.deepEqual(await storage.getDiagnostics(owner.room.roomId), before);
    }
    const foreignActive = await post(`/api/rooms/${control.room.roomId}/diagnostics`, { participantId: "wrong-participant" }, longToken);
    assert.equal(foreignActive.status, 403); assert.equal((await noOwnerData(foreignActive)).reason, "room_mismatch");
    const current = await post(`/api/rooms/${owner.room.roomId}/diagnostics`, { participantId: owner.identity.participantId,
      issueCode: "AUTH_FRESHNESS_TEST", note: "current proof" }, longToken);
    assert.equal(current.status, 201);
    assert.equal((await storage.getDiagnostics(owner.room.roomId)).length, before.length + 1);
    await command({ type: "clock", at: null }, "clock-set");
  });
  for (const route of ["diagnostics", "xr-telemetry"] as const) await t.test(`${route}: body completion re-resolves expiry and revocation before mutation`, async () => {
    for (const change of ["expiry", "revoke"] as const) {
      const owner = await owned();
      const seconds = Math.floor(Date.now() / 1000);
      const token = sessions.sign(owner.identity, { nowSeconds: seconds, lifetimeSeconds: 60 });
      const deadline = (seconds + 60) * 1000;
      const path = `/api/rooms/${owner.room.roomId}/${route}${route === "xr-telemetry" ? `/${owner.identity.participantId}` : ""}`;
      const method = route === "diagnostics" ? "POST" : "PUT";
      const payload = { participantId: owner.identity.participantId, roomId: owner.room.roomId, kind: "baseline",
        issueCode: "AUTH_FRESHNESS_TEST", note: "baseline", updatedAt: new Date().toISOString() };
      const snapshot = async () => {
        const response = await fetch(`${base}/api/rooms/${owner.room.roomId}/${route}`, { headers: { "x-vrata-admin-token": "test-admin" } });
        assert.equal(response.status, 200);
        return { visible: await response.json(), persisted: route === "diagnostics" ? await storage.getDiagnostics(owner.room.roomId)
          : await storage.getXrTelemetry(owner.room.roomId) };
      };
      await command({ type: "clock", at: deadline - 1 }, "clock-set");
      const current = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload) });
      assert.equal(current.status, route === "diagnostics" ? 201 : 200);
      const before = await snapshot();
      const denied = await bodyWait(path, { ...payload, kind: "must_not_mutate", note: "must not mutate" }, async () => {
        if (change === "expiry") await command({ type: "clock", at: deadline }, "clock-set");
        else await storage.roomIdentities.revoke(owner.scope, owner.identity.identityId, owner.identity.authEpoch);
      }, token, method);
      assert.equal(denied.status, change === "expiry" ? 401 : 409);
      assert.equal(JSON.parse(denied.body).reason, change === "expiry" ? "identity_session_expired" : "identity_recovery_required");
      assert.deepEqual(await snapshot(), before, `${route}:${change}: neither persisted nor visible telemetry changes`);
      await command({ type: "clock", at: null }, "clock-set");
    }
  });
  await t.test("non-string body sessionToken returns deterministic 400 for both token handlers", async () => {
    const owner = await owned();
    const token = sessions.sign(owner.identity);
    for (const sessionToken of [0, 123, {}, []]) for (const bearer of [undefined, token]) {
      for (const path of ["/api/tokens/media", "/api/tokens/remote-browser-frame"]) {
        const response = await post(path, { roomId: owner.room.roomId, participantId: owner.identity.participantId, sessionToken,
          objectId: "browser-1", executorSessionId: "remote-browser:browser-1",
          executorInstanceId: "remote-browser:browser-1:instance:generation-1", frameStreamId: "remote-browser:browser-1:frames" }, bearer);
        assert.equal(response.status, 400);
        assert.deepEqual(await noOwnerData(response), { error: "invalid_session_token" });
      }
    }
  });
});
