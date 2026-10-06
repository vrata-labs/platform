import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const publicRoot = fileURLToPath(new URL("../apps/runtime-web/public/", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../packages/room-plugin-sdk/", import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const archiveName = version => `vrata-room-plugin-sdk-${version}.tgz`;

async function readReleases() {
  const manifest = JSON.parse(await readFile(join(publicRoot, "assets/plugin-sdk/releases.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.releases) && manifest.releases.length > 0);
  const urls = new Set();
  for (const release of manifest.releases) {
    assert.equal(release.package, "@vrata/room-plugin-sdk");
    assert.match(release.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.equal(release.url, `/assets/plugin-sdk/${release.version}/${release.sha256}/${archiveName(release.version)}`);
    assert.ok(!urls.has(release.url), "duplicate immutable release URL");
    urls.add(release.url);
  }
  return manifest.releases;
}

async function archiveText(archive, member) {
  const { stdout } = await run("tar", ["-xOf", archive, member], { encoding: "utf8", timeout: 10_000 });
  return stdout;
}

test("published SDK releases pin real archive bytes, CLI, public declarations and standalone example dependencies", async () => {
  for (const release of await readReleases()) {
    const archive = join(publicRoot, release.url.slice(1));
    const bytes = await readFile(archive);
    assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024, "SDK download must be nonempty and at most 1 MiB");
    assert.equal(sha256(bytes), release.sha256, "published archive does not match its immutable digest");

    const published = JSON.parse(await archiveText(archive, "package/package.json"));
    const { stdout } = await run("tar", ["-tzf", archive], { encoding: "utf8", timeout: 10_000 });
    const files = new Set(stdout.trim().split("\n"));
    assert.equal(published.name, release.package);
    assert.equal(published.version, release.version);
    assert.equal(published.type, "module");
    assert.equal(published.types, "./dist/index.d.ts");
    assert.deepEqual(published.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/commonjs/index.js", default: "./dist/index.js" },
      "./artifact": { types: "./dist/artifact.d.ts", import: "./dist/artifact.js", require: "./dist/commonjs/artifact.js", default: "./dist/artifact.js" },
      "./package.json": "./package.json"
    });
    for (const entry of Object.values(published.exports)) {
      for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
        assert.ok(files.has(`package/${target.slice(2)}`), `archive is missing public export ${target}`);
      }
    }
    assert.deepEqual(published.bin, { "vrata-room-plugin": "dist/cli.js" });
    assert.deepEqual(JSON.parse(await archiveText(archive, "package/dist/commonjs/package.json")), { type: "commonjs" });
    assert.ok(files.has("package/dist/cli.js"));
    assert.ok((await archiveText(archive, "package/dist/cli.js")).startsWith("#!/usr/bin/env node\n"));
    assert.deepEqual(published.dependencies, { acorn: "8.18.0", esbuild: "0.25.12" });
    for (const example of ["welcome-status", "auto-seat"]) {
      const examplePackage = JSON.parse(await archiveText(archive, `package/examples/${example}/package.json`));
      assert.deepEqual(examplePackage.dependencies, { "@vrata/room-plugin-sdk": `file:./${archiveName(release.version)}` });
      assert.ok(files.has(`package/examples/${example}/build.mjs`));
    }
  }
});

test("current built SDK packs to the exact bytes of its published release", { timeout: 90_000 }, async () => {
  const sdk = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  const releases = (await readReleases()).filter(release => release.package === sdk.name && release.version === sdk.version);
  assert.equal(releases.length, 1, "current SDK must have exactly one immutable release");
  const directory = await mkdtemp(join(tmpdir(), "vrata-sdk-distribution-"));
  try {
    await run("pnpm", ["pack", "--pack-destination", directory], { cwd: sdkRoot, encoding: "utf8", timeout: 60_000 });
    assert.deepEqual(await readdir(directory), [archiveName(sdk.version)]);
    const bytes = await readFile(join(directory, archiveName(sdk.version)));
    assert.equal(sha256(bytes), releases[0].sha256, "published archive has drifted from the current SDK; rebuild and publish a matching immutable release");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
