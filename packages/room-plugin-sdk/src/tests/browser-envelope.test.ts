import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRoomPluginArtifact, validateRoomPluginArtifact } from "../artifact.js";
import { parseRoomPluginArtifactEnvelope, validateRoomPluginManifest, ROOM_PLUGIN_LIMITS } from "../index.js";

const manifest = { schemaVersion: 1, sdkApiVersion: 1, id: "external.status", version: "1.0.0", displayName: "External status",
  requestedCapabilities: ["status.set"], configSchema: {} } as const;
const entry = "export function init(context) { return context.sdk.status.set('Привет ☕'); }\r\n";

test("browser-safe envelope parsing shares manifest validation and owns exact input bytes", () => {
  const built = createRoomPluginArtifact(manifest, entry);
  const bytes = new TextEncoder().encode(" \n" + new TextDecoder().decode(built.bytes) + "\n ");
  const parsed = parseRoomPluginArtifactEnvelope(bytes);
  const checked = validateRoomPluginArtifact(bytes);
  assert.deepEqual(parsed.artifact, checked.artifact);
  assert.equal(parsed.byteLength, bytes.byteLength);
  assert.equal(parsed.entryByteLength, new TextEncoder().encode(entry).byteLength);
  assert.deepEqual(parsed.entryBytes, new TextEncoder().encode(entry));
  assert.deepEqual(validateRoomPluginManifest(parsed.artifact.manifest), parsed.artifact.manifest);
  const copy = parsed.bytes.slice();
  bytes.fill(0);
  assert.deepEqual(parsed.bytes, copy);
  assert.ok(Object.isFrozen(parsed.artifact));
});

test("browser envelope rejects unbounded, duplicate, polluted and unsupported JSON before execution", () => {
  for (const [bytes, code] of [
    [new Uint8Array(ROOM_PLUGIN_LIMITS.artifactBytes + 1), "artifact_too_large"],
    [new Uint8Array([0xc3, 0x28]), "invalid_utf8"],
    ['{"manifest":{},"manifest":{}}', "duplicate_field"],
    ['{"__proto__":{}}', "unsafe_key"],
    [JSON.stringify({ ...JSON.parse(new TextDecoder().decode(createRoomPluginArtifact(manifest, entry).bytes)), entryUrl: "https://example.invalid" }), "unknown_field"]
  ] as const) assert.throws(() => parseRoomPluginArtifactEnvelope(bytes), { code });
  const source = "globalThis.externalPluginExecuted = true; export function init() {}";
  parseRoomPluginArtifactEnvelope(createRoomPluginArtifact(manifest, source).bytes);
  assert.equal((globalThis as Record<string, unknown>).externalPluginExecuted, undefined);
});

test("public browser contracts and envelope parser bundle without Node packaging or crypto imports", async () => {
  const result = await build({ entryPoints: [new URL("../index.js", import.meta.url).pathname], bundle: true,
    platform: "browser", format: "esm", write: false, metafile: true });
  assert.ok(result.outputFiles[0].text.includes("parseRoomPluginArtifactEnvelope"));
  assert.ok(Object.keys(result.metafile!.inputs).every(path => !/artifact\.js$|acorn|esbuild/.test(path)));
});
