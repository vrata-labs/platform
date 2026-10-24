import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { managedMediaRoomName } from "./managed-media-names.js";
import { createManagedRoomEnforcer } from "./managed-room-enforcer.js";
import { MemoryStorage } from "./storage.js";

async function fixture(options: { kind?: "reference" | "demo-instance"; idleTimeoutSeconds?: number } = {}) {
  const storage = new MemoryStorage();
  await storage.identityProtocol.raise(2);
  const namespace = (await storage.identityProtocol.mediaNamespace())!;
  const room = await storage.createManagedRoom({ roomId: randomUUID(), tenantId: "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW", name: "Room", visibility: "private" }, {
    managedBy: "portal:stage", kind: options.kind ?? "reference", accessUntil: new Date(Date.now() + 3_600_000).toISOString(), graceSeconds: 0, operationId: randomUUID(),
    ...(options.idleTimeoutSeconds ? { idleTimeoutSeconds: options.idleTimeoutSeconds, maxParticipants: 4, demoPolicyId: "qa-demo-v1" } : {})
  });
  const deleted: string[] = [];
  const livekit = new Set<string>();
  const events: Array<Record<string, unknown>> = [];
  let failing = false;
  let clock = Date.now();
  const enforcer = createManagedRoomEnforcer({
    storage: Promise.resolve(storage),
    media: () => ({
      async ensureRoom(name) { livekit.add(name); },
      async deleteRoom(name) { if (failing) throw new Error("livekit unavailable"); deleted.push(name); livekit.delete(name); },
      async listRooms() { if (failing) throw new Error("livekit unavailable"); return [...livekit]; }
    }),
    mediaPrefix: () => "vrata-",
    logEvent: event => events.push(event),
    now: () => clock
  });
  const epoch = async () => (await storage.getRoom(room.roomId))!.managed!.accessEpoch;
  return {
    storage, room, enforcer, deleted, livekit, events, epoch, nameOf: (value: string) => managedMediaRoomName(room.roomId, value, "vrata-", namespace),
    fail: (value: boolean) => { failing = value; }, advance: (ms: number) => { clock += ms; }
  };
}

test("a withdrawn room moves to a new media epoch once and deletes the old LiveKit room, retrying while LiveKit is down", async () => {
  const f = await fixture();
  const first = await f.epoch();
  await f.enforcer.runOnce();
  assert.equal(await f.epoch(), first, "an open room keeps its epoch");

  await f.storage.updateManagedRoomAccess(f.room.roomId, 0, { status: "paused" }, randomUUID());
  f.fail(true);
  await f.enforcer.runOnce();
  const second = await f.epoch();
  assert.notEqual(second, first);
  assert.deepEqual(f.deleted, []);
  assert(f.events.some(event => event.event === "managed_media_delete_failed" && event.alert === true));
  f.fail(false);
  await f.enforcer.runOnce();
  assert.deepEqual(f.deleted, [f.nameOf(first)]);
  await f.enforcer.runOnce();
  assert.equal(await f.epoch(), second, "the same withdrawal is enforced once");
  assert.equal(f.deleted.length, 1);

  // A close is recorded as a rotation request with the close itself, so it ends the epoch whatever the enforcer saw before.
  await f.storage.closeManagedRoom(f.room.roomId, 1, "ended", null);
  await f.enforcer.runOnce();
  assert.notEqual(await f.epoch(), second);
  assert.deepEqual(f.deleted, [f.nameOf(first), f.nameOf(second)]);
  await f.enforcer.runOnce();
  assert.equal((await f.storage.listManagedRoomsForEnforcement()).length, 0, "a fully enforced tombstone leaves the work list");
});

