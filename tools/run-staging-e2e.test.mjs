import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("staging CLI uses one worker in CI while retaining explicit worker overrides", async t => {
  const directory = await mkdtemp(join(tmpdir(), "staging-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "pnpm"), '#!/usr/bin/env node\nconsole.log("received_args:" + JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [{ templateId: "meeting-room-basic", currentVersion: "0.1.0" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const override of [[], ["--workers=2"]]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./run-staging-e2e.mjs", import.meta.url)), ...override], {
      cwd: directory, timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BASE_URL: `http://127.0.0.1:${server.address().port}`, STAGING_ADMIN_TOKEN: "fixture-admin", STAGING_E2E_ENV_FILE: "", VRATA_REFERENCE_CATALOG_ACTIVE: "0", GITHUB_ACTIONS: "true", PATH: `${directory}${delimiter}${process.env.PATH}` }
    });
    let output = "";
    child.stdout.on("data", data => { output += String(data); });
    child.stderr.on("data", data => { output += String(data); });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    const args = JSON.parse(output.split("\n").find(line => line.startsWith("received_args:")).slice("received_args:".length));
    assert.deepEqual(args.filter(arg => arg.startsWith("--workers=")), override.length ? override : ["--workers=1"]);
    assert(args.includes("@staging")); assert(args.includes("@rutube"));
  }
});
