import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { activatedIdentityRoomGuard } from "./identity/protocol-guard.js";
import { startAuthorHttpFixture, authorHttpBearer, until, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000 };
function noGrant(response: AuthorHttpResponse) {
  for (const value of ["identityCredential", '"token"', "rs2.", "ri2.", "sessionId"]) assert.equal(response.bytes.toString().includes(value), false);
}

test("administrative HTTP creation preserves legacy behavior and refuses queued seeds after cutover", postgres, async t => {
  const h = await startAuthorHttpFixture(t, 1, false, true);
  const input = (roomId = `admin-${randomUUID()}`) => ({ roomId, tenantId: "demo-tenant", templateId: "personal-workspace-basic",
    name: "Administrative legacy owner", roomType: "personal", ownerParticipantId: "legacy-owner" });
  const create = (body: unknown) => h.request("/api/rooms", "POST", h.adminHeaders, body);
  const first = input(), second = input();
  assert.equal((await create(first)).status, 201); assert.equal((await create(second)).status, 201);
  const item = await h.request(`/api/rooms/${first.roomId}`, "GET", h.adminHeaders);
  assert.equal(item.status, 200);
  assert.deepEqual([item.json().ownerParticipantId, item.json().currentOwnerParticipantId], ["legacy-owner", "legacy-owner"]);
  assert.equal((await h.request("/api/rooms", "GET", h.adminHeaders)).bytes.toString().includes("currentOwnerParticipantId"), false);
  assert.equal((await create({ ...first, name: "Must not overwrite" })).status, 409);
  assert.equal((await h.storage.getRoom(first.roomId))?.name, first.name);
  assert.equal((await create({ ...input(), ownerParticipantId: null, allowUnownedPersonal: true, minimumIdentityProtocol: 2 })).status, 400);

  const stalled = input(), bytes = Buffer.from(JSON.stringify(stalled));
  const body = h.stalled("/api/rooms", h.adminHeaders, bytes);
  try {
    await body.admitted();
    await h.storage.identityProtocol.raise(2);
    body.finish(); const response = await body.response;
    assert.equal(response.status, 409); noGrant(response);
    assert.deepEqual(response.json(), { error: "identity_required", reason: "identity_upgrade_required" });
    assert.equal(await h.storage.getRoom(stalled.roomId), null);
  } finally { body.destroy(); }
});

test("administrative create orders policy/commit and preserves unknown-ACK rows", postgres, async t => {
  const h = await startAuthorHttpFixture(t, 1, false, true);
  const body = (roomId: string) => ({ roomId, tenantId: "demo-tenant", templateId: "personal-workspace-basic",
    name: "Policy ordered creation", roomType: "personal", ownerParticipantId: "legacy-owner" });
  const blockedId = `queued-${randomUUID()}`, holder = await h.pool.connect();
  let pending: Promise<AuthorHttpResponse> | undefined;
  try {
    await holder.query("begin"); await holder.query("lock table room_identity_protocol_policy in exclusive mode");
    await holder.query(`create or replace function vrata_identity_v2_room_boundary() returns trigger language plpgsql as $body$${activatedIdentityRoomGuard}$body$`);
    await holder.query("update room_identity_protocol_policy set minimum_protocol=2,media_namespace=repeat('a',32) where singleton=true");
    const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid;
    pending = h.request("/api/rooms", "POST", h.adminHeaders, body(blockedId)); void pending.catch(() => undefined);
    await until(async () => (await h.pool.query(`select exists(select 1 from pg_stat_activity where application_name=$2
      and $1=any(pg_blocking_pids(pid)) and query like '%for share%') as waiting`, [pid, h.schema])).rows[0].waiting, "admin create must queue on actual policy lock");
    await holder.query("commit"); const refused = await pending;
    assert.equal(refused.status, 409); noGrant(refused); assert.equal(await h.storage.getRoom(blockedId), null);
  } finally { await holder.query("rollback").catch(() => undefined); holder.release(); await pending?.catch(() => undefined); }

  const ackId = `ack-${randomUUID()}`;
  await h.arm("administrative-ack-loss", ackId);
  const receipt = await h.request("/api/rooms", "POST", h.adminHeaders, { ...body(ackId), ownerParticipantId: null });
  assert.equal(receipt.status, 503); noGrant(receipt);
  assert.equal((await h.storage.getRoom(ackId))?.ownerParticipantId, null);
  assert.equal((await h.request("/api/rooms", "POST", h.adminHeaders, { ...body(ackId), ownerParticipantId: null })).status, 409);
  assert.equal((await h.pool.query("select count(*)::integer as count from rooms where room_id=$1", [ackId])).rows[0].count, 1);
});

test("a committed administrative metadata receipt may finish after raise without holding its creation fence", postgres, async t => {
  const h = await startAuthorHttpFixture(t, 1, false, true), roomId = `receipt-${randomUUID()}`;
  const id = await h.arm("administrative-receipt", roomId);
  const pending = h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId: "demo-tenant",
    templateId: "personal-workspace-basic", name: "Committed metadata receipt", roomType: "personal", ownerParticipantId: "legacy-owner" });
  void pending.catch(() => undefined);
  try {
    await h.phase(id, "administrative-receipt");
    await h.storage.identityProtocol.raise(2);
    await h.resume();
    const response = await pending;
    assert.equal(response.status, 201); noGrant(response);
    assert.equal(response.json().ownerParticipantId, "legacy-owner");
  } finally { await h.resume(); await pending.catch(() => undefined); }
});

