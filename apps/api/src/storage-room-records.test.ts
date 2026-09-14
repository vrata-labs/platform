import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";
import {
  bindRoomTemplateMetadata,
  defaultAvatarConfig,
  defaultGuestAllowed,
  defaultPersonalState,
  defaultRoomStatus,
  defaultRoomType,
  defaultRoomVisibility,
  defaultSessionControl,
  mapRoomRow,
  parseStoredTemplateVersion,
  templateVersionContentHash,
  type RoomRecordWithoutTemplateMetadata
} from "./storage-room-records.js";

const timestamp = "2026-01-02T03:04:05.006Z";
const avatarDefaults = {
  avatarsEnabled: true, avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
  avatarQualityProfile: "desktop-standard", avatarFallbackCapsulesEnabled: true, avatarSeatsEnabled: true
};
const sessionDefaults = {
  hostParticipantId: null, presenterParticipantId: null, presenterGrantedAt: null,
  presenterGrantedBy: null, presenterRevokedAt: null, presenterRevokedBy: null,
  lockedAt: null, lockedBy: null, endedAt: null, endedBy: null, removedParticipants: {}
};

function version(): RoomTemplateVersionSnapshotV1 {
  return { schemaVersion: 1, templateId: "template", version: "v1", label: "Room", assetSlots: ["screen", "seat"] };
}

function storedVersion(snapshot: RoomTemplateVersionSnapshotV1 = version()) {
  return { template_id: snapshot.templateId, version: snapshot.version, snapshot,
    content_hash: templateVersionContentHash(snapshot) };
}

function room(overrides: Partial<RoomRecordWithoutTemplateMetadata> = {}): RoomRecordWithoutTemplateMetadata {
  return { roomId: "room", tenantId: "tenant", templateId: "template", name: "Room",
    features: { voice: false, spatialAudio: true, screenShare: false }, assetIds: ["asset"], ...overrides };
}

type RoomRow = Parameters<typeof mapRoomRow>[0];
function row(overrides: Partial<RoomRow> = {}): RoomRow {
  const stored = storedVersion();
  return { room_id: "room", tenant_id: "tenant", template_id: "template", name: "Room",
    scene_bundle_url: null, features: { voice: false, spatialAudio: true, screenShare: false },
    asset_ids: ["asset"], theme: { primaryColor: "#123456", accentColor: "#abcdef" },
    guest_allowed: false, avatar_config: {}, session_control: null,
    template_version_template_id: stored.template_id, template_version_resolved: stored.version,
    template_version_snapshot: stored.snapshot, template_version_content_hash: stored.content_hash,
    ...overrides };
}

test("avatar defaults preserve explicit false and empty strings", () => {
  assert.deepEqual(defaultAvatarConfig(), avatarDefaults);
  assert.deepEqual(defaultAvatarConfig({}), avatarDefaults);
  assert.deepEqual(defaultAvatarConfig({ avatarsEnabled: false, avatarCatalogUrl: "",
    avatarQualityProfile: "xr", avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: false }), {
    avatarsEnabled: false, avatarCatalogUrl: "", avatarQualityProfile: "xr",
    avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: false
  });
});

test("avatar normalization returns fresh objects without mutating its input", () => {
  const input = Object.freeze({ avatarQualityProfile: "mobile-lite" as const });
  const a = defaultAvatarConfig(input);
  assert.deepEqual(a, { ...avatarDefaults, avatarQualityProfile: "mobile-lite" });
  assert.notEqual(a, defaultAvatarConfig(input));
  assert.deepEqual(input, { avatarQualityProfile: "mobile-lite" });
});

test("room type and status retain their exact fallback rules", () => {
  assert.equal(defaultRoomType(), "standard");
  assert.equal(defaultRoomType("standard"), "standard");
  assert.equal(defaultRoomType("personal"), "personal");
  assert.equal(defaultRoomStatus(), "active");
  assert.equal(defaultRoomStatus("active"), "active");
  assert.equal(defaultRoomStatus("disabled"), "disabled");
});

test("personal visibility remains private even for an explicit public input", () => {
  for (const type of [undefined, "standard", "personal"] as const) {
    for (const visibility of [undefined, "public", "private", "unlisted"] as const) {
      assert.equal(defaultRoomVisibility(visibility, type),
        visibility === "private" || visibility === "unlisted" ? visibility : type === "personal" ? "private" : "public");
    }
  }
});

test("guest defaults depend on room type but honor both explicit boolean values", () => {
  for (const type of [undefined, "standard", "personal"] as const) {
    assert.equal(defaultGuestAllowed(undefined, type), type !== "personal");
    assert.equal(defaultGuestAllowed(true, type), true);
    assert.equal(defaultGuestAllowed(false, type), false);
  }
});

