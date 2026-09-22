import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "./storage.js";
import { listRoomTemplateMetadata, resolveRoomTemplateCreate, templateInputError } from "./room-template-policy.js";
import { createRoomManifestBuilder } from "./room-manifest.js";
import { referenceTemplateContract } from "@vrata/templates";
import { templateVersionContentHash } from "./storage-room-records.js";

test("guarded catalog activation exposes exactly three references and preserves pinned rooms on rollback", async () => {
  const storage = new MemoryStorage();
  const legacy = await storage.createRoom({ templateId: "showroom-basic", name: "Legacy" });
  assert.equal((await storage.listTemplates()).length, 4);
  await assert.rejects(() => resolveRoomTemplateCreate(storage, { templateId: "personal-room-basic" }), /deprecated_template/);
  await storage.transitionReferenceTemplateCatalog("active");
  const catalog = await listRoomTemplateMetadata(storage);
  assert.deepEqual(catalog.map(row => row.templateId), ["personal-room-basic", "meeting-room-basic", "presentation-room-basic"]);
  assert(catalog.every(row => row.currentVersion === "2.0.0" && row.previewUrl?.startsWith("https://cdn.jsdelivr.net/gh/") && row.description && row.defaults));
  await storage.transitionReferenceTemplateCatalog("active");
  const references = [];
  for (const row of catalog) {
    const resolved = await resolveRoomTemplateCreate(storage, { templateId: row.templateId, tenantId: "demo-tenant", name: row.label, ...(row.templateId === "personal-room-basic" ? { ownerParticipantId: "owner-123" } : {}) });
    const room = await storage.createRoom(resolved.input);
    assert.equal(room.templateVersion, "2.0.0");
    assert.equal(room.templateSnapshot.assetLock?.sceneManifest.sha256.length, 64);
    assert.equal(room.sceneBundleUrl, `https://cdn.jsdelivr.net/gh/${room.templateSnapshot.assetLock!.repository}@${room.templateSnapshot.assetLock!.commitSha}/${room.templateSnapshot.assetLock!.sceneManifest.path}`);
    references.push(room);
    const manifest = await createRoomManifestBuilder(Promise.resolve(storage))(room.roomId);
    assert.deepEqual(manifest.sceneBundle?.integrity, { manifestSha256: room.templateSnapshot.assetLock!.sceneManifest.sha256, assetSha256: room.templateSnapshot.assetLock!.sceneAsset.sha256 });
  }
  assert.equal(references[0]!.roomType, "personal");
  assert.equal(references[0]!.visibility, "private");
  assert.equal(references[0]!.guestAllowed, false);
  assert.equal(references[0]!.templateSnapshot.defaults!.settings.notes.defaultScope, "private");
  assert.equal(references[2]!.templateSnapshot.defaults!.settings.audio.joinMutedByDefault, true);
  await assert.rejects(() => resolveRoomTemplateCreate(storage, { templateId: "event-demo-basic" }), /deprecated_template/);
  await storage.transitionReferenceTemplateCatalog("wave2");
  assert.equal((await storage.listTemplates()).length, 4);
  assert.deepEqual(await storage.getRoom(legacy.roomId), legacy);
  for (const room of references) assert.deepEqual(await storage.getRoom(room.roomId), room);
});

test("reference create validates versions, server-owned fields and personal invariants", async () => {
  const storage = new MemoryStorage();
  await storage.transitionReferenceTemplateCatalog("active");
  const cases = [
    [{ templateId: "missing" }, "unknown_template", 400],
    [{ templateId: "meeting-room-basic", templateVersion: "wrong" }, "invalid_template_version", 400],
    [{ templateId: "meeting-room-basic", templateVersion: "9.9.9" }, "unknown_template_version", 400],
    [{ templateId: "meeting-room-basic", templateVersion: "1.0.0" }, "template_version_not_current", 409],
    [{ templateId: "meeting-room-basic", sceneBundleUrl: "https://other.example/scene.json" }, "reference_scene_override_not_allowed", 409],
    [{ templateId: "personal-room-basic" }, "missing_personal_room_owner", 400],
    [{ templateId: "personal-room-basic", ownerParticipantId: "owner", visibility: "public" }, "personal_room_must_be_private", 400],
    [{ templateId: "personal-room-basic", ownerParticipantId: "owner", guestAllowed: true }, "personal_room_guest_access_forbidden", 400]
  ] as const;
  for (const [input, code, status] of cases) await assert.rejects(() => resolveRoomTemplateCreate(storage, input), error => {
    assert.deepEqual(templateInputError(error), { code, status }); return true;
  });
});

test("room setting edits retain immutable policy, checksum bindings and the original mirror URL", async () => {
  const storage = new MemoryStorage();
  await storage.transitionReferenceTemplateCatalog("active");
  const previous = process.env.ROOM_TEMPLATE_ASSET_BASE_URL;
  try {
    process.env.ROOM_TEMPLATE_ASSET_BASE_URL = "https://first.example/mirror";
    const room = await storage.createRoom({ templateId: "meeting-room-basic", name: "Pinned mirror", features: { voice: false, spatialAudio: true, screenShare: true } });
    const hash = templateVersionContentHash(referenceTemplateContract(room.templateSnapshot)!);
    process.env.ROOM_TEMPLATE_ASSET_BASE_URL = "https://second.example/mirror";
    const updated = await storage.updateRoom(room.roomId, { name: "Renamed", theme: { primaryColor: "#111111", accentColor: "#222222" } });
    assert.equal(updated?.sceneBundleUrl, room.sceneBundleUrl);
    assert(updated!.sceneBundleUrl!.startsWith("https://first.example/"));
    assert.equal(templateVersionContentHash(referenceTemplateContract(updated!.templateSnapshot)!), hash);
    assert.equal(updated!.features.voice, false);
    assert.equal(updated!.templateSnapshot.defaults!.features.voice, true);
    assert.equal(updated!.templateSnapshot.roomConfig.features.voice, false);
    await assert.rejects(() => storage.updateRoom(room.roomId, { sceneBundleUrl: room.sceneBundleUrl }), /reference_scene_override_not_allowed/);
    await assert.rejects(() => storage.updateRoom(room.roomId, { templateVersion: "0.1.0" }), /template_change_not_supported/);
    const fresh = await storage.createRoom({ templateId: "meeting-room-basic", name: "New mirror" });
    assert(fresh.sceneBundleUrl!.startsWith("https://second.example/"));
  } finally {
    if (previous === undefined) delete process.env.ROOM_TEMPLATE_ASSET_BASE_URL;
    else process.env.ROOM_TEMPLATE_ASSET_BASE_URL = previous;
  }
});
