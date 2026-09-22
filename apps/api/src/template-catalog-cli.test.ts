import assert from "node:assert/strict";
import test from "node:test";
import { parseTemplateCatalogCommand } from "./template-catalog-cli.js";
import { preflightReferenceTemplateAssets } from "./reference-template-preflight.js";

test("catalog mutation requires an exact image and a verified Wave 2 rollback marker", () => {
  const current = "a".repeat(40), previous = "b".repeat(40);
  const env = { VRATA_DEPLOY_SHA: current, VRATA_TEMPLATE_WAVE2_SHA: previous };
  assert.throws(() => parseTemplateCatalogCommand(["activate"], env), /image_mismatch/);
  assert.throws(() => parseTemplateCatalogCommand(["activate", "--expected-image-sha", previous], env), /image_mismatch/);
  assert.throws(() => parseTemplateCatalogCommand(["activate", "--expected-image-sha", current], env), /rollback_target_required/);
  assert.throws(() => parseTemplateCatalogCommand(["activate", "--expected-image-sha", current, "--rollback-sha", current], env), /rollback_marker_mismatch/);
  assert.equal(parseTemplateCatalogCommand(["activate", "--expected-image-sha", current, "--rollback-sha", previous], env).mode, "activate");
  assert.equal(parseTemplateCatalogCommand(["activate", "--expected-image-sha", current, "--rollback-sha", current], { ...env, VRATA_TEMPLATE_WAVE2_SHA: current }).mode, "activate");
  assert.equal(parseTemplateCatalogCommand(["rollback", "--expected-image-sha", current], env).mode, "rollback");
  assert.throws(() => parseTemplateCatalogCommand(["activate", "--unknown", "value"], env), /invalid_template_catalog_arguments/);
});

test("asset preflight rejects unavailable and changed bytes before catalog mutation", async () => {
  await assert.rejects(() => preflightReferenceTemplateAssets(async () => new Response("missing", { status: 404 })), /reference_asset_unavailable/);
  await assert.rejects(() => preflightReferenceTemplateAssets(async () => new Response("changed")), /reference_asset_checksum_mismatch/);
});
