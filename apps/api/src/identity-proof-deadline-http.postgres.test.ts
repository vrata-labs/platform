import assert from "node:assert/strict";
import test from "node:test";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { AUTHOR_HTTP_SECRET, startAuthorHttpFixture, until, type AuthorHttpRoom, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const codec = createRoomIdentityCodec(AUTHOR_HTTP_SECRET);
const sessions = createRoomSessionV2Codec(AUTHOR_HTTP_SECRET);
const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000 };

test("HTTP RI2 renewal cannot widen an original possession deadline across authority SQL waits", postgres, async t => {
  const h = await startAuthorHttpFixture(t);
  const issue = (f: AuthorHttpRoom, identityCredential: string, extra: Record<string, unknown> = {}) =>
    h.admit(f.room.roomId, { identityCredential, ...extra });
  function noGrant(response: AuthorHttpResponse) {
    assert.equal(response.status, 409);
    assert.deepEqual(response.json(), { error: "identity_required", reason: "identity_recovery_required" });
    for (const value of ["identityCredential", '"token"', "rs2.", "ri2.", "sessionId", "permissions"]) {
      assert.equal(response.bytes.toString().includes(value), false, "denial contains no proof or authenticated grant");
    }
  }
  for (const expires of [false, true] as const) await t.test(`real awaited identity read ${expires ? "denies original expiry" : "permits still-live renewal"}`, async () => {
    const f = await h.room();
    const proof = sessions.verify(f.host.token, f.room); assert.ok(proof);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const original = codec.sign(proof, { nowSeconds, lifetimeSeconds: 60 });
    const before = await h.storage.roomIdentities.get(f.room, proof.identityId);
    const holder = await h.pool.connect();
    let pending: Promise<AuthorHttpResponse> | undefined;
    try {
      await holder.query("begin");
      // Metadata entry reads do not touch this table. This lock stops the real
      // authority SELECT after the service has verified the original RI2 MAC.
      await holder.query("lock table room_identities_v2 in access exclusive mode");
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
      pending = issue(f, original, { expiresAtSeconds: nowSeconds + 86_400, lifetimeSeconds: 86_400 });
      void pending.catch(() => undefined);
      await until(async () => (await h.pool.query(`select exists(select 1 from pg_stat_activity
        where application_name=$2 and $1=any(pg_blocking_pids(pid)) and query like '%from room_identities_v2%') as waiting`, [pid, h.schema])).rows[0].waiting,
      "the credential-verified authority query must reach the owned SQL lock");
      if (expires) await h.clock((nowSeconds + 60) * 1000 - Date.now());
      await holder.query("commit");
      const response = await pending;
      if (expires) noGrant(response);
      else {
        assert.equal(response.status, 200);
        const value = response.json<{ identityCredential: string; token: string; participantId: string; role: string }>();
        const renewed = codec.verify(value.identityCredential, f.room); assert.ok(renewed);
        const session = sessions.verify(value.token, f.room); assert.ok(session);
        assert.deepEqual([renewed.identityId, renewed.authEpoch, value.participantId, value.role],
          [proof.identityId, proof.authEpoch, proof.participantId, "host"]);
        assert.equal(renewed.expiresAtSeconds - renewed.issuedAtSeconds, 86_400);
        assert.equal(session.identityId, proof.identityId);
      }
      await h.clock(0);
      assert.deepEqual(await h.storage.roomIdentities.get(f.room, proof.identityId), before, "expiry does not revoke identity or rotate epoch");
      if (expires) {
        const fresh = await issue(f, f.host.identityCredential);
        assert.equal(fresh.status, 200, "the same active identity can still use an independently valid possession proof");
      }
    } finally {
      await holder.query("rollback").catch(() => undefined); holder.release(); await h.clock(0);
      await pending?.catch(() => undefined);
    }
  });

  await t.test("session expiry is renewable with live possession, while expired or malformed possession grants nothing", async () => {
    const f = await h.room();
    const session = sessions.verify(f.host.token, f.room); assert.ok(session);
    const atSeconds = session.expiresAtSeconds + 10;
    await h.clock(atSeconds * 1000 - Date.now());
    try {
      const response = await issue(f, f.host.identityCredential); assert.equal(response.status, 200);
      const value = response.json<{ identityCredential: string; token: string; participantId: string }>();
      const renewed = codec.verify(value.identityCredential, f.room, atSeconds); assert.ok(renewed);
      assert.equal(renewed.identityId, session.identityId);
      assert.equal(renewed.authEpoch, session.authEpoch);
      assert.equal(value.participantId === session.participantId, true);
      assert.ok(sessions.verify(value.token, f.room, atSeconds));
      const expired = codec.sign(session, { nowSeconds: atSeconds - 60, lifetimeSeconds: 60 });
      noGrant(await issue(f, expired, { expiresAtSeconds: atSeconds + 86_400 }));
      const malformed = `${f.host.identityCredential.slice(0, -1)}!`;
      noGrant(await issue(f, malformed));
      const foreign = await h.room();
      noGrant(await issue(foreign, f.host.identityCredential));
    } finally { await h.clock(0); }
  });
});
