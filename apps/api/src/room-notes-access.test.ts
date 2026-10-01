import assert from "node:assert/strict";
import test from "node:test";
import type { RoomNoteScope } from "./storage.js";
import { createRoomNotesHarness, makeNotesExchange } from "./testing/room-notes-harness.js";

for (const scope of ["shared", "private"] as const) {
  test(`${scope}: empty records preserve IDs, null fields and independent objects`, (t) => {
    const h = createRoomNotesHarness(t);
    const note = h.access.emptyRoomNote("r/1", scope, "owner");
    assert.deepEqual(note, {
      noteId: scope === "shared" ? "r/1:shared" : "r/1:private:owner", roomId: "r/1", scope,
      ownerParticipantId: scope === "shared" ? null : "owner", content: "",
      updatedAt: null, updatedBy: null, deletedAt: null, deletedBy: null
    });
    assert.notEqual(note, h.access.emptyRoomNote("r/1", scope, "owner"));
    assert.equal(h.access.noteWritePermission(scope), scope === "private" ? "notes.view" : "notes.edit");
    assert.equal(h.access.emptyRoomNote("r", "private").noteId, "r:private:");
  });
}

test("construction has no authorization or audit effects", (t) => {
  const h = createRoomNotesHarness(t);
  assert.deepEqual(h.authRequests, []); assert.deepEqual(h.logs, []);
  assert.equal(h.metrics.notesPermissionDeniedTotal, 0);
});

for (const reason of ["missing_identity", "room_mismatch", "room_disabled", "permission_denied"]) {
  test(`authorization preserves ${reason}, request ID and audit order`, async (t) => {
    const h = createRoomNotesHarness(t); const e = makeNotesExchange("GET", "/");
    const room = (await h.storage.getRoom("demo-room"))!;
    if (reason === "missing_identity") h.state.actorResult = { ok: false, statusCode: 401, reason };
    if (reason === "room_mismatch") { h.actor.roomId = "other"; room.status = "disabled"; }
    if (reason === "room_disabled") room.disabledAt = "2026-01-01T00:00:00Z";
    if (reason === "permission_denied") h.actor.permissions = [];
    const writeHead = e.response.writeHead;
    t.mock.method(e.response, "writeHead", function (this: typeof e.response, ...args: Parameters<typeof writeHead>) {
      assert.equal(h.logs.length, 1, "Audit is written before the HTTP response");
      return writeHead.apply(this, args);
    });
    assert.equal(h.access.resolveRoomNotesActor(e.request, e.response, { room, scope: "shared", permission: "notes.view", action: "notes.read" }), null);
    assert.equal(e.output.status, reason === "missing_identity" ? 401 : 403);
    assert.deepEqual(e.output.json(), {
      error: reason === "missing_identity" ? "unauthorized" : "forbidden", reason,
      ...(reason === "missing_identity" ? {} : { permission: "notes.view" }), requestId: "notes-request"
    });
    assert.equal(h.metrics.notesPermissionDeniedTotal, 1); assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0]?.result, "denied"); assert.equal(h.logs[0]?.reason, reason);
    assert.equal(h.logs[0]?.requestId, "notes-request");
  });
}

test("authorization observes changed permissions and retains explicit empty permissions", async (t) => {
  const h = createRoomNotesHarness(t); const room = (await h.storage.getRoom("demo-room"))!;
  const check = () => { const e = makeNotesExchange("GET", "/"); return h.access.resolveRoomNotesActor(e.request, e.response, { room, scope: "shared", permission: "notes.edit", action: "notes.save" }); };
  assert.equal(check(), h.actor);
  h.actor.permissions = []; assert.equal(check(), null);
  h.actor.role = "admin"; delete h.actor.permissions; assert.equal(check(), h.actor);
  h.actor.actorType = "admin-token"; room.status = "disabled"; assert.equal(check(), h.actor);
  h.actor.permissions = []; assert.equal(check(), null); // Admin identity does not bypass explicit permissions.
});

for (const action of ["notes.read", "notes.save", "notes.versions", "notes.restore", "notes.delete", "notes.export"] as const) {
  test(`${action}: private owner mismatch retains the exact counters and audit`, (t) => {
    const h = createRoomNotesHarness(t); const e = makeNotesExchange("GET", "/?participantId=other");
    assert.equal(h.access.resolveAuthorizedRoomNoteOwner(e.request, e.response, {
      roomId: "demo-room", scope: "private", actor: h.actor, url: e.url, permission: "notes.view", action
    }), undefined);
    assert.equal(e.output.status, 403); assert.equal(h.metrics.notesPermissionDeniedTotal, 1);
    assert.equal(h.metrics.notesExportDeniedTotal, action === "notes.export" ? 1 : 0);
    assert.equal(h.logs[0]?.reason, "note_owner_mismatch");
  });
}

for (const query of ["", "?participantId=", "?participantId=%20%20", "?participantId=%20member-1%20"]) {
  test(`private session ownership ignores blank queries and trims explicit owners: ${query}`, (t) => {
    const h = createRoomNotesHarness(t); const e = makeNotesExchange("GET", `/${query}`);
    assert.equal(h.access.resolveAuthorizedRoomNoteOwner(e.request, e.response, {
      roomId: "demo-room", scope: "private", actor: h.actor, url: e.url, permission: "notes.view", action: "notes.read"
    }), "member-1");
    assert.equal(e.output.writes, 0);
  });
}

test("admin private requests require an explicit owner; shared requests ignore it", (t) => {
  const h = createRoomNotesHarness(t); h.actor.actorType = "admin-token";
  function owner(scope: RoomNoteScope, path: string) {
    const e = makeNotesExchange("GET", path);
    const result = h.access.resolveAuthorizedRoomNoteOwner(e.request, e.response, { roomId: "demo-room", scope, actor: h.actor, url: e.url, permission: "notes.view", action: "notes.read" });
    return { e, result };
  }
  assert.equal(owner("private", "/?participantId=%20other%20").result, "other");
  const missing = owner("private", "/"); assert.equal(missing.result, undefined);
  assert.deepEqual(missing.e.output.json(), { error: "missing_private_note_owner" });
  assert.equal(h.metrics.notesSaveFailuresTotal.get("missing_private_note_owner"), 1);
  assert.equal(owner("shared", "/?participantId=other").result, null);
});

test("archive visibility and audit fields do not expose extra actor permissions", (t) => {
  const h = createRoomNotesHarness(t); const e = makeNotesExchange("GET", "/");
  const shared = h.access.emptyRoomNote("demo-room", "shared");
  const privateNote = h.access.emptyRoomNote("demo-room", "private", "other");
  assert.equal(h.access.roomNoteVisibleToActor(shared, h.actor), true);
  assert.equal(h.access.roomNoteVisibleToActor(privateNote, h.actor), false);
  privateNote.ownerParticipantId = h.actor.participantId;
  assert.equal(h.access.roomNoteVisibleToActor(privateNote, h.actor), true);
  h.access.writeRoomNotesAudit({ request: e.request, roomId: "demo-room", scope: "private", action: "notes.read", result: "allowed", actor: h.actor });
  const { timestamp, ...audit } = h.logs[0]!;
  assert.equal(typeof timestamp, "string");
  assert.deepEqual(audit, { service: "api", event: "room_notes_audit", requestId: "notes-request",
    action: "notes.read", roomId: "demo-room", scope: "private", result: "allowed", reason: undefined,
    actor: { actorType: "room-session", actorId: "member-1", role: "member", tenantId: "demo-tenant", roomId: "demo-room", participantId: "member-1", sessionId: "session-1" }
  });
});