test("a revoked grant that was used rotates the epoch of an open room", async () => {
  const f = await fixture();
  const first = await f.epoch();
  const grant = await f.storage.issueManagedRoomGrant({ grantId: randomUUID(), roomId: f.room.roomId, role: "guest", purpose: "visit", maxUses: 1,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), codeHash: "a".repeat(64), operationId: randomUUID() });
  assert(grant && typeof grant !== "string");
  const unused = await f.storage.revokeManagedRoomGrant(grant.grantId, null, randomUUID());
  assert(unused?.revokedAt);
  await f.enforcer.runOnce();
  assert.equal(await f.epoch(), first, "nobody entered with an unused grant");

  const used = await f.storage.issueManagedRoomGrant({ grantId: randomUUID(), roomId: f.room.roomId, role: "guest", purpose: "visit", maxUses: 1,
    expiresAt: new Date(Date.now() + 600_000).toISOString(), codeHash: "b".repeat(64), operationId: randomUUID() });
  assert(used && typeof used !== "string");
  assert.equal((await f.storage.consumeManagedRoomGrant(f.room.roomId, "b".repeat(64))).ok, true);
  // The revoke stops right after marking the grant (as if the request died): the enforcer finishes it.
  await f.storage.revokeManagedRoomGrant(used.grantId, "removed", randomUUID());
  assert.equal((await f.storage.listIncompleteManagedGrantRevocations()).length, 1);
  await f.enforcer.runOnce();
  assert.equal((await f.storage.listIncompleteManagedGrantRevocations()).length, 0);
  assert.notEqual(await f.epoch(), first);
  assert.deepEqual(f.deleted, [f.nameOf(first)]);
});

test("a demo instance closes after its idle timeout unless somebody is connected, and presence is billed in participant-seconds", async () => {
  const f = await fixture({ kind: "demo-instance", idleTimeoutSeconds: 60 });
  const room = (await f.storage.getRoom(f.room.roomId))!;
  f.advance(30_000);
  f.enforcer.observe(room, "identity-a");
  f.enforcer.observe(room, "identity-b");
  f.enforcer.observe(room, "identity-a");
  await f.enforcer.runOnce();
  const usage = await f.storage.getIntegrationUsage(room.tenantId, new Date().toISOString().slice(0, 10));
  assert.equal(usage.participantSeconds, 40, "two people over a flush window capped at two 10 s intervals");

  f.advance(20_000);
  await f.enforcer.runOnce();
  assert.equal((await f.storage.getRoom(room.roomId))!.managed!.status, "active", "the last activity was moments ago in real time");

  f.advance(120_000);
  await f.enforcer.runOnce();
  const closed = (await f.storage.getRoom(room.roomId))!.managed!;
  assert.deepEqual([closed.status, closed.closeReason], ["closed", "idle"]);
  assert(f.events.some(event => event.event === "managed_room_idle_closed"));
});

test("a close right after a resume, before the enforcer saw the resume, still ends the epoch in use", async () => {
  const f = await fixture();
  await f.storage.updateManagedRoomAccess(f.room.roomId, 0, { status: "paused" }, randomUUID());
  await f.enforcer.runOnce();
  const resumed = await f.epoch();
  await f.storage.updateManagedRoomAccess(f.room.roomId, 1, { status: "active" }, randomUUID());
  f.livekit.add(f.nameOf(resumed));
  await f.storage.closeManagedRoom(f.room.roomId, 2, "ended", null);
  await f.enforcer.runOnce();
  assert.notEqual(await f.epoch(), resumed);
  assert(f.deleted.includes(f.nameOf(resumed)));
  assert.equal(f.livekit.size, 0);
});

test("an old epoch room that reappears after its deletion is swept, the current one stays", async () => {
  const f = await fixture();
  const first = await f.epoch();
  await f.storage.updateManagedRoomAccess(f.room.roomId, 0, { status: "paused" }, randomUUID());
  await f.enforcer.runOnce();
  await f.storage.updateManagedRoomAccess(f.room.roomId, 1, { status: "active" }, randomUUID());
  const current = await f.epoch();
  // A CreateRoom for the first epoch delayed past its deletion, and a legitimate room of the current one.
  f.livekit.add(f.nameOf(first));
  f.livekit.add(f.nameOf(current));
  await f.enforcer.runOnce();
  assert.deepEqual([...f.livekit], [f.nameOf(current)]);
  assert(f.events.some(event => event.event === "managed_media_stale_epoch_deleted"));
});
