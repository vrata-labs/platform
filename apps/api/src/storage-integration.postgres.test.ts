import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { PostgresStorage } from "./storage.js";

const url = process.env.VRATA_TEST_POSTGRES_URL;
const skip = url ? false : "VRATA_TEST_POSTGRES_URL is not set; skipping PostgreSQL integration storage test";

async function database(run: (pools: Pool[]) => Promise<void>) {
  assert(url);
  const schema = `integration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  // One connection per pool: a transaction that asks its pool for a second connection hangs here.
  const pools = [0, 1].map(() => new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 1 }));
  try {
    await admin.query(`create schema "${schema}"`);
    await run(pools);
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`drop schema if exists "${schema}" cascade`);
    await admin.end();
  }
}

const managedInput = (operationId: string) => ({ managedBy: "portal:stage", kind: "reference" as const, accessUntil: "2030-01-01T00:00:00.000Z", graceSeconds: 60, ownerSubject: null, operationId });

test("Postgres integration storage keeps tenants, managed rooms, CAS and operations consistent on single-connection pools", { skip, timeout: 120_000 }, async () => {
  await database(async ([first, second]) => {
    const storage = new PostgresStorage(first!);
    const other = new PostgresStorage(second!);
    await storage.init();
    await storage.transitionReferenceTemplateCatalog("active");

    const tenantId = "pt_01JABCDEFGHJKMNPQRSTVWXYZ1";
    const upserts = await Promise.all([
      storage.upsertIntegrationTenant({ tenantId, managedBy: "portal:stage", displayName: "Acme" }),
      other.upsertIntegrationTenant({ tenantId, managedBy: "portal:stage", displayName: "Acme" })
    ]);
    assert(upserts.every(result => result !== "tenant_mismatch" && result.revision === 0));
    assert.equal(await other.upsertIntegrationTenant({ tenantId, managedBy: "portal:prod", displayName: "Acme" }), "tenant_mismatch");
    const renamed = await storage.upsertIntegrationTenant({ tenantId, managedBy: "portal:stage", displayName: "Acme Inc" });
    assert(renamed !== "tenant_mismatch");
    assert.equal(renamed.revision, 1);
    assert.equal((await storage.listTenants()).find(tenant => tenant.tenantId === tenantId)?.name, "Acme Inc");
    await storage.createTenant({ tenantId: "operator-tenant", name: "Operator" });
    assert.equal(await storage.upsertIntegrationTenant({ tenantId: "operator-tenant", managedBy: "portal:stage", displayName: "Taken" }), "tenant_mismatch");

    const roomId = randomUUID();
    const operationId = randomUUID();
    const input = { roomId, tenantId, templateId: "meeting-room-basic", templateVersion: "2.0.0", name: "Managed", visibility: "unlisted" as const, guestAllowed: true };
    const room = await storage.createManagedRoom(input, managedInput(operationId));
    assert.deepEqual([room.managed?.revision, room.managed?.status, room.managed?.graceSeconds, room.managed?.lastOperationId], [0, "active", 60, operationId]);
    await assert.rejects(other.createManagedRoom(input, managedInput(randomUUID())), /managed_room_exists/);
    assert.equal((await storage.listRooms()).filter(item => item.managed).length, 1);
    const plain = await storage.createRoom({ name: "Plain", templateId: "meeting-room-basic" });
    assert.equal(plain.managed, undefined);
    assert.equal((await storage.updateRoom(roomId, { name: "Renamed", managed: undefined }))?.managed?.revision, 0);

    const updateId = randomUUID();
    const results = await Promise.all([
      storage.updateManagedRoomAccess(roomId, 0, { status: "paused" }, updateId),
      other.updateManagedRoomAccess(roomId, 0, { graceSeconds: 0 }, randomUUID())
    ]);
    assert.equal(results.filter(result => result === "revision_mismatch").length, 1);
    const updated = await storage.getRoom(roomId);
    assert.equal(updated?.managed?.revision, 1);
    assert.equal(await storage.updateManagedRoomAccess(plain.roomId, 0, { status: "paused" }, randomUUID()), null);
    const extended = await storage.updateManagedRoomAccess(roomId, 1, { accessUntil: "2031-01-01T00:00:00.000Z" }, updateId);
    assert(extended && extended !== "revision_mismatch" && extended !== "room_closed");
    assert.deepEqual([extended.managed?.accessUntil, extended.managed?.revision, extended.managed?.lastOperationId], ["2031-01-01T00:00:00.000Z", 2, updateId]);

    const start = { principal: "portal:stage", idempotencyKey: "operation-key-0001", kind: "room.create", requestHash: "sha256:" + "a".repeat(64), resourceType: "room", resourceId: randomUUID(), leaseSeconds: 30 };
    const begun = await Promise.all([storage.beginIntegrationOperation({ ...start, operationId: randomUUID() }), other.beginIntegrationOperation({ ...start, operationId: randomUUID() })]);
    assert.equal(begun.filter(result => result.created).length, 1);
    assert.equal(begun[0]!.operation.operationId, begun[1]!.operation.operationId);
    const operation = begun[0]!.operation;
    assert.equal(await other.claimIntegrationOperation(operation.operationId, 30), null);
    await storage.releaseIntegrationOperation(operation.operationId);
    assert.equal((await other.claimIntegrationOperation(operation.operationId, 30))?.state, "running");
    const done = await storage.completeIntegrationOperation(operation.operationId, { state: "succeeded", resultRevision: 0, responseStatus: 201, responseBody: { roomId } });
    assert.deepEqual([done?.state, done?.responseStatus, done?.responseBody, done?.resultRevision], ["succeeded", 201, { roomId }, 0]);
    assert.equal(await other.claimIntegrationOperation(operation.operationId, 30), null);
    assert.equal((await other.findIntegrationOperation("portal:stage", "operation-key-0001"))?.operationId, operation.operationId);
    assert.equal(await other.findIntegrationOperation("portal:prod", "operation-key-0001"), null);
    assert.equal(await other.getIntegrationOperation("portal:prod", operation.operationId), null);

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const recorded = await Promise.all([storage.recordIntegrationAssertion("portal:stage", "jti-000000000001", expiresAt), other.recordIntegrationAssertion("portal:stage", "jti-000000000001", expiresAt)]);
    assert.deepEqual(recorded.sort(), [false, true]);
    assert.equal(await storage.recordIntegrationAssertion("portal:prod", "jti-000000000001", expiresAt), true);

    await assert.rejects(first!.query("delete from rooms where room_id = $1", [roomId]), /foreign key/);
    await assert.rejects(first!.query("delete from tenants where tenant_id = $1", [tenantId]), /foreign key/);
    await storage.init();
    assert.deepEqual((await storage.getRoom(roomId))?.managed, extended.managed);
  });
});
