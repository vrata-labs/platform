import test from "node:test";
import assert from "node:assert/strict";
import { createRoomPluginAuthorHttp, parseRoomPluginAuthorLibrary, roomPluginAuthorFailure, RoomPluginAuthorError } from "./author-http.js";

const manifest = { schemaVersion: 1, sdkApiVersion: 1, id: "external.http", version: "1.0.0", displayName: "HTTP",
  requestedCapabilities: ["status.set"], configSchema: {}, entrySha256: "e".repeat(64) };
const pkg = { packageId: "00000000-0000-4000-8000-000000000001", pluginId: "external.http", version: "1.0.0", artifactSha256: "a".repeat(64),
  byteLength: 5, manifest, state: "ready", uploadSettled: true, createdAt: "2026-10-22T00:00:00.000Z" };
const binding = { bindingId: "00000000-0000-4000-8000-000000000002", packageId: pkg.packageId, pluginId: pkg.pluginId, version: "1.0.0",
  artifactSha256: pkg.artifactSha256, enabled: true, generation: 1, bindingRevision: 1, config: { greeting: "hi" }, approvedCapabilities: ["status.set"] };

function server(handler: (url: URL, init: RequestInit) => Response) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = (async (input: string, init: RequestInit) => { const url = new URL(input); requests.push({ url, init }); return handler(url, init); }) as typeof globalThis.fetch;
  return { requests, http: createRoomPluginAuthorHttp({ apiBaseUrl: "https://app.invalid", roomId: "room/1", token: () => "rs2.private", fetch }) };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("library parsing keeps only author DTO fields and rejects inconsistent manifests", () => {
  const library = parseRoomPluginAuthorLibrary(JSON.stringify({ revision: 3, packages: [pkg], bindings: [binding] }));
  assert.equal(library.revision, 3); assert.equal(library.packages[0].manifest.displayName, "HTTP");
  assert.equal(Object.hasOwn(library.bindings[0], "bindingId"), false); assert.equal(library.bindings[0].bindingRevision, 1);
  for (const broken of [{ ...pkg, version: "1.0.1" }, { ...pkg, state: "deleted" }, { ...pkg, packageId: "../x" }]) {
    assert.throws(() => parseRoomPluginAuthorLibrary(JSON.stringify({ revision: 3, packages: [broken], bindings: [] })), RoomPluginAuthorError);
  }
  assert.throws(() => parseRoomPluginAuthorLibrary(JSON.stringify({ revision: 3, packages: [], bindings: [binding, binding] })), RoomPluginAuthorError);
});

test("writes use the caller's own bearer, exact paths and explicit artifact approval without cookies or redirects", async () => {
  const s = server((url, init) => url.pathname.endsWith("/packages") && init.method === "GET"
    ? json(200, { revision: 1, packages: [pkg], bindings: [] }) : json(init.method === "POST" ? 201 : 200, { ok: true, revision: 2, package: pkg }));
  await s.http.library();
  await s.http.upload(new Uint8Array([1, 2]));
  assert.equal(await s.http.bind("external.http", 1, { packageId: pkg.packageId, version: "1.0.0", artifactSha256: pkg.artifactSha256,
    enabled: true, config: { greeting: "hi" }, approvedCapabilities: ["status.set"] }, ["status.set"]), 2);
  assert.equal(await s.http.unbind("external.http", 2), 2);
  await s.http.remove(pkg.packageId);
  assert.deepEqual(s.requests.map(({ url, init }) => `${init.method} ${url.pathname}`), [
    "GET /api/rooms/room%2F1/plugins/packages", "POST /api/rooms/room%2F1/plugins/packages", "PUT /api/rooms/room%2F1/plugins/bindings/external.http",
    "DELETE /api/rooms/room%2F1/plugins/bindings/external.http", `DELETE /api/rooms/room%2F1/plugins/packages/${pkg.packageId}`]);
  for (const { init } of s.requests) {
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer rs2.private");
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
  }
  assert.deepEqual(JSON.parse(String(s.requests[2].init.body)), { expectedRevision: 1, packageId: pkg.packageId, version: "1.0.0",
    artifactSha256: pkg.artifactSha256, enabled: true, config: { greeting: "hi" }, approvedCapabilities: ["status.set"],
    capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities: ["status.set"] } });
  await assert.rejects(s.http.bind("../admin", 1, { packageId: pkg.packageId, version: "1.0.0", artifactSha256: pkg.artifactSha256,
    enabled: false, config: {}, approvedCapabilities: [] }, null), RoomPluginAuthorError);
});

test("server failures become fixed classes; oversized uploads and missing tokens never reach the network", async () => {
  const s = server(() => json(409, { error: "plugin_revision_conflict", message: "<script>private</script>" }));
  await assert.rejects(s.http.library(), (error: RoomPluginAuthorError) => error.failure === "conflict");
  await assert.rejects(s.http.upload(new Uint8Array(1024 * 1024 + 1)), (error: RoomPluginAuthorError) => error.failure === "too-large");
  const anonymous = createRoomPluginAuthorHttp({ apiBaseUrl: "https://app.invalid", roomId: "room", token: () => null,
    fetch: (() => { throw new Error("network used"); }) as never });
  await assert.rejects(anonymous.library(), (error: RoomPluginAuthorError) => error.failure === "session");
  assert.equal(s.requests.length, 1);
  assert.equal(roomPluginAuthorFailure(409, "plugin_identity_not_active"), "unsupported");
  assert.equal(roomPluginAuthorFailure(403, "plugin_capability_approval_required"), "approval-required");
  assert.equal(roomPluginAuthorFailure(400, "invalid_manifest"), "invalid-package");
  assert.equal(roomPluginAuthorFailure(503, "plugin_upload_pending"), "pending");
  assert.equal(roomPluginAuthorFailure(500, undefined), "unavailable");
  assert.equal(roomPluginAuthorFailure(404, "not_found"), "unsupported");
  assert.equal(roomPluginAuthorFailure(404, "plugin_package_not_found"), "conflict");
  assert.equal(roomPluginAuthorFailure(409, "plugin_invalid_transition", "upload"), "version-deleted");
  assert.equal(roomPluginAuthorFailure(400, "invalid_config", "binding"), "config-invalid");
  assert.equal(roomPluginAuthorFailure(400, "plugin_invalid_binding", "binding"), "config-invalid");
  assert.equal(roomPluginAuthorFailure(400, "invalid_manifest", "upload"), "invalid-package");
});
