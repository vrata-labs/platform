import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRoomPluginArtifact } from "../artifact.js";
import { ROOM_PLUGIN_LIMITS } from "../contracts.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "dist/cli.js");
const manifest = {
  schemaVersion: 1, sdkApiVersion: 1, id: "cli-fixture", version: "1.0.0", displayName: "CLI fixture",
  requestedCapabilities: ["status.set"], configSchema: {}
};
function call(cwd: string, args: string[], expected = 0): Record<string, any> {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.equal(result.stderr, "", "source/paths/diagnostics must not escape through stderr");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]!);
  assert.equal(output.ok, expected === 0);
  return output;
}
function temporary(action: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "vrata-sdk-cli-"));
  try { action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function author(directory: string): void {
  mkdirSync(join(directory, "node_modules/tiny-local"), { recursive: true });
  writeFileSync(join(directory, "node_modules/tiny-local/package.json"), JSON.stringify({
    name: "tiny-local", version: "1.0.0", main: "index.cjs",
    scripts: { prepare: "node -e 'process.exit(99)'", install: "node -e 'process.exit(98)'" }
  }));
  writeFileSync(join(directory, "node_modules/tiny-local/index.cjs"), "module.exports = { greeting: 'Привет' };\n");
  writeFileSync(join(directory, "entry.ts"), "import type { RoomPluginContext } from '@vrata/room-plugin-sdk';\nimport value from 'tiny-local';\nexport function init(context: RoomPluginContext) { return context.sdk.status.set(value.greeting); }\n");
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
}

test("real esbuild bundles local TS/dependencies without scripts and packs deterministic SDK-valid bytes across directories", () => temporary(directory => {
  const a = join(directory, "author-a");
  const b = join(directory, "different-author-location");
  mkdirSync(a); mkdirSync(b);
  author(a); author(b);
  for (const cwd of [a, b]) {
    const bundle = call(cwd, ["bundle", "--entry", "entry.ts", "--out", "entry.bundle.mjs"]);
    assert.equal(typeof bundle.entrySha256, "string");
    const packed = call(cwd, ["pack", "--manifest", "manifest.json", "--entry", "entry.bundle.mjs", "--out", "fixture.vrata-plugin.json"]);
    const validated = validateRoomPluginArtifact(readFileSync(join(cwd, "fixture.vrata-plugin.json")));
    assert.equal(packed.artifactSha256, validated.artifactSha256);
    assert.equal(call(cwd, ["validate", "fixture.vrata-plugin.json"]).artifactSha256, validated.artifactSha256);
  }
  assert.deepEqual(readFileSync(join(a, "entry.bundle.mjs")), readFileSync(join(b, "entry.bundle.mjs")));
  assert.deepEqual(readFileSync(join(a, "fixture.vrata-plugin.json")), readFileSync(join(b, "fixture.vrata-plugin.json")));
}));

test("both standalone sample graphs reproduce checked-in artifacts with only SDK CLI and no platform imports", () => temporary(directory => {
  for (const [name, entry, output] of [["welcome-status", "entry.js", "welcome-status.vrata-plugin.json"], ["auto-seat", "entry.ts", "auto-seat.vrata-plugin.json"]]) {
    const source = join(root, "examples", name!);
    const cwd = join(directory, name!);
    cpSync(source, cwd, { recursive: true });
    call(cwd, ["bundle", "--entry", entry!, "--out", "entry.bundle.mjs"]);
    const packed = call(cwd, ["pack", "--manifest", "manifest.json", "--entry", "entry.bundle.mjs", "--out", output!]);
    const checked = validateRoomPluginArtifact(readFileSync(join(cwd, output!)));
    assert.equal(packed.artifactSha256, checked.artifactSha256);
    assert.deepEqual(readFileSync(join(cwd, output!)), readFileSync(join(source, output!)));
  }
}));

test("bundle/pack/validate never execute author JavaScript and never dump secret source or manifest props", () => temporary(directory => {
  const secret = "AUTHOR_SOURCE_SECRET_DO_NOT_PRINT";
  writeFileSync(join(directory, "entry.js"), `globalThis.process.exit(77); console.log('${secret}'); export function dispose() {}\n`);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  for (const args of [
    ["bundle", "--entry", "entry.js", "--out", "bundle.mjs"],
    ["pack", "--manifest", "manifest.json", "--entry", "bundle.mjs", "--out", "artifact.json"],
    ["validate", "artifact.json"]
  ]) assert.ok(!JSON.stringify(call(directory, args)).includes(secret));
  writeFileSync(join(directory, "entry.js"), `export const invalid = '${secret}' + ;`);
  const syntaxError = call(directory, ["bundle", "--entry", "entry.js", "--out", "bundle.mjs"], 5);
  assert.deepEqual(syntaxError.error, { code: "bundle_failed" });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...manifest, [secret]: true }));
  const dataError = call(directory, ["pack", "--manifest", "manifest.json", "--entry", "bundle.mjs", "--out", "artifact.json"], 3);
  assert.deepEqual(dataError.error, { code: "unknown_field" });
  assert.ok(!JSON.stringify(dataError).includes(secret));
}));

