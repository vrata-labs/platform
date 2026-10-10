import test from "node:test";
import assert from "node:assert/strict";
import { createLegacySceneMediaSurfaceResolver } from "./legacy-scene-media-surfaces.js";
import type { SceneMediaSurfaceLoad } from "./scene-media-surfaces.js";

const ORIGIN = "http://127.0.0.1:4000";
const DESK = { surfaceId: "desk", label: "Desk", allowedObjectTypes: ["markdown-board"] };
const manifest = (surfaces?: unknown[]) => JSON.stringify(surfaces === undefined ? { schemaVersion: 1 } : { schemaVersion: 1, mediaSurfaces: surfaces });
const ids = (result: SceneMediaSurfaceLoad) => result.kind === "failed" ? `failed:${result.reason}` : result.surfaces?.map(item => item.surfaceId).join() ?? "none";

/** Injected fetch and clock; every request and its init are recorded. */
function harness(reply: () => Response | Promise<Response>) {
  let at = 1_000_000;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const resolver = createLegacySceneMediaSurfaceResolver({ now: () => at,
    fetchManifest: async (url, init) => { calls.push({ url: String(url), init }); return reply(); } });
  return { resolver, calls, tick: (ms: number) => { at += ms; } };
}

test("concurrent requests for one normalized URL share a fetch; entries live 5 s and a new URL is a new key", async () => {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const { resolver, calls, tick } = harness(async () => { await gate; return new Response(manifest([DESK])); });
  const pending = [resolver.resolve("/scene.json", ORIGIN), resolver.resolve(`${ORIGIN}/scene.json`, ORIGIN), resolver.resolve("/scene.json", ORIGIN)];
  open();
  assert.deepEqual((await Promise.all(pending)).map(ids), ["desk", "desk", "desk"]);
  assert.deepEqual(calls.map(call => [call.url, call.init?.headers, call.init?.signal instanceof AbortSignal]),
    [[`${ORIGIN}/scene.json`, undefined, true]], "one bounded fetch, both spellings coalesced, no credential");
  tick(4_999); await resolver.resolve("/scene.json", ORIGIN);
  assert.equal(calls.length, 1, "a hit inside the TTL");
  tick(1); await resolver.resolve("/scene.json", ORIGIN);
  tick(-60_000); await resolver.resolve("/scene.json", ORIGIN);
  assert.equal(calls.length, 3, "an expired entry, or one stamped ahead of a clock step back, is refetched");
  assert.equal(ids(await resolver.resolve("/rebound.json", ORIGIN)), "desk");
  assert.equal(calls.length, 4, "a rebound URL is fetched within the TTL");
});

test("a failure is never cached and never serves an expired success; an empty valid manifest is a cached success", async () => {
  let response = () => new Response(manifest([DESK]));
  const { resolver, calls, tick } = harness(() => response());
  assert.equal(ids(await resolver.resolve("/scene.json", ORIGIN)), "desk");
  response = () => new Response("down", { status: 503 }); tick(5_000);
  assert.equal(ids(await resolver.resolve("/scene.json", ORIGIN)), "failed:http");
  assert.equal(ids(await resolver.resolve("/scene.json", ORIGIN)), "failed:http");
  tick(-5_000);
  assert.equal(ids(await resolver.resolve("/scene.json", ORIGIN)), "failed:http", "the dropped success is not revived");
  response = () => new Response(manifest());
  assert.deepEqual(await resolver.resolve("/scene.json", ORIGIN), { kind: "loaded", surfaces: undefined });
  assert.deepEqual(await resolver.resolve("/scene.json", ORIGIN), { kind: "loaded", surfaces: undefined });
  assert.equal(calls.length, 5, "every failure refetches; the empty success is cached");
});

