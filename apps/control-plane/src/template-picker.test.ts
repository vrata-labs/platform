import assert from "node:assert/strict";
import test from "node:test";
import { displayOwnerParticipantId, personalRoomInviteFields, templateCreationFields, templateDefaultsSummary } from "./template-picker.js";
import { controlPlaneIdentityFloor, type ControlPlaneSession, type RoomRecord, type TemplateRecord } from "./index.js";
import type { RoomTemplateDefaults } from "@vrata/shared-types";

const defaults: RoomTemplateDefaults = {
  roomType: "personal", visibility: "private", guestAllowed: false,
  features: { voice: true, spatialAudio: true, screenShare: false },
  theme: { primaryColor: "#123456", accentColor: "#654321" },
  avatarConfig: { avatarsEnabled: true, avatarCatalogUrl: "/avatars.json", avatarQualityProfile: "desktop-standard", avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: true },
  surfaces: [{ surfaceId: "workspace-main", label: "Workspace", purpose: "workspace", allowedObjectTypes: ["markdown-board"] }],
  settings: { layout: "personal-workspace", notes: { enabled: true, defaultScope: "private" }, audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "owner-focused" }, presentation: { enabled: false } }
};

test("reference create fields carry version/owner while legacy payloads retain their old shape", () => {
  const reference: TemplateRecord = { templateId: "personal-room-basic", currentVersion: "2.0.0", label: "Personal", assetSlots: [], defaults };
  assert.deepEqual(templateCreationFields(reference, " owner-123 "), { templateVersion: "2.0.0", roomType: "personal", ownerParticipantId: "owner-123" });
  assert.deepEqual(templateCreationFields({ templateId: "legacy", label: "Legacy", assetSlots: [] }, ""), {});
  assert.match(templateDefaultsSummary(reference), /v2\.0\.0.*private.*private notes/);
  assert.equal(Object.hasOwn(templateCreationFields(reference, "owner"), "sceneBundleUrl"), false);
});

test("protocol hint defaults to legacy and v2 create never forwards stale raw owner input", () => {
  const session = (minimumIdentityProtocol?: 1 | 2): ControlPlaneSession => ({ actor: { actorType: "admin-token", actorId: "admin", role: "admin" },
    permissions: [], ...(minimumIdentityProtocol ? { minimumIdentityProtocol } : {}) });
  assert.deepEqual([undefined, session(), session(1), session(2)].map(controlPlaneIdentityFloor), [1, 1, 1, 2]);
  const reference: TemplateRecord = { templateId: "personal-room-basic", currentVersion: "2.0.0", label: "Personal", assetSlots: [], defaults };
  const standard: TemplateRecord = { ...reference, templateId: "meeting-room-basic", defaults: { ...defaults, roomType: "standard", visibility: "public", guestAllowed: true } };
  const legacy: TemplateRecord = { templateId: "legacy", label: "Legacy", assetSlots: [] }, before = structuredClone([reference, standard, legacy]);
  assert.deepEqual(templateCreationFields(reference, " stale-owner ", controlPlaneIdentityFloor(session(2))), { templateVersion: "2.0.0", roomType: "personal", ownerParticipantId: null });
  assert.deepEqual(templateCreationFields(reference, " owner-1 ", controlPlaneIdentityFloor(session())), { templateVersion: "2.0.0", roomType: "personal", ownerParticipantId: "owner-1" });
  for (const floor of [1, 2] as const) {
    assert.deepEqual(templateCreationFields(standard, " stale-owner ", floor), { templateVersion: "2.0.0", roomType: "standard" });
    assert.deepEqual(templateCreationFields(legacy, " stale-owner ", floor), {});
  }
  assert.deepEqual([reference, standard, legacy], before);
});

test("every ownerless personal invitation is Member while other room invitations keep their existing default", () => {
  type InviteRoom = Pick<RoomRecord, "roomType" | "ownerParticipantId">;
  const ownerless: InviteRoom[] = [{ roomType: "personal", ownerParticipantId: null }, { roomType: "personal" }];
  const unchanged: InviteRoom[] = [{ roomType: "personal", ownerParticipantId: "owner-1" }, { roomType: "standard", ownerParticipantId: null }, { roomType: "standard" }, { ownerParticipantId: null }, {}];
  const before = structuredClone([ownerless, unchanged]);
  for (const room of ownerless) assert.deepEqual(personalRoomInviteFields(room), { role: "member" });
  for (const room of unchanged) assert.deepEqual(personalRoomInviteFields(room), {});
  assert.deepEqual([ownerless, unchanged], before);
});

test("current authority presentation takes precedence over frozen legacy owner metadata", () => {
  type OwnerRoom = Pick<RoomRecord, "roomType" | "ownerParticipantId" | "currentOwnerParticipantId">;
  const cases: Array<[OwnerRoom, string | null, { role?: "member" }]> = [
    [{ roomType: "personal", ownerParticipantId: null, currentOwnerParticipantId: "new-owner" }, "new-owner", {}],
    [{ roomType: "personal", ownerParticipantId: null, currentOwnerParticipantId: null }, null, { role: "member" }],
    [{ roomType: "personal", ownerParticipantId: "legacy-owner", currentOwnerParticipantId: null }, null, { role: "member" }],
    [{ roomType: "personal", ownerParticipantId: "legacy-owner", currentOwnerParticipantId: "new-owner" }, "new-owner", {}],
    [{ roomType: "personal", ownerParticipantId: "legacy-owner" }, "legacy-owner", {}],
    [{ roomType: "standard", ownerParticipantId: null, currentOwnerParticipantId: null }, null, {}]
  ];
  const before = structuredClone(cases);
  for (const [room, owner, fields] of cases) { assert.equal(displayOwnerParticipantId(room), owner); assert.deepEqual(personalRoomInviteFields(room), fields); }
  assert.deepEqual(cases, before);
});