test("remote/static/dynamic imports and URL input paths are rejected without fetching", () => temporary(directory => {
  for (const source of [
    'import "https://127.0.0.1:1/secret.js"; export function dispose() {}',
    'export { value } from "https://example.invalid/remote.js";',
    'export function init() { return import("https://example.invalid/module.js"); }',
    'export function init(name) { return import(name); }',
    'import { readFile } from "node:fs"; export { readFile };'
  ]) {
    writeFileSync(join(directory, "entry.js"), source);
    assert.deepEqual(call(directory, ["bundle", "--entry", "entry.js", "--out", "out.mjs"], 3).error, { code: "module_import_forbidden" });
  }
  assert.deepEqual(call(directory, ["validate", "https://example.invalid/artifact.json"], 2).error, { code: "local_path_required" });
}));

test("bounded CLI reads reject oversized manifest/entry/artifact and malformed UTF-8 before parsing", () => temporary(directory => {
  writeFileSync(join(directory, "manifest.json"), Buffer.alloc(32 * 1024 + 1, 32));
  writeFileSync(join(directory, "entry.js"), "export function dispose() {}\n");
  assert.deepEqual(call(directory, ["pack", "--manifest", "manifest.json", "--entry", "entry.js", "--out", "out.json"], 3).error, { code: "manifest_too_large" });
  writeFileSync(join(directory, "large.js"), Buffer.alloc(ROOM_PLUGIN_LIMITS.artifactBytes + 1, 32));
  assert.deepEqual(call(directory, ["bundle", "--entry", "large.js", "--out", "out.mjs"], 3).error, { code: "entry_too_large" });
  assert.deepEqual(call(directory, ["validate", "large.js"], 3).error, { code: "artifact_too_large" });
  writeFileSync(join(directory, "invalid.js"), new Uint8Array([0xc3, 0x28]));
  assert.deepEqual(call(directory, ["bundle", "--entry", "invalid.js", "--out", "out.mjs"], 3).error, { code: "invalid_utf8" });
  writeFileSync(join(directory, "manifest.json"), '{"__proto__":{"polluted":true}}');
  assert.deepEqual(call(directory, ["pack", "--manifest", "manifest.json", "--entry", "entry.js", "--out", "out.json"], 3).error, { code: "unsafe_key" });
  writeFileSync(join(directory, "manifest.json"), "[".repeat(1000));
  assert.deepEqual(call(directory, ["pack", "--manifest", "manifest.json", "--entry", "entry.js", "--out", "out.json"], 3).error, { code: "nesting_too_deep" });
}));

test("shared artifact hash validation detects exact byte mutation through CLI", () => temporary(directory => {
  author(directory);
  call(directory, ["bundle", "--entry", "entry.ts", "--out", "bundle.mjs"]);
  call(directory, ["pack", "--manifest", "manifest.json", "--entry", "bundle.mjs", "--out", "artifact.json"]);
  const artifact = JSON.parse(readFileSync(join(directory, "artifact.json"), "utf8"));
  artifact.entry += " ";
  writeFileSync(join(directory, "artifact.json"), JSON.stringify(artifact));
  assert.deepEqual(call(directory, ["validate", "artifact.json"], 3).error, { code: "entry_checksum_mismatch" });
}));

