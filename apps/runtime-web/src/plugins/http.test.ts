import test from "node:test";
import assert from "node:assert/strict";
import { createRoomPluginHttp, RoomPluginHttpError } from "./http.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath } from "./runtime-dto.js";

const roomId = "private/room", packageId = "22222222-2222-4222-8222-222222222222";
const data = { schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1, bindings: [{ bindingId: "11111111-1111-4111-8111-111111111111",
  packageId, pluginId: "external.status", version: "1.0.0", artifactSha256: "a".repeat(64), enabled: true, generation: 1, bindingRevision: 1,
  approvedCapabilities: ["status.set"], config: {}, contentUrl: roomPluginContentPath(roomId, packageId) }] };
const binding = parseRoomPluginRuntimeSnapshot(JSON.stringify(data), roomId).bindings[0];
const proof = { token: "private-native-proof", deadlineMs: 900_000 };

test("runtime fetches only computed room paths with a bearer header, no cookies or redirects", async () => {
  const paths: string[] = [];
  const http = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async function (url, init) {
    assert.equal(this, globalThis); paths.push(String(url)); assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store"); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${proof.token}`);
    return new Response(paths.length === 1 ? JSON.stringify(data) : "owned bytes");
  } });
  const snapshot = await http.snapshot(proof, new AbortController().signal); assert.equal(snapshot.bindings.length, 1);
  assert.equal(new TextDecoder().decode(await http.content(binding, proof, new AbortController().signal)), "owned bytes");
  assert.deepEqual(paths, ["https://app.invalid/api/rooms/private%2Froom/plugins/runtime", `https://app.invalid${binding.contentUrl}`]);
  assert.equal(paths.some(path => path.includes(proof.token)), false);
});

test("snapshot and content limits hold for declared and streamed oversized bodies", async () => {
  for (const declared of [false, true]) {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); }, cancel() { cancelled++; } });
    const http = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async () => new Response(body,
      declared ? { headers: { "content-length": String(64 * 1024 + 1) } } : undefined) });
    await assert.rejects(http.snapshot(proof, new AbortController().signal), { code: "network-unavailable" });
    assert.equal(cancelled, 1);
  }
  const http = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async () => new Response(new Uint8Array(1024 * 1024 + 1)) });
  await assert.rejects(http.content(binding, proof, new AbortController().signal), { code: "network-unavailable" });
});

test("old API, inactive identity, content rebind and real identity denials stay distinct without body echoes", async () => {
  for (const [status, error, expected] of [[404, "missing", "unsupported"], [409, "plugin_identity_not_active", "unsupported"],
    [409, "plugin_binding_changed", "changed"], [401, "identity_session_expired", "denied"]] as const) {
    const http = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async () => new Response(JSON.stringify({ error }), { status }) });
    await assert.rejects(http.snapshot(proof, new AbortController().signal), (cause: unknown) => cause instanceof RoomPluginHttpError && cause.disposition === expected);
  }
  const content = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async () => new Response('{"error":"plugin_content_not_bound"}', { status: 403 }) });
  await assert.rejects(content.content(binding, proof, new AbortController().signal), (cause: unknown) => cause instanceof RoomPluginHttpError && cause.disposition === "changed");
});

test("deadline and parent cancellation return even if an injected fetch ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let signal!: AbortSignal;
  const http = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async (_url, init) => {
    signal = init!.signal!; return new Promise<Response>(() => {});
  } });
  const request = http.snapshot(proof, new AbortController().signal); const failed = assert.rejects(request, { code: "network-unavailable" });
  t.mock.timers.tick(2000); await failed; assert.equal(signal.aborted, true);
  const parent = new AbortController(); const pending = http.snapshot(proof, parent.signal); const stopped = assert.rejects(pending, { code: "network-unavailable" });
  parent.abort(); await stopped; assert.equal(signal.aborted, true);
});

test("foreign content URLs and already aborted contexts allocate no request", async () => {
  let requests = 0;
  const http = createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId, fetch: async () => { requests++; return new Response(); } });
  await assert.rejects(http.content({ ...binding, contentUrl: "https://outside.invalid" }, proof, new AbortController().signal), { code: "invalid-runtime-config" });
  const parent = new AbortController(); parent.abort(); await assert.rejects(http.snapshot(proof, parent.signal), { code: "network-unavailable" });
  assert.equal(requests, 0);
});
