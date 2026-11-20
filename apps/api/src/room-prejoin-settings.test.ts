import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyIdentityBoundary, IdentityBoundaryError, legacyBoundaryApplies } from "./identity/legacy-boundary.js";
import { openToAnonymousGuests, publicPrejoinSettings, readPrejoinSettings } from "./room-prejoin-settings.js";
import { resolveRoomTemplateCreate } from "./room-template-policy.js";
import type { RoomRecord } from "./storage.js";
import { MemoryStorage } from "./storage.js";
import { startApiProcess } from "./testing/api-process.js";

const upgradeRequired = (error: unknown) => error instanceof IdentityBoundaryError && error.status === 409 && error.reason === "identity_upgrade_required";

// Rooms on the reference catalog carry template settings; the legacy seed templates do not.
async function referenceStorage(floor: 1 | 2) {
  const storage = new MemoryStorage();
  await storage.transitionReferenceTemplateCatalog("active");
  if (floor === 2) await storage.identityProtocol.raise(2);
  const create = async (roomId: string, templateId: string, overrides: Partial<RoomRecord> = {}) => {
    const resolved = await resolveRoomTemplateCreate(storage, { templateId, tenantId: "demo-tenant", name: roomId });
    return storage.createRoom({ ...resolved.input, roomId, ...overrides });
  };
  return { storage, create, boundary: createLegacyIdentityBoundary(Promise.resolve(storage)) };
}

const bind = (storage: MemoryStorage, roomId: string) =>
  storage.roomIdentities.create({ tenantId: "demo-tenant", roomId, displayName: "Bound", baseRole: "guest", provenance: { kind: "guest" } });

test("floor 2 releases a public room's template settings before entry", async () => {
  const { storage, create, boundary } = await referenceStorage(2);
  await create("meeting", "meeting-room-basic");
  await create("talk", "presentation-room-basic");
  await bind(storage, "meeting");
  await bind(storage, "talk");

  const meeting = await readPrejoinSettings(storage, boundary, "meeting");
  assert.ok(meeting.status === 200, "a bound public room is released");
  assert.deepEqual(meeting.body, {
    roomId: "meeting",
    settings: {
      layout: "meeting",
      notes: { enabled: true, defaultScope: "shared" },
      audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "round-table" },
      presentation: { enabled: true, surfaceId: "debug-main" }
    }
  }, "the meeting template opens the microphone; no participants, owner, tokens or room record");

  const talk = await readPrejoinSettings(storage, boundary, "talk");
  assert.ok(talk.status === 200);
  assert.equal(talk.body.settings?.audio.joinMutedByDefault, true, "the presentation template joins muted");
  assert.equal(talk.body.settings?.layout, "presentation");
});

test("floor 2 releases an unlisted guest room and answers a room without a template with no settings", async () => {
  const { storage, create, boundary } = await referenceStorage(2);
  await create("unlisted", "presentation-room-basic", { visibility: "unlisted" });
  const plain = await create("plain", "meeting-room-basic");
  const unlisted = await readPrejoinSettings(storage, boundary, "unlisted");
  assert.ok(unlisted.status === 200, "a guest enters an unlisted room by its link");
  assert.equal(unlisted.body.settings?.audio.joinMutedByDefault, true);
  const legacy = { getRoom: async () => ({ ...plain, templateSnapshot: { ...plain.templateSnapshot, defaults: undefined } }) };
  assert.deepEqual(await readPrejoinSettings(legacy, boundary, "plain"), { status: 200, body: { roomId: "plain", settings: null } },
    "a room open to guests without template settings keeps the shared defaults instead of a refusal");
});

test("floor 2 keeps the identity refusal for private, closed and missing rooms", async () => {
  const { storage, create, boundary } = await referenceStorage(2);
  await create("private", "meeting-room-basic", { visibility: "private" });
  await create("members", "meeting-room-basic", { guestAllowed: false });
  await create("disabled", "meeting-room-basic", { disabledAt: new Date().toISOString() });
  for (const roomId of ["private", "members", "disabled", "missing"]) {
    await assert.rejects(readPrejoinSettings(storage, boundary, roomId), upgradeRequired, roomId);
  }
});

