import { expect } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startRoomPluginFixture } from "./room-plugin-fixture";
import { lightSeatSceneBundleUrl } from "./scene-bundle-fixtures";
import { cleanupAll } from "./test-cleanup";

export async function startNoAnchorRoomPluginFixture() {
  const { templateId, ...value } = await startOwnedTemplateFixture("t16-owned-no-anchor", "Owned no-anchor regression");
  return { ...value, noAnchorTemplateId: templateId };
}

/** Real clients, authority and plugin in a room whose scene costs almost nothing to render. */
export async function startLightSceneRoomPluginFixture() {
  const { templateId, ...value } = await startOwnedTemplateFixture("t16-owned-light-seats", "Owned light seats regression");
  return { ...value, lightScene: { templateId, sceneBundleUrl: lightSeatSceneBundleUrl() } };
}

/** Extra non-reference template ONLY in this test's disposable schema. */
async function startOwnedTemplateFixture(templateId: string, label: string) {
  const value = await startRoomPluginFixture(2);
  expect(value.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
  const { Pool } = createRequire(resolve("apps/api/package.json"))("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${value.schema},public` });
  const close = () => cleanupAll([
    // Hide only our template before the reference fixture checks its catalog and drops its schema.
    () => pool.query("update templates set status = 'deprecated' where template_id = $1", [templateId]),
    () => pool.end(), () => value.close()
  ]);
  try {
    const ownership = await pool.query("select current_schema() as schema");
    expect(ownership.rows).toEqual([{ schema: value.schema }]);
    const { templateVersionContentHash } = await import(pathToFileURL(resolve("apps/api/dist/storage-room-records.js")).href);
    const snapshot = { schemaVersion: 1, templateId, version: "0.1.0", label, assetSlots: [] };
    await pool.query("insert into templates(template_id,label,asset_slots,status) values ($1,$2,'[]'::jsonb,'active')", [templateId, snapshot.label]);
    await pool.query("insert into template_versions(template_id,version,snapshot,content_hash) values ($1,$2,$3::jsonb,$4)",
      [templateId, snapshot.version, JSON.stringify(snapshot), templateVersionContentHash(snapshot)]);
    await pool.query("update templates set current_version = $2 where template_id = $1", [templateId, snapshot.version]);
    return { ...value, templateId, close };
  } catch (error) {
    await cleanupAll([close], { error });
    throw error;
  }
}
