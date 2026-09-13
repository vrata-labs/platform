import assert from "node:assert/strict";
import test from "node:test";

import {
  isRoomVisibility,
  sanitizeRoomVisibility,
  normalizeParticipantId,
  validateRoomInput,
  normalizeRoomPayload,
  type RoomPayloadInput
} from "./room-input.js";

const templates = new Set(["meeting-room-basic", "personal-workspace-basic"]);
const tenants = new Set(["tenant-1"]);
const valid = (): RoomPayloadInput => ({ roomId: "room-1", name: "Meeting room", templateId: "meeting-room-basic", tenantId: "tenant-1" });
// Exercise the same untrusted values that JSON parsing supplies to the API.
const raw = (input: unknown): RoomPayloadInput => input as RoomPayloadInput;
const validate = (input: RoomPayloadInput) => validateRoomInput(input, templates, tenants);

for (const visibility of ["public", "unlisted", "private"] as const) {
  test(`visibility accepts and preserves ${visibility}`, () => {
    assert.equal(isRoomVisibility(visibility), true);
    assert.equal(sanitizeRoomVisibility(visibility, "private"), visibility);
  });
}

test("visibility does not trim, coerce or accept alternative spellings", () => {
  for (const value of [undefined, null, "", "Public", " public", "private ", false, 0, {}, ["public"]]) {
    assert.equal(isRoomVisibility(value), false);
    assert.equal(sanitizeRoomVisibility(value), "public");
    assert.equal(sanitizeRoomVisibility(value, "unlisted"), "unlisted");
  }
});

test("participant IDs retain case and allowed punctuation after trimming", () => {
  for (const id of ["AbC", "a.b:c_d-e", "123", "..:", "a".repeat(128)]) {
    assert.equal(normalizeParticipantId(` \t${id}\n`), id);
  }
  for (const id of [undefined, null, 123, {}, "", "ab", "a".repeat(129), "a/b", "a b", "a\nb", "абв", "a@b"]) {
    assert.equal(normalizeParticipantId(id), null);
  }
});

test("room validation accepts generated IDs and exact slug boundaries", () => {
  for (const roomId of [undefined, "abc", "a-b", "123", "a".repeat(64)]) {
    assert.equal(validate({ ...valid(), roomId }), null);
  }
  for (const roomId of [null, "", "ab", "a".repeat(65), "ABC", "a_b", "a--b", "-abc", "abc-", " abc", "abc ", 123]) {
    assert.equal(validate(raw({ ...valid(), roomId })), "invalid_room_slug");
  }
});

test("room names use trimmed length without mutating the supplied name", () => {
  for (const name of ["abc", "a".repeat(80), "  abc  ", ` ${"a".repeat(80)} `]) {
    const input = { ...valid(), name };
    assert.equal(validate(input), null);
    assert.equal(input.name, name);
  }
  for (const name of [undefined, null, "", "  ", "ab", "a".repeat(81)]) {
    assert.equal(validate(raw({ ...valid(), name })), "invalid_room_name");
  }
  assert.throws(() => validate(raw({ ...valid(), name: 123 })), TypeError);
});

const invalidFields: Array<[string, unknown, string]> = [
  ["templateId", undefined, "invalid_template"], ["templateId", "unknown", "invalid_template"],
  ["tenantId", undefined, "invalid_tenant"], ["tenantId", "unknown", "invalid_tenant"],
  ["visibility", "PUBLIC", "invalid_room_visibility"], ["visibility", null, "invalid_room_visibility"],
  ["roomType", "other", "invalid_room_type"], ["roomType", null, "invalid_room_type"]
];
for (const [key, value, error] of invalidFields) {
  test(`room validation rejects ${key}=${String(value)}`, () => {
    assert.equal(validate(raw({ ...valid(), [key]: value })), error);
  });
}

test("validation preserves error precedence", () => {
  const input = raw({ roomId: "?", name: "", templateId: "?", tenantId: "?", visibility: "?", roomType: "?" });
  for (const [key, value, error] of [
    ["roomId", "room-1", "invalid_room_slug"], ["name", "Room", "invalid_room_name"],
    ["templateId", "meeting-room-basic", "invalid_template"], ["tenantId", "tenant-1", "invalid_tenant"],
    ["visibility", "private", "invalid_room_visibility"], ["roomType", "personal", "invalid_room_type"],
    ["ownerParticipantId", "owner-1", "missing_personal_room_owner"]
  ] as const) {
    assert.equal(validate(input), error);
    Object.assign(input, { [key]: value });
  }
  assert.equal(validate(input), null);
});

test("only personal rooms require a valid owner and validation does not rewrite it", () => {
  for (const ownerParticipantId of [undefined, null, "ab", "bad/id"]) {
    assert.equal(validate(raw({ ...valid(), roomType: "personal", ownerParticipantId })), "missing_personal_room_owner");
    assert.equal(validate(raw({ ...valid(), roomType: "standard", ownerParticipantId })), null);
  }
  const input = { ...valid(), roomType: "personal" as const, ownerParticipantId: "  Owner-1  " };
  assert.equal(validate(input), null);
  assert.equal(input.ownerParticipantId, "  Owner-1  ");
});