test("atomic explicit output replaces requested regular files only; failures/symlinks preserve other bytes", () => temporary(directory => {
  writeFileSync(join(directory, "entry.js"), "export function dispose() {}\n");
  writeFileSync(join(directory, "out.mjs"), "original");
  writeFileSync(join(directory, "other"), "unrequested");
  symlinkSync("other", join(directory, "link.mjs"));
  assert.deepEqual(call(directory, ["bundle", "--entry", "entry.js", "--out", "link.mjs"], 4).error, { code: "output_not_regular" });
  assert.equal(readFileSync(join(directory, "other"), "utf8"), "unrequested");
  call(directory, ["bundle", "--entry", "entry.js", "--out", "out.mjs"]);
  const valid = readFileSync(join(directory, "out.mjs"));
  writeFileSync(join(directory, "entry.js"), "invalid javascript !!!");
  call(directory, ["bundle", "--entry", "entry.js", "--out", "out.mjs"], 5);
  assert.deepEqual(readFileSync(join(directory, "out.mjs")), valid);
  assert.ok(!readdirSync(directory).some(name => name.startsWith(".vrata-plugin-")));
  assert.deepEqual(call(directory, ["validate", "."], 4).error, { code: "input_not_regular" });
  assert.deepEqual(call(directory, ["validate", "missing.json"], 4).error, { code: "io_error" });
}));

test("CLI graph budget caps dependency count, even when exports could be tree-shaken", () => temporary(directory => {
  let entry = "";
  for (let i = 0; i < 129; i++) {
    writeFileSync(join(directory, `module-${i}.js`), `export const value = ${i};`);
    entry += `export { value as v${i} } from './module-${i}.js';\n`;
  }
  writeFileSync(join(directory, "entry.js"), entry);
  assert.deepEqual(call(directory, ["bundle", "--entry", "entry.js", "--out", "out.mjs"], 3).error, { code: "source_graph_too_large" });
}));

test("temporary-name collision never removes an unrequested pre-existing file", () => temporary(directory => {
  // Trusted test preload fixes the OS temporary name; no author module is executed.
  writeFileSync(join(directory, "preload.cjs"), "const crypto=require('node:crypto'); crypto.randomUUID=()=> 'collision-fixture'; require('node:module').syncBuiltinESMExports();\n");
  writeFileSync(join(directory, "entry.js"), "export function dispose() {}\n");
  writeFileSync(join(directory, "out.mjs"), "requested original");
  const collision = join(directory, ".vrata-plugin-collision-fixture.tmp");
  writeFileSync(collision, "unrequested original");
  const result = spawnSync(process.execPath, ["--require", join(directory, "preload.cjs"), cli, "bundle", "--entry", "entry.js", "--out", "out.mjs"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 4);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).error, { code: "io_error" });
  assert.equal(readFileSync(collision, "utf8"), "unrequested original");
  assert.equal(readFileSync(join(directory, "out.mjs"), "utf8"), "requested original");
}));

