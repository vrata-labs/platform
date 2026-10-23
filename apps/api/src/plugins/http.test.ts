import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_PLUGIN_LIMITS, ROOM_PLUGIN_VALIDATION_ERROR_CODES, RoomPluginValidationError } from "@vrata/room-plugin-sdk";
import { roomPluginSha256 } from "@vrata/room-plugin-sdk/artifact";
import { IdentityStorageError } from "../identity/contracts.js";
import { RoomFenceCommitUncertain } from "../identity/fence-transaction.js";
import { IdentityBoundaryError } from "../identity/legacy-boundary.js";
import { RoomPluginAccessError } from "./access-contracts.js";
import type { StoredRoomPluginBinding } from "./contracts.js";
import { RoomPluginStorageError } from "./contracts.js";
import { RoomPluginBlobWriteUncertain } from "./blob-storage.js";
import { ROOM_PLUGIN_BINDING_HTTP_BYTES } from "./http-dto.js";
import { pluginHttpFixture, pluginHttpRequest, pluginHttpResponse, httpTestBearer } from "./http-test-helper.js";
import { handleRoomPluginHttp } from "./http.js";
import { RoomPluginHttpError } from "./http-errors.js";

const base = "https://example.test/api/rooms/room/plugins/";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function binding(f: ReturnType<typeof pluginHttpFixture>, enabled = true): StoredRoomPluginBinding {
  return { tenantId: "tenant", roomId: "room", pluginId: "fixture", packageId: f.value.packageId, version: "1.0.0",
    artifactSha256: f.value.artifactSha256, enabled, approvedCapabilities: ["status.set"], config: { label: "hello" },
    bindingId: "binding", generation: 1, bindingRevision: 1 };
}
function bindingInput(f: ReturnType<typeof pluginHttpFixture>, expectedRevision = 0) {
  return { expectedRevision, packageId: f.value.packageId, version: "1.0.0", artifactSha256: f.value.artifactSha256,
    enabled: true, config: { label: "hello" }, approvedCapabilities: ["status.set"] };
}
async function call(f: ReturnType<typeof pluginHttpFixture>, method: string, path: string,
  body?: Uint8Array, headers?: Record<string, string>) {
  const request = pluginHttpRequest(method, headers, body), result = pluginHttpResponse();
  const handled = await handleRoomPluginHttp(request, result.response, new URL(base + path), f.deps);
  return { ...result, request, handled };
}

