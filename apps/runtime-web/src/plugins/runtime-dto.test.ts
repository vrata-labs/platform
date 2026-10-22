import test from "node:test";
import assert from "node:assert/strict";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, ROOM_PLUGIN_RUNTIME_CONFIG_BYTES } from "./runtime-dto.js";

const roomId = "private room/with-boundary";
const bindingId = "11111111-1111-4111-8111-111111111111", packageId = "22222222-2222-4222-8222-222222222222";
const binding = () => ({ bindingId, packageId, pluginId: "external.status", version: "1.0.0", artifactSha256: "a".repeat(64),
  enabled: true, generation: 3, bindingRevision: 3, config: { greeting: "<b>literal</b>" }, approvedCapabilities: ["status.set"], contentUrl: roomPluginContentPath(roomId, packageId) });
const snapshot = () => ({ schemaVersion: 1, sdkApiVersion: 1, revision: 3, leaseExpiresAtMs: 1, bindings: [binding()] });
test("runtime DTO accepts empty discovery and freezes host-only bindings without comparing wall clocks", () => {
  const parsed = parseRoomPluginRuntimeSnapshot(JSON.stringify(snapshot()), roomId);
  assert.equal(parsed.bindings[0].contentUrl, "/api/rooms/private%20room%2Fwith-boundary/plugins/packages/22222222-2222-4222-8222-222222222222/content");
  assert.equal(parsed.leaseExpiresAtMs, 1, "epoch expiry is not a client wall-clock authority check");
  assert.ok(Object.isFrozen(parsed.bindings)); assert.ok(Object.isFrozen(parsed.bindings[0].config));
  assert.equal(parseRoomPluginRuntimeSnapshot(JSON.stringify({ ...snapshot(), revision: 0, bindings: [] }), roomId).bindings.length, 0);
});
test("runtime DTO rejects malformed identities, capabilities, inactive bindings and arbitrary content URLs", () => {
  for (const patch of [{ enabled: false }, { contentUrl: "https://example.invalid/content" }, { contentUrl: "/api/rooms/other/plugins/packages/x/content" },
    { bindingId: "native-session" }, { packageId: "../escape" }, { pluginId: "Upper" }, { version: "latest" },
    { artifactSha256: "x".repeat(64) }, { generation: -1 }, { bindingRevision: 4 }, { approvedCapabilities: ["network.fetch"] },
    { config: { nested: {} } }, { privateCredential: "must not escape" }] as const) {
    assert.throws(() => parseRoomPluginRuntimeSnapshot(JSON.stringify({ ...snapshot(), bindings: [{ ...binding(), ...patch }] }), roomId), { code: "invalid-runtime-config" });
  }
});
test("runtime DTO rejects duplicate and oversized catalogs, root extras and duplicate JSON keys", () => {
  for (const value of [{ ...snapshot(), bindings: [binding(), binding()] }, { ...snapshot(), bindings: [binding(), binding(), binding()] },
    { ...snapshot(), revision: -1 }, { ...snapshot(), schemaVersion: 2 }, { ...snapshot(), leaseExpiresAtMs: 0 },
    { ...snapshot(), extra: true }]) assert.throws(() => parseRoomPluginRuntimeSnapshot(JSON.stringify(value), roomId), { code: "invalid-runtime-config" });
  assert.throws(() => parseRoomPluginRuntimeSnapshot(new Uint8Array(ROOM_PLUGIN_RUNTIME_CONFIG_BYTES + 1), roomId), { code: "invalid-runtime-config" });
  assert.throws(() => parseRoomPluginRuntimeSnapshot('{"revision":0,"revision":1}', roomId), { code: "invalid-runtime-config" });
});
test("binding, package and plugin identity are independently unique; generation remains opaque", () => {
  const other = { ...binding(), bindingId: "33333333-3333-4333-8333-333333333333", packageId: "44444444-4444-4444-8444-444444444444",
    pluginId: "external.other", contentUrl: roomPluginContentPath(roomId, "44444444-4444-4444-8444-444444444444") };
  for (const field of ["bindingId", "packageId", "pluginId"] as const) {
    const duplicate = { ...other, [field]: binding()[field] };
    if (field === "packageId") duplicate.contentUrl = binding().contentUrl;
    assert.throws(() => parseRoomPluginRuntimeSnapshot(JSON.stringify({ ...snapshot(), bindings: [binding(), duplicate] }), roomId), { code: "invalid-runtime-config" });
  }
  assert.equal(parseRoomPluginRuntimeSnapshot(JSON.stringify({ ...snapshot(), bindings: [{ ...binding(), generation: 999 }] }), roomId).bindings[0].generation, 999);
});
