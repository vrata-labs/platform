import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { MemoryStorage, PostgresStorage, type Storage } from "./storage.js";

async function open(t: TestContext, backend: "memory" | "postgres"): Promise<{ storage: Storage; pool?: Pool }> {
  if (backend === "memory") return { storage: new MemoryStorage() };
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL, "CI storage contracts require real PostgreSQL");
  const schema = `room_data_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${schema},public` });
  t.after(async () => { await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const storage = new PostgresStorage(pool);
  await storage.init();
  return { storage, pool };
}

const document = (roomId: string, tenantId: string, name: string) => ({ documentId: randomUUID(), roomId, tenantId,
  filename: `${name}.pdf`, contentType: "application/pdf", sizeBytes: 4, storageKey: `documents/${tenantId}/${roomId}/${name}.pdf`,
  checksum: "sha256:test", uploadedBy: "author", metadata: { kind: "pdf" as const, pageCount: 1 } });

for (const backend of ["memory", "postgres"] as const) {
  const skip = backend === "postgres" && !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI;

  test(`${backend}: a recreated room with the same ID starts without the deleted room's notes and documents`, { skip, timeout: 60_000 }, async t => {
    const { storage } = await open(t, backend);
    const room = await storage.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "First" });
    await storage.upsertRoomNote({ roomId: room.roomId, scope: "shared", ownerParticipantId: null, content: "first meeting", updatedBy: "author" });
    await storage.upsertRoomNote({ roomId: room.roomId, scope: "private", ownerParticipantId: "author", content: "mine", updatedBy: "author" });
    const slides = await storage.createRoomDocument(document(room.roomId, room.tenantId, "slides"));
    const draft = await storage.createRoomDocument(document(room.roomId, room.tenantId, "draft"));
    assert.ok(await storage.markRoomDocumentDeleted(room.roomId, draft.documentId, new Date().toISOString(), "author"));
    const other = await storage.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Other" });
    await storage.upsertRoomNote({ roomId: other.roomId, scope: "shared", ownerParticipantId: null, content: "kept", updatedBy: "author" });
    await storage.createRoomDocument(document(other.roomId, other.tenantId, "kept"));

    const keys: string[] = [];
    assert.equal(await storage.deleteRoom(room.roomId, undefined, keys), true);
    assert.deepEqual(keys.sort(), [draft.storageKey, slides.storageKey].sort(), "deleted documents' objects are collected too");
    await storage.createRoom({ roomId: room.roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Second" });
    assert.deepEqual(await storage.listRoomNotes(room.roomId, true), []);
    assert.equal(await storage.getRoomNote(room.roomId, "private", "author"), null);
    assert.deepEqual(await storage.listRoomNoteVersions(room.roomId, "shared", null, 100), []);
    assert.deepEqual(await storage.listRoomDocuments(room.roomId), []);
    assert.equal((await storage.listRoomNotes(other.roomId, true)).length, 1, "another room keeps its notes");
    assert.equal((await storage.listRoomDocuments(other.roomId)).length, 1, "another room keeps its documents");
  });

  test(`${backend}: linking a deleted or missing document never unlinks the document on that surface`, { skip, timeout: 60_000 }, async t => {
    const { storage } = await open(t, backend);
    const room = await storage.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Surface" });
    const shown = await storage.createRoomDocument(document(room.roomId, room.tenantId, "shown"));
    const deleted = await storage.createRoomDocument(document(room.roomId, room.tenantId, "deleted"));
    assert.equal((await storage.updateRoomDocumentSurface(room.roomId, shown.documentId, "debug-main"))?.linkedSurfaceId, "debug-main");
    assert.ok(await storage.markRoomDocumentDeleted(room.roomId, deleted.documentId, new Date().toISOString(), "author"));

    assert.equal(await storage.updateRoomDocumentSurface(room.roomId, deleted.documentId, "debug-main"), null);
    assert.equal(await storage.updateRoomDocumentSurface(room.roomId, randomUUID(), "debug-main"), null);
    assert.equal((await storage.getRoomDocument(room.roomId, shown.documentId))?.linkedSurfaceId, "debug-main");

    const next = await storage.createRoomDocument(document(room.roomId, room.tenantId, "next"));
    assert.equal((await storage.updateRoomDocumentSurface(room.roomId, next.documentId, "debug-main"))?.linkedSurfaceId, "debug-main");
    assert.equal((await storage.getRoomDocument(room.roomId, shown.documentId))?.linkedSurfaceId, null, "a live target still takes the surface over");
  });
}

const postgresOnly = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 60_000 };

test("postgres: surface assignments of one room serialize, so concurrent picks leave one document on the surface", postgresOnly, async t => {
  const { storage, pool } = await open(t, "postgres");
  const room = await storage.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Race" });
  const first = await storage.createRoomDocument(document(room.roomId, room.tenantId, "first"));
  const second = await storage.createRoomDocument(document(room.roomId, room.tenantId, "second"));
  const holder = await pool!.connect();
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtextextended('vrata:room-document-surface:' || $1, 0))", [room.roomId]);
    let settled = false;
    const pending = storage.updateRoomDocumentSurface(room.roomId, first.documentId, "debug-main").finally(() => { settled = true; });
    await new Promise(done => setTimeout(done, 300));
    assert.equal(settled, false, "an assignment waits for the room's surface lock");
    await holder.query("commit");
    assert.equal((await pending)?.linkedSurfaceId, "debug-main");
  } finally { holder.release(); }
  for (let round = 0; round < 10; round++) {
    const surface = `surface-${round}`;
    await Promise.all([storage.updateRoomDocumentSurface(room.roomId, first.documentId, surface),
      storage.updateRoomDocumentSurface(room.roomId, second.documentId, surface)]);
    const linked = (await storage.listRoomDocuments(room.roomId)).filter(item => item.linkedSurfaceId === surface);
    assert.equal(linked.length, 1, `round ${round}: one document per surface`);
  }
});

test("postgres: a document read inside a room fence holds the row until the fence ends", postgresOnly, async t => {
  const { storage, pool } = await open(t, "postgres");
  const room = await storage.createRoom({ roomId: randomUUID(), tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Held" });
  const shown = await storage.createRoomDocument(document(room.roomId, room.tenantId, "shown"));
  const fence = await pool!.connect(), writer = await pool!.connect();
  try {
    await fence.query("begin");
    const scoped = new PostgresStorage(pool!, Date.now, fence);
    assert.equal((await scoped.getRoomDocument(room.roomId, shown.documentId))?.deletedAt, null);
    await writer.query("set lock_timeout='300ms'");
    await assert.rejects(writer.query("update room_documents set deleted_at=now() where document_id=$1", [shown.documentId]),
      (error: { code?: string }) => error.code === "55P03", "a tombstone waits for the release that read the live row");
    await fence.query("commit");
    await writer.query("update room_documents set deleted_at=now() where document_id=$1", [shown.documentId]);
  } finally { fence.release(); writer.release(); }
  assert.ok((await storage.getRoomDocument(room.roomId, shown.documentId))?.deletedAt);
});