test("session defaults are complete and allocate independent removed-participant maps", () => {
  for (const value of [undefined, null, {}]) assert.deepEqual(defaultSessionControl(value), sessionDefaults);
  const a = defaultSessionControl();
  const b = defaultSessionControl();
  assert.notEqual(a, b);
  assert.notEqual(a.removedParticipants, b.removedParticipants);
});

test("session normalization preserves supplied identifiers, timestamps and map identity", () => {
  const removedParticipants = { guest: { removedAt: timestamp, removedBy: "host", reason: "" } };
  const input = Object.freeze({ hostParticipantId: "", presenterParticipantId: "presenter",
    presenterGrantedAt: timestamp, presenterGrantedBy: "host", presenterRevokedAt: "",
    presenterRevokedBy: "", lockedAt: timestamp, lockedBy: "host", endedAt: "", endedBy: "",
    removedParticipants });
  const result = defaultSessionControl(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.equal(result.removedParticipants, removedParticipants);
});

test("personal state without a last pose becomes a fresh empty object", () => {
  for (const input of [undefined, null, {}, { lastPose: null }]) assert.deepEqual(defaultPersonalState(input), {});
  assert.notEqual(defaultPersonalState(), defaultPersonalState());
});

test("personal pose is copied without normalizing coordinates or empty attribution", () => {
  for (const updatedBy of [undefined, null, "", "actor"]) {
    const position = Object.freeze({ x: -3.5, y: 0, z: 8 });
    const lastPose = Object.freeze({ position, yaw: 7, pitch: -4, updatedAt: "unparsed", updatedBy });
    const input = Object.freeze({ lastPose });
    const result = defaultPersonalState(input);
    assert.deepEqual(result, { lastPose: { ...lastPose, updatedBy: updatedBy ?? null } });
    assert.notEqual(result.lastPose, lastPose);
    assert.notEqual(result.lastPose!.position, position);
  }
});

test("template content hash matches the existing canonical serialization", () => {
  const canonical = '{"assetSlots":["screen","seat"],"label":"Room","schemaVersion":1,"templateId":"template","version":"v1"}';
  assert.equal(templateVersionContentHash(version()), createHash("sha256").update(canonical).digest("hex"));
});

test("template hashes ignore object insertion order and undefined object properties", () => {
  const a = Object.assign(version(), { metadata: { z: 1, A: 2, a: 3, unused: undefined } });
  const b = { metadata: { a: 3, A: 2, z: 1 }, assetSlots: ["screen", "seat"], label: "Room",
    version: "v1", templateId: "template", schemaVersion: 1 as const };
  assert.equal(templateVersionContentHash(a), templateVersionContentHash(b));
  assert.notEqual(templateVersionContentHash(a), templateVersionContentHash({ ...a, assetSlots: ["seat", "screen"] }));
});

test("template hashing retains code-unit key order rather than locale sorting", () => {
  const value = Object.assign(version(), { metadata: { a: 1, Z: 2, "10": 3, "2": 4 } });
  const canonical = '{"assetSlots":["screen","seat"],"label":"Room","metadata":{"10":3,"2":4,"Z":2,"a":1},"schemaVersion":1,"templateId":"template","version":"v1"}';
  assert.equal(templateVersionContentHash(value), createHash("sha256").update(canonical).digest("hex"));
});

test("template hashing propagates failures for unsupported array entries", () => {
  for (const entry of [undefined, Symbol("value"), () => 1]) {
    assert.throws(() => templateVersionContentHash(Object.assign(version(), { metadata: [entry] })),
      { message: "template_snapshot_not_json_serializable" });
  }
  assert.throws(() => templateVersionContentHash(Object.assign(version(), { metadata: 1n })), TypeError);
});

test("stored template accepts object and JSON snapshots and returns deep clones", () => {
  const snapshot = version();
  const stored = storedVersion(snapshot);
  const a = parseStoredTemplateVersion(stored);
  const b = parseStoredTemplateVersion({ ...stored, snapshot: JSON.stringify(snapshot) });
  assert.deepEqual(a, snapshot);
  assert.deepEqual(b, snapshot);
  assert.notEqual(a, snapshot);
  assert.notEqual(a.assetSlots, snapshot.assetSlots);
  a.assetSlots.push("new");
  assert.deepEqual(snapshot.assetSlots, ["screen", "seat"]);
});

test("stored template rejects invalid JSON, non-objects and malformed required fields", () => {
  const stored = storedVersion();
  const invalid: unknown[] = ["{", "null", "[]", null, undefined, false, 3, [], {},
    { ...version(), schemaVersion: 2 }, { ...version(), templateId: 3 }, { ...version(), version: null },
    { ...version(), label: false }, { ...version(), assetSlots: null }, { ...version(), assetSlots: [1] }];
  for (const snapshot of invalid) {
    assert.throws(() => parseStoredTemplateVersion({ ...stored, snapshot, content_hash: "bad" }),
      { message: "invalid_template_version_snapshot:template@v1" });
  }
});

test("stored template checks identity before content hash and preserves error messages", () => {
  const stored = storedVersion();
  for (const snapshot of [{ ...version(), templateId: "other" }, { ...version(), version: "v2" }]) {
    assert.throws(() => parseStoredTemplateVersion({ ...stored, snapshot, content_hash: "bad" }),
      { message: "template_version_identity_mismatch:template@v1" });
  }
  assert.throws(() => parseStoredTemplateVersion({ ...stored, content_hash: "bad" }),
    { message: "template_version_content_hash_mismatch:template@v1" });
  assert.throws(() => parseStoredTemplateVersion({ ...stored, snapshot: { ...version(), label: "Changed" } }),
    { message: "template_version_content_hash_mismatch:template@v1" });
});

test("stored template preserves additional snapshot properties rather than stripping them", () => {
  const snapshot = Object.assign(version(), { metadata: { values: [1, null, "value"] } });
  const result = parseStoredTemplateVersion(storedVersion(snapshot));
  assert.deepEqual(result, snapshot);
  assert.notEqual((result as typeof snapshot).metadata, snapshot.metadata);
});

test("template binding preserves room references but isolates the template snapshot", () => {
  const source = room();
  const snapshot = version();
  const result = bindRoomTemplateMetadata(source, snapshot);
  assert.equal(result.templateVersion, "v1");
  assert.equal(result.features, source.features);
  assert.equal(result.assetIds, source.assetIds);
  assert.notEqual(result.templateSnapshot.assetSlots, snapshot.assetSlots);
  assert.notEqual(result.templateSnapshot.roomConfig.features, source.features);
  assert.deepEqual(result.templateSnapshot.roomConfig, {
    roomType: "standard", visibility: "public", guestAllowed: true, sceneBundleUrl: null,
    features: source.features, theme: { primaryColor: "#5fc8ff", accentColor: "#163354" }, avatarConfig: avatarDefaults
  });
  assert.equal(source.roomType, undefined);
  assert.equal(source.theme, undefined);
});

test("template binding honors personal defaults and explicit false, empty configuration values", () => {
  const source = room({ roomType: "personal", visibility: "public", guestAllowed: false, sceneBundleUrl: "",
    theme: { primaryColor: "", accentColor: "" }, avatarConfig: {
      avatarsEnabled: false, avatarQualityProfile: "xr", avatarCatalogUrl: "",
      avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: false
    } });
  const result = bindRoomTemplateMetadata(source, version());
  assert.equal(result.visibility, "public");
  assert.deepEqual(result.templateSnapshot.roomConfig, {
    roomType: "personal", visibility: "private", guestAllowed: false, sceneBundleUrl: "",
    features: source.features, theme: source.theme, avatarConfig: source.avatarConfig
  });
  assert.notEqual(result.templateSnapshot.roomConfig.theme, source.theme);
  assert.notEqual(result.templateSnapshot.roomConfig.avatarConfig, source.avatarConfig);
});

test("template binding overwrites a snapshot roomConfig without mutating either input", () => {
  const source = room();
  const snapshot = Object.assign(version(), { roomConfig: { stale: true }, metadata: { value: 1 } });
  const before = structuredClone({ source, snapshot });
  Object.freeze(source);
  Object.freeze(snapshot);
  const result = bindRoomTemplateMetadata(source, snapshot);
  assert.equal("stale" in result.templateSnapshot.roomConfig, false);
  assert.deepEqual({ source, snapshot }, before);
  assert.notEqual((result.templateSnapshot as unknown as typeof snapshot).metadata, snapshot.metadata);
});

test("room mapper preserves fields and references while filling optional defaults", () => {
  const input = row();
  const result = mapRoomRow(input);
  assert.deepEqual(result, {
    roomId: "room", tenantId: "tenant", templateId: "template", name: "Room", roomType: "standard",
    ownerParticipantId: null, status: "active", disabledAt: null, disabledBy: null, visibility: "public",
    sceneBundleUrl: undefined, features: input.features, assetIds: input.asset_ids, theme: input.theme,
    guestAllowed: false, avatarConfig: avatarDefaults, sessionControl: sessionDefaults, personalState: {},
    templateVersion: "v1", templateSnapshot: { ...version(), roomConfig: {
      roomType: "standard", visibility: "public", guestAllowed: false, sceneBundleUrl: null,
      features: input.features, theme: input.theme, avatarConfig: avatarDefaults
    } }
  });
  assert.equal(result.features, input.features);
  assert.equal(result.assetIds, input.asset_ids);
  assert.equal(result.theme, input.theme);
  assert.notEqual(result.templateSnapshot.roomConfig.features, input.features);
});

test("room mapper preserves disabled state, empty identifiers and unparsed timestamps", () => {
  for (const disabledAt of [undefined, null, "", timestamp, "not-a-date", new Date(timestamp)]) {
    const result = mapRoomRow(row({ owner_participant_id: "", disabled_by: "", status: "disabled",
      disabled_at: disabledAt, scene_bundle_url: "" }));
    assert.equal(result.ownerParticipantId, "");
    assert.equal(result.disabledBy, "");
    assert.equal(result.status, "disabled");
    assert.equal(result.disabledAt, disabledAt instanceof Date ? timestamp : disabledAt || null);
    assert.equal(result.sceneBundleUrl, "");
  }
});

test("room mapper uses the resolved template version instead of stale room metadata", () => {
  const snapshot = { ...version(), version: "v2", label: "Resolved" };
  const result = mapRoomRow(row({ template_version: "obsolete",
    template_snapshot: bindRoomTemplateMetadata(room(), version()).templateSnapshot,
    template_version_resolved: "v2", template_version_snapshot: JSON.stringify(snapshot),
    template_version_content_hash: templateVersionContentHash(snapshot) }));
  assert.equal(result.templateVersion, "v2");
  assert.equal(result.templateSnapshot.label, "Resolved");
});

test("room mapper rejects every missing resolved-version field", () => {
  const missing: Partial<RoomRow>[] = [
    { template_version_template_id: null }, { template_version_template_id: "" },
    { template_version_resolved: null }, { template_version_resolved: "" },
    { template_version_snapshot: undefined }, { template_version_snapshot: null },
    { template_version_content_hash: null }, { template_version_content_hash: "" }
  ];
  for (const overrides of missing) assert.throws(() => mapRoomRow(row(overrides)),
    { message: "template_version_not_found:template" });
});

test("room mapper propagates resolved-version validation and hash errors", () => {
  assert.throws(() => mapRoomRow(row({ template_version_snapshot: {} })),
    { message: "invalid_template_version_snapshot:template@v1" });
  assert.throws(() => mapRoomRow(row({ template_version_resolved: "v2" })),
    { message: "template_version_identity_mismatch:template@v2" });
  assert.throws(() => mapRoomRow(row({ template_version_content_hash: "bad" })),
    { message: "template_version_content_hash_mismatch:template@v1" });
});

test("room mapper preserves normalization error order before template resolution", () => {
  assert.throws(() => mapRoomRow(row({ disabled_at: new Date(NaN), template_version_snapshot: null })), RangeError);
});

test("room mapper retains session map identity and copies personal pose", () => {
  const removedParticipants = { guest: { removedAt: timestamp } };
  const personalState = { lastPose: { position: { x: 1, y: 2, z: 3 }, yaw: 4, pitch: 5, updatedAt: timestamp } };
  const result = mapRoomRow(row({ room_type: "personal", visibility: "public", guest_allowed: true,
    session_control: { removedParticipants }, personal_state: personalState }));
  assert.equal(result.roomType, "personal");
  assert.equal(result.visibility, "private");
  assert.equal(result.guestAllowed, true);
  assert.equal(result.sessionControl!.removedParticipants, removedParticipants);
  assert.notEqual(result.personalState!.lastPose!.position, personalState.lastPose.position);
  assert.deepEqual(result.personalState, { lastPose: { ...personalState.lastPose, updatedBy: null } });
});

test("room mapping does not mutate frozen input and creates independent snapshots", () => {
  const input = row();
  const before = structuredClone(input);
  Object.freeze(input);
  Object.freeze(input.features);
  Object.freeze(input.theme);
  const a = mapRoomRow(input);
  const b = mapRoomRow(input);
  assert.deepEqual(input, before);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a.avatarConfig, b.avatarConfig);
  assert.notEqual(a.templateSnapshot, b.templateSnapshot);
  assert.notEqual(a.templateSnapshot.assetSlots, b.templateSnapshot.assetSlots);
});
