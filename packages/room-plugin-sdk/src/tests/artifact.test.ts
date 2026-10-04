import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "acorn";
import { createRoomPluginArtifact, validateRoomPluginArtifact, validateRoomPluginModule } from "../artifact.js";
import { ROOM_PLUGIN_LIMITS, type RoomPluginManifest } from "../contracts.js";
import { RoomPluginValidationError, type RoomPluginValidationErrorCode } from "../errors.js";

const entry = "export function init(context) { return context.sdk.status.set('Welcome'); }\n";
const manifest: Omit<RoomPluginManifest, "entrySha256"> = {
  schemaVersion: 1, sdkApiVersion: 1, id: "welcome-status", version: "1.0.0", displayName: "Welcome status",
  requestedCapabilities: ["status.set"],
  configSchema: { greeting: { type: "string", required: false, minLength: 1, maxLength: 256 } }
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function raw(source = entry): Record<string, any> {
  return { manifest: { ...manifest, entrySha256: sha(source) }, entry: source };
}
function error(action: () => unknown, code: RoomPluginValidationErrorCode): void {
  assert.throws(action, (cause: unknown) => cause instanceof RoomPluginValidationError && cause.code === code);
}
function invalid(change: (value: Record<string, any>) => void, code: RoomPluginValidationErrorCode): void {
  const value = raw();
  change(value);
  error(() => validateRoomPluginArtifact(JSON.stringify(value)), code);
}

test("exact upload bytes and decoded UTF-8 entry have independent checksums", () => {
  const source = entry + "// Привет ☕\r\n";
  const text = "\n " + JSON.stringify(raw(source), null, 2) + " \n";
  const bytes = Buffer.from(text);
  const checked = validateRoomPluginArtifact(bytes, sha(bytes));
  assert.equal(checked.artifactSha256, sha(bytes));
  assert.equal(checked.entrySha256, sha(Buffer.from(source)));
  assert.equal(checked.byteLength, bytes.length);
  assert.equal(checked.entryByteLength, Buffer.byteLength(source));
  assert.equal(Buffer.from(checked.bytes).toString(), text);
  assert.ok(Object.isFrozen(checked.artifact.manifest.configSchema.greeting));
  bytes.fill(0);
  assert.equal(Buffer.from(checked.bytes).toString(), text, "input buffer ownership must not leak");
  error(() => validateRoomPluginArtifact(JSON.stringify(raw(source)), checked.artifactSha256), "artifact_checksum_mismatch");
});

test("packaging is deterministic across config and manifest property order", () => {
  const schema = { z: { type: "boolean", required: false }, a: { type: "boolean", required: true } } as const;
  const first = createRoomPluginArtifact({ ...manifest, configSchema: schema }, entry);
  const second = createRoomPluginArtifact({
    configSchema: { a: schema.a, z: schema.z }, requestedCapabilities: manifest.requestedCapabilities,
    displayName: manifest.displayName, version: manifest.version, id: manifest.id, sdkApiVersion: 1, schemaVersion: 1
  }, entry);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.artifactSha256, second.artifactSha256);
});

test("standalone welcome-status source builds without runtime imports", () => {
  const source = readFileSync(new URL("../../examples/welcome-status/entry.js", import.meta.url), "utf8");
  const artifact = createRoomPluginArtifact(manifest, source);
  assert.equal(validateRoomPluginArtifact(artifact.bytes).artifact.manifest.id, "welcome-status");
  assert.equal(artifact.artifact.manifest.requestedCapabilities.join(), "status.set");
  const fixture = readFileSync(new URL("../../examples/welcome-status/welcome-status.vrata-plugin.json", import.meta.url));
  assert.equal(validateRoomPluginArtifact(fixture).artifactSha256, artifact.artifactSha256);
  assert.deepEqual(new Uint8Array(fixture), artifact.bytes);
  const module = parse(artifact.artifact.entry, { ecmaVersion: 2020, sourceType: "module" });
  const functions = module.body.filter(node => node.type === "ExportNamedDeclaration")
    .map(node => node.declaration)
    .filter(node => node?.type === "FunctionDeclaration")
    .map(node => ({ name: node.id!.name, args: node.params.map(param => param.type === "Identifier" ? param.name : "other") }));
  assert.deepEqual(functions, [
    { name: "init", args: ["context"] },
    { name: "onEvent", args: ["event", "context"] },
    { name: "dispose", args: [] }
  ]);
});

test("reject unsupported versions, null containers, unknown fields and non-release IDs", () => {
  invalid(v => { v.manifest.schemaVersion = 2; }, "unsupported_schema_version");
  invalid(v => { v.manifest.sdkApiVersion = "1"; }, "unsupported_sdk_api_version");
  invalid(v => { v.manifest = null; }, "invalid_manifest");
  invalid(v => { v.entryUrl = "https://example.invalid/plugin.js"; }, "unknown_field");
  invalid(v => { v.manifest.scripts = { install: "run" }; }, "unknown_field");
  invalid(v => { delete v.manifest.id; }, "missing_field");
  for (const id of ["../plugin", "https://example.com", "UPPER", "a--b", "a".repeat(65)]) {
    invalid(v => { v.manifest.id = id; }, "invalid_manifest");
  }
  for (const version of ["latest", "1", "01.0.0", "1.0.0-beta", "1.0.0+build"]) {
    invalid(v => { v.manifest.version = version; }, "invalid_manifest");
  }
  invalid(v => { v.manifest.displayName = "\nInjected status"; }, "invalid_manifest");
});

