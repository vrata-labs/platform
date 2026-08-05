import test from "node:test";
import assert from "node:assert/strict";

import { templates, type TemplateDefinition } from "./index.js";
import { createSpaceManifest, getCurrentTemplateVersion, getTemplateDefinition, getTemplateVersion, listTemplateDefinitions } from "./registry.js";

test("createSpaceManifest resolves template slot config", () => {
  const manifest = createSpaceManifest("meeting-room-basic");
  assert.equal(manifest.templateId, "meeting-room-basic");
  assert.deepEqual(manifest.assetSlots, ["logo", "hero-screen"]);
});

test("legacy public catalog preserves mutable shape and reference behavior", () => {
  assert.deepEqual(Object.keys(templates[0] ?? {}).sort(), ["assetSlots", "id", "label"]);
  assert.equal(Object.isFrozen(templates), false);
  assert.equal(Object.isFrozen(templates[0]), false);
  assert.equal(Object.isFrozen(templates[0]?.assetSlots), false);

  const definition = getTemplateDefinition("meeting-room-basic");
  assert.ok(definition);
  const originalLabel = definition.label;
  const originalSlots = [...definition.assetSlots];
  const added: TemplateDefinition = { id: "legacy-added-template", label: "Legacy Added", assetSlots: ["logo"] };
  try {
    definition.label = "Mutated Legacy Label";
    definition.assetSlots.push("legacy-slot");
    templates.push(added);

    assert.equal(getTemplateDefinition("meeting-room-basic"), definition);
    assert.equal(getTemplateDefinition(added.id), added);
    const manifest = createSpaceManifest("meeting-room-basic");
    assert.equal(manifest.assetSlots, definition.assetSlots);
    assert.deepEqual(manifest.assetSlots, [...originalSlots, "legacy-slot"]);
  } finally {
    definition.label = originalLabel;
    definition.assetSlots.splice(0, definition.assetSlots.length, ...originalSlots);
    templates.splice(templates.indexOf(added), 1);
  }
});

test("versioned registry exposes only the four active 0.1.0 templates", () => {
  assert.deepEqual(
    listTemplateDefinitions().map(({ id, version, status }) => ({ id, version, status })),
    [
      { id: "meeting-room-basic", version: "0.1.0", status: "active" },
      { id: "showroom-basic", version: "0.1.0", status: "active" },
      { id: "event-demo-basic", version: "0.1.0", status: "active" },
      { id: "personal-workspace-basic", version: "0.1.0", status: "active" }
    ]
  );
});

test("versioned registry lookups return defensive clones isolated from legacy mutations", () => {
  const firstDefinition = getTemplateDefinition("meeting-room-basic");
  const firstList = listTemplateDefinitions();
  const firstCurrent = getCurrentTemplateVersion("meeting-room-basic");
  const firstVersion = getTemplateVersion("meeting-room-basic", "0.1.0");
  assert.ok(firstDefinition);
  assert.ok(firstCurrent);
  assert.ok(firstVersion);

  const legacySlots = [...firstDefinition.assetSlots];
  try {
    firstDefinition.assetSlots.push("legacy-mutation");
    firstList[0]?.assetSlots.push("spoofed-slot");
    firstCurrent.assetSlots.push("spoofed-slot");
    firstVersion.assetSlots.push("spoofed-slot");

    assert.deepEqual(listTemplateDefinitions()[0]?.assetSlots, ["logo", "hero-screen"]);
    assert.deepEqual(getCurrentTemplateVersion("meeting-room-basic")?.assetSlots, ["logo", "hero-screen"]);
    assert.deepEqual(getTemplateVersion("meeting-room-basic", "0.1.0")?.assetSlots, ["logo", "hero-screen"]);
    assert.equal(getTemplateVersion("meeting-room-basic", "0.2.0"), undefined);
  } finally {
    firstDefinition.assetSlots.splice(0, firstDefinition.assetSlots.length, ...legacySlots);
  }
});