test("each refusal is typed, and no URL that cannot be fetched is fetched", async () => {
  const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  const cases: Array<[string, () => Response]> = [["http", () => new Response("no", { status: 404 })], ["timeout", () => { throw timeout; }],
    ["parse", () => new Response("not-json")], ["parse", () => new Response(JSON.stringify({ schemaVersion: 2, mediaSurfaces: [] }))],
    ["too_large", () => new Response(" ".repeat(1024 * 1024 + 1))], ["invalid_surfaces", () => new Response(manifest([{ id: "__proto__" }]))]];
  for (const [reason, reply] of cases) assert.equal(ids(await harness(reply).resolver.resolve("/scene.json", ORIGIN)), `failed:${reason}`);
  const { resolver, calls } = harness(() => { throw new Error("must-not-fetch"); });
  assert.equal(ids(await resolver.resolve("file:///private.json", ORIGIN)), "failed:unsupported_protocol");
  assert.equal(ids(await resolver.resolve(`data:application/json,${"x".repeat(2 * 1024 * 1024 + 1)}`, ORIGIN)), "failed:too_large");
  assert.deepEqual(await resolver.resolve(null, ORIGIN), { kind: "loaded", surfaces: undefined });
  assert.equal(calls.length, 0);
});

test("each caller gets a deep copy, so mutating one grant cannot widen the shared entry", async () => {
  const { resolver } = harness(() => new Response(manifest([DESK])));
  const [first, second] = await Promise.all([resolver.resolve("/scene.json", ORIGIN), resolver.resolve("/scene.json", ORIGIN)]);
  assert.ok(first.kind === "loaded" && first.surfaces);
  first.surfaces[0]?.allowedObjectTypes.push("remote-browser");
  first.surfaces.push({ surfaceId: "forged", label: "Forged", allowedObjectTypes: [] });
  for (const result of [second, await resolver.resolve("/scene.json", ORIGIN)]) assert.deepEqual(result, { kind: "loaded", surfaces: [DESK] });
});

test("the cache holds at most 128 entries and evicts the oldest", async () => {
  const { resolver, calls } = harness(() => new Response(manifest([DESK])));
  for (let index = 0; index <= 128; index++) await resolver.resolve(`/scene-${index}.json`, ORIGIN);
  await resolver.resolve("/scene-128.json", ORIGIN);
  assert.equal(calls.length, 129, "the newest entry is still cached");
  await resolver.resolve("/scene-0.json", ORIGIN);
  assert.equal(calls.length, 130, "the oldest entry was evicted");
});

test("at most 128 distinct fetches are pending: another key refuses without network, duplicates coalesce", async () => {
  let open!: () => void;
  let held = new Promise<void>(resolve => { open = resolve; });
  const { resolver, calls, tick } = harness(async () => { await held; return new Response(manifest([DESK])); });
  const pending = Array.from({ length: 128 }, (_, index) => resolver.resolve(`/scene-${index}.json`, ORIGIN));
  const duplicate = resolver.resolve("/scene-0.json", ORIGIN);
  assert.equal(ids(await resolver.resolve("/scene-128.json", ORIGIN)), "failed:capacity");
  assert.deepEqual(calls.map(call => call.url), Array.from({ length: 128 }, (_, index) => `${ORIGIN}/scene-${index}.json`),
    "the refused key never reached the network; the duplicate coalesced");
  open();
  assert.deepEqual([...await Promise.all(pending), await duplicate].map(ids), Array(129).fill("desk"));
  assert.equal(ids(await resolver.resolve("/scene-128.json", ORIGIN)), "desk", "settled fetches free their slots");
  assert.equal(ids(await resolver.resolve("/scene-1.json", ORIGIN)), "desk");
  assert.equal(calls.length, 129, "a cached key needs no network");
  tick(5_000);
  assert.equal(ids(await resolver.resolve("/fresh.json", ORIGIN)), "desk");
  held = new Promise<void>(resolve => { open = resolve; });
  const next = Array.from({ length: 128 }, (_, index) => resolver.resolve(`/next-${index}.json`, ORIGIN));
  assert.equal(ids(await resolver.resolve("/fresh.json", ORIGIN)), "desk", "cached success is served while the cap is full");
  assert.equal(ids(await resolver.resolve("/scene-64.json", ORIGIN)), "failed:capacity");
  tick(-5_000);
  assert.equal(ids(await resolver.resolve("/scene-64.json", ORIGIN)), "failed:capacity", "an expired success is not revived");
  assert.equal(calls.length, 258);
  open();
  assert.deepEqual((await Promise.all(next)).map(ids), Array(128).fill("desk"));
});
