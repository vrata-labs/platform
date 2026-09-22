import assert from "node:assert/strict";
import test from "node:test";
import { templateCreationFields, templateDefaultsSummary } from "./template-picker.js";
import type { TemplateRecord } from "./index.js";
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