test("normalization strips template snapshots and legacy fields without mutating input", () => {
  const nested = { retained: true };
  const input = raw({ ...valid(), roomId: " room-1 ", templateVersion: "99", templateSnapshot: nested, custom: nested });
  const before = structuredClone(input);
  const result = normalizeRoomPayload(input, "create");
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
  assert.equal(result.roomId, "room-1");
  assert.equal(result.visibility, "public");
  assert.equal(Object.hasOwn(result, "templateVersion"), false);
  assert.equal(Object.hasOwn(result, "templateSnapshot"), false);
  assert.equal((result as unknown as { custom: unknown }).custom, nested);
});

test("normalization distinguishes absent IDs from an own undefined ID", () => {
  const omitted = normalizeRoomPayload({}, "patch");
  assert.equal(Object.hasOwn(omitted, "roomId"), false);
  const empty = normalizeRoomPayload({ roomId: " \t " }, "patch");
  assert.equal(Object.hasOwn(empty, "roomId"), true);
  assert.equal(empty.roomId, undefined);
  assert.equal(normalizeRoomPayload(raw({ roomId: null }), "patch").roomId, null);
});

test("legacy avatar fields merge shallowly with nested fields taking precedence", () => {
  const avatarConfig = { avatarsEnabled: true, avatarCatalogUrl: "nested", avatarSeatsEnabled: undefined };
  const input = raw({ avatarsEnabled: false, avatarCatalogUrl: "legacy", avatarQualityProfile: "xr", avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: true, avatarConfig });
  const before = structuredClone(input);
  const result = normalizeRoomPayload(input, "patch");
  assert.deepEqual(result, { avatarConfig: { avatarsEnabled: true, avatarCatalogUrl: "nested", avatarQualityProfile: "xr", avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: undefined } });
  assert.deepEqual(input, before);
  assert.notEqual(result.avatarConfig, avatarConfig);
});

test("false legacy avatar values count as present and retain undefined sibling fields", () => {
  const result = normalizeRoomPayload({ avatarsEnabled: false }, "patch");
  assert.deepEqual(result, { avatarConfig: { avatarsEnabled: false, avatarCatalogUrl: undefined, avatarQualityProfile: undefined, avatarFallbackCapsulesEnabled: undefined, avatarSeatsEnabled: undefined } });
  assert.equal(Object.hasOwn(result, "avatarsEnabled"), false);
});

test("absent legacy values do not allocate or replace nested avatar configuration", () => {
  const avatarConfig = { avatarsEnabled: true, avatarQualityProfile: "xr" as const, avatarFallbackCapsulesEnabled: false };
  const result = normalizeRoomPayload({ avatarsEnabled: undefined, avatarConfig }, "patch");
  assert.deepEqual(result, { avatarConfig });
  assert.equal(result.avatarConfig, avatarConfig);
  assert.deepEqual(normalizeRoomPayload({ avatarsEnabled: undefined }, "patch"), {});
});

const visibilityCases: Array<[string, RoomPayloadInput, "create" | "patch", unknown]> = [
  ["create defaults public", {}, "create", "public"],
  ["create with guests disabled", { guestAllowed: false }, "create", "private"],
  ["patch with guests disabled", { guestAllowed: false }, "patch", "private"],
  ["patch with guests enabled", { guestAllowed: true }, "patch", "public"],
  ["patch with room type", { roomType: "standard" }, "patch", "public"],
  ["explicit visibility beats guest fallback", { visibility: "unlisted", guestAllowed: false }, "create", "unlisted"],
  ["personal room overrides valid public visibility", { roomType: "personal", visibility: "public", guestAllowed: true }, "patch", "private"],
  ["invalid personal visibility is retained for rejection", raw({ roomType: "personal", visibility: "invalid" }), "create", "invalid"],
  ["null visibility is retained for rejection", raw({ visibility: null }), "patch", null]
];
for (const [name, input, mode, expected] of visibilityCases) {
  test(`visibility normalization: ${name}`, () => {
    assert.equal(normalizeRoomPayload(input, mode).visibility, expected);
  });
}

test("an unrelated patch leaves visibility absent, including own undefined fields", () => {
  const input = { name: "Renamed", visibility: undefined, roomType: undefined, guestAllowed: undefined };
  const result = normalizeRoomPayload(input, "patch");
  assert.equal(Object.hasOwn(result, "visibility"), false);
  assert.equal(Object.hasOwn(input, "visibility"), true);
  assert.equal(Object.hasOwn(result, "roomType"), true);
  assert.equal(Object.hasOwn(result, "guestAllowed"), true);
});

test("personal normalization keeps explicit templates and applies only nullish defaults", () => {
  for (const templateId of [undefined, null, "", "custom-template"]) {
    const result = normalizeRoomPayload(raw({ roomType: "personal", guestAllowed: true, templateId }), "patch");
    assert.equal(result.visibility, "private");
    assert.equal(result.guestAllowed, false);
    assert.equal(result.templateId, templateId ?? "personal-workspace-basic");
  }
});

test("unrelated nested state retains references and JSON property order", () => {
  const input = raw({ name: "Room", custom: { nested: true }, visibility: "unlisted", roomId: " room-1 ", templateVersion: "discard", avatarSeatsEnabled: false });
  const result = normalizeRoomPayload(input, "patch");
  assert.deepEqual(Object.keys(result), ["name", "custom", "visibility", "roomId", "avatarConfig"]);
  assert.equal(JSON.stringify(result), '{"name":"Room","custom":{"nested":true},"visibility":"unlisted","roomId":"room-1","avatarConfig":{"avatarSeatsEnabled":false}}');
});
