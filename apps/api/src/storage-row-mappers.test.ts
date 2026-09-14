import assert from "node:assert/strict";
import test from "node:test";

import {
  isoString,
  mapRoomDocumentRow,
  mapRoomInviteRow,
  mapRoomNoteRow,
  mapRoomNoteVersionRow,
  mapWaitingRoomRequestRow
} from "./storage-row-mappers.js";

const timestamp = "2026-01-02T03:04:05.006Z";

function invite(overrides: Partial<Parameters<typeof mapRoomInviteRow>[0]> = {}) {
  return { invite_id: "invite", room_id: "room", token_hash: "hash", role: "guest" as const,
    waiting_room_enabled: false, created_at: timestamp, expires_at: timestamp, ...overrides };
}

function request(overrides: Partial<Parameters<typeof mapWaitingRoomRequestRow>[0]> = {}) {
  return { request_id: "request", room_id: "room", invite_id: "invite", participant_id: "participant",
    display_name: "Guest", status: "pending" as const, created_at: timestamp, ...overrides };
}

function note(overrides: Partial<Parameters<typeof mapRoomNoteRow>[0]> = {}) {
  return { note_id: "note", room_id: "room", scope: "shared" as const,
    content: "Note content", updated_at: timestamp, ...overrides };
}

function version(overrides: Partial<Parameters<typeof mapRoomNoteVersionRow>[0]> = {}) {
  return { version_id: "version", note_id: "note", room_id: "room", scope: "private" as const,
    content: "Version content", action: "restore" as const, created_at: timestamp, ...overrides };
}

function document(overrides: Partial<Parameters<typeof mapRoomDocumentRow>[0]> = {}) {
  return { document_id: "document", room_id: "room", tenant_id: "tenant", filename: "slides.pdf",
    content_type: "application/pdf", size_bytes: "42", storage_key: "key", checksum: "checksum",
    uploaded_at: timestamp, ...overrides };
}

function requiredDates(value: string | Date): string[] {
  const mappedInvite = mapRoomInviteRow(invite({ created_at: value, expires_at: value }));
  return [mappedInvite.createdAt, mappedInvite.expiresAt,
    mapWaitingRoomRequestRow(request({ created_at: value })).createdAt,
    mapRoomNoteRow(note({ updated_at: value })).updatedAt!,
    mapRoomNoteVersionRow(version({ created_at: value })).createdAt,
    mapRoomDocumentRow(document({ uploaded_at: value })).uploadedAt];
}

function optionalDates(value?: string | Date | null): Array<string | null | undefined> {
  return [mapRoomInviteRow(invite({ revoked_at: value })).revokedAt,
    mapWaitingRoomRequestRow(request({ decided_at: value })).decidedAt,
    mapRoomNoteRow(note({ deleted_at: value })).deletedAt,
    mapRoomDocumentRow(document({ deleted_at: value })).deletedAt];
}

test("isoString preserves strings verbatim, normalizes Date and maps empty values to null", () => {
  for (const value of [undefined, null, ""]) assert.equal(isoString(value), null);
  for (const value of [timestamp, "2026-01-02T06:04:05+03:00", " ", "not-a-date"]) {
    assert.equal(isoString(value), value);
  }
  assert.equal(isoString(new Date(timestamp)), timestamp);
  assert.throws(() => isoString(new Date(NaN)), RangeError);
});

test("invite mapper preserves fields, roles and waiting-room settings", () => {
  for (const role of ["guest", "member", "presenter", "host", "admin"] as const) {
    for (const waitingRoomEnabled of [true, false]) {
      const row = invite({ role, waiting_room_enabled: waitingRoomEnabled,
        revoked_at: timestamp, created_by: "creator", revoked_by: "revoker" });
      assert.deepEqual(mapRoomInviteRow(row), {
        inviteId: "invite", roomId: "room", tokenHash: "hash", role, waitingRoomEnabled,
        createdAt: timestamp, expiresAt: timestamp, revokedAt: timestamp,
        createdBy: "creator", revokedBy: "revoker"
      });
    }
  }
});

