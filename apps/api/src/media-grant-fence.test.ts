import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assertMediaGrantPin, MediaBoundaryChanged } from "./identity/effect-write-guard.js";
import { MemoryStorage } from "./storage.js";

const namespace = "a".repeat(32), incarnation = "1".repeat(32), epoch = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

test("a media pin names one codec, namespace, generation and managed access epoch", () => {
  const current = { codec: 3, namespace, incarnation, accessEpoch: epoch };
  assertMediaGrantPin({ codec: 3, namespace, incarnation, accessEpoch: epoch }, current);
  assertMediaGrantPin({ codec: 2, namespace }, { codec: 2, namespace, incarnation, accessEpoch: null });
  for (const changed of [{ ...current, accessEpoch: randomUUID() }, { ...current, accessEpoch: null }, { ...current, incarnation: "2".repeat(32) },
    { ...current, codec: 2 }, { ...current, namespace: "b".repeat(32) }]) {
    assert.throws(() => assertMediaGrantPin({ codec: 3, namespace, incarnation, accessEpoch: epoch }, changed), MediaBoundaryChanged);
  }
  assert.throws(() => assertMediaGrantPin({ codec: 2, namespace }, { codec: 2, namespace, incarnation, accessEpoch: epoch }), MediaBoundaryChanged,
    "a room that became managed is a change for an unmanaged pin");
  assert.throws(() => assertMediaGrantPin({ codec: 3, namespace }, current), /invalid_identity_input/);
  assert.throws(() => assertMediaGrantPin({ codec: 2, namespace, incarnation }, current), /invalid_identity_input/);
});

test("a managed room's epoch rotation before release refuses the prepared grant", async () => {
  const storage = new MemoryStorage();
  await storage.identityProtocol.raise(2);
  const boundary = (await storage.identityProtocol.mediaBoundary())!;
  const room = await storage.createManagedRoom({ roomId: randomUUID(), tenantId: "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", name: "Room", visibility: "private" }, {
    managedBy: "portal:stage", kind: "reference", accessUntil: new Date(Date.now() + 3_600_000).toISOString(), graceSeconds: 0, operationId: randomUUID() });
  const scope = { tenantId: room.tenantId, roomId: room.roomId }, before = room.managed!.accessEpoch;
  let released = 0;
  await storage.releaseMediaGrant(scope, { codec: 2, namespace: boundary.namespace, accessEpoch: before }, () => { released++; });
  assert.equal(released, 1);
  assert.ok(await storage.rotateManagedRoomEpoch(room.roomId, before, null));
  await assert.rejects(storage.releaseMediaGrant(scope, { codec: 2, namespace: boundary.namespace, accessEpoch: before }, () => { released++; }),
    MediaBoundaryChanged);
  await assert.rejects(storage.releaseMediaGrant(scope, { codec: 2, namespace: boundary.namespace }, () => { released++; }), MediaBoundaryChanged,
    "an unmanaged pin never releases into a managed room");
  assert.equal(released, 1);
});