test("CLI usage/help are JSON with stable exit codes and never echo unknown arguments", () => temporary(directory => {
  assert.equal(call(directory, ["--help"]).command, "help");
  for (const args of [[], ["SECRET_UNKNOWN_COMMAND"], ["validate"], ["bundle", "--entry", "one", "--entry", "two", "--out", "out"], ["pack", "--manifest", "one", "--entry", "two", "--out", "out", "--unknown", "SECRET"]]) {
    const result = call(directory, args, 2);
    assert.deepEqual(result.error, { code: "cli_usage" });
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
}));

test("cwd project root permits src entry and sibling node_modules; explicit root gives identical bytes from src", () => temporary(directory => {
  author(directory);
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src/entry.ts"), readFileSync(join(directory, "entry.ts")));
  const normal = call(directory, ["bundle", "--entry", "src/entry.ts", "--out", "normal.mjs"]);
  const explicit = call(join(directory, "src"), ["bundle", "--entry", "entry.ts", "--out", "../explicit.mjs", "--root", ".."]);
  assert.equal(normal.entrySha256, explicit.entrySha256);
  assert.deepEqual(readFileSync(join(directory, "normal.mjs")), readFileSync(join(directory, "explicit.mjs")));
}));

test("malicious local dependency cannot bundle absolute or relative outside JSON, including root-prefix siblings", () => temporary(directory => {
  const project = join(directory, "project");
  const outside = join(directory, "project-extra");
  mkdirSync(project); mkdirSync(outside);
  author(project);
  const secret = join(outside, "private.json");
  const marker = "PRIVATE_JSON_MUST_NEVER_ENTER_BUNDLE";
  writeFileSync(secret, JSON.stringify({ greeting: marker }));
  writeFileSync(join(project, "out.mjs"), "previous requested output");
  const dependency = join(project, "node_modules/tiny-local/index.cjs");
  for (const specifier of [secret, relative(dirname(dependency), secret)]) {
    writeFileSync(dependency, `module.exports = require(${JSON.stringify(specifier)});`);
    const result = call(project, ["bundle", "--entry", "entry.ts", "--out", "out.mjs"], 3);
    assert.deepEqual(result.error, { code: "source_outside_root" });
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.equal(readFileSync(join(project, "out.mjs"), "utf8"), "previous requested output");
  }
}));

test("realpath guard rejects escaping source and package symlinks before source inclusion", () => temporary(directory => {
  const project = join(directory, "project");
  const outside = join(directory, "outside");
  mkdirSync(project); mkdirSync(outside);
  const secret = join(outside, "private.json");
  writeFileSync(secret, '{"greeting":"PRIVATE_SYMLINK_SECRET"}');
  symlinkSync(outside, join(project, "alias"), "dir");
  writeFileSync(join(project, "entry.js"), "import value from './alias/private.json'; export const result = value.greeting;");
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.js", "--out", "out.mjs"], 3).error, { code: "source_outside_root" });
  mkdirSync(join(project, "node_modules"));
  writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "tiny-local", main: "private.json" }));
  symlinkSync(outside, join(project, "node_modules/tiny-local"), "dir");
  writeFileSync(join(project, "entry.js"), "import value from 'tiny-local'; export const result = value.greeting;");
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.js", "--out", "out.mjs"], 3).error, { code: "source_outside_root" });
}));

test("onLoad containment rejects a local package main that resolves outside the chosen project", () => temporary(directory => {
  const project = join(directory, "project");
  mkdirSync(project);
  author(project);
  const secret = join(directory, "private.json");
  writeFileSync(secret, '{"greeting":"PACKAGE_MAIN_SECRET"}');
  const packageDirectory = join(project, "node_modules/tiny-local");
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "tiny-local", main: relative(packageDirectory, secret) }));
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.ts", "--out", "out.mjs"], 3).error, { code: "source_outside_root" });
}));

test("bare dependency resolution cannot fall back to parent node_modules without an explicit wider root", () => temporary(directory => {
  const project = join(directory, "project");
  mkdirSync(project);
  mkdirSync(join(directory, "node_modules/parent-only"), { recursive: true });
  writeFileSync(join(directory, "node_modules/parent-only/package.json"), JSON.stringify({ name: "parent-only", main: "index.js" }));
  writeFileSync(join(directory, "node_modules/parent-only/index.js"), "export const value = 'parent package';");
  writeFileSync(join(project, "entry.js"), "export { value } from 'parent-only';");
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.js", "--out", "out.mjs"], 3).error, { code: "dependency_not_local" });
  call(project, ["bundle", "--entry", "entry.js", "--out", "out.mjs", "--root", ".."]);
}));

