import assert from "node:assert/strict";
import test from "node:test";
import { listProductRoomTemplateVersionContracts, listReferenceTemplateVersionContracts } from "./product-room-definitions.js";
import { getStandardRoomTemplateVersionContract } from "./standard-room-definitions.js";

test("product versions bind approved independent releases without rewriting historical contracts", () => {
  const definitions = listProductRoomTemplateVersionContracts();
  assert.deepEqual(definitions.map(value => [value.templateId, value.version, value.assetLock.sceneReleaseId]), [
    ["personal-room-basic", "2.0.0", "personal-workspace-v1@0.4.2"],
    ["meeting-room-basic", "2.0.0", "warm-modern-meeting-room-candidate-01@0.3.4"],
    ["presentation-room-basic", "2.0.0", "presentation-room-v1@0.4.2"]
  ]);
  assert.deepEqual(definitions.map(value => value.scene.seats.minimum), [1, 8, 8]);
  assert.equal(definitions[0]!.scene.surfaces[0]!.surfaceId, "workspace-main");
  assert.equal(getStandardRoomTemplateVersionContract("meeting-room-basic", "1.0.0")!.scene.seats.maximum, 4);
  assert.equal(getStandardRoomTemplateVersionContract("personal-room-basic", "1.0.0")!.scene.surfaces[0]!.surfaceId, "debug-main");
  assert.equal(listReferenceTemplateVersionContracts().length, 6);
  definitions[0]!.assetLock.commitSha = "corrupt";
  assert.notEqual(listProductRoomTemplateVersionContracts()[0]!.assetLock.commitSha, "corrupt");
});
