import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { PostgresStorage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";

test("v2 scene, presence and invitation effects use current room authority", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
}, async () => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `identity_metadata_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  const storage = new PostgresStorage(pool);
  const secret = "identity-metadata-isolated-state-key-32-bytes";
  const adminActor = { actorType: "admin-token" as const, actorId: "test-admin", role: "admin" as const };
  const service = createRoomIdentityService(storage.roomIdentities, secret);
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  let child: ReturnType<typeof spawn> | undefined;
  let log = "";
  const base = `http://127.0.0.1:${port}`;
  try {
    await admin.query(`create schema "${schema}"`);
    await storage.init();
    await storage.identityProtocol.raise(2);
    const bundle = await storage.createSceneBundle({ bundleId: randomUUID(), storageKey: "fixture/scene.json",
      publicUrl: "https://example.test/fixture/scene.json", contentType: "application/json", provider: "minio-default", version: "test-v1" });
    child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: {
      ...process.env, NODE_ENV: "development", API_PORT: String(port), POSTGRES_URL: connection.href,
      STATE_TOKEN_SECRET: secret, CONTROL_PLANE_ADMIN_TOKEN: "test-admin", ROOM_ACCESS_POLICY_ENABLED: "true",
      FEATURE_HOST_CONTROLS: "true", FEATURE_ROOM_STATE_REALTIME: "false"
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", chunk => { log += String(chunk); });
    child.stderr!.on("data", chunk => { log += String(chunk); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`metadata_api_start_failed:${log}`);
      ready = await fetch(`${base}/health`).then(value => value.ok).catch(() => false);
      if (ready) break;
      await delay(60);
    }
    assert.equal(ready, true, "isolated metadata API must start");
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    const control = { "x-vrata-admin-token": "test-admin", "content-type": "application/json" };

    async function roomWithHost(personal = false) {
      const legacy = randomUUID();
      const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Metadata races",
        sessionControl: { hostParticipantId: legacy }, ...(personal ? { roomType: "personal" as const, ownerParticipantId: legacy } : {}) });
      const scope = { tenantId: room.tenantId, roomId: room.roomId };
      const recovery = await service.issueRecovery({ ...scope, targetParticipantId: legacy, targetRole: personal ? "owner" : "host",
        expiresAt: new Date(Date.now() + 120_000).toISOString(), issuer: adminActor });
      const host = await service.redeemRecovery(recovery.credential, scope);
      const session = await service.issueSession(host.credential, scope);
      return { room, scope, host, token: session.sessionToken };
    }
    async function member(scope: { tenantId: string; roomId: string }, waiting = false) {
      const token = randomUUID();
      const tokenHash = createHmac("sha256", secret).update(token).digest("base64url");
      const invite = await storage.createRoomInviteV2({ roomId: scope.roomId, tokenHash, role: "member",
        waitingRoomEnabled: waiting, expiresAt: new Date(Date.now() + 120_000).toISOString(), actor: adminActor });
      if (waiting) return { invite, pending: await service.beginWaiting({ ...scope, displayName: "Waiting member", inviteTokenHash: tokenHash,
        expiresAt: new Date(Date.now() + 120_000).toISOString() }) };
      const admitted = await service.admit({ ...scope, displayName: "Member", inviteTokenHash: tokenHash });
      const session = await service.issueSession(admitted.credential, scope);
      return { invite, admitted, token: session.sessionToken };
    }
    async function held(roomId: string, path: string, token: string, change: (client: PoolClient) => Promise<void>,
      method = "GET", body?: unknown): Promise<Response> {
      const holder = await pool.connect();
      let pending: Promise<Response> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select room_id from rooms where room_id=$1 for update", [roomId]);
        const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
        let settled = false;
        pending = fetch(`${base}${path}`, { method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
          .then(value => { settled = true; return value; });
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !settled; attempt++) {
          blocked = (await pool.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [pid])).rows[0].waiting;
          if (blocked) break;
          await delay(20);
        }
        assert.equal(blocked, true, `request must reach its authority fence: ${method} ${path}`);
        await change(holder);
        await holder.query("commit");
        return await pending;
      } finally {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
        if (pending) await pending.catch(() => undefined);
      }
    }
    async function delayed(path: string, token: string, body: unknown, change: () => Promise<void>, method = "POST") {
      const wire = JSON.stringify(body);
      let complete!: (value: { status: number; body: string }) => void;
      let fail!: (error: Error) => void;
      const result = new Promise<{ status: number; body: string }>((resolve, reject) => { complete = resolve; fail = reject; });
      const request = httpRequest(`${base}${path}`, { method, headers: headers(token) }, response => {
        let text = "";
        response.on("data", chunk => { text += String(chunk); });
        response.on("end", () => complete({ status: response.statusCode ?? 0, body: text }));
      });
      request.on("error", fail);
      request.write(wire.slice(0, -1));
      try { await delay(100); await change(); request.end(wire.slice(-1)); return await result; }
      catch (error) { request.destroy(); throw error; }
    }
    const scene = await roomWithHost();
    const path = `/api/rooms/${scene.room.roomId}/bind-scene-bundle`;
    const changed = await held(scene.room.roomId, path, scene.token, async client => {
      await client.query("update rooms set visibility='private' where room_id=$1", [scene.room.roomId]);
    }, "POST", { bundleId: bundle.bundleId });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json() as { visibility: string }).visibility, "private");
    assert.equal((await storage.getRoom(scene.room.roomId))!.visibility, "private", "narrow scene writes must not restore an old public visibility");
    assert.equal((await pool.query("select template_snapshot#>>'{roomConfig,sceneBundleUrl}' as url from rooms where room_id=$1", [scene.room.roomId])).rows[0].url, bundle.publicUrl);
    const disabled = await held(scene.room.roomId, path, scene.token, async client => {
      await client.query("update rooms set status='disabled',disabled_at=now() where room_id=$1", [scene.room.roomId]);
    }, "POST", { bundleId: bundle.bundleId });
    assert.equal(disabled.status, 409);
    assert.equal((await storage.getRoom(scene.room.roomId))!.status, "disabled");

    const demoted = await roomWithHost();
    const next = await member(demoted.scope);
    assert.ok(next.admitted && next.token);
    const demotedBinding = await delayed(`/api/rooms/${demoted.room.roomId}/bind-scene-bundle`, demoted.token,
      { bundleId: bundle.bundleId }, async () => {
        const revision = (await storage.roomIdentities.authority(demoted.scope))!.revision;
        await storage.roomIdentities.transition(demoted.scope, adminActor, revision,
          { type: "transfer-host", targetParticipantId: next.admitted!.identity.participantId });
      });
    assert.equal(demotedBinding.status, 403);
    assert.equal((await storage.getRoom(demoted.room.roomId))!.sceneBundleUrl, demoted.room.sceneBundleUrl);

    const personal = await roomWithHost(true);
    const personalGuest = await member(personal.scope);
    assert.ok(personalGuest.admitted);
    await storage.roomIdentities.transition(personal.scope, adminActor, (await storage.roomIdentities.authority(personal.scope))!.revision,
      { type: "transfer-host", targetParticipantId: personalGuest.admitted.identity.participantId });
    assert.equal((await service.resolveSession(personal.token, personal.scope))!.role, "member");
    assert.equal((await fetch(`${base}/api/rooms/${personal.room.roomId}/bind-scene-bundle`, {
      method: "POST", headers: headers(personal.token), body: JSON.stringify({ bundleId: bundle.bundleId })
    })).status, 200, "a Member owner retains scene management without taking Host");
    const pendingGuest = await member(personal.scope, true);
    assert.ok(pendingGuest.pending);
    for (const suffix of ["invites", "waiting-room"]) {
      assert.equal((await fetch(`${base}/api/rooms/${personal.room.roomId}/${suffix}`, { headers: headers(personal.token) })).status, 200);
    }
    const approveUrl = `${base}/api/rooms/${personal.room.roomId}/waiting-room/${pendingGuest.pending.requestId}/approve`;
    assert.equal((await fetch(approveUrl, { method: "POST", headers: headers(personal.token) })).status, 200);
    assert.equal((await fetch(approveUrl, { method: "POST", headers: headers(personal.token) })).status, 200);
    assert.equal((await service.redeemWaiting(pendingGuest.pending.credential, personal.scope)).identity.baseRole, "member");
    const revokeUrl = `${base}/api/rooms/${personal.room.roomId}/invites/${personalGuest.invite.inviteId}/revoke`;
    const originalRevoke = await fetch(revokeUrl, { method: "POST", headers: headers(personal.token) });
    assert.equal(originalRevoke.status, 200);
    const original = await originalRevoke.json() as { revokedAt: string; revokedBy: string };
    const retried = await fetch(revokeUrl, { method: "POST", headers: control });
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), original, "retry must retain the first revocation provenance");
    const singlePool = new Pool({ connectionString: connection.href, max: 1, connectionTimeoutMillis: 1000 });
    try {
      const single = new PostgresStorage(singlePool);
      const guard = { ...personal.host.identity, permission: "room.join" as const, hostOrOwner: true,
        roomWrite: true, expiresAtSeconds: Math.floor(Date.now() / 1000) + 120 };
      assert.equal((await single.withRoomIdentityEffect(guard,
        scoped => scoped.setRoomSceneBundleUrl(personal.scope.tenantId, personal.scope.roomId, bundle.publicUrl)))!.sceneBundleUrl, bundle.publicUrl);
      await assert.rejects(single.withRoomIdentityEffect({ ...guard, roomWrite: false },
        scoped => scoped.setRoomSceneBundleUrl(personal.scope.tenantId, personal.scope.roomId, bundle.publicUrl)), /scene_binding_requires_room_write_fence/);
      const approved = await single.withRoomIdentityEffect({ ...guard, roomWrite: false },
        scoped => scoped.updateWaitingRoomRequest(personal.scope.roomId, pendingGuest.pending!.requestId, { status: "approved" }));
      assert.equal(approved!.status, "approved", "same-decision retry must use the fenced connection even with a one-connection pool");
      assert.ok((await single.withRoomIdentityEffect({ ...guard, roomWrite: false },
        scoped => scoped.listWaitingRoomRequests(personal.scope.roomId))).length > 0);
      assert.ok((await single.withRoomIdentityEffect({ ...guard, roomWrite: false },
        scoped => scoped.listRoomInvites(personal.scope.roomId))).length > 0);
      assert.equal((await single.withRoomIdentityEffect({ ...guard, roomWrite: false },
        scoped => scoped.revokeRoomInvite(personal.scope.roomId, personalGuest.invite.inviteId, new Date().toISOString(), "later")))!.revokedBy, original.revokedBy);
    } finally { await singlePool.end(); }

    for (const suffix of ["invites", "waiting-room", `invites/${next.invite.inviteId}/revoke`]) {
      const former = await held(demoted.room.roomId, `/api/rooms/${demoted.room.roomId}/${suffix}`, next.token,
        async client => { await client.query("update room_identity_authority_v2 set host_identity_id=null,revision=revision+1 where room_id=$1", [demoted.room.roomId]); },
        suffix.endsWith("revoke") ? "POST" : "GET");
      assert.equal(former.status, 403);
      assert.equal((await storage.getRoomInvite(next.invite.inviteId))!.revokedAt, null);
      await storage.roomIdentities.transition(demoted.scope, adminActor, (await storage.roomIdentities.authority(demoted.scope))!.revision,
        { type: "transfer-host", targetParticipantId: next.admitted.identity.participantId });
    }
    const waiting = await member(demoted.scope, true);
    assert.ok(waiting.pending);
    const lateApprove = await held(demoted.room.roomId, `/api/rooms/${demoted.room.roomId}/waiting-room/${waiting.pending.requestId}/approve`, next.token,
      async client => { await client.query("update room_identity_authority_v2 set host_identity_id=null,revision=revision+1 where room_id=$1", [demoted.room.roomId]); }, "POST");
    assert.equal(lateApprove.status, 403);
    assert.equal((await storage.getWaitingRoomRequest(waiting.pending.requestId))!.status, "pending");

    const presence = await roomWithHost();
    const target = await member(presence.scope);
    assert.ok(target.admitted && target.token);
    const presencePath = `/api/rooms/${presence.room.roomId}/presence/${target.admitted.identity.participantId}`;
    const forged = { participantId: "public-id-spoof", displayName: "Member", mode: "desktop", updatedAt: "2099-01-01T00:00:00Z",
      position: { x: 0, y: 1, z: 0 }, rotation: { yaw: 0, pitch: 0 }, role: "admin", permissions: ["room.admin"] };
    const before = Date.now();
    assert.equal((await fetch(`${base}${presencePath}`, { method: "PUT", headers: headers(target.token), body: JSON.stringify(forged) })).status, 200);
    const peers = async () => (await (await fetch(`${base}/api/rooms/${presence.room.roomId}/presence`, { headers: control })).json() as {
      items: Array<{ participantId: string; role: string; permissions: string[]; updatedAt: string }> }).items;
    const peer = (await peers())[0]!;
    assert.equal(peer.participantId, target.admitted.identity.participantId);
    assert.equal(peer.role, "member");
    assert.equal(peer.permissions.includes("room.admin"), false);
    assert.ok(Date.parse(peer.updatedAt) >= before && Date.parse(peer.updatedAt) <= Date.now());
    const latePresence = await delayed(presencePath, target.token, forged, async () => {
      const removed = await fetch(`${base}/api/rooms/${presence.room.roomId}/participants/${target.admitted!.identity.participantId}/remove`,
        { method: "POST", headers: control, body: "{}" });
      assert.equal(removed.status, 200);
    }, "PUT");
    assert.equal(latePresence.status, 409);
    assert.equal((await peers()).some(item => item.participantId === target.admitted!.identity.participantId), false,
      "late presence cannot resurrect a participant already removed by the API");
    const formerHostPresence = await delayed(`/api/rooms/${presence.room.roomId}/presence/${presence.host.identity.participantId}`, presence.token,
      forged, async () => {
        const successor = await member(presence.scope);
        assert.ok(successor.admitted);
        await storage.roomIdentities.transition(presence.scope, adminActor, (await storage.roomIdentities.authority(presence.scope))!.revision,
          { type: "transfer-host", targetParticipantId: successor.admitted.identity.participantId });
      }, "PUT");
    assert.equal(formerHostPresence.status, 200, "a demoted but valid participant can still publish presence");
    assert.equal((await peers()).find(item => item.participantId === presence.host.identity.participantId)!.role, "member");

    for (const suffix of ["manifest", "presence"]) {
      const viewer = await member(presence.scope);
      assert.ok(viewer.admitted && viewer.token);
      const denied = await held(presence.room.roomId, `/api/rooms/${presence.room.roomId}/${suffix}`, viewer.token, async client => {
        await client.query("update room_identities_v2 set auth_epoch=auth_epoch+1,revoked_at=now() where room_id=$1 and identity_id=$2",
          [presence.room.roomId, viewer.admitted!.identity.identityId]);
      });
      assert.equal(denied.status, 409);
    }
    const bindingViewer = await roomWithHost();
    const bindingProof = createRoomIdentityCodec(secret).verify(bindingViewer.host.credential, bindingViewer.scope)!;
    assert.equal((await held(bindingViewer.room.roomId, `/api/rooms/${bindingViewer.room.roomId}/bind-scene-bundle`, bindingViewer.token,
      async client => { await client.query("update room_identities_v2 set auth_epoch=auth_epoch+1,revoked_at=now() where room_id=$1 and identity_id=$2",
        [bindingViewer.room.roomId, bindingProof.identityId]); }, "POST", { bundleId: bundle.bundleId })).status, 409);
    const groupRoom = await roomWithHost();
    const eight = await Promise.all(Array.from({ length: 8 }, () => member(groupRoom.scope)));
    const requests: Array<Promise<Response>> = [];
    for (const participant of eight) {
      assert.ok(participant.admitted && participant.token);
      requests.push(fetch(`${base}/api/rooms/${groupRoom.room.roomId}/presence/${participant.admitted.identity.participantId}`, {
        method: "PUT", headers: headers(participant.token), body: JSON.stringify(forged)
      }));
      requests.push(fetch(`${base}/api/rooms/${groupRoom.room.roomId}/presence`, { headers: headers(participant.token) }));
      requests.push(fetch(`${base}/api/rooms/${groupRoom.room.roomId}/manifest`, { headers: headers(participant.token) }));
    }
    const groupLock = fetch(`${base}/api/rooms/${groupRoom.room.roomId}/session-control/lock`, { method: "POST", headers: control, body: "{}" });
    const responses = await Promise.all(requests);
    assert.ok(responses.every(response => response.status === 200), "eight participants must progress through concurrent presence/manifest fences");
    assert.equal((await groupLock).status, 200, "Host lifecycle writes must still progress alongside the read fences");
    const groupPresence = await fetch(`${base}/api/rooms/${groupRoom.room.roomId}/presence`, { headers: control });
    assert.equal((await groupPresence.json() as { items: unknown[] }).items.length, 8);
    await storage.transitionReferenceTemplateCatalog("active");
    const reference = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Immutable reference scene" });
    const templateBefore = (await pool.query("select template_version,template_snapshot,scene_bundle_url from rooms where room_id=$1", [reference.roomId])).rows[0];
    const rejectedReference = await fetch(`${base}/api/rooms/${reference.roomId}/bind-scene-bundle`, {
      method: "POST", headers: control, body: JSON.stringify({ bundleId: bundle.bundleId })
    });
    assert.equal(rejectedReference.status, 409);
    assert.equal((await rejectedReference.json() as { error: string }).error, "reference_scene_override_not_allowed");
    assert.deepEqual((await pool.query("select template_version,template_snapshot,scene_bundle_url from rooms where room_id=$1", [reference.roomId])).rows[0], templateBefore);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});
