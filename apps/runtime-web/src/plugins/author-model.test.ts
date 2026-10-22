import test from "node:test";
import assert from "node:assert/strict";
import type { RoomPluginCapability, RoomPluginManifest } from "@vrata/room-plugin-sdk";
import type { RoomPluginAuthorBinding, RoomPluginAuthorLibrary, RoomPluginAuthorPackage } from "./author-http.js";
import { initialRoomPluginApproval, initialRoomPluginConfigForm, planRoomPluginAuthorAction, readRoomPluginConfigForm,
  roomPluginAuthorEntries, roomPluginAuthorMessage, roomPluginPackageSelectable, roomPluginPackageUsable } from "./author-model.js";

const schema = { greeting: { type: "string", required: true, minLength: 1, maxLength: 32 },
  count: { type: "number", required: false, minimum: 1, maximum: 8 }, loud: { type: "boolean", required: false },
  tone: { type: "enum", required: false, values: ["calm", "warm"] } } as const;
let next = 0;
function pkg(pluginId: string, version: string, capabilities: RoomPluginCapability[] = ["status.set"], state: RoomPluginAuthorPackage["state"] = "ready"): RoomPluginAuthorPackage {
  const id = String(++next).padStart(12, "0");
  const manifest: RoomPluginManifest = { schemaVersion: 1, sdkApiVersion: 1, id: pluginId, version, displayName: `${pluginId} name`,
    requestedCapabilities: capabilities, configSchema: schema, entrySha256: "e".repeat(64) };
  return { packageId: `00000000-0000-4000-8000-${id}`, pluginId, version, artifactSha256: id.padStart(64, "a"), byteLength: 10, manifest, state, uploadSettled: state === "ready" };
}
const bound = (value: RoomPluginAuthorPackage, enabled = true, approved: RoomPluginCapability[] = ["status.set"]): RoomPluginAuthorBinding => ({
  packageId: value.packageId, pluginId: value.pluginId, version: value.version, artifactSha256: value.artifactSha256,
  enabled, bindingRevision: 1, config: { greeting: "hello", count: 2 }, approvedCapabilities: approved });

test("entries group exact versions newest first and keep the bound package name", () => {
  const old = pkg("external.welcome", "1.2.0"), newer = pkg("external.welcome", "1.10.0"), other = pkg("external.second", "0.1.0");
  const entries = roomPluginAuthorEntries({ revision: 3, packages: [old, other, newer], bindings: [bound(old)] });
  assert.deepEqual(entries.map(entry => entry.pluginId), ["external.second", "external.welcome"]);
  assert.deepEqual(entries[1].versions.map(value => value.version), ["1.10.0", "1.2.0"]);
  assert.equal(entries[1].binding?.packageId, old.packageId); assert.equal(entries[0].binding, null);
});

test("approval starts unchecked for a first install and for capabilities gained by another version", () => {
  const first = pkg("external.seat", "1.0.0"), gained = pkg("external.seat", "1.1.0", ["status.set", "seating.claimSelfOnEntry"]);
  const library = { revision: 1, packages: [first, gained], bindings: [] };
  assert.deepEqual(initialRoomPluginApproval(roomPluginAuthorEntries(library)[0], first), []);
  const entry = roomPluginAuthorEntries({ ...library, bindings: [bound(first)] })[0];
  assert.deepEqual(initialRoomPluginApproval(entry, gained), ["status.set"]);
});

test("config form uses typed values, omits empty optional fields and never coerces invalid numbers", () => {
  const value = pkg("external.form", "1.0.0"), entry = roomPluginAuthorEntries({ revision: 1, packages: [value], bindings: [bound(value)] })[0];
  assert.deepEqual(initialRoomPluginConfigForm(entry, schema), { greeting: "hello", count: "2", loud: false, tone: "" });
  assert.deepEqual(readRoomPluginConfigForm(schema, { greeting: " hi ", count: " 3 ", loud: true, tone: "" }), { greeting: " hi ", count: 3, loud: true });
  assert.deepEqual(readRoomPluginConfigForm(schema, { greeting: "", count: "abc" }), { greeting: "", count: "abc" });
  const library = { revision: 1, packages: [value], bindings: [] };
  for (const config of [{ greeting: "", count: 3 }, { greeting: "x", count: "abc" }, { greeting: "x", count: 99 }]) {
    assert.deepEqual(planRoomPluginAuthorAction(library, { type: "enable", pluginId: value.pluginId, packageId: value.packageId, approved: ["status.set"], config }),
      { ok: false, reason: "config-invalid" });
  }
});