test("waiting-room mapper preserves identity, display name and each decision status", () => {
  for (const status of ["pending", "approved", "rejected"] as const) {
    assert.deepEqual(mapWaitingRoomRequestRow(request({ status, decided_at: timestamp, decided_by: "host" })), {
      requestId: "request", roomId: "room", inviteId: "invite", participantId: "participant",
      displayName: "Guest", status, createdAt: timestamp, decidedAt: timestamp, decidedBy: "host"
    });
  }
});

test("note mapper preserves scope, owner, content and deletion fields", () => {
  for (const scope of ["shared", "private"] as const) {
    assert.deepEqual(mapRoomNoteRow(note({ scope, owner_participant_id: "owner",
      updated_by: "editor", deleted_at: timestamp, deleted_by: "deleter" })), {
      noteId: "note", roomId: "room", scope, ownerParticipantId: "owner", content: "Note content",
      updatedAt: timestamp, updatedBy: "editor", deletedAt: timestamp, deletedBy: "deleter"
    });
  }
});

test("note-version mapper preserves scope, action, content and restore provenance", () => {
  for (const scope of ["shared", "private"] as const) {
    for (const action of ["save", "restore", "delete"] as const) {
      assert.deepEqual(mapRoomNoteVersionRow(version({ scope, action, owner_participant_id: "owner",
        restored_from_version_id: "source", created_by: "editor" })), {
        versionId: "version", noteId: "note", roomId: "room", scope, ownerParticipantId: "owner",
        content: "Version content", action, restoredFromVersionId: "source",
        createdAt: timestamp, createdBy: "editor"
      });
    }
  }
});

test("document mapper preserves fields, metadata and upload/deletion provenance", () => {
  const metadata = { kind: "pdf" as const, pageCount: 3, title: "Slides", author: null };
  assert.deepEqual(mapRoomDocumentRow(document({ metadata, uploaded_by: "uploader",
    deleted_at: timestamp, deleted_by: "deleter", linked_surface_id: "surface" })), {
    documentId: "document", roomId: "room", tenantId: "tenant", filename: "slides.pdf",
    contentType: "application/pdf", sizeBytes: 42, storageKey: "key", checksum: "checksum",
    metadata, uploadedBy: "uploader", uploadedAt: timestamp, deletedAt: timestamp,
    deletedBy: "deleter", linkedSurfaceId: "surface"
  });
});

test("missing optional fields become explicit nulls and document metadata becomes an object", () => {
  assert.deepEqual(mapRoomInviteRow(invite()), { inviteId: "invite", roomId: "room", tokenHash: "hash",
    role: "guest", waitingRoomEnabled: false, createdAt: timestamp, expiresAt: timestamp,
    revokedAt: null, createdBy: null, revokedBy: null });
  assert.deepEqual(mapWaitingRoomRequestRow(request()), { requestId: "request", roomId: "room",
    inviteId: "invite", participantId: "participant", displayName: "Guest", status: "pending",
    createdAt: timestamp, decidedAt: null, decidedBy: null });
  assert.deepEqual(mapRoomNoteRow(note()), { noteId: "note", roomId: "room", scope: "shared",
    ownerParticipantId: null, content: "Note content", updatedAt: timestamp, updatedBy: null,
    deletedAt: null, deletedBy: null });
  assert.deepEqual(mapRoomNoteVersionRow(version()), { versionId: "version", noteId: "note", roomId: "room",
    scope: "private", ownerParticipantId: null, content: "Version content", action: "restore",
    restoredFromVersionId: null, createdAt: timestamp, createdBy: null });
  assert.deepEqual(mapRoomDocumentRow(document()), { documentId: "document", roomId: "room", tenantId: "tenant",
    filename: "slides.pdf", contentType: "application/pdf", sizeBytes: 42, storageKey: "key",
    checksum: "checksum", metadata: {}, uploadedBy: null, uploadedAt: timestamp, deletedAt: null,
    deletedBy: null, linkedSurfaceId: null });
});

