import assert from "node:assert/strict";
import test from "node:test";
import { getStandardRoomTemplateVersionContract } from "./standard-room-definitions.js";
import { materializeReferenceTemplate, referenceTemplateContract } from "./materialization.js";

const personal = getStandardRoomTemplateVersionContract("personal-room-basic", "1.0.0")!;
const presentation = getStandardRoomTemplateVersionContract("presentation-room-basic", "1.0.0")!;

test("server materialization applies defaults and preserves explicit allowed overrides", () => {
  const result = materializeReferenceTemplate(presentation, { features: { voice: false }, theme: { accentColor: "#123456" }, avatarConfig: { avatarsEnabled: false } });
  assert.equal(result.features.voice, false);
  assert.equal(result.features.screenShare, true);
  assert.equal(result.theme.primaryColor, presentation.defaults.theme.primaryColor);
  assert.equal(result.theme.accentColor, "#123456");
  assert.equal(result.avatarConfig.avatarsEnabled, false);
  assert.equal(result.roomType, "standard");
  assert.equal(result.sceneBundleUrl, `https://cdn.jsdelivr.net/gh/${presentation.assetLock.repository}@${presentation.assetLock.commitSha}/${presentation.assetLock.sceneManifest.path}`);
  result.features.screenShare = false;
  assert.equal(presentation.defaults.features.screenShare, true);
});

test("personal invariants reject conflicting overrides instead of silently correcting them", () => {
  assert.throws(() => materializeReferenceTemplate(personal, {}), /missing_personal_room_owner/);
  for (const [input, reason] of [
    [{ roomType: "standard" }, "template_room_type_conflict"],
    [{ visibility: "public" }, "personal_room_must_be_private"],
    [{ guestAllowed: true }, "personal_room_guest_access_forbidden"],
    [{ sceneBundleUrl: "https://other.example/scene.json" }, "reference_scene_override_not_allowed"]
  ] as const) assert.throws(() => materializeReferenceTemplate(personal, { ownerParticipantId: "owner-123", ...input }), new RegExp(reason));
  const result = materializeReferenceTemplate(personal, { ownerParticipantId: "owner-123" });
  assert.equal(result.roomType, "personal");
  assert.equal(result.visibility, "private");
  assert.equal(result.guestAllowed, false);
});

test("reference detection preserves historical snapshots but fails on incomplete contracts", () => {
  assert.equal(referenceTemplateContract({ schemaVersion: 1, templateId: "legacy", version: "0.1.0", label: "Legacy", assetSlots: [] }), undefined);
  const incomplete = { ...presentation, defaults: undefined };
  assert.throws(() => referenceTemplateContract(incomplete), /invalid_reference_template_snapshot/);
  const copy = referenceTemplateContract(presentation)!;
  copy.defaults.surfaces[0]!.label = "Changed";
  assert.notEqual(presentation.defaults.surfaces[0]!.label, "Changed");
  const bound = { ...presentation, roomConfig: { visibility: "private", features: { voice: false } } };
  assert.equal(Object.hasOwn(referenceTemplateContract(bound)!, "roomConfig"), false);
});
