import assert from "node:assert/strict";
import test from "node:test";
import { expectedReferenceCatalog, planReferenceCatalogTransition, referenceCatalogState } from "./catalog-transition.js";

test("activation and rollback describe exact atomic catalog states and are idempotent", () => {
  const before = expectedReferenceCatalog("wave2");
  const active = planReferenceCatalogTransition(before, "active");
  assert.deepEqual(active.filter(value => value.status === "active").map(value => value.templateId).sort(), ["meeting-room-basic", "personal-room-basic", "presentation-room-basic"]);
  assert.equal(referenceCatalogState(active), "active");
  assert.deepEqual(planReferenceCatalogTransition(active, "active"), []);
  assert.deepEqual(planReferenceCatalogTransition(active, "wave2"), before);
  assert.deepEqual(planReferenceCatalogTransition(before, "wave2"), []);
});

test("catalog transitions reject partial activation, unexpected versions and unaccounted active templates", () => {
  for (const corrupt of [
    expectedReferenceCatalog("wave2").slice(1),
    expectedReferenceCatalog("wave2").map((value, index) => index === 0 ? { ...value, currentVersion: "2.0.0" } : value),
    [...expectedReferenceCatalog("wave2"), { templateId: "custom", currentVersion: "0.1.0", status: "active" as const }]
  ]) assert.throws(() => planReferenceCatalogTransition(corrupt, "active"), /template_catalog_state_mismatch/);
  const catalog = [...expectedReferenceCatalog("wave2"), { templateId: "custom", currentVersion: "0.1.0", status: "deprecated" as const }];
  assert.equal(planReferenceCatalogTransition(catalog, "active").some(value => value.templateId === "custom"), false);
});