test("optional identifier defaults are nullish, not truthy", () => {
  for (const value of [undefined, null, "", "actor"]) {
    const expected = value ?? null;
    const a = mapRoomInviteRow(invite({ created_by: value, revoked_by: value }));
    const b = mapWaitingRoomRequestRow(request({ decided_by: value }));
    const c = mapRoomNoteRow(note({ owner_participant_id: value, updated_by: value, deleted_by: value }));
    const d = mapRoomNoteVersionRow(version({ owner_participant_id: value,
      restored_from_version_id: value, created_by: value }));
    const e = mapRoomDocumentRow(document({ uploaded_by: value, deleted_by: value, linked_surface_id: value }));
    for (const actual of [a.createdBy, a.revokedBy, b.decidedBy, c.ownerParticipantId, c.updatedBy,
      c.deletedBy, d.ownerParticipantId, d.restoredFromVersionId, d.createdBy, e.uploadedBy,
      e.deletedBy, e.linkedSurfaceId]) assert.equal(actual, expected);
  }
});

test("all required timestamps convert Date but preserve strings without parsing", () => {
  assert.deepEqual(requiredDates(new Date(timestamp)), Array(6).fill(timestamp));
  for (const value of [timestamp, "2026-01-02T06:04:05+03:00", "not-a-date", " "]) {
    assert.deepEqual(requiredDates(value), Array(6).fill(value));
  }
});

test("empty required timestamps sample the current clock on each call", (t) => {
  const now = Date.parse(timestamp);
  t.mock.timers.enable({ apis: ["Date"], now });
  assert.deepEqual(requiredDates(""), Array(6).fill(timestamp));
  t.mock.timers.tick(1234);
  assert.deepEqual(requiredDates(""), Array(6).fill(new Date(now + 1234).toISOString()));
});

test("optional timestamps become null without a current-time fallback", () => {
  for (const value of [undefined, null, ""]) assert.deepEqual(optionalDates(value), Array(4).fill(null));
  assert.deepEqual(optionalDates(new Date(timestamp)), Array(4).fill(timestamp));
  for (const value of [timestamp, "not-a-date", " "]) {
    assert.deepEqual(optionalDates(value), Array(4).fill(value));
  }
});

test("invalid Date errors propagate from every required and optional timestamp", () => {
  const value = new Date(NaN);
  const calls = [
    () => mapRoomInviteRow(invite({ created_at: value })),
    () => mapRoomInviteRow(invite({ expires_at: value })),
    () => mapRoomInviteRow(invite({ revoked_at: value })),
    () => mapWaitingRoomRequestRow(request({ created_at: value })),
    () => mapWaitingRoomRequestRow(request({ decided_at: value })),
    () => mapRoomNoteRow(note({ updated_at: value })),
    () => mapRoomNoteRow(note({ deleted_at: value })),
    () => mapRoomNoteVersionRow(version({ created_at: value })),
    () => mapRoomDocumentRow(document({ uploaded_at: value })),
    () => mapRoomDocumentRow(document({ deleted_at: value }))
  ];
  for (const call of calls) assert.throws(call, RangeError);
});

test("document sizes retain Number conversion, including unusual stored values", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, "", " 42 ", "1.5", "1e3", "0x10", "invalid", "9007199254740993"]) {
    assert.equal(mapRoomDocumentRow(document({ size_bytes: value })).sizeBytes, Number(value));
  }
});

test("document metadata retains reference identity and missing defaults are fresh objects", () => {
  const metadata = { kind: "video" as const, durationMs: 1000, metadataSource: "browser" as const };
  assert.equal(mapRoomDocumentRow(document({ metadata })).metadata, metadata);
  const a = mapRoomDocumentRow(document()).metadata;
  const b = mapRoomDocumentRow(document({ metadata: null })).metadata;
  assert.deepEqual(a, {});
  assert.deepEqual(b, {});
  assert.notEqual(a, b);
});

test("mappers do not mutate input rows and return fresh records on each invocation", () => {
  function verify<T extends object>(row: T, map: (row: T) => object) {
    const original = structuredClone(row);
    Object.freeze(row);
    const a = map(row);
    const b = map(row);
    assert.deepEqual(row, original);
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
    assert.notEqual(a, row);
  }
  verify(invite(), mapRoomInviteRow);
  verify(request(), mapWaitingRoomRequestRow);
  verify(note(), mapRoomNoteRow);
  verify(version(), mapRoomNoteVersionRow);
  verify(document({ metadata: Object.freeze({ kind: "pdf" as const }) }), mapRoomDocumentRow);
});
