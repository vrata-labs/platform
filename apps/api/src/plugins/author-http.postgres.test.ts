import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { getRoomPermissions } from "@vrata/shared-types";
import { signRoomSessionToken } from "@vrata/shared-types/session-token";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";
import { createRoomPluginArtifact, validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { AUTHOR_HTTP_CONFIG, AUTHOR_HTTP_SECRET, AUTHOR_HTTP_SOURCE, assertAuthorHttpDenied, assertAuthorHttpPublicDto,
  authorHttpArtifact, authorHttpBearer, authorHttpBinding, authorHttpPath, exactSizeAuthorHttpArtifact,
  startAuthorHttpFixture, uncheckedAuthorHttpArtifact, type AuthorHttpPackage, type AuthorHttpRoom } from "./author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 180_000 };
const expiresOffset = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).expiresAtSeconds * 1000 - Date.now() + 10;

test("real HTTP floor 1 denies the entire plugin family before identity, metadata, state and private IO", postgres, async t => {
  const h = await startAuthorHttpFixture(t, 1);
  const created = await h.request("/api/rooms", "POST", h.adminHeaders, { tenantId: "demo-tenant", templateId: "meeting-room-basic",
    name: "Floor one plugin denial", sessionControl: { hostParticipantId: "trusted-legacy-host" } });
  assert.equal(created.status, 201);
  const roomId = created.json<{ roomId: string }>().roomId;
  const seconds = Math.floor(Date.now() / 1000);
  const legacy = signRoomSessionToken({ tenantId: "demo-tenant", roomId, participantId: "trusted-legacy-host", displayName: "Host",
    role: "host", roleSource: "trusted", permissions: getRoomPermissions("host"), sessionId: randomUUID(), jti: randomUUID(),
    iat: seconds, exp: seconds + 600 }, AUTHOR_HTTP_SECRET);
  const before = await h.snapshot(roomId);
  assert.deepEqual(before.state, []); assert.deepEqual(before.packages, []); assert.deepEqual(before.bindings, []);
  const packageId = randomUUID();
  for (const headers of [authorHttpBearer(legacy), h.adminHeaders, {}]) {
    for (const [suffix, method] of [["packages", "POST"], ["packages", "GET"], ["runtime", "GET"],
      [`packages/${packageId}/content`, "GET"], [`packages/${packageId}`, "DELETE"], ["bindings/http-status", "PUT"], ["bindings/http-status", "DELETE"]]) {
      const body = method === "POST" || method === "PUT" || method === "DELETE"
        ? { identityProtocolVersion: 2, participantId: "trusted-legacy-host", role: "host", expiresAtSeconds: seconds + 86_400 } : undefined;
      assertAuthorHttpDenied(await h.request(authorHttpPath(roomId, suffix), method, headers, body), 409, "plugin_identity_not_active");
      assert.deepEqual(await h.snapshot(roomId), before, "floor one must not create plugin state or consult blob storage");
    }
  }
  assert.equal(await h.storage.identityProtocol.minimum(), 1);
});