test("floor 1 releases a public room and keeps not found or the boundary refusal for the rest", async () => {
  const { storage, create, boundary } = await referenceStorage(1);
  const created = await create("talk", "presentation-room-basic");
  await create("private", "meeting-room-basic", { visibility: "private" });
  await create("bound", "meeting-room-basic", { visibility: "private" });
  await bind(storage, "bound");
  const talk = await readPrejoinSettings(storage, boundary, "talk");
  assert.ok(talk.status === 200);
  assert.deepEqual(talk.body, { roomId: "talk", settings: created.templateSnapshot.defaults?.settings });
  assert.equal(talk.body.settings?.audio.joinMutedByDefault, true);
  assert.deepEqual(await readPrejoinSettings(storage, boundary, "private"), { status: 404, body: { error: "room_not_found" } });
  assert.deepEqual(await readPrejoinSettings(storage, boundary, "missing"), { status: 404, body: { error: "room_not_found" } });
  await assert.rejects(readPrejoinSettings(storage, boundary, "bound"), upgradeRequired);
});

test("portal-managed rooms are not open to anonymous guests; rooms without template settings release none", async () => {
  const { create } = await referenceStorage(1);
  const room = await create("plain", "meeting-room-basic");
  assert.equal(openToAnonymousGuests(room), true);
  assert.equal(openToAnonymousGuests({ ...room, visibility: "unlisted" }), true);
  assert.equal(openToAnonymousGuests({ ...room, managed: { status: "open" } as unknown as NonNullable<RoomRecord["managed"]> }), false, "a managed room takes a grant");
  assert.equal(openToAnonymousGuests(null), false);
  assert.equal(publicPrejoinSettings({ ...room, templateSnapshot: { ...room.templateSnapshot, defaults: undefined } }), null);
});

test("only the known template settings fields are copied", async () => {
  const { create } = await referenceStorage(1);
  const room = await create("plain", "meeting-room-basic");
  const defaults = room.templateSnapshot.defaults!;
  const tainted = { ...defaults.settings, ownerParticipantId: "owner-secret", audio: { ...defaults.settings.audio, token: "token-secret" } };
  const settings = publicPrejoinSettings({ ...room, templateSnapshot: { ...room.templateSnapshot, defaults: { ...defaults, settings: tainted } } });
  assert.ok(settings);
  assert.equal(JSON.stringify(settings).includes("secret"), false);
  assert.deepEqual(settings, defaults.settings);
  const withoutSurface = publicPrejoinSettings({ ...room, templateSnapshot: { ...room.templateSnapshot,
    defaults: { ...defaults, settings: { ...defaults.settings, presentation: { enabled: false } } } } });
  assert.deepEqual(withoutSurface?.presentation, { enabled: false }, "no surfaceId key appears for a presentation without one");
});

test("the pre-join read is exempt from the path boundary only as its own GET", () => {
  assert.equal(legacyBoundaryApplies("GET", "/api/rooms/room/prejoin-settings"), false);
  assert.equal(legacyBoundaryApplies("POST", "/api/rooms/room/prejoin-settings"), true);
  assert.equal(legacyBoundaryApplies("GET", "/api/rooms/room/prejoin-settings/extra"), true);
  assert.equal(legacyBoundaryApplies("GET", "/api/rooms/room/manifest"), true);
});

test("the API routes the anonymous pre-join read", { timeout: 120_000 }, async () => {
  const adminToken = "prejoin-settings-admin";
  const api = await startApiProcess({ CONTROL_PLANE_ADMIN_TOKEN: adminToken, ROOM_ACCESS_POLICY_ENABLED: "true" });
  try {
    const created = await fetch(`${api.baseUrl}/api/rooms`, {
      method: "POST", headers: { "content-type": "application/json", "x-vrata-admin-token": adminToken },
      body: JSON.stringify({ roomId: "prejoin-private", tenantId: "demo-tenant", name: "Prejoin private", templateId: "meeting-room-basic", visibility: "private" })
    });
    assert.equal(created.status, 201, await created.text());
    const hidden = await fetch(`${api.baseUrl}/api/rooms/prejoin-private/prejoin-settings`);
    assert.deepEqual([hidden.status, await hidden.json()], [404, { error: "room_not_found" }]);
    const open = await fetch(`${api.baseUrl}/api/rooms`, {
      method: "POST", headers: { "content-type": "application/json", "x-vrata-admin-token": adminToken },
      body: JSON.stringify({ roomId: "prejoin-public", tenantId: "demo-tenant", name: "Prejoin public", templateId: "meeting-room-basic" })
    });
    assert.equal(open.status, 201, await open.text());
    const released = await fetch(`${api.baseUrl}/api/rooms/prejoin-public/prejoin-settings`);
    assert.equal(released.status, 200);
    assert.deepEqual(Object.keys(await released.json()).sort(), ["roomId", "settings"], "only the room id and its template settings");
  } finally {
    await api.stop();
  }
});