test("filesystem-wide cwd needs an explicit root and outside entry files cannot bypass the project boundary", () => temporary(directory => {
  const project = join(directory, "project");
  mkdirSync(project);
  const entry = join(directory, "outside.js");
  writeFileSync(entry, "export function dispose() {}");
  assert.deepEqual(call(project, ["bundle", "--entry", entry, "--out", "out.mjs"], 3).error, { code: "source_outside_root" });
  assert.deepEqual(call("/", ["bundle", "--entry", entry, "--out", join(directory, "out.mjs")], 2).error, { code: "explicit_root_required" });
  call("/", ["bundle", "--entry", entry, "--out", join(directory, "out.mjs"), "--root", directory]);
}));

test("trusted cyclic fixture shares one entry module identity and live exported state", () => temporary(directory => {
  writeFileSync(join(directory, "plugin.js"), "import { read } from './helper.js'; export let value = 0; export function init() { value = 1; return read(); }\n");
  writeFileSync(join(directory, "helper.js"), "import { value } from './plugin.js'; export function read() { return value; }\n");
  call(directory, ["bundle", "--entry", "plugin.js", "--out", "trusted-cycle.mjs"]);
  // Only this fixed, repository-owned fixture is evaluated in an isolated Node process.
  // The CLI must still never evaluate arbitrary author source (tested separately).
  const evaluated = spawnSync(process.execPath, ["--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const module = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify({result: module.init(), value: module.value}));", join(directory, "trusted-cycle.mjs")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.deepEqual(JSON.parse(evaluated.stdout), { result: 1, value: 1 });
}));

test("canonical entry bytes are reused on cyclic imports instead of reading the entry twice", () => temporary(directory => {
  writeFileSync(join(directory, "plugin.js"), "import { read } from './helper.js'; export let value = 0; export function init() { value = 1; return read(); }\n");
  writeFileSync(join(directory, "helper.js"), "import { value } from './plugin.js'; export function read() { return value; }\n");
  const entry = join(directory, "plugin.js");
  const marker = join(directory, "entry-read-count");
  writeFileSync(join(directory, "read-monitor.cjs"), `
const fs = require('node:fs'); const fsp = require('node:fs/promises');
const originalOpen = fsp.open;
fsp.open = async function(path, ...args) {
  const handle = await originalOpen(path, ...args);
  if (String(path) === ${JSON.stringify(entry)}) {
    const originalRead = handle.read.bind(handle); let counted = false;
    handle.read = async function(...args) {
      if (!counted) { counted = true; const file = ${JSON.stringify(marker)}; const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0; fs.writeFileSync(file, String(count + 1)); }
      return originalRead(...args);
    };
  }
  return handle;
}; require('node:module').syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--require", join(directory, "read-monitor.cjs"), cli, "bundle", "--entry", "plugin.js", "--out", "out.mjs"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "1");
}));

test("aggregate graph quota rejects the next source before reading it, including concurrent onLoad callbacks", () => temporary(directory => {
  let entry = "";
  for (let i = 0; i < 8; i++) {
    const suffix = `*/export const value = ${i};\n`;
    writeFileSync(join(directory, `large-${i}.js`), "/*" + "x".repeat(ROOM_PLUGIN_LIMITS.artifactBytes - 2 - suffix.length) + suffix);
    entry += `export { value as v${i} } from './large-${i}.js';\n`;
  }
  writeFileSync(join(directory, "entry.js"), entry);
  const marker = join(directory, "large-source-read-count");
  writeFileSync(join(directory, "read-monitor.cjs"), `
const fs = require('node:fs'); const fsp = require('node:fs/promises'); const {basename} = require('node:path');
const originalOpen = fsp.open; let count = 0;
fsp.open = async function(path, ...args) {
  const handle = await originalOpen(path, ...args);
  if (/^large-\\d+\\.js$/.test(basename(String(path)))) {
    const originalRead = handle.read.bind(handle); let counted = false;
    handle.read = async function(...args) {
      if (!counted) { counted = true; fs.writeFileSync(${JSON.stringify(marker)}, String(++count)); }
      return originalRead(...args);
    };
  }
  return handle;
}; require('node:module').syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--require", join(directory, "read-monitor.cjs"), cli, "bundle", "--entry", "entry.js", "--out", "out.mjs"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).error, { code: "source_graph_too_large" });
  assert.equal(readFileSync(marker, "utf8"), "7", "the 8th MiB source does not fit after entry bytes and must not be materialized");
}));

test("trusted mixed ESM/CJS fixture selects dual exports by import kind and preserves SDK CommonJS namespace", () => temporary(directory => {
  const dependency = join(directory, "node_modules/dual");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "dual", type: "module", exports: {
    module: "./unsupported.js", browser: "./unsupported.js", node: "./unsupported.js",
    import: "./import.js", require: "./require.cjs", default: "./unsupported.js"
  } }));
  writeFileSync(join(dependency, "import.js"), "export default function() { return 'esm import'; }\n");
  writeFileSync(join(dependency, "require.cjs"), "module.exports = function() { return 'cjs require'; };\n");
  writeFileSync(join(dependency, "unsupported.js"), "throw new Error('custom condition must not be selected');\n");
  const sdk = join(directory, "node_modules/@vrata/room-plugin-sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), readFileSync(join(root, "package.json")));
  cpSync(join(root, "dist/commonjs"), join(sdk, "dist/commonjs"), { recursive: true });
  for (const name of ["index", "contracts", "config", "data", "errors", "messages", "text"]) {
    writeFileSync(join(sdk, `dist/${name}.js`), readFileSync(join(root, `dist/${name}.js`)));
  }
  writeFileSync(join(directory, "helper.cjs"), "const dual = require('dual'); const sdk = require('@vrata/room-plugin-sdk'); module.exports = () => ({ required: dual(), sdkFunction: typeof sdk.validateRoomPluginData, sdkLimit: sdk.ROOM_PLUGIN_LIMITS.artifactBytes });\n");
  writeFileSync(join(directory, "plugin.js"), "import dual from 'dual'; import helper from './helper.cjs'; export function init() { return { imported: dual(), ...helper() }; }\n");
  call(directory, ["bundle", "--entry", "plugin.js", "--out", "trusted-mixed.mjs"]);
  // Only this fixed trusted fixture is evaluated; CLI compilation remains non-executing.
  const evaluated = spawnSync(process.execPath, ["--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const module = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify(module.init()));", join(directory, "trusted-mixed.mjs")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.deepEqual(JSON.parse(evaluated.stdout), { imported: "esm import", required: "cjs require", sdkFunction: "function", sdkLimit: 1048576 });
}));

test("trusted legacy dual package keeps module named exports for import and main callable for require", () => temporary(directory => {
  const dependency = join(directory, "node_modules/legacy-dual");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "legacy-dual", type: "module", main: "./main.cjs", module: "./module.js" }));
  writeFileSync(join(dependency, "main.cjs"), "module.exports = function() { return 'legacy require main'; };\n");
  writeFileSync(join(dependency, "module.js"), "export default function() { return 'legacy import module'; } export function named() { return 'named module export'; }\n");
  writeFileSync(join(directory, "helper.cjs"), "const dual = require('legacy-dual'); module.exports = () => dual();\n");
  writeFileSync(join(directory, "plugin.js"), "import dual, { named } from 'legacy-dual'; import helper from './helper.cjs'; export function init() { return { imported: dual(), named: named(), required: helper() }; }\n");
  call(directory, ["bundle", "--entry", "plugin.js", "--out", "trusted-legacy.mjs"]);
  const evaluated = spawnSync(process.execPath, ["--input-type=module", "-e", "import {pathToFileURL} from 'node:url'; const module = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify(module.init()));", join(directory, "trusted-legacy.mjs")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.deepEqual(JSON.parse(evaluated.stdout), { imported: "legacy import module", named: "named module export", required: "legacy require main" });
}));

test("trusted package matrix preserves main-only, module-only, scoped roots/subpaths and conditional exports", () => temporary(directory => {
  function pkg(name: string, fields: Record<string, unknown>, files: Record<string, string>): void {
    const folder = join(directory, "node_modules", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name, type: "module", ...fields }));
    for (const [file, code] of Object.entries(files)) writeFileSync(join(folder, file), code);
  }
  pkg("main-only", { main: "./main.cjs" }, { "main.cjs": "module.exports=()=> 'main-only';" });
  pkg("module-only", { module: "./module.js" }, { "module.js": "export const named=()=> 'module-only';" });
  pkg("@scope/legacy", { main: "./main.cjs", module: "./module.js" }, {
    "main.cjs": "module.exports=()=> 'scoped main';", "module.js": "export const named=()=> 'scoped module';",
    "sub.cjs": "module.exports=()=> 'scoped subpath';"
  });
  pkg("legacy-subpath", { main: "./main.cjs", module: "./module.js" }, {
    "main.cjs": "throw new Error('root must not replace subpath');", "module.js": "throw new Error('root must not replace subpath');",
    "sub.cjs": "module.exports=()=> 'unscoped subpath';"
  });
  pkg("exported", { main: "./wrong.cjs", module: "./wrong.cjs", exports: {
    ".": { import: "./import.js", require: "./require.cjs" },
    "./sub": { import: "./import-sub.js", require: "./require-sub.cjs" }
  } }, {
    "wrong.cjs": "throw new Error('exports must override legacy fields');",
    "import.js": "export const named=()=> 'export import';", "require.cjs": "module.exports=()=> 'export require';",
    "import-sub.js": "export const named=()=> 'export sub import';", "require-sub.cjs": "module.exports=()=> 'export sub require';"
  });
  writeFileSync(join(directory, "helper.cjs"), "module.exports=()=>({main:require('main-only')(),module:require('module-only').named(),scoped:require('@scope/legacy')(),scopedSub:require('@scope/legacy/sub.cjs')(),sub:require('legacy-subpath/sub.cjs')(),exported:require('exported')(),exportSub:require('exported/sub')()});");
  writeFileSync(join(directory, "plugin.js"), "import main from 'main-only';import {named as mod} from 'module-only';import {named as scoped} from '@scope/legacy';import {named as exported} from 'exported';import {named as exportSub} from 'exported/sub';import helper from './helper.cjs';export function init(){return {imported:{main:main(),module:mod(),scoped:scoped(),exported:exported(),exportSub:exportSub()},required:helper()};}");
  call(directory, ["bundle", "--entry", "plugin.js", "--out", "trusted-matrix.mjs"]);
  const evaluated = spawnSync(process.execPath, ["--input-type=module", "-e", "import {pathToFileURL} from 'node:url';const module=await import(pathToFileURL(process.argv[1]).href);process.stdout.write(JSON.stringify(module.init()));", join(directory, "trusted-matrix.mjs")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.deepEqual(JSON.parse(evaluated.stdout), {
    imported: { main: "main-only", module: "module-only", scoped: "scoped module", exported: "export import", exportSub: "export sub import" },
    required: { main: "main-only", module: "module-only", scoped: "scoped main", scopedSub: "scoped subpath", sub: "unscoped subpath", exported: "export require", exportSub: "export sub require" }
  });
}));

test("legacy require main override retains canonical root and bounded metadata guards", () => temporary(directory => {
  const project = join(directory, "project");
  const dependency = join(project, "node_modules/legacy");
  mkdirSync(dependency, { recursive: true });
  const outside = join(directory, "secret.cjs");
  writeFileSync(outside, "module.exports=()=> 'PRIVATE_LEGACY_MAIN';");
  writeFileSync(join(dependency, "module.js"), "export default ()=> 'allowed module';");
  writeFileSync(join(project, "entry.cjs"), "module.exports=require('legacy');");
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "legacy", main: outside, module: "./module.js" }));
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.cjs", "--out", "out.mjs"], 3).error, { code: "source_outside_root" });
  symlinkSync(outside, join(dependency, "alias.cjs"));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "legacy", main: "./alias.cjs", module: "./module.js" }));
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.cjs", "--out", "out.mjs"], 3).error, { code: "source_outside_root" });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "legacy", main: "./inside.cjs", module: "./module.js", oversized: "x".repeat(32 * 1024) }));
  assert.deepEqual(call(project, ["bundle", "--entry", "entry.cjs", "--out", "out.mjs"], 3).error, { code: "package_manifest_too_large" });
}));