test("real HTTP plugin authority and immutable publication boundaries on an isolated v2 schema", postgres, async t => {
  const h = await startAuthorHttpFixture(t);
  async function installed() {
    const f = await h.room(); const value = await h.upload(f); assert.equal((await h.bind(f, value)).status, 200);
    return { ...f, value };
  }
  // Authorization and malformed-request tests must not depend on a successful blob upload first.
  // A well-formed local ID/body proves denial precedes package lookup, validation or private IO.
  const absentPackage = (): AuthorHttpPackage => ({ packageId: randomUUID(), pluginId: "http-status", version: "1.0.0",
    artifactSha256: "a".repeat(64), byteLength: 1, state: "ready", uploadSettled: true, manifest: authorHttpArtifact().artifact.manifest });
  async function unchanged(f: AuthorHttpRoom, run: () => Promise<void>) {
    const before = await h.snapshot(f.room.roomId); await run(); assert.deepEqual(await h.snapshot(f.room.roomId), before);
  }
  async function content(f: AuthorHttpRoom, value: AuthorHttpPackage, token = f.host.token) {
    return h.request(authorHttpPath(f.room.roomId, `packages/${value.packageId}/content`), "GET", authorHttpBearer(token));
  }
  async function policyFloors() {
    const relation = (await h.pool.query("select to_regclass('public.room_identity_protocol_policy') as policy")).rows[0].policy;
    const shared = relation ? (await h.pool.query("select minimum_protocol from public.room_identity_protocol_policy where singleton=true")).rows[0].minimum_protocol : null;
    return { owned: await h.storage.identityProtocol.minimum(), shared };
  }
  async function queuedContent(f: AuthorHttpRoom & { value: AuthorHttpPackage }, action: () => Promise<void>, token = f.host.token) {
    const id = await h.arm("private-read", f.room.roomId);
    const pending = content(f, f.value, token); void pending.catch(() => undefined);
    try { await h.phase(id, "private-read"); await action(); await h.resume(); return await pending; }
    finally { await h.resume(); await pending.catch(() => undefined); }
  }
  async function assertCleanUnpublished(f: AuthorHttpRoom) {
    const snapshot = await h.snapshot(f.room.roomId);
    assert.equal(snapshot.packages.length, 1);
    assert.equal(snapshot.packages[0].state, "deleted"); assert.equal(snapshot.packages[0].upload_settled, true);
    assert.deepEqual(snapshot.bindings, []); assert.equal(Number(snapshot.state[0].revision), 0);
    assert.equal(Object.keys(snapshot.files).some(key => key.includes(Buffer.from(f.room.roomId).toString("hex"))), false,
      "confirmed author denial cleans only the unpublished settled artifact");
    assert.equal(h.io.includes("delete"), true);
  }

  await t.test("Host invite admission installs, lists, binds and returns exact hash-verified bytes to an admitted Member", async () => {
    const f = await installed(); const member = await h.session(f.room.roomId);
    const library = await h.request(authorHttpPath(f.room.roomId, "packages"), "GET", authorHttpBearer(f.host.token));
    assert.equal(library.status, 200);
    const dto = library.json<{ packages: AuthorHttpPackage[]; revision: number; bindings: unknown[] }>();
    assert.equal(dto.revision, 1); assert.equal(dto.packages.length, 1); assert.equal(dto.bindings.length, 1);
    const row = (await h.snapshot(f.room.roomId)).packages[0];
    assertAuthorHttpPublicDto(dto, [h.localRoot, row.storage_key, row.backend_fingerprint, f.host.token, f.host.identityCredential]);
    const runtime = await h.request(authorHttpPath(f.room.roomId, "runtime"), "GET", authorHttpBearer(member.token));
    assert.equal(runtime.status, 200);
    const snapshot = runtime.json<{ revision: number; leaseExpiresAtMs: number; bindings: Array<{ contentUrl: string; config: unknown }> }>();
    assert.equal(snapshot.revision, 1); assert.equal(snapshot.bindings.length, 1);
    assert.equal(snapshot.bindings[0].contentUrl, authorHttpPath(f.room.roomId, `packages/${f.value.packageId}/content`));
    assert.deepEqual(snapshot.bindings[0].config, { label: AUTHOR_HTTP_CONFIG });
    assert.ok(snapshot.leaseExpiresAtMs > Date.now()); assert.ok(snapshot.leaseExpiresAtMs <= Date.now() + 5000);
    assertAuthorHttpPublicDto(snapshot, [h.localRoot, row.storage_key, row.backend_fingerprint, member.token]);
    const bytes = await content(f, f.value, member.token);
    assert.equal(bytes.status, 200); assert.deepEqual(bytes.bytes, Buffer.from(authorHttpArtifact().bytes));
    assert.equal(createHash("sha256").update(bytes.bytes).digest("hex"), f.value.artifactSha256);
    assert.equal(bytes.headers["x-artifact-sha256"], f.value.artifactSha256);
    assert.equal(bytes.headers["content-type"], "application/octet-stream"); assert.equal(bytes.headers["x-content-type-options"], "nosniff");
    assert.equal(bytes.headers["cache-control"], "no-store"); assert.match(bytes.headers["content-security-policy"], /^sandbox;/);
    assert.equal(bytes.headers["content-length"], String(f.value.byteLength));
    assert.equal((await h.upload(f)).packageId, f.value.packageId, "idempotent exact bytes retain their immutable package ID");
    assert.equal((await h.snapshot(f.room.roomId)).packages.length, 1);
  });

  await t.test("capability gain on version update needs explicit approval for the exact new artifact", async () => {
    const f = await installed();
    const next = await h.upload(f, authorHttpArtifact("http-status", "1.0.1", AUTHOR_HTTP_SOURCE, ["status.set", "seating.claimSelfOnEntry"]));
    const body = { approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"] };
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.bind(f, next, 1, body), 403, "plugin_capability_approval_required");
      assertAuthorHttpDenied(await h.bind(f, next, 1, { ...body,
        capabilityApproval: { artifactSha256: f.value.artifactSha256, capabilities: body.approvedCapabilities } }), 403, "plugin_capability_approval_required");
    });
    assert.equal((await h.bind(f, next, 1, { ...body, capabilityApproval: { artifactSha256: next.artifactSha256,
      capabilities: body.approvedCapabilities } })).status, 200);
    assertAuthorHttpDenied(await content(f, f.value), 403, "plugin_content_not_bound");
    assert.equal(validateRoomPluginArtifact((await content(f, next)).bytes).artifactSha256, next.artifactSha256);
  });

  await t.test("CAS serializes competing writes; disabled bindings still prohibit deletion until explicit unbind", async () => {
    const f = await installed();
    const outcomes = await Promise.all([h.bind(f, f.value, 1, { config: { label: "first" } }),
      h.bind(f, f.value, 1, { config: { label: "second" } })]);
    assert.deepEqual(outcomes.map(value => value.status).sort(), [200, 409]);
    assertAuthorHttpDenied(outcomes.find(value => value.status === 409)!, 409, "plugin_revision_conflict");
    assert.equal((await h.bind(f, f.value, 2, { enabled: false })).status, 200);
    const disabledRuntime = await h.request(authorHttpPath(f.room.roomId, "runtime"), "GET", authorHttpBearer(f.host.token));
    assert.equal(disabledRuntime.status, 200); assert.deepEqual(disabledRuntime.json<{ bindings: unknown[] }>().bindings, []);
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await content(f, f.value), 403, "plugin_content_not_bound");
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `packages/${f.value.packageId}`), "DELETE",
        authorHttpBearer(f.host.token)), 409, "plugin_package_bound");
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `bindings/${f.value.pluginId}`), "DELETE",
        authorHttpBearer(f.host.token), { expectedRevision: 2 }), 409, "plugin_revision_conflict");
    });
    assert.equal((await h.request(authorHttpPath(f.room.roomId, `bindings/${f.value.pluginId}`), "DELETE",
      authorHttpBearer(f.host.token), { expectedRevision: 3 })).status, 200);
    assert.equal((await h.request(authorHttpPath(f.room.roomId, `packages/${f.value.packageId}`), "DELETE", authorHttpBearer(f.host.token))).status, 200);
    const after = await h.snapshot(f.room.roomId);
    assert.equal(after.packages[0].state, "deleted"); assert.deepEqual(after.bindings, []); assert.equal(Number(after.state[0].revision), 4);
    assert.equal(Object.hasOwn(after.files, after.packages[0].storage_key), false);
  });

  await t.test("admitted Guest, Member and currently granted Presenter cannot author any install route", async () => {
    const f = { ...await h.room(), value: absentPackage() }; const member = await h.session(f.room.roomId);
    const guestResponse = await h.admit(f.room.roomId); assert.equal(guestResponse.status, 200);
    const guest = guestResponse.json<typeof member>(); assert.equal(guest.role, "guest");
    const deniedAuthor = async (token: string) => unchanged(f, async () => {
      for (const [suffix, method, body] of [["packages", "GET", undefined], ["packages", "POST", Buffer.from("not an artifact")],
        [`bindings/${f.value.pluginId}`, "PUT", authorHttpBinding(f.value, 1)],
        [`bindings/${f.value.pluginId}`, "DELETE", { expectedRevision: 1 }], [`packages/${f.value.packageId}`, "DELETE", undefined]] as const) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, suffix), method, authorHttpBearer(token), body), 403, "plugin_author_forbidden");
      }
    });
    await deniedAuthor(guest.token); await deniedAuthor(member.token);
    await h.transition(f, `presenters/${member.participantId}/grant`, member);
    const granted = await h.admit(f.room.roomId, { identityCredential: member.identityCredential });
    assert.equal(granted.json<{ role: string }>().role, "presenter");
    // The original Member RS2 is resolved against the live Presenter assignment, not stale token roles.
    await deniedAuthor(member.token);
    await h.transition(f, `presenters/${member.participantId}/revoke`, member);
    await unchanged(f, async () => assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST",
      authorHttpBearer(member.token), authorHttpArtifact("after-revoke").bytes), 403, "plugin_author_forbidden"));
  });

  await t.test("personal Owner remains an author as Member after a real Host transfer", async () => {
    const created = await h.request("/api/personal-room", "POST", {}, { identityProtocolVersion: 2, displayName: "HTTP owner" });
    assert.equal(created.status, 201);
    const owned = created.json<{ room: AuthorHttpRoom["room"]; identityCredential: string }>();
    const admitted = await h.admit(owned.room.roomId, { identityCredential: owned.identityCredential });
    assert.equal(admitted.status, 200);
    const f = { room: owned.room, host: admitted.json<AuthorHttpRoom["host"]>() };
    const next = await h.session(f.room.roomId); await h.transition(f, "host/transfer", next);
    const renewed = await h.admit(f.room.roomId, { identityCredential: f.host.identityCredential });
    assert.equal(renewed.json<{ role: string; isOwner: boolean }>().role, "member"); assert.equal(renewed.json<{ isOwner: boolean }>().isOwner, true);
    const value = await h.upload(f); assert.equal((await h.bind(f, value)).status, 200);
    assert.equal((await content(f, value)).status, 200);
  });

  await t.test("public Host ID, query role, body v2 claims and widened deadlines cannot elevate a Member", async () => {
    const f = { ...await h.room(), value: absentPackage() }; const member = await h.session(f.room.roomId);
    const claimed = await h.admit(f.room.roomId, { participantId: f.host.participantId, requestedRole: "host" });
    assert.equal(claimed.status, 200); const impostor = claimed.json<typeof member>();
    assert.equal(impostor.role, "guest"); assert.notEqual(impostor.participantId, f.host.participantId);
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "GET", authorHttpBearer(impostor.token)), 403, "plugin_author_forbidden");
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages") + `?participantId=${f.host.participantId}&role=host`,
        "GET", authorHttpBearer(member.token)), 403, "plugin_author_forbidden");
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(member.token),
        { identityProtocolVersion: 2, identityId: f.host.participantId, participantId: f.host.participantId, role: "host", isOwner: true,
          expiresAtSeconds: Math.floor(Date.now() / 1000) + 86_400 }), 403, "plugin_author_forbidden");
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "runtime") + "?role=host&expiresAtSeconds=9999999999", "GET",
        authorHttpBearer(member.token)), 400, "plugin_invalid_request");
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `packages/${f.value.packageId}/content`) + "?participantId=" + f.host.participantId,
        "GET", authorHttpBearer(member.token)), 400, "plugin_invalid_request");
    });
  });

  await t.test("cookie, invite, RI2 and pending waiting proof cannot fetch source; administrator cannot fetch runtime", async () => {
    const f = { ...await h.room(), value: absentPackage() }; const invite = await h.invite(f.room.roomId);
    const waitingInvite = await h.invite(f.room.roomId, "member", true);
    const pending = await h.admit(f.room.roomId, { inviteToken: waitingInvite.inviteToken }); assert.equal(pending.status, 202);
    const waiting = pending.json<{ waitingCredential: string }>().waitingCredential;
    await unchanged(f, async () => {
      for (const headers of [{ cookie: `sessionToken=${f.host.token}` }, authorHttpBearer(invite.inviteToken),
        authorHttpBearer(f.host.identityCredential), authorHttpBearer(waiting)]) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `packages/${f.value.packageId}/content`), "GET", headers), 401, "identity_required");
      }
      for (const suffix of ["runtime", `packages/${f.value.packageId}/content`]) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, suffix), "GET", h.adminHeaders), 401, "identity_required");
      }
    });
  });

  await t.test("cross-room and cross-tenant package IDs never select foreign artifacts; encoded local IDs are rejected", async () => {
    const f = await installed(); const other = await h.room();
    const tenant = `author-http-${randomUUID()}`;
    const created = await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: tenant, name: "Isolated foreign tenant" }); assert.equal(created.status, 201);
    const foreign = await h.room(tenant); const foreignValue = await h.upload(foreign);
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.request(authorHttpPath(other.room.roomId, "runtime"), "GET", authorHttpBearer(f.host.token)), 403, "room_mismatch");
      assertAuthorHttpDenied(await h.request(authorHttpPath(foreign.room.roomId, `packages/${foreignValue.packageId}/content`), "GET",
        authorHttpBearer(f.host.token)), 403, "room_mismatch");
      assertAuthorHttpDenied(await content(f, foreignValue), 403, "plugin_content_not_bound");
      assertAuthorHttpDenied(await h.bind(f, foreignValue, 1), 404, "plugin_package_not_found");
      for (const suffix of ["packages/not-a-uuid/content", "packages/%2e%2e%2fprivate/content", "bindings/a%2fb"]) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, suffix), suffix.startsWith("bindings") ? "PUT" : "GET",
          authorHttpBearer(f.host.token), suffix.startsWith("bindings") ? authorHttpBinding(f.value, 1) : undefined), 400, "plugin_invalid_request");
      }
    });
    assert.equal((await content(foreign, foreignValue)).status, 403, "foreign but unbound content is also unavailable to its Host");
  });

  await t.test("original MAC-valid Host RS2 has renewable own-room expiry but expired foreign URLs require identity recovery", async () => {
    const own = await installed(); const foreign = await installed();
    const codec = createRoomSessionV2Codec(AUTHOR_HTTP_SECRET);
    const proof = codec.verify(own.host.token, own.room);
    assert.ok(proof, "the original invite-admitted Host session must have a valid MAC and live deadline");
    assert.equal(proof.participantId, own.host.participantId);
    const originalIdentity = await h.storage.roomIdentities.resolve(proof);
    assert.ok(originalIdentity); assert.equal(originalIdentity.role, "host");
    assert.equal(originalIdentity.identity.authEpoch, proof.authEpoch); assert.equal(originalIdentity.identity.revokedAt, null);
    const beforeOwn = await h.snapshot(own.room.roomId); const beforeForeign = await h.snapshot(foreign.room.roomId);
    for (const [f, snapshot] of [[own, beforeOwn], [foreign, beforeForeign]] as const) {
      assert.equal(snapshot.packages.length, 1); assert.equal(snapshot.packages[0].state, "ready");
      assert.equal(snapshot.files[snapshot.packages[0].storage_key], f.value.artifactSha256);
      assert.deepEqual(snapshot.bindings[0].config, { label: AUTHOR_HTTP_CONFIG });
    }
    const floorsBefore = await policyFloors();
    const headers = authorHttpBearer(own.host.token);
    const deniedReads = async (f: typeof own, status: number, error: string, reason?: string) => {
      for (const suffix of ["runtime", "packages", `packages/${f.value.packageId}/content`]) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, suffix), "GET", headers), status, error, reason);
        assert.deepEqual(await h.snapshot(own.room.roomId), beforeOwn);
        assert.deepEqual(await h.snapshot(foreign.room.roomId), beforeForeign);
      }
    };
    // The same unmodified A token first proves the fresh foreign-room mismatch on all three read boundaries.
    await deniedReads(foreign, 403, "room_mismatch");
    try {
      await h.clock(proof.expiresAtSeconds * 1000 - Date.now() + 10);
      assert.equal(codec.verify(own.host.token, own.room, proof.expiresAtSeconds), null, "the original deadline is expired");
      assert.ok(codec.verify(own.host.token, own.room, proof.expiresAtSeconds - 1),
        "MAC, original scope and original claims remain valid independently of the expired deadline");
      const liveIdentity = await h.storage.roomIdentities.resolve(proof);
      assert.ok(liveIdentity, "expiry must not be confused with a removed identity or revoked epoch");
      assert.equal(liveIdentity.role, "host"); assert.equal(liveIdentity.identity.identityId, proof.identityId);
      assert.equal(liveIdentity.identity.authEpoch, proof.authEpoch); assert.equal(liveIdentity.identity.revokedAt, null);
      assert.equal(liveIdentity.authority.hostIdentityId, proof.identityId);

      await deniedReads(foreign, 409, "identity_required", "identity_recovery_required");
      await deniedReads(own, 401, "identity_session_expired", "identity_session_expired");
      assert.deepEqual(await policyFloors(), floorsBefore);
    } finally { await h.clock(0); }
  });

  await t.test("expiry at request entry rejects author, runtime and source without metadata or IO changes", async () => {
    const f = { ...await h.room(), value: absentPackage() }; const before = await h.snapshot(f.room.roomId);
    try {
      await h.clock(expiresOffset(f.host.token));
      for (const suffix of ["packages", "runtime", `packages/${f.value.packageId}/content`]) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, suffix), "GET", authorHttpBearer(f.host.token)),
          401, "identity_session_expired", "identity_session_expired");
      }
      assert.deepEqual(await h.snapshot(f.room.roomId), before);
    } finally { await h.clock(0); }
  });

  await t.test("expiry after observed author body admission cannot reserve a package or widen the original deadline", async () => {
    const f = await h.room(); const before = await h.snapshot(f.room.roomId);
    const body = Buffer.from(JSON.stringify({ ...authorHttpBinding({ packageId: randomUUID(), pluginId: "http-status", version: "1.0.0",
      artifactSha256: "a".repeat(64) } as AuthorHttpPackage), expiresAtSeconds: 9999999999 }));
    const pending = h.stalled(authorHttpPath(f.room.roomId, "packages"), f.host.token, body);
    try {
      await pending.admitted(); await h.clock(expiresOffset(f.host.token)); pending.finish(); await pending.ended();
      assertAuthorHttpDenied(await pending.response, 401, "identity_session_expired", "identity_session_expired");
      assert.deepEqual(await h.snapshot(f.room.roomId), before);
    } finally { pending.destroy(); await h.clock(0); }
  });

  await t.test("expiry at final publication lock after acknowledged PUT settlement refuses success and cleans unpublished bytes", async () => {
    const f = await h.room(); const id = await h.arm("upload-settled", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), authorHttpArtifact().bytes);
    void pending.catch(() => undefined);
    try {
      await h.phase(id, "upload-settled");
      assertAuthorHttpDenied(await h.held(f.room.roomId, async () => { await h.resume(); return pending; }, async () => {
        await h.clock(expiresOffset(f.host.token));
      }), 401, "identity_session_expired", "identity_session_expired");
      await assertCleanUnpublished(f);
    } finally { await h.resume(); await h.clock(0); await pending.catch(() => undefined); }
  });

  await t.test("known PUT ACK survives an actual 5s settlement lock timeout by bounded retry without repeating PUT or deleting bytes", async () => {
    const f = await h.room(); const artifact = authorHttpArtifact("settlement-lock-retry");
    const floorsBefore = await policyFloors(); const before = await h.snapshot(f.room.roomId);
    const putId = await h.arm("put-written", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), artifact.bytes);
    void pending.catch(() => undefined);
    try {
      await h.phase(putId, "put-written");
      const written = await h.snapshot(f.room.roomId); assert.equal(written.packages.length, 1);
      const originalPackage = written.packages[0];
      assert.equal(originalPackage.state, "reserved"); assert.equal(originalPackage.upload_settled, false);
      assert.equal(written.files[originalPackage.storage_key], artifact.artifactSha256);
      const timeoutId = await h.arm("settlement-timeout", f.room.roomId);
      // held() acquires the parent FOR UPDATE before resuming PUT and confirms pg_blocking_pids.
      // The error checkpoint then pauses the actual 55P03 before production observes it or starts retrying.
      const response = await h.held(f.room.roomId, async () => { await h.resume(); return pending; }, async () => {
        const timeout = await h.phase(timeoutId, "settlement-timeout");
        assert.equal(timeout.sqlState, "55P03"); assert.equal(timeout.lockTimeoutMs, 5000);
        const rejected = await h.snapshot(f.room.roomId);
        assert.deepEqual(rejected.packages, written.packages); assert.deepEqual(rejected.state, written.state);
        assert.deepEqual(rejected.bindings, []);
        assert.equal(rejected.files[originalPackage.storage_key], artifact.artifactSha256);
        assert.equal(Object.hasOwn(rejected.files, `${originalPackage.storage_key}.upload`), false,
          "PUT has fully acknowledged and removed its temp key before the settlement timeout");
        assert.equal(rejected.io.slice(before.io.length).filter(operation => operation === "put").length, 1);
        assert.equal(rejected.io.slice(before.io.length).includes("delete"), false);
      }, () => h.resume()); // Resume the original DatabaseError only AFTER the parent's lock is committed away.
      assert.equal(response.status, 201, "one confirmed settlement rejection must be recovered within the original HTTP request");
      const dto = response.json<{ package: AuthorHttpPackage }>();
      assertAuthorHttpPublicDto(dto, [h.localRoot, originalPackage.storage_key, originalPackage.backend_fingerprint, f.host.token]);
      const value = dto.package;
      assert.equal(value.packageId, originalPackage.package_id); assert.equal(value.state, "ready"); assert.equal(value.uploadSettled, true);
      assert.equal(value.artifactSha256, artifact.artifactSha256); assert.equal(value.byteLength, artifact.byteLength);
      const ready = await h.snapshot(f.room.roomId);
      assert.equal(ready.packages.length, 1); assert.equal(ready.packages[0].state, "ready"); assert.equal(ready.packages[0].upload_settled, true);
      assert.deepEqual(ready.bindings, []); assert.equal(Number(ready.state[0].revision), 0);
      assert.equal(ready.files[originalPackage.storage_key], artifact.artifactSha256);
      assert.equal(ready.io.slice(before.io.length).filter(operation => operation === "put").length, 1);
      assert.equal(ready.io.slice(before.io.length).includes("delete"), false);

      assert.equal((await h.bind(f, value)).status, 200);
      const source = await content(f, value); assert.equal(source.status, 200); assert.deepEqual(source.bytes, Buffer.from(artifact.bytes));
      assert.equal(source.headers["x-artifact-sha256"], artifact.artifactSha256);
      const bound = await h.snapshot(f.room.roomId);
      assert.equal(bound.packages.length, 1); assert.equal(bound.packages[0].state, "ready"); assert.equal(bound.packages[0].upload_settled, true);
      assert.equal(Number(bound.state[0].revision), 1); assert.equal(bound.bindings[0].package_id, originalPackage.package_id);
      assert.equal(bound.io.slice(before.io.length).filter(operation => operation === "put").length, 1);
      assert.equal(bound.io.slice(before.io.length).includes("delete"), false); assert.deepEqual(await policyFloors(), floorsBefore);
    } finally { await h.resume(); await pending.catch(() => undefined); }
  });

  await t.test("Host transfer during actual private PUT duration is rechecked before publication and safely compensated", async () => {
    const f = await h.room(); const next = await h.session(f.room.roomId);
    const id = await h.arm("put-written", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), authorHttpArtifact().bytes);
    void pending.catch(() => undefined);
    try {
      await h.phase(id, "put-written");
      const during = await h.snapshot(f.room.roomId);
      assert.equal(during.packages[0].state, "reserved"); assert.equal(during.packages[0].upload_settled, false);
      assert.equal(Object.hasOwn(during.files, during.packages[0].storage_key), true);
      await h.transition(f, "host/transfer", next); await h.resume();
      assertAuthorHttpDenied(await pending, 403, "plugin_author_forbidden"); await assertCleanUnpublished(f);
    } finally { await h.resume(); await pending.catch(() => undefined); }
  });

  await t.test("Host transfer after settlement COMMIT (locks released) prevents old-author publish without unsafe deletion of ready packages", async () => {
    const f = await installed(); const next = await h.session(f.room.roomId);
    const before = await h.snapshot(f.room.roomId); const existingBytes = await readFile(join(h.localRoot, before.packages[0].storage_key));
    const id = await h.arm("upload-settled", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), authorHttpArtifact("late-publish").bytes);
    void pending.catch(() => undefined);
    try {
      await h.phase(id, "upload-settled"); await h.transition(f, "host/transfer", next); await h.resume();
      assertAuthorHttpDenied(await pending, 403, "plugin_author_forbidden");
      const after = await h.snapshot(f.room.roomId);
      assert.equal(after.packages.find(value => value.plugin_id === "late-publish")?.state, "deleted");
      assert.equal(after.packages.find(value => value.package_id === f.value.packageId)?.state, "ready");
      assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.state, before.state);
      assert.deepEqual(await readFile(join(h.localRoot, before.packages[0].storage_key)), existingBytes);
    } finally { await h.resume(); await pending.catch(() => undefined); }
  });

  await t.test("room DELETE cleans an ACK-settled reservation before the paused publisher resumes without resurrection", async () => {
    const f = await h.room(); const roomPath = `/api/rooms/${f.room.roomId}`;
    const artifact = authorHttpArtifact("delete-after-settlement");
    const floorsBefore = await policyFloors();
    const before = await h.snapshot(f.room.roomId);
    const id = await h.arm("upload-settled", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), artifact.bytes);
    void pending.catch(() => undefined);
    try {
      // COMMIT has been acknowledged and all fence locks are released. The HTTP publisher has not resumed.
      await h.phase(id, "upload-settled");
      const settled = await h.snapshot(f.room.roomId);
      assert.equal(settled.packages.length, 1); const value = settled.packages[0];
      assert.equal(value.state, "reserved"); assert.equal(value.upload_settled, true);
      assert.equal(value.artifact_sha256, artifact.artifactSha256);
      assert.equal(settled.files[value.storage_key], artifact.artifactSha256);
      assert.deepEqual(settled.bindings, []); assert.equal(Number(settled.state[0].revision), 0);

      const deleted = await h.request(roomPath, "DELETE", h.adminHeaders);
      assert.equal(deleted.status, 200); assert.deepEqual(deleted.json(), { ok: true, roomId: f.room.roomId });
      const removed = await h.snapshot(f.room.roomId);
      assert.deepEqual(removed.state, []); assert.deepEqual(removed.packages, []); assert.deepEqual(removed.bindings, []);
      assert.deepEqual(removed.files, before.files);
      assert.deepEqual(removed.io.slice(settled.io.length), ["delete", "temp-delete"]);
      assert.equal(await h.storage.getRoom(f.room.roomId), null, "settled reservation cleanup must not need its publisher to resume");

      await h.resume(); assertAuthorHttpDenied(await pending, 503, "plugin_operation_pending");
      assert.deepEqual(await h.snapshot(f.room.roomId), removed, "late publication must not recreate room, metadata or bytes");
      for (const suffix of ["runtime", `packages/${value.package_id}/content`]) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, suffix), "GET", authorHttpBearer(f.host.token)),
          409, "identity_required", "identity_recovery_required");
      }
      assert.deepEqual(await h.snapshot(f.room.roomId), removed); assert.deepEqual(await policyFloors(), floorsBefore);
    } finally { await h.resume(); await pending.catch(() => undefined); }
  });

  await t.test("API restart after PUT ACK settlement loses producer tickets but HTTP room DELETE still clears metadata and private bytes", async () => {
    const f = await h.room(); const artifact = authorHttpArtifact("producer-gone");
    const floorsBefore = await policyFloors(); const before = await h.snapshot(f.room.roomId);
    const id = await h.arm("upload-settled", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), artifact.bytes);
    // The tracked child is deliberately stopped with the HTTP request still open. Discard transport errors, never log them.
    const writerOutcome = pending.then(response => ({ response }), () => ({ response: null }));
    try {
      await h.phase(id, "upload-settled");
      const settled = await h.snapshot(f.room.roomId); assert.equal(settled.packages.length, 1);
      const value = settled.packages[0];
      assert.equal(value.state, "reserved"); assert.equal(value.upload_settled, true);
      assert.equal(value.artifact_sha256, artifact.artifactSha256); assert.equal(settled.files[value.storage_key], artifact.artifactSha256);
      assert.deepEqual(settled.bindings, []); assert.equal(Number(settled.state[0].revision), 0);

      const restarted = await h.restartApi(); assert.notEqual(restarted.currentPid, restarted.previousPid);
      const outcome = await writerOutcome;
      if (outcome.response) assertAuthorHttpDenied(outcome.response, 503, "plugin_operation_pending");
      assert.deepEqual(await h.snapshot(f.room.roomId), settled, "restart must retain the durable ACK and bytes, not revive a publisher");
      // The original RS2 proves that the same room, authority and signing secret survived the restart.
      const library = await h.request(authorHttpPath(f.room.roomId, "packages"), "GET", authorHttpBearer(f.host.token));
      assert.equal(library.status, 200);
      const dto = library.json<{ revision: number; bindings: unknown[]; packages: AuthorHttpPackage[] }>();
      assert.equal(dto.revision, 0); assert.deepEqual(dto.bindings, []); assert.equal(dto.packages.length, 1);
      assert.equal(dto.packages[0].packageId, value.package_id); assert.equal(dto.packages[0].state, "reserved");
      assert.equal(dto.packages[0].uploadSettled, true);
      assertAuthorHttpPublicDto(dto, [h.localRoot, value.storage_key, value.backend_fingerprint, f.host.token, f.host.identityCredential]);
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `packages/${value.package_id}/content`), "GET",
        authorHttpBearer(f.host.token)), 403, "plugin_content_not_bound");
      assert.deepEqual(await h.snapshot(f.room.roomId), settled);

      const deleted = await h.request(`/api/rooms/${f.room.roomId}`, "DELETE", h.adminHeaders);
      assert.equal(deleted.status, 200); assert.deepEqual(deleted.json(), { ok: true, roomId: f.room.roomId });
      const removed = await h.snapshot(f.room.roomId);
      assert.deepEqual(removed.state, []); assert.deepEqual(removed.packages, []); assert.deepEqual(removed.bindings, []);
      assert.deepEqual(removed.files, before.files);
      assert.deepEqual(removed.io.slice(settled.io.length), ["delete", "temp-delete"]);
      assert.equal(await h.storage.getRoom(f.room.roomId), null);
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `packages/${value.package_id}/content`), "GET",
        authorHttpBearer(f.host.token)), 409, "identity_required", "identity_recovery_required");
      assert.deepEqual(await h.snapshot(f.room.roomId), removed); assert.deepEqual(await policyFloors(), floorsBefore);
    } finally { await h.resume(); await writerOutcome; }
  });

  await t.test("unknown PUT ACK after producer restart cannot be guessed from visible bytes or retried into settlement or deletion", async () => {
    const f = await h.room(); const artifact = authorHttpArtifact("unknown-put-ack");
    const floorsBefore = await policyFloors(); const before = await h.snapshot(f.room.roomId);
    const id = await h.arm("put-written", f.room.roomId);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), artifact.bytes);
    const writerOutcome = pending.then(response => ({ response }), () => ({ response: null }));
    try {
      // The final key is visible, but PUT has not returned/settled: killing this child loses its terminal ACK proof.
      await h.phase(id, "put-written");
      const uncertain = await h.snapshot(f.room.roomId); assert.equal(uncertain.packages.length, 1);
      const value = uncertain.packages[0];
      assert.equal(value.state, "reserved"); assert.equal(value.upload_settled, false);
      assert.equal(uncertain.files[value.storage_key], artifact.artifactSha256);
      assert.equal(uncertain.files[`${value.storage_key}.upload`], artifact.artifactSha256);
      assert.deepEqual(uncertain.bindings, []); assert.equal(Number(uncertain.state[0].revision), 0);
      await h.restartApi(); const outcome = await writerOutcome;
      if (outcome.response) assertAuthorHttpDenied(outcome.response, 503, "plugin_operation_pending");
      assert.deepEqual(await h.snapshot(f.room.roomId), uncertain);

      for (let attempt = 0; attempt < 2; attempt++) {
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), artifact.bytes),
          503, "plugin_upload_pending");
        assert.deepEqual(await h.snapshot(f.room.roomId), uncertain,
          "a fresh request must not read visible bytes as evidence, repeat PUT or manufacture upload_settled");
      }
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, `packages/${value.package_id}/content`), "GET",
        authorHttpBearer(f.host.token)), 403, "plugin_content_not_bound");
      assert.deepEqual(await h.snapshot(f.room.roomId), uncertain);

      assertAuthorHttpDenied(await h.request(`/api/rooms/${f.room.roomId}`, "DELETE", h.adminHeaders), 409, "plugin_upload_pending");
      const deleting = await h.snapshot(f.room.roomId);
      assert.deepEqual(deleting.packages, uncertain.packages); assert.deepEqual(deleting.bindings, []);
      assert.equal(deleting.state[0].deleting, true); assert.ok(deleting.state[0].deletion_id);
      assert.deepEqual(deleting.state[0].cleanup_package_ids, [value.package_id]); assert.equal(Number(deleting.state[0].revision), 0);
      assert.deepEqual(deleting.files, uncertain.files); assert.deepEqual(deleting.io, uncertain.io);
      assertAuthorHttpDenied(await h.request(`/api/rooms/${f.room.roomId}`, "DELETE", h.adminHeaders), 409, "plugin_upload_pending");
      assert.deepEqual(await h.snapshot(f.room.roomId), deleting); assert.ok(await h.storage.getRoom(f.room.roomId));
      assert.equal(deleting.io.slice(before.io.length).filter(operation => operation === "put").length, 1);
      assert.equal(deleting.io.slice(before.io.length).includes("delete"), false); assert.deepEqual(await policyFloors(), floorsBefore);
    } finally { await h.resume(); await writerOutcome; }
  });

  await t.test("final library release distinguishes actor lookup from plugin parent fence and denies a queued former Host", async () => {
    const f = await installed(); const next = await h.session(f.room.roomId); const before = await h.snapshot(f.room.roomId);
    // Skip the author's initial authorize() fence; pause only the subsequent releaseLibrary() fence.
    const id = await h.arm("plugin-room", f.room.roomId, 1);
    const pending = h.request(authorHttpPath(f.room.roomId, "packages"), "GET", authorHttpBearer(f.host.token)); void pending.catch(() => undefined);
    try {
      await h.phase(id, "plugin-room");
      assertAuthorHttpDenied(await h.held(f.room.roomId, async () => { await h.resume(); return pending; }, async client => {
        const identity = (await client.query("select identity_id from room_identities_v2 where room_id=$1 and participant_id=$2",
          [f.room.roomId, next.participantId])).rows[0].identity_id;
        await client.query("update room_identity_authority_v2 set host_identity_id=$2,revision=revision+1 where room_id=$1", [f.room.roomId, identity]);
      }), 403, "plugin_author_forbidden");
      assert.deepEqual(await h.snapshot(f.room.roomId), before);
    } finally { await h.resume(); await pending.catch(() => undefined); }
  });

  await t.test("content read outside the DB cannot release old bytes after a real binding configuration revision", async () => {
    const f = await installed(); const before = await h.snapshot(f.room.roomId);
    assertAuthorHttpDenied(await queuedContent(f, async () => {
      assert.equal((await h.bind(f, f.value, 1, { config: { label: "changed" } })).status, 200);
    }), 409, "plugin_binding_changed");
    const after = await h.snapshot(f.room.roomId);
    assert.deepEqual(after.packages, before.packages); assert.deepEqual(after.files, before.files);
    assert.equal(Number(after.state[0].revision), 2); assert.deepEqual(after.bindings[0].config, { label: "changed" });
    assert.equal((await content(f, f.value)).status, 200, "a fresh tuple still permits the exact source");
  });

  await t.test("content ticket is invalidated by disable or unbind while captured private bytes are paused", async () => {
    for (const action of ["disable", "unbind"]) {
      const f = await installed(); const before = await h.snapshot(f.room.roomId);
      const response = await queuedContent(f, async () => {
        const changed = action === "disable" ? await h.bind(f, f.value, 1, { enabled: false })
          : await h.request(authorHttpPath(f.room.roomId, `bindings/${f.value.pluginId}`), "DELETE", authorHttpBearer(f.host.token), { expectedRevision: 1 });
        assert.equal(changed.status, 200);
      });
      assertAuthorHttpDenied(response, 409, "plugin_binding_changed");
      const after = await h.snapshot(f.room.roomId); assert.deepEqual(after.packages, before.packages); assert.deepEqual(after.files, before.files);
      assert.equal(Number(after.state[0].revision), 2);
      assertAuthorHttpDenied(await content(f, f.value), 403, "plugin_content_not_bound");
    }
  });

  await t.test("real participant removal during private source read revokes epoch before final release", async () => {
    const f = await installed(); const member = await h.session(f.room.roomId); const before = await h.snapshot(f.room.roomId);
    assertAuthorHttpDenied(await queuedContent(f, async () => {
      await h.transition(f, `participants/${member.participantId}/remove`, member);
    }, member.token), 401, "identity_required", "identity_recovery_required");
    const after = await h.snapshot(f.room.roomId);
    assert.deepEqual(after.state, before.state); assert.deepEqual(after.packages, before.packages);
    assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.files, before.files);
    assertAuthorHttpDenied(await content(f, f.value, member.token), 409, "identity_required", "identity_recovery_required");
  });

  await t.test("source expiry while blocked on final parent lock cannot send attachment headers or old bytes", async () => {
    const f = await installed(); const before = await h.snapshot(f.room.roomId); const id = await h.arm("private-read", f.room.roomId);
    const pending = content(f, f.value); void pending.catch(() => undefined);
    try {
      await h.phase(id, "private-read");
      assertAuthorHttpDenied(await h.held(f.room.roomId, async () => { await h.resume(); return pending; }, async () => {
        await h.clock(expiresOffset(f.host.token));
      }), 401, "identity_session_expired", "identity_session_expired");
      const after = await h.snapshot(f.room.roomId);
      assert.deepEqual(after.state, before.state); assert.deepEqual(after.packages, before.packages);
      assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.files, before.files);
    } finally { await h.resume(); await h.clock(0); await pending.catch(() => undefined); }
  });

  await t.test("transferred Host, removed identity and ended room cannot reuse old RS2 for author or source", async () => {
    for (const action of ["transfer", "remove", "end"]) {
      const f = await installed(); const next = await h.session(f.room.roomId);
      if (action === "transfer") await h.transition(f, "host/transfer", next);
      if (action === "remove") {
        await h.transition(f, "host/transfer", next);
        await h.transition(f, `participants/${f.host.participantId}/remove`, f.host, next);
      }
      if (action === "end") await h.transition(f, "session-control/end");
      await unchanged(f, async () => {
        const expected = action !== "transfer" ? [409, "identity_required", "identity_recovery_required"] as const
          : [403, "plugin_author_forbidden", undefined] as const;
        assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token),
          authorHttpArtifact("revoked-author").bytes), expected[0], expected[1], expected[2]);
        if (action !== "transfer") assertAuthorHttpDenied(await content(f, f.value), expected[0], expected[1], expected[2]);
      });
      if (action === "transfer") assert.equal((await content(f, f.value)).status, 200, "a former Host remains an admitted runtime Member");
    }
  });

  await t.test("closed-room lock does not invent automatic revocation for already-admitted runtime identities", async () => {
    const f = await installed(); const member = await h.session(f.room.roomId); const before = await h.snapshot(f.room.roomId);
    await h.transition(f, "session-control/lock");
    assert.equal((await content(f, f.value, member.token)).status, 200);
    assert.equal((await h.request(authorHttpPath(f.room.roomId, "runtime"), "GET", authorHttpBearer(member.token))).status, 200);
    const after = await h.snapshot(f.room.roomId);
    assert.deepEqual(after.state, before.state); assert.deepEqual(after.packages, before.packages);
    assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.files, before.files);
  });

  await t.test("buffered exact 1 MiB is preserved; declared and chunked oversized bodies fail before state or blob IO", async () => {
    const f = await h.room(); const before = await h.snapshot(f.room.roomId);
    const oversized = Buffer.alloc(ROOM_PLUGIN_LIMITS.artifactBytes + 1, 32);
    assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), oversized), 413, "plugin_body_too_large");
    const chunked = h.stalled(authorHttpPath(f.room.roomId, "packages"), f.host.token, oversized, "POST", false);
    try { chunked.finish(); assertAuthorHttpDenied(await chunked.response, 413, "plugin_body_too_large"); }
    finally { chunked.destroy(); }
    assert.deepEqual(await h.snapshot(f.room.roomId), before);
    const bytes = exactSizeAuthorHttpArtifact(ROOM_PLUGIN_LIMITS.artifactBytes);
    const response = await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), bytes);
    assert.equal(response.status, 201); const value = response.json<{ package: AuthorHttpPackage }>().package;
    assert.equal(value.byteLength, ROOM_PLUGIN_LIMITS.artifactBytes);
    assert.equal(value.artifactSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal((await h.bind(f, value)).status, 200); assert.deepEqual((await content(f, value)).bytes, Buffer.from(bytes));
  });

  await t.test("invalid UTF-8, checksum and module imports are bounded HTTP validation failures with no state or IO", async () => {
    const f = await h.room(); const before = await h.snapshot(f.room.roomId);
    assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), Buffer.from([0xff, 0xfe])), 400, "invalid_utf8");
    const artifact = authorHttpArtifact();
    const corrupt = Buffer.from(JSON.stringify({ ...artifact.artifact, manifest: { ...artifact.artifact.manifest, entrySha256: "a".repeat(64) } }));
    assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), corrupt), 400, "entry_checksum_mismatch");
    assert.deepEqual(await h.snapshot(f.room.roomId), before);
    const imported = await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), uncheckedAuthorHttpArtifact("import 'node:fs'; export function init() {}"));
    assert.deepEqual(await h.snapshot(f.room.roomId), before);
    assertAuthorHttpDenied(imported, 400, "module_import_forbidden");
  });

  await t.test("persisted NUL in valid manifest enum is rejected before reservation; unsupported defaults stay invalid", async () => {
    const f = await h.room(); const base = authorHttpArtifact("nul-manifest");
    const { entrySha256: _entrySha256, ...manifest } = base.artifact.manifest;
    const artifact = createRoomPluginArtifact({ ...manifest, configSchema: {
      label: { type: "enum", required: false, values: ["safe", "MANIFEST\u0000ENUM"] }
    } }, AUTHOR_HTTP_SOURCE);
    assert.equal(validateRoomPluginArtifact(artifact.bytes).artifact.manifest.configSchema.label.type, "enum",
      "the enum fixture must be valid SDK data, so the HTTP refusal comes from persisted-text validation");
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), artifact.bytes),
        400, "plugin_invalid_persisted_text");
    });
    // Defaults are not part of the SDK schema. Do not mistake this unknown-field refusal for a persisted-NUL check.
    const defaults = Buffer.from(JSON.stringify({ ...base.artifact, manifest: { ...base.artifact.manifest, configSchema: {
      label: { ...base.artifact.manifest.configSchema.label, default: "MANIFEST\u0000DEFAULT" }
    } } }));
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token), defaults),
        400, "unknown_field");
    });
  });

  await t.test("persisted NUL config is a typed HTTP 400 without changing binding revision, packages or blob IO", async () => {
    const f = await installed();
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.bind(f, f.value, 1, { config: { label: "CONFIG\u0000VALUE" } }),
        400, "plugin_invalid_persisted_text");
    });
  });

  await t.test("NUL inside source entry string literal remains valid exact artifact bytes and is not persisted as manifest text", async () => {
    const f = await h.room();
    const artifact = authorHttpArtifact("nul-entry", "1.0.0", "export function init() { const data = \"ENTRY\u0000LITERAL\"; }");
    const value = await h.upload(f, artifact);
    assert.equal((await h.bind(f, value)).status, 200);
    const source = await content(f, value);
    assert.equal(source.status, 200); assert.deepEqual(source.bytes, Buffer.from(artifact.bytes));
    assert.equal(validateRoomPluginArtifact(source.bytes).artifactSha256, artifact.artifactSha256);
    const after = await h.snapshot(f.room.roomId);
    assert.equal(after.packages.length, 1); assert.equal(after.packages[0].state, "ready");
    assert.equal(JSON.stringify(after.packages[0].manifest).includes("\\u0000"), false);
    assert.equal(Number(after.state[0].revision), 1);
  });

  await t.test("altered bytes for an existing version conflict; ten live packages reject the next reservation without IO", async () => {
    const f = await h.room(); const value = await h.upload(f);
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token),
        authorHttpArtifact("http-status", "1.0.0", AUTHOR_HTTP_SOURCE + "\n").bytes), 409, "plugin_version_conflict");
    });
    const fingerprint = (await h.snapshot(f.room.roomId)).packages[0].backend_fingerprint;
    // Quota setup is metadata-only; the boundary under test is one real HTTP reservation, not 200 duplicate requests.
    for (let index = 1; index < ROOM_PLUGIN_LIMITS.packagesPerRoom; index++) {
      const seeded = (await h.storage.roomPlugins.reservePackage(f.room, authorHttpArtifact(`quota-${index}`).bytes, fingerprint)).package;
      await h.storage.roomPlugins.confirmPackageUpload(f.room, seeded.packageId); await h.storage.roomPlugins.publishPackage(f.room, seeded.packageId);
    }
    await unchanged(f, async () => {
      assertAuthorHttpDenied(await h.request(authorHttpPath(f.room.roomId, "packages"), "POST", authorHttpBearer(f.host.token),
        authorHttpArtifact("over-quota").bytes), 409, "plugin_quota_exceeded");
    });
    assert.equal((await h.snapshot(f.room.roomId)).packages.length, ROOM_PLUGIN_LIMITS.packagesPerRoom);
    assert.equal((await h.upload(f)).packageId, value.packageId, "quota does not prevent exact ready-version retries");
  });
});
