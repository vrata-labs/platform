import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { PostgresStorage } from "./storage.js";
import { createRoomIdentityService } from "./identity/service.js";

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test("internal room-state verifier trusts v2 possession and current authority, never JWT role claims", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 90_000
}, async () => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const schema = `identity_session_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  const documentRoot = await mkdtemp(join(tmpdir(), "vrata-identity-effect-docs-"));
  let failDocumentCleanup = false;
  let documentCleanupCalls = 0;
  const roomStateMock = createHttpServer((request, response) => {
    if (request.method === "DELETE") {
      documentCleanupCalls++;
      response.writeHead(failDocumentCleanup ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ removedCount: 0 }));
    } else { response.writeHead(200); response.end("{}"); }
  });
  roomStateMock.listen(0, "127.0.0.1");
  await once(roomStateMock, "listening");
  const mockStatePort = (roomStateMock.address() as { port: number }).port;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = "identity-session-test-signing-root-32-bytes";
  const internalToken = "identity-session-test-internal";
  let child: ChildProcess | undefined, logs = "";
  try {
    await admin.query(`create schema "${schema}"`);
    const storage = new PostgresStorage(pool);
    await storage.init();
    const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", roomId: randomUUID(), name: "Identity authority verifier" });
    const scope = { tenantId: room.tenantId, roomId: room.roomId };
    const identity = await storage.roomIdentities.create({ ...scope, displayName: "Host", baseRole: "member",
      provenance: { kind: "invite", role: "host", inviteId: "fixture-created-before-activation" } });
    const credential = createRoomIdentityCodec(secret).sign(identity);
    const service = createRoomIdentityService(storage.roomIdentities, secret);
    const { sessionToken } = await service.issueSession(credential, scope);
    child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], { env: {
      ...process.env, NODE_ENV: "development", POSTGRES_URL: connection.href,
      CONTROL_PLANE_ADMIN_TOKEN: "test-admin", VRATA_INTERNAL_SERVICE_TOKEN: internalToken,
      DOCUMENT_LOCAL_UPLOAD_ROOT: documentRoot,
      ROOM_STATE_INTERNAL_URL: `http://127.0.0.1:${mockStatePort}`,
      VRATA_IDENTITY_PROXY_TOKEN: "identity-session-test-proxy-key-32-bytes",
      LIVEKIT_API_KEY: "media-test-key", LIVEKIT_API_SECRET: "media-test-secret", LIVEKIT_URL: "ws://127.0.0.1:7880",
      STATE_TOKEN_SECRET: secret, API_PORT: String(port), VRATA_DISABLE_AUTOSTART: "0", NOAH_DISABLE_AUTOSTART: "0"
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", data => { logs += String(data); }); child.stderr?.on("data", data => { logs += String(data); });
    for (let i = 0; i < 240; i++) {
      if (child.exitCode !== null) throw new Error(`api_start_failed:${logs}`);
      if (await fetch(`${baseUrl}/health`).then(response => response.ok, () => false)) break;
      if (i === 239) throw new Error(`api_start_timeout:${logs}`);
      await delay(250);
    }
    const verify = (token: string, participantId = identity.participantId, headers: Record<string, string> = { "x-vrata-internal-token": internalToken }) =>
      fetch(`${baseUrl}/api/internal/identity-session/verify`, { method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ roomId: scope.roomId, participantId, sessionToken: token }) });
    const delayedBody = async (path: string, token: string, contentType: string, prefix: Buffer, suffix: Buffer,
      duringBody: () => Promise<void>, method: "PUT" | "POST" = "POST"): Promise<{ status: number; body: string }> => {
      let complete!: (value: { status: number; body: string }) => void;
      let fail!: (error: Error) => void;
      const received = new Promise<{ status: number; body: string }>((resolve, reject) => { complete = resolve; fail = reject; });
      const outgoing = httpRequest(`${baseUrl}${path}`, { method, headers: {
        "content-type": contentType, authorization: `Bearer ${token}`
      } }, result => {
        let body = "";
        result.on("data", chunk => { body += String(chunk); });
        result.on("end", () => complete({ status: result.statusCode ?? 0, body }));
      });
      outgoing.on("error", fail);
      outgoing.write(prefix);
      try {
        await delay(100);
        await duringBody();
        outgoing.end(suffix);
        return await received;
      } catch (error) {
        outgoing.destroy();
        throw error;
      }
    };
    const delayedJson = (path: string, token: string, prefix: string, suffix: string,
      duringBody: () => Promise<void>, method: "PUT" | "POST" = "POST") =>
      delayedBody(path, token, "application/json", Buffer.from(prefix), Buffer.from(suffix), duringBody, method);
    const heldRoomRead = async (targetRoomId: string, path: string, token: string,
      change: (holder: import("pg").PoolClient) => Promise<void>) => {
      const holder = await pool.connect();
      let pending: Promise<Response> | undefined;
      try {
        await holder.query("begin");
        await holder.query("select room_id from rooms where room_id=$1 for update", [targetRoomId]);
        const holderPid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        let settled = false;
        pending = fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } }).then(value => { settled = true; return value; });
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !settled; attempt++) {
          blocked = (await pool.query("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting", [holderPid])).rows[0].waiting;
          if (blocked) break;
          await delay(20);
        }
        assert.equal(blocked, true, `the prepared response must wait behind the room authority transaction: ${path}`);
        await change(holder);
        await holder.query("commit");
        return await pending;
      } finally {
        await holder.query("rollback").catch(() => undefined);
        holder.release();
        if (pending) await pending.catch(() => undefined);
      }
    };
    assert.equal((await verify(sessionToken, identity.participantId, {})).status, 403);
    assert.equal((await verify(sessionToken)).status, 409, "no v2 session is usable before activation");
    const legacyPersonal = await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic", name: "Legacy personal materials",
      roomType: "personal", ownerParticipantId: "legacy-personal-owner", visibility: "private" });
    const publicRoom = await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic", name: "Server-issued IDs" });
    const legacyHostRoom = await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic",
      name: "Pre-cutover Host", sessionControl: { hostParticipantId: "legacy-host-id" } });
    const publicScope = { tenantId: publicRoom.tenantId, roomId: publicRoom.roomId };
    const oldStateResponse = await fetch(`${baseUrl}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: publicRoom.roomId, participantId: "legacy-listener", displayName: "Listener" }) });
    assert.equal(oldStateResponse.status, 200);
    const oldSession = await oldStateResponse.json() as { token: string };
    const media = async (token: string, participantId: string) => {
      const response = await fetch(`${baseUrl}/api/tokens/media`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: publicRoom.roomId, participantId, sessionToken: token, canPublishAudio: true, canPublishVideo: false }) });
      assert.equal(response.status, 200);
      const { token: mediaToken } = await response.json() as { token: string };
      return JSON.parse(Buffer.from(mediaToken.split(".")[1]!, "base64url").toString("utf8")) as { video: { room: string } };
    };
    const oldMediaRoom = (await media(oldSession.token, "legacy-listener")).video.room;
    assert.equal(oldMediaRoom, `${process.env.LIVEKIT_ROOM_PREFIX ?? "vrata-"}${publicRoom.roomId}`);
    assert.equal((await pool.query("select count(*)::integer as total from room_identity_admission_buckets_v2")).rows[0].total, 0,
      "legacy issuance is not subject to the prepared v2 budget");
    await storage.identityProtocol.raise(2);
    const recover = (targetRoomId: string, participantId: string, role: "host" | "owner", authorized = true) =>
      fetch(`${baseUrl}/api/rooms/${targetRoomId}/identity-recovery`, { method: "POST", headers: {
        "content-type": "application/json", ...(authorized ? { "x-vrata-admin-token": "test-admin" } : {})
      }, body: JSON.stringify({ participantId, role }) });
    assert.equal((await recover(legacyHostRoom.roomId, "legacy-host-id", "host", false)).status, 401);
    const oldHostJwt = signRoomSessionToken({ tenantId: legacyHostRoom.tenantId, roomId: legacyHostRoom.roomId,
      participantId: "legacy-host-id", displayName: "Legacy Host", role: "host", roleSource: "trusted",
      permissions: [], sessionId: randomUUID(), jti: randomUUID(), iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600 }, secret);
    assert.equal((await fetch(`${baseUrl}/api/rooms/${legacyHostRoom.roomId}/identity-recovery`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${oldHostJwt}` },
      body: JSON.stringify({ participantId: "legacy-host-id", role: "host" })
    })).status, 403, "an old trusted Host JWT cannot issue its own recovery secret");
    assert.equal((await recover(legacyHostRoom.roomId, "spoofed-host", "host")).status, 403);
    const hostRecovery = await recover(legacyHostRoom.roomId, "legacy-host-id", "host");
    assert.equal(hostRecovery.status, 201);
    assert.equal(hostRecovery.headers.get("cache-control"), "no-store");
    const hostProof = (await hostRecovery.json() as { recoveryCredential: string }).recoveryCredential;
    assert.ok(hostProof.startsWith("rr2."));
    const redeem = (targetRoomId: string, recoveryCredential: string) => fetch(`${baseUrl}/api/tokens/state`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        roomId: targetRoomId, identityProtocolVersion: 2, participantId: "spoofed-public-id", recoveryCredential
      })
    });
    assert.equal((await redeem(publicRoom.roomId, hostProof)).status, 409, "recovery proof is room-bound");
    const hostSession = await redeem(legacyHostRoom.roomId, hostProof);
    assert.equal(hostSession.status, 200);
    const restoredHost = await hostSession.json() as { participantId: string; role: string; identityCredential: string };
    assert.equal(restoredHost.participantId, "legacy-host-id");
    assert.equal(restoredHost.role, "host");
    assert.ok(restoredHost.identityCredential.startsWith("ri2."));
    assert.equal((await redeem(legacyHostRoom.roomId, hostProof)).status, 409, "recovery proof is single-use");
    const expiring = await createRoomIdentityService(storage.roomIdentities, secret).issueRecovery({
      tenantId: legacyHostRoom.tenantId, roomId: legacyHostRoom.roomId,
      targetParticipantId: "legacy-host-id", targetRole: "host", expiresAt: new Date(Date.now() + 3000).toISOString(),
      issuer: { actorType: "admin-token", actorId: "test-admin", role: "admin" }
    });
    await delay(3200);
    assert.equal((await redeem(legacyHostRoom.roomId, expiring.credential)).status, 409, "expired recovery proof cannot be redeemed");
    const ownerRecovery = await recover(legacyPersonal.roomId, "legacy-personal-owner", "owner");
    assert.equal(ownerRecovery.status, 201);
    const ownerProof = (await ownerRecovery.json() as { recoveryCredential: string }).recoveryCredential;
    const ownerSession = await redeem(legacyPersonal.roomId, ownerProof);
    assert.equal(ownerSession.status, 200);
    const restoredOwner = await ownerSession.json() as { participantId: string; role: string; isOwner: boolean; token: string };
    assert.equal(restoredOwner.participantId, "legacy-personal-owner");
    assert.equal(restoredOwner.role, "host");
    assert.equal(restoredOwner.isOwner, true);
    assert.equal((await fetch(`${baseUrl}/api/rooms/${legacyPersonal.roomId}/personal-state`, {
      headers: { authorization: `Bearer ${restoredOwner.token}` }
    })).status, 200, "legacy owner recovers private state without changing participant ID");
    const legacyRoomV2Join = await fetch(`${baseUrl}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: legacyHostRoom.roomId, identityProtocolVersion: 2, participantId: "legacy-host-id", displayName: "New guest" }) });
    assert.equal(legacyRoomV2Join.status, 200, JSON.stringify(await legacyRoomV2Join.json()));
    const personal = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/personal-room`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityProtocolVersion: 2, ...body })
    });
    assert.equal((await personal({ participantId: "legacy-personal-owner", displayName: "Legacy Owner" })).status, 409);
    const opened = await personal({ participantId: "someone-else", displayName: "Owner" });
    assert.equal(opened.status, 201);
    const owned = await opened.json() as { room: { roomId: string; tenantId: string; ownerParticipantId: string }; participantId: string;
      identityCredential: string; identityProtocolVersion: number };
    assert.equal(owned.identityProtocolVersion, 2);
    assert.equal(owned.room.ownerParticipantId, owned.participantId);
    assert.notEqual(owned.participantId, "someone-else");
    assert.ok(owned.identityCredential.startsWith("ri2."));
    const reopened = await personal({ roomId: owned.room.roomId, identityCredential: owned.identityCredential });
    assert.equal(reopened.status, 200);
    const continuity = await reopened.json() as typeof owned & { created: boolean };
    assert.equal(continuity.created, false);
    assert.equal(continuity.participantId, owned.participantId);
    assert.notEqual(continuity.identityCredential, owned.identityCredential);
    assert.equal((await personal({ roomId: owned.room.roomId, identityCredential: "ri2.invalid", participantId: owned.participantId })).status, 409);
    assert.equal((await personal({ roomId: owned.room.roomId })).status, 409, "a known room without owner proof cannot create a replacement");
    const behalf = await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic",
      roomType: "personal", ownerParticipantId: "admin-selected-public-id", name: "Ownership handoff",
      visibility: "private", guestAllowed: false });
    const memberInvite = async () => {
      const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
      await storage.createRoomInviteV2({ roomId: behalf.roomId, tokenHash: createHmac("sha256", secret).update(token).digest("base64url"),
        role: "member", waitingRoomEnabled: false, expiresAt: new Date(Date.now() + 300_000).toISOString(),
        actor: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
      return token;
    };
    const recipientJoin = async (inviteToken: string) => fetch(`${baseUrl}/api/tokens/state`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: behalf.roomId, identityProtocolVersion: 2, inviteToken, displayName: "Recipient" })
    });
    const recipientEntry = await recipientJoin(await memberInvite());
    assert.equal(recipientEntry.status, 200);
    const recipient = await recipientEntry.json() as { participantId: string; token: string; identityCredential: string; role: string; isOwner: boolean };
    assert.equal(recipient.role, "member");
    assert.equal(recipient.isOwner, false);
    const handoff = (participantId: string, expectedRevision: number | undefined, bearer?: string, admin = false) =>
      fetch(`${baseUrl}/api/rooms/${behalf.roomId}/owner/transfer`, { method: "POST", headers: {
        "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(admin ? { "x-vrata-admin-token": "test-admin" } : {})
      }, body: JSON.stringify({ participantId, expectedRevision }) });
    assert.equal((await handoff(recipient.participantId, undefined, undefined, true)).status, 400,
      "ownership transfer requires a compare-and-swap revision");
    assert.equal((await handoff("admin-selected-public-id", 0, undefined, true)).status, 403,
      "a chosen public ID is not an admitted target");
    assert.equal((await handoff(identity.participantId, 0, undefined, true)).status, 403,
      "an identity admitted to a different room cannot receive ownership");
    const firstHandoff = await handoff(recipient.participantId, 0, undefined, true);
    assert.equal(firstHandoff.status, 200);
    assert.equal((await firstHandoff.json() as { revision: number; ownerParticipantId: string }).revision, 1);
    assert.equal((await handoff(recipient.participantId, 0, undefined, true)).status, 409,
      "repeating a stale handoff cannot override current authority");
    const ownerProjection = await fetch(`${baseUrl}/api/rooms/${behalf.roomId}/session-control`, {
      headers: { authorization: `Bearer ${recipient.token}` }
    });
    assert.equal(ownerProjection.status, 200);
    const view = await ownerProjection.json() as { authorityRevision: number; ownerParticipantId: string;
      participant: { role: string; isOwner: boolean; permissions: string[] } };
    assert.equal(view.authorityRevision, 1);
    assert.equal(view.ownerParticipantId, recipient.participantId);
    assert.equal(view.participant.role, "member");
    assert.equal(view.participant.isOwner, true);
    assert.equal(view.participant.permissions.includes("room.session-control"), false,
      "proof-bound ownership is independent from Host permissions");
    assert.equal((await fetch(`${baseUrl}/api/rooms/${behalf.roomId}/personal-state`, {
      headers: { authorization: `Bearer ${recipient.token}` }
    })).status, 200);
    const nextJoin = await recipientJoin(await memberInvite());
    assert.equal(nextJoin.status, 200);
    const nextOwner = await nextJoin.json() as typeof recipient;
    assert.equal((await handoff(nextOwner.participantId, 1, recipient.token)).status, 200,
      "the current owner may hand off to a second proof-bound identity");
    assert.equal((await fetch(`${baseUrl}/api/rooms/${behalf.roomId}/personal-state`, {
      headers: { authorization: `Bearer ${recipient.token}` }
    })).status, 403, "previous owner loses private room access even though its proof remains valid");
    const nextProjection = await fetch(`${baseUrl}/api/rooms/${behalf.roomId}/session-control`, {
      headers: { authorization: `Bearer ${nextOwner.token}` }
    });
    assert.equal((await nextProjection.json() as { participant: { isOwner: boolean } }).participant.isOwner, true);
    assert.equal((await fetch(`${baseUrl}/api/rooms/${behalf.roomId}/session-control/lock`, {
      method: "POST", headers: { authorization: `Bearer ${nextOwner.token}` }
    })).status, 200, "a proof-bound Member owner can control their room without taking the Host role");
    assert.equal((await handoff(recipient.participantId, 2, recipient.token)).status, 403,
      "former owner cannot retake ownership using its old room session");
    const first = await verify(sessionToken);
    assert.equal(first.status, 200);
    const manifest = await fetch(`${baseUrl}/api/rooms/${room.roomId}/manifest`, { headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json() as { roomId: string }).roomId, room.roomId);
    const wrongRoom = await fetch(`${baseUrl}/api/rooms/${randomUUID()}/manifest`, { headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(wrongRoom.status, 403);
    const oldSignedState = signRoomSessionToken({ ...scope, participantId: identity.participantId,
      displayName: "Old Host", role: "host", permissions: [], sessionId: randomUUID(), iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900, jti: randomUUID() }, secret);
    assert.equal((await fetch(`${baseUrl}/api/rooms/${room.roomId}/manifest`, { headers: { authorization: `Bearer ${oldSignedState}` } })).status, 409);
    const before = await first.json() as { role: string; permissions: string[]; identityId: string; authEpoch: number; sessionId: string };
    assert.equal(before.role, "member");
    assert.equal(before.identityId, identity.identityId);
    assert.equal(before.authEpoch, 1);
    assert.equal(before.permissions.includes("room.session-control"), false);
    const controlBefore = await fetch(`${baseUrl}/api/rooms/${room.roomId}/session-control`, { headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(controlBefore.status, 200);
    const initialControl = await controlBefore.json() as { state: { hostParticipantId: string | null }; participant: { role: string }; token?: string };
    assert.equal(initialControl.state.hostParticipantId, null);
    assert.equal(initialControl.participant.role, "member");
    assert.equal(initialControl.token, undefined, "v2 refresh must not silently mint a legacy JWT");
    assert.equal((await verify(sessionToken, "spoofed-public-id")).status, 401);
    const now = Math.floor(Date.now() / 1000);
    const legacy = signRoomSessionToken({ ...scope, participantId: identity.participantId, displayName: "Legacy Host", role: "host",
      roleSource: "trusted", permissions: [], sessionId: randomUUID(), iat: now, exp: now + 900, jti: randomUUID() }, secret);
    assert.equal((await verify(legacy)).status, 401);
    await storage.roomIdentities.claimHost(identity, 0);
    const host = await verify(sessionToken);
    assert.equal(host.status, 200);
    const elevated = await host.json() as typeof before;
    assert.equal(elevated.role, "host");
    assert.equal(elevated.permissions.includes("room.session-control"), true);
    assert.equal(elevated.sessionId, before.sessionId);
    const controlAfter = await fetch(`${baseUrl}/api/rooms/${room.roomId}/session-control`, { headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(controlAfter.status, 200);
    const hostControl = await controlAfter.json() as typeof initialControl;
    assert.equal(hostControl.state.hostParticipantId, identity.participantId);
    assert.equal(hostControl.participant.role, "host");
    assert.equal(hostControl.token, undefined);
    const action = (type: "lock" | "unlock", expectedRevision: number) => fetch(`${baseUrl}/api/rooms/${room.roomId}/session-control/${type}`, {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision })
    });
    const locked = await action("lock", 1);
    assert.equal(locked.status, 200);
    const lockedState = await locked.json() as { revision: number; state: { lockedAt: string | null } };
    assert.equal(lockedState.revision, 2);
    assert.ok(lockedState.state.lockedAt);
    assert.equal((await action("unlock", 1)).status, 409, "a stale command cannot overwrite the current lifecycle");
    const unlocked = await action("unlock", 2);
    assert.equal(unlocked.status, 200);
    assert.equal((await unlocked.json() as typeof lockedState).state.lockedAt, null);
    await storage.roomIdentities.revoke(scope, identity.identityId, 1);
    assert.equal((await verify(sessionToken)).status, 401, "revocation invalidates existing live sessions without trusting cached role");
    assert.equal((await fetch(`${baseUrl}/api/rooms/${room.roomId}/session-control`, { headers: { authorization: `Bearer ${sessionToken}` } })).status, 409);

    const issue = (body: Record<string, unknown>, bearer?: string) => fetch(`${baseUrl}/api/tokens/state`, {
      method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ roomId: publicRoom.roomId, identityProtocolVersion: 2, ...body })
    });
    assert.equal((await issue({ participantId: identity.participantId, requestedRole: "host", displayName: "Old client", identityProtocolVersion: 1 })).status, 426);
    const guest = await issue({ participantId: identity.participantId, requestedRole: "host", displayName: "New guest" });
    assert.equal(guest.status, 200);
    const created = await guest.json() as { participantId: string; identityCredential: string; token: string; role: string };
    assert.notEqual(created.participantId, identity.participantId);
    assert.equal(created.role, "guest");
    assert.equal(created.token.startsWith("rs2."), true);
    const v2MediaRoom = (await media(created.token, created.participantId)).video.room;
    assert.equal(v2MediaRoom, `${process.env.LIVEKIT_ROOM_PREFIX ?? "vrata-"}v2:${await storage.identityProtocol.mediaNamespace()}:${publicRoom.roomId}`);
    assert.notEqual(v2MediaRoom, oldMediaRoom, "a pre-cutover LiveKit token cannot connect to the v2 room");
    const executorMedia = await fetch(`${baseUrl}/api/tokens/remote-browser-media`, { method: "POST", headers: {
      "content-type": "application/json", "x-vrata-internal-token": internalToken
    }, body: JSON.stringify({ roomId: publicRoom.roomId, objectId: "browser-1", executorSessionId: "remote-browser:browser-1",
      executorInstanceId: "remote-browser:browser-1:instance:generation-1", mediaParticipantId: "remote-browser:browser-1" }) });
    assert.equal(executorMedia.status, 200, "a verified executor may publish in the v2 media namespace");
    const executorJwt = (await executorMedia.json() as { token: string }).token;
    assert.equal((JSON.parse(Buffer.from(executorJwt.split(".")[1]!, "base64url").toString("utf8")) as { video: { room: string } }).video.room, v2MediaRoom);
    const endedExecutorRoom = await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic", name: "Ended browser media" });
    await storage.roomIdentities.transition({ tenantId: endedExecutorRoom.tenantId, roomId: endedExecutorRoom.roomId },
      { actorType: "admin-token", actorId: "test-admin", role: "admin" }, 0, { type: "end" });
    assert.equal((await fetch(`${baseUrl}/api/tokens/remote-browser-media`, { method: "POST", headers: {
      "content-type": "application/json", "x-vrata-internal-token": internalToken
    }, body: JSON.stringify({ roomId: endedExecutorRoom.roomId, objectId: "browser-1", executorSessionId: "remote-browser:browser-1",
      executorInstanceId: "remote-browser:browser-1:instance:generation-1", mediaParticipantId: "remote-browser:browser-1" }) })).status, 409,
    "an ended v2 room cannot issue new remote-browser publication grants");
    const spaces = await fetch(`${baseUrl}/api/rooms/${publicRoom.roomId}/spaces`, { headers: { authorization: `Bearer ${created.token}` } });
    assert.equal(spaces.status, 200, "the authenticated selector continues to work after activation");
    const repeated = await issue({ participantId: created.participantId, requestedRole: "host" });
    assert.equal(repeated.status, 200);
    assert.notEqual((await repeated.json() as { participantId: string }).participantId, created.participantId, "public ID is not proof");
    const renewal = await issue({ identityCredential: created.identityCredential, requestedRole: "host" });
    assert.equal(renewal.status, 200);
    const continued = await renewal.json() as typeof created;
    assert.equal(continued.participantId, created.participantId);
    assert.equal(continued.role, "guest");
    assert.notEqual(continued.identityCredential, created.identityCredential);
    assert.equal((await issue({ identityCredential: created.identityCredential }, legacy)).status, 426);
    assert.equal((await issue({ identityCredential: "ri2.invalid", inviteToken: "a".repeat(64) })).status, 409);

    const inviteToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    const inviteTokenHash = createHmac("sha256", secret).update(inviteToken).digest("base64url");
    await storage.createRoomInviteV2({ roomId: publicRoom.roomId, tokenHash: inviteTokenHash, role: "host", actor: {
      actorType: "admin-token", actorId: "test-admin", role: "admin" },
      waitingRoomEnabled: false, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const invited = await issue({ inviteToken, participantId: "legacy-host", displayName: "New Host" });
    assert.equal(invited.status, 200);
    const hostEntry = await invited.json() as typeof created;
    assert.equal(hostEntry.role, "host");
    assert.notEqual(hostEntry.participantId, "legacy-host");
    assert.equal((await storage.roomIdentities.authority(publicScope))?.revision, 1);

    const waitingToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    const waitingHash = createHmac("sha256", secret).update(waitingToken).digest("base64url");
    await storage.createRoomInviteV2({ roomId: publicRoom.roomId, tokenHash: waitingHash, role: "member", actor: {
      actorType: "admin-token", actorId: "test-admin", role: "admin" },
      waitingRoomEnabled: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const waiting = await issue({ inviteToken: waitingToken, participantId: created.participantId, displayName: "Pending member" });
    assert.equal(waiting.status, 202);
    const pending = await waiting.json() as { accessRequestId: string; waitingCredential: string };
    assert.ok(pending.accessRequestId);
    assert.ok(pending.waitingCredential.startsWith("rw2."));
    assert.equal((await issue({ waitingCredential: pending.waitingCredential })).status, 202);
    const approved = await fetch(`${baseUrl}/api/rooms/${publicRoom.roomId}/waiting-room/${pending.accessRequestId}/approve`, {
      method: "POST", headers: { "x-vrata-admin-token": "test-admin" }
    });
    assert.equal(approved.status, 200);
    const admitted = await issue({ waitingCredential: pending.waitingCredential, participantId: identity.participantId });
    assert.equal(admitted.status, 200);
    const resumed = await admitted.json() as typeof created;
    assert.equal(resumed.role, "member");
    assert.notEqual(resumed.participantId, identity.participantId);
    assert.equal((await issue({ waitingCredential: pending.waitingCredential })).status, 409, "pending proof is consumed once");
    assert.equal((await storage.roomIdentities.resolve({ ...publicScope,
      identityId: createRoomIdentityCodec(secret).verify(resumed.identityCredential, publicScope)!.identityId,
      participantId: resumed.participantId, authEpoch: 1 }))?.role, "member");
    const notesRoom = await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic", name: "Delayed notes authorization" });
    const notesScope = { tenantId: notesRoom.tenantId, roomId: notesRoom.roomId };
    const writerResponse = await fetch(`${baseUrl}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: notesRoom.roomId, identityProtocolVersion: 2, displayName: "Temporary Presenter" }) });
    assert.equal(writerResponse.status, 200);
    const writer = await writerResponse.json() as { token: string; participantId: string };
    const granted = await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" }, 0,
      { type: "grant-presenter", targetParticipantId: writer.participantId });
    assert.equal((await fetch(`${baseUrl}/api/rooms/${notesRoom.roomId}/notes/shared`, { method: "PUT", headers: {
      "content-type": "application/json", authorization: `Bearer ${writer.token}`
    }, body: JSON.stringify({ content: "before demotion" }) })).status, 201);
    const delayedNote = await delayedJson(`/api/rooms/${notesRoom.roomId}/notes/shared`, writer.token,
      '{"content":"after ', 'demotion"}', async () => {
        await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" }, granted.revision,
          { type: "revoke-presenter", targetParticipantId: writer.participantId });
      }, "PUT");
    assert.equal(delayedNote.status, 403, "a body delayed past presenter revocation cannot modify shared notes");
    assert.equal((await storage.getRoomNote(notesRoom.roomId, "shared"))?.content, "before demotion");
    assert.equal((await storage.listRoomNoteVersions(notesRoom.roomId, "shared")).length, 1);
    const regranted = await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
      granted.revision + 1, { type: "grant-presenter", targetParticipantId: writer.participantId });
    const boundary = `----vrata-${randomUUID()}`;
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWISW+z1H4QBAAAA///iIMP1AAAABklEQVQDAA/LBAeJ81I+AAAAAElFTkSuQmCC", "base64");
    const multipartHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`);
    const multipartFooter = Buffer.concat([image, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const delayedUpload = await delayedBody(`/api/rooms/${notesRoom.roomId}/documents`, writer.token,
      `multipart/form-data; boundary=${boundary}`, multipartHeader, multipartFooter, async () => {
        await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
          regranted.revision, { type: "revoke-presenter", targetParticipantId: writer.participantId });
      });
    assert.equal(delayedUpload.status, 403, "a demoted presenter cannot persist an upload after the request body arrives");
    assert.deepEqual(await storage.listRoomDocuments(notesRoom.roomId), []);
    const afterUpload = await readdir(join(documentRoot, "documents", notesRoom.tenantId, notesRoom.roomId), { recursive: true })
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    assert.equal(afterUpload.some(name => name.endsWith("pixel.png")), false, "a rejected upload must remove its unreferenced object");
    const finalGrant = await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
      regranted.revision + 1, { type: "grant-presenter", targetParticipantId: writer.participantId });
    const form = new FormData();
    form.set("document", new Blob([new Uint8Array(image)], { type: "image/png" }), "pixel.png");
    const storedImage = await fetch(`${baseUrl}/api/rooms/${notesRoom.roomId}/documents`, {
      method: "POST", headers: { authorization: `Bearer ${writer.token}` }, body: form
    });
    assert.equal(storedImage.status, 201, "current Presenter can still publish an image");
    const storedDocument = (await storedImage.json() as { document: { documentId: string } }).document;
    const delayedSurface = await delayedJson(`/api/rooms/${notesRoom.roomId}/documents/${storedDocument.documentId}/surface`,
      writer.token, '{"surfaceId":"debug-', 'main"}', async () => {
        await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
          finalGrant.revision, { type: "revoke-presenter", targetParticipantId: writer.participantId });
      });
    assert.equal(delayedSurface.status, 403, "a demoted Presenter cannot change the active document surface");
    assert.equal((await storage.getRoomDocument(notesRoom.roomId, storedDocument.documentId))?.linkedSurfaceId, null);
    const documentHost = await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
      finalGrant.revision + 1, { type: "transfer-host", targetParticipantId: writer.participantId });
    const documentUrl = `${baseUrl}/api/rooms/${notesRoom.roomId}/documents/${storedDocument.documentId}`;
    failDocumentCleanup = true;
    assert.equal((await fetch(documentUrl, { method: "DELETE", headers: { authorization: `Bearer ${writer.token}` } })).status, 503);
    assert.ok((await storage.getRoomDocument(notesRoom.roomId, storedDocument.documentId))?.deletedAt,
      "failed external cleanup must not leave live access to the deleted document");
    assert.deepEqual(await storage.listRoomDocuments(notesRoom.roomId), []);
    assert.equal((await fetch(`${documentUrl}/download`, { headers: { "x-vrata-admin-token": "test-admin" } })).status, 404);
    const successor = await service.admit({ ...notesScope, displayName: "Next Host" });
    await storage.roomIdentities.transition(notesScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
      documentHost.revision, { type: "transfer-host", targetParticipantId: successor.identity.participantId });
    const callsBeforeDenied = documentCleanupCalls;
    failDocumentCleanup = false;
    assert.equal((await fetch(documentUrl, { method: "DELETE", headers: { authorization: `Bearer ${writer.token}` } })).status, 403,
      "former Host cannot resume deletion after losing document.delete");
    assert.equal(documentCleanupCalls, callsBeforeDenied);
    assert.equal((await fetch(documentUrl, { method: "DELETE", headers: { "x-vrata-admin-token": "test-admin" } })).status, 200,
      "an administrator can retry cleanup of a retained tombstone");
    assert.equal((await fetch(documentUrl, { method: "DELETE", headers: { "x-vrata-admin-token": "test-admin" } })).status, 200,
      "cleanup retry is idempotent");
    const personalForRace = await personal({ displayName: "Transfer during personal-state body" });
    assert.equal(personalForRace.status, 201);
    const oldOwner = await personalForRace.json() as typeof owned;
    const personalScope = { tenantId: oldOwner.room.tenantId, roomId: oldOwner.room.roomId };
    const oldOwnerSession = await service.issueSession(oldOwner.identityCredential, personalScope);
    const handoffInviteToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    const handoffInviteHash = createHmac("sha256", secret).update(handoffInviteToken).digest("base64url");
    await storage.createRoomInviteV2({ roomId: oldOwner.room.roomId, tokenHash: handoffInviteHash, role: "member",
      waitingRoomEnabled: false, expiresAt: new Date(Date.now() + 120_000).toISOString(),
      actor: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
    const receivingOwner = await service.admit({ ...personalScope, displayName: "New owner", inviteTokenHash: handoffInviteHash });
    const receivingSession = await service.issueSession(receivingOwner.credential, personalScope);
    const personalPath = `/api/rooms/${personalScope.roomId}/personal-state`;
    const stalePersonal = await delayedJson(personalPath, oldOwnerSession.sessionToken,
      '{"lastPose":{"position":{"x":', '77,"y":1,"z":2},"yaw":0,"pitch":0}}', async () => {
        const revision = (await storage.roomIdentities.authority(personalScope))!.revision;
        const transferred = await fetch(`${baseUrl}/api/rooms/${personalScope.roomId}/owner/transfer`, {
          method: "POST", headers: { "content-type": "application/json", "x-vrata-admin-token": "test-admin" },
          body: JSON.stringify({ participantId: receivingOwner.identity.participantId, expectedRevision: revision })
        });
        assert.equal(transferred.status, 200);
      }, "PUT");
    assert.equal(stalePersonal.status, 403, "a former owner cannot complete a personal-state body after handoff");
    assert.deepEqual(await storage.getPersonalRoomState(personalScope.tenantId, personalScope.roomId), {});
    const activeState = await fetch(`${baseUrl}${personalPath}`, { method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${receivingSession.sessionToken}` },
      body: JSON.stringify({ lastPose: { position: { x: 12, y: 1, z: 2 }, yaw: 0, pitch: 0 } }) });
    assert.equal(activeState.status, 200);
    const oldIdentityId = createRoomIdentityCodec(secret).verify(oldOwner.identityCredential, personalScope)!.identityId;
    const deniedOwnerRead = await heldRoomRead(personalScope.roomId, personalPath, receivingSession.sessionToken, async holder => {
      await holder.query("update room_identity_authority_v2 set owner_identity_id=$2, revision=revision+1 where room_id=$1",
        [personalScope.roomId, oldIdentityId]);
    });
    assert.equal(deniedOwnerRead.status, 403, "owner access must be rechecked before releasing prepared personal state");
    assert.equal((await deniedOwnerRead.text()).includes('"x":12'), false);
    const memberRoomDetails = await fetch(`${baseUrl}/api/rooms/${personalScope.roomId}`,
      { headers: { authorization: `Bearer ${receivingSession.sessionToken}` } });
    assert.equal(memberRoomDetails.status, 200);
    assert.equal((await memberRoomDetails.json() as { personalState?: unknown }).personalState, undefined,
      "generic room metadata cannot expose the current owner's personal state to invitees or former owners");
    const administrativeRoomDetails = await fetch(`${baseUrl}/api/rooms/${personalScope.roomId}`,
      { headers: { "x-vrata-admin-token": "test-admin" } });
    assert.equal(administrativeRoomDetails.status, 200);
    assert.equal((await administrativeRoomDetails.json() as { personalState: { lastPose: { position: { x: number } } } }).personalState.lastPose.position.x, 12);
    const handoffAuthority = (await storage.roomIdentities.authority(personalScope))!;
    await storage.roomIdentities.transition(personalScope, { actorType: "admin-token", actorId: "test-admin", role: "admin" },
      handoffAuthority.revision, { type: "transfer-host", targetParticipantId: receivingOwner.identity.participantId });
    const fixtureBundle = await storage.createSceneBundle({ bundleId: randomUUID(), storageKey: "fixture/scene.json",
      publicUrl: "https://example.test/fixture/scene.json", contentType: "application/json", provider: "minio-default", version: "test-v1" });
    const bindScene = await fetch(`${baseUrl}/api/rooms/${personalScope.roomId}/bind-scene-bundle`, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${receivingSession.sessionToken}`
    }, body: JSON.stringify({ bundleId: fixtureBundle.bundleId }) });
    assert.equal(bindScene.status, 200);
    assert.equal((await bindScene.json() as { personalState?: unknown }).personalState, undefined,
      "a Host who is not the owner cannot obtain personal state through a room mutation response");
    await storage.upsertRoomNote({ roomId: personalScope.roomId, scope: "private", ownerParticipantId: receivingOwner.identity.participantId,
      content: "participant private note survives ownership handoff" });
    const oldPrivateNotes = await fetch(`${baseUrl}/api/rooms/${personalScope.roomId}/notes/private`,
      { headers: { authorization: `Bearer ${receivingSession.sessionToken}` } });
    assert.equal(oldPrivateNotes.status, 200, "room ownership and participant-private notes are separate authority domains");

    const protectedForm = new FormData();
    protectedForm.set("document", new Blob([new Uint8Array(image)], { type: "image/png" }), "protected.png");
    const protectedUpload = await fetch(`${baseUrl}/api/rooms/${notesRoom.roomId}/documents`, {
      method: "POST", headers: { "x-vrata-admin-token": "test-admin" }, body: protectedForm
    });
    assert.equal(protectedUpload.status, 201);
    const protectedDocument = (await protectedUpload.json() as { document: { documentId: string } }).document;
    const readInviteHash = createHmac("sha256", secret).update(randomUUID()).digest("base64url");
    await storage.createRoomInviteV2({ roomId: notesRoom.roomId, tokenHash: readInviteHash, role: "member",
      waitingRoomEnabled: false, expiresAt: new Date(Date.now() + 120_000).toISOString(),
      actor: { actorType: "admin-token", actorId: "test-admin", role: "admin" } });
    for (const suffix of ["notes/private", "notes/private/versions", "notes/private/export?format=json",
      "notes/export?format=zip", `documents/${protectedDocument.documentId}/download`, "documents", ""]) {
      const reader = await service.admit({ ...notesScope, displayName: "Revoked reader", inviteTokenHash: readInviteHash });
      const readerSession = await service.issueSession(reader.credential, notesScope);
      await storage.upsertRoomNote({ roomId: notesRoom.roomId, scope: "private", ownerParticipantId: reader.identity.participantId,
        content: "PRIVATE-RESPONSE-MUST-NOT-LEAK" });
      const deniedRead = await heldRoomRead(notesRoom.roomId, `/api/rooms/${notesRoom.roomId}${suffix ? `/${suffix}` : ""}`, readerSession.sessionToken,
        async holder => {
          await holder.query("update room_identities_v2 set auth_epoch=auth_epoch+1, revoked_at=now() where room_id=$1 and identity_id=$2",
            [notesRoom.roomId, reader.identity.identityId]);
        });
      assert.equal(deniedRead.status, 409, `prepared private response denied after revoke: ${suffix}`);
      assert.equal(deniedRead.headers.get("content-disposition"), null);
      assert.equal((await deniedRead.text()).includes("PRIVATE-RESPONSE-MUST-NOT-LEAK"), false);
    }
    const fileReader = await service.admit({ ...notesScope, displayName: "Active document reader", inviteTokenHash: readInviteHash });
    const fileSession = await service.issueSession(fileReader.credential, notesScope);
    const protectedDownload = `/api/rooms/${notesRoom.roomId}/documents/${protectedDocument.documentId}/download`;
    const goneDocument = await heldRoomRead(notesRoom.roomId, protectedDownload, fileSession.sessionToken, async holder => {
      await holder.query("update room_documents set deleted_at=now() where room_id=$1 and document_id=$2",
        [notesRoom.roomId, protectedDocument.documentId]);
    });
    assert.equal(goneDocument.status, 404, "download must recheck a document tombstone after loading its bytes");
    await pool.query("update room_documents set deleted_at=null where room_id=$1 and document_id=$2", [notesRoom.roomId, protectedDocument.documentId]);
    await storage.updateRoomDocumentSurface(notesRoom.roomId, protectedDocument.documentId, "debug-main");
    const unlinkedContent = await heldRoomRead(notesRoom.roomId,
      `/api/rooms/${notesRoom.roomId}/documents/${protectedDocument.documentId}/content`, fileSession.sessionToken, async holder => {
        await holder.query("update room_documents set linked_surface_id=null where room_id=$1 and document_id=$2",
          [notesRoom.roomId, protectedDocument.documentId]);
      });
    assert.equal(unlinkedContent.status, 404, "a surface viewer cannot receive an image unlinked while its bytes were prepared");
    assert.equal(unlinkedContent.headers.get("content-disposition"), null);
    const storedRow = (await storage.getRoomDocument(notesRoom.roomId, protectedDocument.documentId))!;
    const readWithoutBlob = await heldRoomRead(notesRoom.roomId, protectedDownload, fileSession.sessionToken, async () => {
      await unlink(join(documentRoot, storedRow.storageKey));
    });
    assert.equal(readWithoutBlob.status, 200, "blob preparation must finish before acquiring the authority fence");
    assert.equal(Buffer.compare(Buffer.from(await readWithoutBlob.arrayBuffer()), image), 0);
    const peers = (await pool.query("select distinct origin_hash from room_identity_admission_buckets_v2 where kind='room'")).rows;
    assert.equal(peers.length, 1);
    const peerHash = peers[0].origin_hash as string;
    let limited: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Math.floor(Date.now() / 60_000) * 60_000;
      await pool.query(`insert into room_identity_admission_buckets_v2 (origin_hash,kind,window_ms,window_start_ms,attempts)
        values ($1,'room',60000,$2,180),($1,'room',60000,$3,180) on conflict (origin_hash,kind,window_ms,window_start_ms)
        do update set attempts=180`, [peerHash, start, start + 60_000]);
      limited = await issue({ displayName: "Budget blocked" });
      if (limited.status === 429) break;
    }
    assert.equal(limited?.status, 429, "new v2 room admission is bounded across API requests");
    assert.equal((await limited!.json() as { reason: string }).reason, "identity_rate_limited");
    assert.equal((await issue({ identityCredential: created.identityCredential })).status, 200,
      "a valid existing identity can still renew after anonymous capacity is reached");
    const privilegedRecovery = await recover(legacyHostRoom.roomId, "legacy-host-id", "host");
    assert.equal(privilegedRecovery.status, 201);
    const reservedProof = (await privilegedRecovery.json() as { recoveryCredential: string }).recoveryCredential;
    assert.equal((await redeem(legacyHostRoom.roomId, reservedProof)).status, 200,
      "administrator-approved recovery is not an anonymous new-identity request");
    const joinWithProxyHeaders = (proxyToken: string) => fetch(`${baseUrl}/api/tokens/state`, {
      method: "POST", headers: { "content-type": "application/json", "x-vrata-proxy-auth": proxyToken,
        "x-vrata-client-ip": "198.51.100.8" },
      body: JSON.stringify({ roomId: publicRoom.roomId, identityProtocolVersion: 2, displayName: "New peer" })
    });
    assert.equal((await joinWithProxyHeaders("forged-proxy-proof")).status, 429,
      "a direct caller cannot override the exhausted transport-peer budget");
    assert.equal((await joinWithProxyHeaders("identity-session-test-proxy-key-32-bytes")).status, 200,
      "the authenticated reverse proxy can rate-limit distinct clients independently");
    assert.equal((await pool.query("select count(distinct origin_hash)::integer as total from room_identity_admission_buckets_v2 where kind='room'")).rows[0].total, 2);
    const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await pool.query(`insert into room_identity_admission_buckets_v2 (origin_hash,kind,window_ms,window_start_ms,attempts)
      values ($1,'personal',3600000,$2,20) on conflict (origin_hash,kind,window_ms,window_start_ms)
      do update set attempts=20`, [peerHash, hourStart]);
    assert.equal((await personal({ displayName: "Budget blocked" })).status, 429);
    assert.equal((await personal({ roomId: owned.room.roomId, identityCredential: owned.identityCredential })).status, 200,
      "personal owner proof remains usable after anonymous creation is throttled");
    const victimProof = createRoomIdentityCodec(secret).verify(created.identityCredential, publicScope)!;
    const staleMedia = await delayedJson("/api/tokens/media", created.token,
      JSON.stringify({ roomId: publicRoom.roomId, participantId: created.participantId, canPublishAudio: true }).slice(0, -1) + ",",
      '"canPublishVideo":false}', async () => { await storage.roomIdentities.revoke(publicScope, victimProof.identityId, victimProof.authEpoch); });
    assert.equal(staleMedia.status, 409, "a stalled media request cannot release a token after its identity is revoked");
    assert.equal(JSON.parse(staleMedia.body).token, undefined);
    const framePayload = { roomId: publicRoom.roomId, objectId: "browser-1", executorSessionId: "remote-browser:browser-1",
      executorInstanceId: "remote-browser:browser-1:instance:generation-1", frameStreamId: "remote-browser:browser-1:frames" };
    assert.equal((await fetch(`${baseUrl}/api/tokens/remote-browser-frame`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${resumed.token}` },
      body: JSON.stringify(framePayload)
    })).status, 200, "a current Member can obtain a frame-viewer token");
    const frameProof = createRoomIdentityCodec(secret).verify(resumed.identityCredential, publicScope)!;
    const staleFrame = await delayedJson("/api/tokens/remote-browser-frame", resumed.token,
      JSON.stringify(framePayload).slice(0, -1) + ",", '"ignored":true}', async () => {
        await storage.roomIdentities.revoke(publicScope, frameProof.identityId, frameProof.authEpoch);
      });
    assert.equal(staleFrame.status, 409, "a stalled frame request cannot release a token after revocation");
    assert.equal(JSON.parse(staleFrame.body).token, undefined);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
    await rm(documentRoot, { recursive: true, force: true });
    roomStateMock.closeAllConnections();
    await new Promise<void>(resolve => roomStateMock.close(() => resolve()));
  }
});
