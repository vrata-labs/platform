import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertLocalPluginRollbackObject, pluginRollbackModuleSetting } from "./rollback-fixture.test-helper.js";

test("plugin rollback requires an explicit CI fixture and fails clearly when local history is unavailable", async t => {
  assert.throws(() => pluginRollbackModuleSetting({ CI: "true" }), /CI requires VRATA_PLUGIN_ROLLBACK_STORAGE_MODULE/);
  assert.throws(() => pluginRollbackModuleSetting({ CI: "true", VRATA_PLUGIN_ROLLBACK_STORAGE_MODULE: " " }), /CI requires/);
  assert.equal(pluginRollbackModuleSetting({ CI: "true", VRATA_PLUGIN_ROLLBACK_STORAGE_MODULE: "/fixture/apps/api/dist/storage.js" }), "/fixture/apps/api/dist/storage.js");
  assert.equal(pluginRollbackModuleSetting({}), undefined);
  const root = await mkdtemp(join(tmpdir(), "vrata-no-rollback-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)("git", ["init", "--bare", "--quiet", root]);
  await assert.rejects(assertLocalPluginRollbackObject(root), /plugin_rollback_source_unavailable:.*VRATA_PLUGIN_ROLLBACK_STORAGE_MODULE/);
});