test("floor2 personal reference provisioning requires invited identity and explicit Owner handoff, not raw IDs", postgres, async t => {
  const h = await startAuthorHttpFixture(t, 2, false, true);
  await h.storage.transitionReferenceTemplateCatalog("active");
  const input = { roomId: `personal-${randomUUID()}`, tenantId: "demo-tenant", templateId: "personal-room-basic", name: "Proof-bound recipient" };
  const create = (extra: Record<string, unknown> = {}) => h.request("/api/rooms", "POST", h.adminHeaders, { ...input, ...extra });
  for (const extra of [{ ownerParticipantId: "public-owner" }, { sessionControl: { hostParticipantId: "raw-host" } },
    { sessionControl: { presenterParticipantId: "raw-presenter" } }]) {
    const refused = await create(extra); assert.equal(refused.status, 409); noGrant(refused); assert.equal(await h.storage.getRoom(input.roomId), null);
  }
  const result = await create({ ownerParticipantId: null }); assert.equal(result.status, 201); noGrant(result);
  const room = result.json<{ roomId: string; roomType: string; ownerParticipantId: string | null; visibility: string; guestAllowed: boolean }>();
  assert.deepEqual([room.roomType, room.ownerParticipantId, room.visibility, room.guestAllowed], ["personal", null, "private", false]);
  assert.equal(await h.storage.hasRoomIdentityAuthority(room.roomId), false);
  const item = async (headers: Record<string, string> = h.adminHeaders) => {
    const value = await h.request(`/api/rooms/${room.roomId}`, "GET", headers); assert.equal(value.status, 200);
    return value.json<{ ownerParticipantId: string | null; currentOwnerParticipantId?: string | null }>();
  };
  const createdView = await item();
  assert.deepEqual([createdView.ownerParticipantId, createdView.currentOwnerParticipantId], [null, null]);
  const recipient = await h.session(room.roomId, "member");
  const authority = await h.storage.roomIdentities.authority({ tenantId: input.tenantId, roomId: room.roomId }); assert.ok(authority);
  assert.equal(authority.hostIdentityId, null); assert.equal(authority.ownerIdentityId, null);
  const handoff = await h.request(`/api/rooms/${room.roomId}/owner/transfer`, "POST", h.adminHeaders,
    { participantId: recipient.participantId, expectedRevision: authority.revision });
  assert.equal(handoff.status, 200);
  const ownerView = await item();
  assert.deepEqual([ownerView.ownerParticipantId, ownerView.currentOwnerParticipantId], [null, recipient.participantId]);
  assert.equal("currentOwnerParticipantId" in await item(authorHttpBearer(recipient.token)), false);
  assert.equal((await h.request("/api/rooms", "GET", h.adminHeaders)).bytes.toString().includes("currentOwnerParticipantId"), false);
  const explicit = await h.request(`/api/rooms/${room.roomId}/invites`, "POST", h.adminHeaders, { role: "member", expiresInSeconds: 3600 });
  assert.equal(explicit.status, 201);
  const invited = await h.admit(room.roomId, { inviteToken: new URL(explicit.json<{ inviteLink: string }>().inviteLink).searchParams.get("invite") });
  assert.equal(invited.status, 200);
  assert.deepEqual([invited.json().role, invited.json().isOwner], ["member", false]);
  await h.request(`/api/rooms/${room.roomId}`, "PATCH", h.adminHeaders, { currentOwnerParticipantId: "forged-current-owner" });
  assert.equal((await item()).currentOwnerParticipantId, recipient.participantId);
  const control = await h.request(`/api/rooms/${room.roomId}/session-control`, "GET", authorHttpBearer(recipient.token));
  assert.equal(control.status, 200); const projection = control.json<{ participant: { role: string; isOwner: boolean }; state: { hostParticipantId: string | null } }>();
  assert.deepEqual([projection.participant.role, projection.participant.isOwner, projection.state.hostParticipantId], ["member", true, null]);
  for (const change of [{ name: "Renamed unowned reference" }, { theme: { primaryColor: "#111111", accentColor: "#222222" } }, { ownerParticipantId: null }]) {
    assert.equal((await h.request(`/api/rooms/${room.roomId}`, "PATCH", h.adminHeaders, change)).status, 200);
  }
  assert.equal((await h.request(`/api/rooms/${room.roomId}/disable`, "POST", h.adminHeaders)).status, 200);
  assert.equal((await h.request(`/api/rooms/${room.roomId}/enable`, "POST", h.adminHeaders)).status, 200);
  assert.equal((await h.request(`/api/rooms/${room.roomId}`, "PATCH", h.adminHeaders, { ownerParticipantId: recipient.participantId })).status, 409);
  assert.equal((await h.request(`/api/rooms/${room.roomId}`, "PATCH", h.adminHeaders, { sessionControl: { hostParticipantId: recipient.participantId } })).status, 409);
  const row = (await h.pool.query("select owner_participant_id from rooms where room_id=$1", [room.roomId])).rows[0];
  assert.equal(row.owner_participant_id, null);
  const session = await h.request("/api/control-plane/session", "GET", h.adminHeaders);
  assert.equal(session.json().minimumIdentityProtocol, 2);
});