test("enable always sends explicit approval for the exact artifact and the current room revision", () => {
  const value = pkg("external.enable", "1.0.0", ["status.set", "seating.claimSelfOnEntry"]);
  const library: RoomPluginAuthorLibrary = { revision: 7, packages: [value], bindings: [] };
  const plan = planRoomPluginAuthorAction(library, { type: "enable", pluginId: value.pluginId, packageId: value.packageId,
    approved: ["status.set", "status.set"], config: { greeting: "hi" } });
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), { ok: true, operation: "bind", pluginId: value.pluginId, expectedRevision: 7, approval: ["status.set"],
    write: { packageId: value.packageId, version: "1.0.0", artifactSha256: value.artifactSha256, enabled: true, config: { greeting: "hi" }, approvedCapabilities: ["status.set"] } });
  assert.deepEqual(planRoomPluginAuthorAction(library, { type: "enable", pluginId: value.pluginId, packageId: value.packageId,
    approved: ["seating.cancelPendingOwnClaim"], config: { greeting: "hi" } }), { ok: false, reason: "capability-unknown" });
  assert.deepEqual(planRoomPluginAuthorAction(library, { type: "enable", pluginId: "external.other", packageId: value.packageId,
    approved: [], config: { greeting: "hi" } }), { ok: false, reason: "stale" });
});

test("pending uploads, the enabled quota, bound deletion and enabled unbind are refused before any request", () => {
  const pending = pkg("external.pending", "1.0.0", ["status.set"], "reserved");
  const a = pkg("external.a", "1.0.0"), b = pkg("external.b", "1.0.0"), c = pkg("external.c", "1.0.0");
  const library: RoomPluginAuthorLibrary = { revision: 2, packages: [pending, a, b, c], bindings: [bound(a), bound(b)] };
  const enable = (value: RoomPluginAuthorPackage) => planRoomPluginAuthorAction(library, { type: "enable", pluginId: value.pluginId,
    packageId: value.packageId, approved: [], config: { greeting: "x" } });
  assert.deepEqual(enable(pending), { ok: false, reason: "not-ready" });
  assert.deepEqual(enable(c), { ok: false, reason: "quota" });
  assert.equal(enable(a).ok, true, "an already enabled behavior may switch version or settings");
  assert.deepEqual(planRoomPluginAuthorAction(library, { type: "delete", packageId: a.packageId }), { ok: false, reason: "bound" });
  assert.deepEqual(planRoomPluginAuthorAction(library, { type: "delete", packageId: c.packageId }), { ok: true, operation: "delete", packageId: c.packageId });
  assert.deepEqual(planRoomPluginAuthorAction(library, { type: "unbind", pluginId: a.pluginId }), { ok: false, reason: "enabled" });
  // A version left half-deleted by a storage failure can be deleted again from the UI.
  const halfDeleted = { ...pkg("external.half", "1.0.0", ["status.set"], "cleanup-pending"), uploadSettled: true };
  assert.equal(roomPluginPackageSelectable(halfDeleted), true); assert.equal(roomPluginPackageUsable(halfDeleted), false);
  assert.deepEqual(planRoomPluginAuthorAction({ ...library, packages: [...library.packages, halfDeleted] }, { type: "delete", packageId: halfDeleted.packageId }),
    { ok: true, operation: "delete", packageId: halfDeleted.packageId });
  assert.equal(roomPluginPackageSelectable(pending), false);
});

test("disable keeps the exact bound artifact and approvals without a new capability approval", () => {
  const value = pkg("external.disable", "2.0.0"), binding = bound(value);
  const library = { revision: 4, packages: [value], bindings: [binding] };
  assert.deepEqual(planRoomPluginAuthorAction(library, { type: "disable", pluginId: value.pluginId }), { ok: true, operation: "bind",
    pluginId: value.pluginId, expectedRevision: 4, approval: null, write: { packageId: binding.packageId, version: binding.version,
      artifactSha256: binding.artifactSha256, enabled: false, config: binding.config, approvedCapabilities: binding.approvedCapabilities } });
});

test("every author refusal and failure has a fixed message without server text", () => {
  for (const reason of ["stale", "not-ready", "config-invalid", "capability-unknown", "bound", "enabled", "quota", "unsupported", "forbidden", "session",
    "conflict", "approval-required", "invalid-package", "version-conflict", "version-deleted", "too-large", "pending", "unavailable"] as const) {
    assert.match(roomPluginAuthorMessage(reason), /^[A-Z][^<>]{10,}\.$/);
  }
});
