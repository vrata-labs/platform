import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalEnv, parseArgs } from "./pull-staging-e2e-env.mjs";

test("explicit SSH target gets public URLs from that host instead of an old IP", () => {
  const args = parseArgs(["--ssh", "deploy@198.51.100.20"]);
  const remote = new Map([["CONTROL_PLANE_ADMIN_TOKEN", "test-admin"], ["VRATA_APP_DOMAIN", "198.51.100.20.sslip.io"],
    ["VRATA_STATE_DOMAIN", "state.198.51.100.20.sslip.io"], ["STAGING_SCENE_BUNDLE_VERSION", "a".repeat(40)]]);
  const values = buildLocalEnv(remote, { ...args, baseUrl: null });
  assert.equal(values.get("BASE_URL"), "https://198.51.100.20.sslip.io");
  assert.equal(values.get("STAGING_ASSET_BASE_URL"), "https://state.198.51.100.20.sslip.io");
  assert.equal(values.get("STAGING_SCENE_BUNDLE_VERSION"), "a".repeat(40));
  assert.equal(buildLocalEnv(remote, { ...args, baseUrl: "https://explicit.example.test" }).get("BASE_URL"), "https://explicit.example.test");
  assert.throws(() => buildLocalEnv(new Map([["CONTROL_PLANE_ADMIN_TOKEN", "test-admin"]]), { baseUrl: null }), /URL is required/);
});
