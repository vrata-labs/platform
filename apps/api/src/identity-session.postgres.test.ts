import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
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
    assert.equal((await verify(sessionToken, identity.participantId, {})).status, 403);
    assert.equal((await verify(sessionToken)).status, 409, "no v2 session is usable before activation");
    await storage.createRoom({ tenantId: scope.tenantId, templateId: "meeting-room-basic", name: "Legacy personal materials",
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
    await storage.identityProtocol.raise(2);
    const legacyRoomV2Join = await fetch(`${baseUrl}/api/tokens/state`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: legacyHostRoom.roomId, identityProtocolVersion: 2, participantId: "legacy-host-id", displayName: "New guest" }) });
    assert.equal(legacyRoomV2Join.status, 200, JSON.stringify(await legacyRoomV2Join.json()));
    const personal = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/personal-room`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityProtocolVersion: 2, ...body })
    });
    assert.equal((await personal({ participantId: "legacy-personal-owner", displayName: "Legacy Owner" })).status, 409);
    const opened = await personal({ participantId: "someone-else", displayName: "Owner" });
    assert.equal(opened.status, 201);
    const owned = await opened.json() as { room: { roomId: string; ownerParticipantId: string }; participantId: string;
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
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
});