test("unknown and repeated capabilities cannot be smuggled through nested objects", () => {
  for (const capabilities of [["network.fetch"], [["status.set"]], { "status.set": true }, null, [null]]) {
    invalid(v => { v.manifest.requestedCapabilities = capabilities; }, "unknown_capability");
  }
  invalid(v => { v.manifest.requestedCapabilities = ["status.set", "status.set"]; }, "duplicate_capability");
  const value = raw();
  value.manifest.requestedCapabilities = [];
  assert.deepEqual([...validateRoomPluginArtifact(JSON.stringify(value)).artifact.manifest.requestedCapabilities], []);
});

test("hash formats, entry byte changes and full envelope changes are rejected", () => {
  for (const hash of [null, "0".repeat(63), "G".repeat(64), "SHA256:" + sha(entry), sha(entry).toUpperCase()]) {
    invalid(v => { v.manifest.entrySha256 = hash; }, "invalid_hash");
  }
  invalid(v => { v.entry += " "; }, "entry_checksum_mismatch");
  const checked = createRoomPluginArtifact(manifest, entry);
  error(() => validateRoomPluginArtifact(checked.bytes, "0".repeat(64)), "artifact_checksum_mismatch");
  error(() => validateRoomPluginArtifact(checked.bytes, "not-a-hash"), "invalid_hash");
});

test("byte limit is enforced before JSON.parse for both bytes and UTF-8 strings", () => {
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { calls++; return parse(...args); }) as typeof JSON.parse;
  try {
    error(() => validateRoomPluginArtifact(new Uint8Array(ROOM_PLUGIN_LIMITS.artifactBytes + 1)), "artifact_too_large");
    error(() => validateRoomPluginArtifact("é".repeat(ROOM_PLUGIN_LIMITS.artifactBytes / 2 + 1)), "artifact_too_large");
    assert.equal(calls, 0);
  } finally { JSON.parse = parse; }
});

test("inclusive 1 MiB artifact boundary counts exact serialized bytes", () => {
  const text = JSON.stringify(raw());
  const exact = text + " ".repeat(ROOM_PLUGIN_LIMITS.artifactBytes - Buffer.byteLength(text));
  assert.equal(validateRoomPluginArtifact(exact).byteLength, ROOM_PLUGIN_LIMITS.artifactBytes);
  error(() => validateRoomPluginArtifact(exact + " "), "artifact_too_large");
  error(() => createRoomPluginArtifact(manifest, "//" + "\\".repeat(600_000)), "artifact_too_large");
});

test("invalid UTF-8, unpaired surrogates, BOM, duplicate and pollution keys fail closed", () => {
  error(() => validateRoomPluginArtifact(new Uint8Array([0xc3, 0x28])), "invalid_utf8");
  error(() => validateRoomPluginArtifact("\ud800"), "invalid_utf8");
  error(() => validateRoomPluginArtifact("\ufeff" + JSON.stringify(raw())), "invalid_json");
  error(() => validateRoomPluginArtifact('{"manifest":{},"manifest":{}}'), "duplicate_field");
  error(() => validateRoomPluginArtifact('{"manifest":{},"\\u006danifest":{}}'), "duplicate_field");
  for (const key of ["__proto__", "constructor", "prototype"]) {
    error(() => validateRoomPluginArtifact(`{"${key}":{"polluted":true}}`), "unsafe_key");
  }
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  invalid(v => { v.entry = "\ud800"; }, "invalid_utf8");
});

test("100,000 levels of JSON nesting fail before parse, not by stack exhaustion", () => {
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { calls++; return parse(...args); }) as typeof JSON.parse;
  try {
    error(() => validateRoomPluginArtifact("[".repeat(100_000) + "0" + "]".repeat(100_000)), "nesting_too_deep");
    assert.equal(calls, 0);
  } finally { JSON.parse = parse; }
});

for (const source of [
  'import "https://example.invalid/x.js";',
  'import { x } from "./other.js";',
  'export * from "other";',
  'export { value } from "other";',
  'function later() { return import /* split */ ("other"); }',
  'const load = () => import(`https://${"example.invalid"}/x.js`);',
  'export function onEvent() { return import.meta.url; }'
]) {
  test(`AST rejects import syntax: ${source}`, () => {
    error(() => validateRoomPluginArtifact(JSON.stringify(raw(source))), "module_import_forbidden");
  });
}

test("parser does not mistake import-like text in comments, regexes or strings for imports", () => {
  validateRoomPluginModule('/* import "remote" */ export const text = "import(\\\"remote\\\")"; const pattern = /import\\(/;');
  validateRoomPluginModule('export { init }; function init() {}');
});

test("invalid JS/TypeScript/newer syntax is rejected without executing source", () => {
  for (const source of ["", "export const a = ;", "export const a: number = 1;", "class A { field = 1; }", "await 1;"]) {
    error(() => validateRoomPluginArtifact(JSON.stringify(raw(source))), "invalid_module");
  }
  const probe = "globalThis.roomPluginExecuted = true; export function init() { throw 'must never execute'; }";
  validateRoomPluginArtifact(JSON.stringify(raw(probe)));
  assert.equal((globalThis as Record<string, unknown>).roomPluginExecuted, undefined);
});
