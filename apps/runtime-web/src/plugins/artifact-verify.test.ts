import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { verifyRoomPluginArtifact } from "./artifact-verify.js";
import { roomPluginContentPath, type RoomPluginRuntimeBinding } from "./runtime-dto.js";

const built = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "external.status", version: "1.0.0", displayName: "External status",
  requestedCapabilities: ["status.set"], configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 32 } } },
  "globalThis.mustNotExecute = true; export function init() {} // Привет ☕\r\n");
const binding = (): RoomPluginRuntimeBinding => ({ bindingId: "11111111-1111-4111-8111-111111111111", packageId: "22222222-2222-4222-8222-222222222222",
  pluginId: built.artifact.manifest.id, version: "1.0.0", artifactSha256: built.artifactSha256, enabled: true, generation: 1, bindingRevision: 1,
  config: { greeting: "<b>literal</b>" }, approvedCapabilities: ["status.set"], contentUrl: roomPluginContentPath("room", "22222222-2222-4222-8222-222222222222") });
test("browser verification checks both exact hashes and manifest/config agreement without executing entry", async () => {
  const verified = await verifyRoomPluginArtifact(built.bytes, binding());
  assert.equal(verified.artifact.entry, built.artifact.entry);
  assert.equal(verified.config.greeting, "<b>literal</b>");
  assert.equal((globalThis as Record<string, unknown>).mustNotExecute, undefined);
});
test("browser verification rejects altered artifact bytes and forged decoded entry checksums", async () => {
  const changed = new Uint8Array([...built.bytes, 32]);
  await assert.rejects(verifyRoomPluginArtifact(changed, binding()), { code: "integrity-failed" });
  const envelope = JSON.parse(new TextDecoder().decode(built.bytes)); envelope.entry += " ";
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await assert.rejects(verifyRoomPluginArtifact(bytes, { ...binding(), artifactSha256: createHash("sha256").update(bytes).digest("hex") }), { code: "integrity-failed" });
});
test("truncated transfers fail integrity first and owned hashing covers only a nonzero-offset view", async () => {
  await assert.rejects(verifyRoomPluginArtifact(built.bytes.slice(0, -8), binding()), { code: "integrity-failed" });
  const padded = new Uint8Array(built.bytes.byteLength + 8); padded.set(built.bytes, 4);
  const view = padded.subarray(4, 4 + built.bytes.byteLength);
  const verifying = verifyRoomPluginArtifact(view, binding()); view.fill(0);
  assert.equal((await verifying).artifact.entry, built.artifact.entry, "caller mutation during digest cannot change verified bytes");
});
test("browser verification rejects mismatched package identity, approvals and manifest config", async () => {
  const patches: Array<Partial<RoomPluginRuntimeBinding>> = [{ pluginId: "other.plugin" }, { version: "2.0.0" }, { approvedCapabilities: ["seating.claimSelfOnEntry"] },
    { config: { greeting: false } }, { config: { unknown: "value" } }];
  for (const patch of patches) {
    await assert.rejects(verifyRoomPluginArtifact(built.bytes, { ...binding(), ...patch }), { code: "invalid-artifact" });
  }
});
test("insecure hosts fail closed instead of using an unverified hashing fallback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try { await assert.rejects(verifyRoomPluginArtifact(built.bytes, binding()), { code: "insecure-context" }); }
  finally { if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else Reflect.deleteProperty(globalThis, "crypto"); }
});