test("floor 1 rejects every plugin endpoint including administrators before actor/config/metadata IO", async () => {
  const routes = [["GET", "packages"], ["POST", "packages"], ["DELETE", "packages/11111111-1111-4111-8111-111111111111"],
    ["PUT", "bindings/fixture"], ["DELETE", "bindings/fixture"], ["GET", "runtime"], ["GET", "packages/11111111-1111-4111-8111-111111111111/content"],
    ["GET", "unrecognized/source.js"]];
  for (const [method, path] of routes) {
    const f = pluginHttpFixture(); f.setFloor(1);
    const result = await call(f, method, path, Uint8Array.of(255), { "x-vrata-admin-token": "platform-admin" });
    assert.equal(result.handled, true); assert.equal(result.captured.statusCode, 409);
    assert.deepEqual(result.json(), { error: "plugin_identity_not_active" }); assert.deepEqual(f.calls, ["floor"]);
    assert.equal(result.request.listenerCount("data"), 0);
  }
});
test("unrelated routes return false without touching any authority or storage", async () => {
  const f = pluginHttpFixture(), res = pluginHttpResponse();
  assert.equal(await handleRoomPluginHttp(pluginHttpRequest("GET"), res.response, new URL("https://example.test/api/rooms/room"), f.deps), false);
  assert.deepEqual(f.calls, []); assert.equal(res.captured.sends, 0);
});
test("guest and expired sessions fail before request validation, oversized buffering and secrets", async () => {
  for (const [error, status, body] of [
    [new RoomPluginAccessError("plugin_author_forbidden"), 403, { error: "plugin_author_forbidden" }],
    [new IdentityStorageError("identity_session_expired"), 401, { error: "identity_session_expired", reason: "identity_session_expired" }]
  ] as const) {
    const f = pluginHttpFixture(); f.setDenial(error);
    const result = await call(f, "POST", "packages", Uint8Array.of(255), { authorization: httpTestBearer, "content-length": "1048577" });
    assert.equal(result.captured.statusCode, status); assert.deepEqual(result.json(), body);
    assert.deepEqual(f.calls, ["floor", "resolve-actor", "access", "authorize"]);
    assert.equal(result.request.listenerCount("data"), 0);
  }
});
test("only explicit Bearer RS2 or administrator headers are eligible; cookies and URL credentials cannot authenticate", async () => {
  const rejected: { headers: Record<string, string>; path: string; status: number }[] = [
    { headers: {}, path: "packages?sessionToken=secret", status: 401 },
    { headers: { cookie: "sessionToken=secret; adminToken=platform-admin" }, path: "packages", status: 401 },
    { headers: { authorization: "Bearer legacy.jwt.token" }, path: "packages", status: 401 },
    { headers: { authorization: httpTestBearer, "x-vrata-admin-token": "platform-admin" }, path: "packages", status: 400 },
    { headers: { "x-noah-admin-token": "legacy-admin" }, path: "packages", status: 401 },
    { headers: { authorization: httpTestBearer + ", Bearer secret" }, path: "packages", status: 401 }
  ];
  for (const input of rejected) {
    const f = pluginHttpFixture(), result = await call(f, "GET", input.path, undefined, input.headers);
    assert.equal(result.captured.statusCode, input.status); assert.deepEqual(f.calls, ["floor"]);
    assert.doesNotMatch(result.captured.bytes.toString(), /secret|platform-admin|legacy/);
  }
  const f = pluginHttpFixture();
  const result = await call(f, "GET", "packages?tenantId=other&role=host", undefined, { authorization: httpTestBearer });
  assert.equal(result.captured.statusCode, 400); assert.equal(f.calls.includes("release-library"), false);
});
test("duplicate security headers are rejected, and configured Origin policy does not trust Host", async t => {
  const env = process.env.API_CORS_ORIGIN; t.after(() => { if (env === undefined) delete process.env.API_CORS_ORIGIN; else process.env.API_CORS_ORIGIN = env; });
  process.env.API_CORS_ORIGIN = "https://trusted.test";
  for (const origin of ["https://attacker.test", "null"]) {
    const f = pluginHttpFixture(), result = await call(f, "GET", "packages", undefined,
      { authorization: httpTestBearer, origin, host: "trusted.test" });
    assert.equal(result.captured.statusCode, 403); assert.deepEqual(f.calls, ["floor"]);
  }
  const f = pluginHttpFixture(), request = pluginHttpRequest("GET"), result = pluginHttpResponse();
  request.rawHeaders.push("Authorization", httpTestBearer);
  await handleRoomPluginHttp(request, result.response, new URL(base + "packages"), f.deps);
  assert.equal(result.captured.statusCode, 400); assert.deepEqual(f.calls, ["floor"]);
});
test("Bearer scheme is case-insensitive while the RS2 prefix and exact credential bytes stay unchanged", async () => {
  const token = httpTestBearer.slice("Bearer ".length);
  for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
    const f = pluginHttpFixture();
    const resolve = f.deps.resolveActor;
    f.deps.resolveActor = async (request, roomId) => {
      assert.equal(request.headers.authorization, `${scheme} ${token}`);
      return resolve(request, roomId);
    };
    const result = await call(f, "GET", "packages", undefined, { authorization: `${scheme} ${token}` });
    assert.equal(result.captured.statusCode, 200); assert.equal(f.calls.includes("release-library"), true);
  }
  for (const prefix of ["RS2", "Rs2", "rS2"]) {
    const f = pluginHttpFixture();
    const result = await call(f, "GET", "packages", undefined, { authorization: `bearer ${token.replace(/^rs2/, prefix)}` });
    assert.equal(result.captured.statusCode, 401); assert.deepEqual(f.calls, ["floor"]);
  }
  const duplicate = pluginHttpFixture(), request = pluginHttpRequest("GET", { authorization: `bearer ${token}` }), response = pluginHttpResponse();
  request.rawHeaders.push("AUTHORIZATION", `BEARER ${token}`);
  await handleRoomPluginHttp(request, response.response, new URL(base + "packages"), duplicate.deps);
  assert.equal(response.captured.statusCode, 400); assert.deepEqual(duplicate.calls, ["floor"]);
});
test("verified resolver missing-room and scope-mismatch errors retain their published status and code", async () => {
  for (const [status, code] of [[404, "room_not_found"], [403, "room_mismatch"]] as const) {
    const f = pluginHttpFixture();
    f.deps.resolveActor = async () => { f.calls.push("resolve-actor"); throw new RoomPluginHttpError(status, code); };
    const result = await call(f, "POST", "packages", Uint8Array.of(255));
    assert.equal(result.captured.statusCode, status); assert.deepEqual(result.json(), { error: code });
    assert.deepEqual(f.calls, ["floor", "resolve-actor"]); assert.equal(result.request.listenerCount("data"), 0);
  }
});
test("resolver actors must match the explicit credential channel and route room", async () => {
  const wrongRoom = pluginHttpFixture();
  wrongRoom.actor.proof.roomId = "other-room";
  const result = await call(wrongRoom, "GET", "packages");
  assert.equal(result.captured.statusCode, 401); assert.equal(wrongRoom.calls.includes("access"), false);
  const wrongChannel = pluginHttpFixture();
  wrongChannel.deps.resolveActor = async () => ({ actorType: "administrator", scope: { tenantId: "tenant", roomId: "room" } });
  const adminFromBearer = await call(wrongChannel, "GET", "packages");
  assert.equal(adminFromBearer.captured.statusCode, 401); assert.equal(wrongChannel.calls.includes("access"), false);
});
test("successful POST preserves original bytes and public package projection, then GET releases a live library", async () => {
  const f = pluginHttpFixture();
  const result = await call(f, "POST", "packages", f.bytes);
  assert.equal(result.captured.statusCode, 201); assert.equal(result.json().package.state, "ready");
  assert.equal(result.json().package.manifest.entrySha256, f.value.manifest.entrySha256);
  assert.deepEqual(f.objects.get(f.value.storageKey), f.bytes);
  assert.equal(result.json().package.artifactSha256, roomPluginSha256(f.bytes));
  assert.equal(f.calls.at(-1), "release-library");
  assert.doesNotMatch(result.captured.bytes.toString(), /storageKey|backendFingerprint|private-object|tenantId|roomId|identityId|entry\"/);
  const library = await call(f, "GET", "packages");
  assert.equal(library.captured.statusCode, 200); assert.equal(library.json().packages.length, 1);
  assert.deepEqual(library.json().bindings, []); assert.equal(library.json().revision, 0);
  assert.equal((globalThis as Record<string, unknown>).__plugin_http_executed, undefined);
});
test("PUT binding uses the strict flat body and returns only its known revision ack after a final live release", async () => {
  const f = pluginHttpFixture();
  const result = await call(f, "PUT", "bindings/fixture", encode(bindingInput(f)));
  assert.equal(result.captured.statusCode, 200); assert.deepEqual(result.json(), { ok: true, revision: 1 });
  assert.deepEqual(f.calls, ["floor", "resolve-actor", "access", "authorize", "bind", "release-library"]);
  assert.equal(f.calls.includes("config"), false);
  const removed = await call(f, "DELETE", "bindings/fixture", encode({ expectedRevision: 1 }));
  assert.deepEqual(removed.json(), { ok: true, revision: 2 });
});
test("body authority claims, wrappers, duplicate fields, nested config, malformed revisions and approval extras are rejected", async () => {
  const f = pluginHttpFixture(), input = bindingInput(f);
  const invalid = [
    { ...input, tenantId: "other" }, { ...input, participantId: "victim" }, { ...input, role: "host" },
    { expectedRevision: 0, binding: input }, { ...input, expectedRevision: "0" }, { ...input, expectedRevision: -1 },
    { ...input, config: { label: { expression: "script" } } },
    { ...input, capabilityApproval: { artifactSha256: f.value.artifactSha256, capabilities: ["status.set"], admin: true } }
  ];
  for (const value of invalid) {
    const result = await call(f, "PUT", "bindings/fixture", encode(value));
    assert.equal(result.captured.statusCode, 400); assert.equal(f.calls.includes("bind"), false);
  }
  const duplicate = encode(input);
  const raw = new TextEncoder().encode(new TextDecoder().decode(duplicate).replace('"expectedRevision":0', '"expectedRevision":0,"expectedRevision":1'));
  const result = await call(f, "PUT", "bindings/fixture", raw);
  assert.equal(result.captured.statusCode, 400); assert.deepEqual(result.json(), { error: "duplicate_field" });
});
test("SDK artifact security validation errors are malformed-input 400 before reservation or blob config", async () => {
  for (const code of ["module_import_forbidden", "unknown_capability", "unsafe_key", "invalid_manifest"] as const) {
    const f = pluginHttpFixture();
    const artifact = JSON.parse(new TextDecoder().decode(f.bytes));
    if (code === "module_import_forbidden") {
      artifact.entry = 'import "https://private.example/secret.js"; export function init() {}';
      artifact.manifest.entrySha256 = roomPluginSha256(new TextEncoder().encode(artifact.entry));
    } else if (code === "unknown_capability") artifact.manifest.requestedCapabilities = ["private.secretCapability"];
    else if (code === "unsafe_key") Object.defineProperty(artifact.manifest, "__proto__", { value: { secret: "private" }, enumerable: true });
    else artifact.manifest.id = "INVALID";
    const result = await call(f, "POST", "packages", encode(artifact));
    assert.equal(result.captured.statusCode, 400); assert.deepEqual(result.json(), { error: code });
    assert.equal(f.calls.includes("config"), false); assert.equal(f.calls.includes("reserve"), false);
    assert.doesNotMatch(result.captured.bytes.toString(), /private|secret|https|entrySha256|configSchema/);
  }
});
test("all SDK validation codes stay 400 without leaking diagnostics; actual capability approvals remain 403", async () => {
  for (const code of ROOM_PLUGIN_VALIDATION_ERROR_CODES) {
    const f = pluginHttpFixture();
    f.author.putBinding = async () => { throw new RoomPluginValidationError(code, "$.private.secret", "private secret diagnostic"); };
    const result = await call(f, "PUT", "bindings/fixture", encode(bindingInput(f)));
    assert.equal(result.captured.statusCode, 400); assert.deepEqual(result.json(), { error: code });
    assert.equal(f.calls.includes("release-library"), false); assert.equal(f.calls.includes("config"), false);
  }
  const approval = pluginHttpFixture();
  approval.author.putBinding = async () => { throw new RoomPluginStorageError("plugin_capability_approval_required"); };
  const denied = await call(approval, "PUT", "bindings/fixture", encode(bindingInput(approval)));
  assert.equal(denied.captured.statusCode, 403); assert.deepEqual(denied.json(), { error: "plugin_capability_approval_required" });
});
test("binding envelope has a separate small bound and does not apply the artifact's 1 MiB allowance", async () => {
  const f = pluginHttpFixture();
  const result = await call(f, "PUT", "bindings/fixture", Buffer.alloc(ROOM_PLUGIN_BINDING_HTTP_BYTES + 1, 32));
  assert.equal(result.captured.statusCode, 413); assert.equal(f.calls.includes("bind"), false); assert.equal(f.calls.includes("config"), false);
  const tooMuchConfig = await call(f, "PUT", "bindings/fixture", encode({ ...bindingInput(f), config: { label: "a".repeat(ROOM_PLUGIN_LIMITS.configBytes) } }));
  assert.equal(tooMuchConfig.captured.statusCode, 400); assert.equal(f.calls.includes("bind"), false);
});
test("mutations never release metadata or ACK to a former Host after the final author release denies", async () => {
  const f = pluginHttpFixture(), put = f.author.putBinding;
  f.author.putBinding = async (...args) => { const result = await put(...args); f.setDenial(new RoomPluginAccessError("plugin_author_forbidden")); return result; };
  const result = await call(f, "PUT", "bindings/fixture", encode(bindingInput(f)));
  assert.equal(result.captured.statusCode, 403); assert.deepEqual(result.json(), { error: "plugin_author_forbidden" });
  assert.equal(result.captured.sends, 1); assert.doesNotMatch(result.captured.bytes.toString(), /revision|bindings|packages|manifest/);
});
test("administrator author is accepted but runtime and content cannot inherit administrator bypass", async () => {
  for (const path of ["runtime", "packages/11111111-1111-4111-8111-111111111111/content", "packages"]) {
    const f = pluginHttpFixture();
    f.deps.resolveActor = async () => { f.calls.push("resolve-actor"); return { actorType: "administrator", scope: { tenantId: "tenant", roomId: "room" } }; };
    const result = await call(f, "GET", path, undefined, { "x-vrata-admin-token": "platform-admin" });
    assert.equal(result.captured.statusCode, path === "packages" ? 200 : 401);
    assert.equal(f.calls.includes("config"), false); assert.equal(f.calls.includes("release-snapshot"), false);
  }
});
test("runtime emits only enabled exact immutable binding packets with internal token-free content URLs", async () => {
  const f = pluginHttpFixture(); f.setBindings([binding(f), { ...binding(f, false), pluginId: "disabled" }], 7);
  const result = await call(f, "GET", "runtime");
  const body = result.json(); assert.equal(body.schemaVersion, 1); assert.equal(body.sdkApiVersion, 1); assert.equal(body.revision, 7);
  assert.ok(body.leaseExpiresAtMs > Date.now() && body.leaseExpiresAtMs <= Date.now() + 5000);
  assert.equal(body.bindings.length, 1); assert.equal(body.bindings[0].artifactSha256, f.value.artifactSha256);
  assert.equal(body.bindings[0].contentUrl, `/api/rooms/room/plugins/packages/${f.value.packageId}/content`);
  assert.equal(body.bindings[0].contentUrl.includes("?"), false);
  assert.doesNotMatch(result.captured.bytes.toString(), /tenantId|roomId|identityId|participantId|backendFingerprint|storageKey|Bearer|role/);
  assert.equal(f.calls.includes("config"), false);
});
test("content is attachment/octet-stream only, with byte-exact SHA headers and sandbox after final validation", async () => {
  const f = pluginHttpFixture(); f.value.state = "ready"; f.value.uploadSettled = true;
  f.objects.set(f.value.storageKey, f.bytes); f.setBindings([binding(f)], 1);
  const result = await call(f, "GET", `packages/${f.value.packageId}/content`);
  assert.equal(result.captured.statusCode, 200); assert.deepEqual(new Uint8Array(result.captured.bytes), f.bytes);
  assert.equal(result.captured.headers["content-type"], "application/octet-stream");
  assert.equal(result.captured.headers["content-length"], String(f.bytes.byteLength));
  assert.equal(result.captured.headers["x-artifact-sha256"], roomPluginSha256(f.bytes));
  assert.equal(result.captured.headers.etag, `"${roomPluginSha256(f.bytes)}"`);
  assert.match(result.captured.headers["content-disposition"], /^attachment; filename="[a-f0-9-]+\.vrata-plugin\.json"$/);
  assert.equal(result.captured.headers["x-content-type-options"], "nosniff");
  assert.match(result.captured.headers["content-security-policy"], /^sandbox;/);
  assert.deepEqual(f.calls, ["floor", "resolve-actor", "access", "prepare-content", "config", "read", "release-content"]);
  assert.equal(result.captured.headers["access-control-allow-credentials"], undefined);
});
test("disabled/unbound package content cannot reach object storage", async () => {
  const f = pluginHttpFixture(); f.setBindings([binding(f, false)]);
  const result = await call(f, "GET", `packages/${f.value.packageId}/content`);
  assert.equal(result.captured.statusCode, 403); assert.deepEqual(result.json(), { error: "plugin_content_not_bound" });
  assert.equal(f.calls.includes("config"), false); assert.equal(f.calls.includes("read"), false);
});
test("binding change, expiry, blob corruption and backend retargeting prevent content release", async () => {
  for (const mode of ["changed", "expired", "corrupt", "retargeted"]) {
    const f = pluginHttpFixture(); f.value.state = "ready"; f.value.uploadSettled = true; f.setBindings([binding(f)], 1);
    f.objects.set(f.value.storageKey, f.bytes);
    const read = f.blobs.read;
    f.blobs.read = async (...args) => {
      const result = await read(...args);
      if (mode === "changed") f.setBindings([binding(f, false)], 2);
      if (mode === "expired") f.setDenial(new IdentityStorageError("identity_session_expired"));
      return mode === "corrupt" ? Uint8Array.of(255) : result;
    };
    if (mode === "retargeted") f.value.backendFingerprint = "b".repeat(64);
    const result = await call(f, "GET", `packages/${f.value.packageId}/content`);
    assert.equal(result.captured.statusCode, mode === "changed" ? 409 : mode === "expired" ? 401 : mode === "corrupt" ? 400 : 503);
    assert.equal(result.captured.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.captured.headers["content-disposition"], undefined); assert.equal(result.captured.headers["x-artifact-sha256"], undefined);
    if (mode === "retargeted") assert.equal(f.calls.includes("read"), false);
  }
});
test("HTTP errors are strict and sanitized for conflict/quota/capability/not-found/pending/fence failures", async () => {
  const mapping = [
    [new RoomPluginStorageError("plugin_revision_conflict"), 409, "plugin_revision_conflict"],
    [new RoomPluginStorageError("plugin_quota_exceeded"), 409, "plugin_quota_exceeded"],
    [new RoomPluginStorageError("plugin_capability_approval_required"), 403, "plugin_capability_approval_required"],
    [new RoomPluginStorageError("plugin_invalid_binding"), 400, "plugin_invalid_binding"],
    [new RoomPluginStorageError("plugin_package_not_found"), 404, "plugin_package_not_found"],
    [new RoomPluginStorageError("plugin_upload_pending"), 503, "plugin_upload_pending"],
    [new RoomFenceCommitUncertain(new Error("storageKey-secret-token")), 503, "identity_authority_unavailable"],
    [new Error("storageKey-secret-token"), 503, "plugin_backend_unavailable"]
  ] as const;
  for (const [error, status, code] of mapping) {
    const f = pluginHttpFixture(); f.author.putBinding = async () => { throw error; };
    const result = await call(f, "PUT", "bindings/fixture", encode(bindingInput(f)));
    assert.equal(result.captured.statusCode, status); assert.deepEqual(result.json(), { error: code });
  }
  const expired = pluginHttpFixture(); expired.deps.resolveActor = async () => { throw new IdentityBoundaryError(401, "identity_session_expired"); };
  const expiredResult = await call(expired, "GET", "packages");
  assert.deepEqual(expiredResult.json(), { error: "identity_session_expired", reason: "identity_session_expired" });
  const unknown = pluginHttpFixture(); unknown.blobs.put = async () => { throw new RoomPluginBlobWriteUncertain(new Error("private secret token")); };
  const pending = await call(unknown, "POST", "packages", unknown.bytes);
  assert.equal(pending.captured.statusCode, 503); assert.deepEqual(pending.json(), { error: "plugin_operation_pending" });
});
test("after synchronous fenced JSON or content release a COMMIT failure escapes without a second send", async () => {
  for (const mode of ["library", "content", "snapshot"]) {
    const f = pluginHttpFixture(), failure = new RoomFenceCommitUncertain(new Error("lost ACK"));
    let path = "packages";
    if (mode === "library") {
      const release = f.author.releaseLibrary;
      f.author.releaseLibrary = async send => { await release(send); throw failure; };
    } else if (mode === "snapshot") {
      path = "runtime"; const release = f.runtime.releaseSnapshot;
      f.runtime.releaseSnapshot = async send => { await release(send); throw failure; };
    } else {
      f.value.state = "ready"; f.value.uploadSettled = true; f.setBindings([binding(f)], 1); f.objects.set(f.value.storageKey, f.bytes);
      path = `packages/${f.value.packageId}/content`; const release = f.runtime.releaseBoundContent;
      f.runtime.releaseBoundContent = async (...args) => { await release(...args); throw failure; };
    }
    const result = pluginHttpResponse();
    await assert.rejects(handleRoomPluginHttp(pluginHttpRequest("GET"), result.response, new URL(base + path), f.deps), e => e === failure);
    assert.equal(result.captured.sends, 1); assert.equal(result.captured.statusCode, 200);
  }
});
test("DELETE package acknowledges only after deletion continuation and a live author release", async () => {
  const f = pluginHttpFixture(); f.value.state = "ready"; f.value.uploadSettled = true; f.objects.set(f.value.storageKey, f.bytes);
  const result = await call(f, "DELETE", `packages/${f.value.packageId}`);
  assert.equal(result.captured.statusCode, 200); assert.deepEqual(result.json(), { deleted: true, packageId: f.value.packageId });
  assert.equal(f.value.state, "deleted"); assert.equal(f.objects.size, 0);
  assert.deepEqual(f.calls, ["floor", "resolve-actor", "access", "authorize", "authorize", "delete-intent", "config", "delete", "confirm-delete", "release-library"]);
});
