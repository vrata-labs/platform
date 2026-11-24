import assert from "node:assert/strict";
import test from "node:test";
import { privateSceneSource } from "./private-scene-source.js";

const endpoint = "https://app.example/api/rooms/r/delivery-descriptor";
const binding = { bundleVersionId: "pinned", contentHash: "sha256:pinned" };
const serverNow = Date.parse("2026-11-24T10:49:00Z");

function descriptor(issue: number, issuedAt = serverNow) {
  const baseUrl = `https://assets.example/c/${String(issue).repeat(43)}/`;
  return {
    ...binding,
    roomId: "r",
    purpose: "view",
    baseUrl,
    manifestUrl: `${baseUrl}scene.json`,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 120_000).toISOString(),
    refreshAfter: new Date(issuedAt + 90_000).toISOString()
  };
}

test("concurrent private file reads share one renewal, keep the exact version and send no room credentials to the asset origin", async () => {
  let issues = 0;
  const descriptors: typeof fetch = async (url, init) => {
    assert.equal(url, endpoint);
    assert.deepEqual(init?.headers, { authorization: "Bearer session" });
    return Response.json(descriptor(++issues));
  };
  const assets: typeof fetch = async (url, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.headers, undefined);
    return new Response(null, { status: String(url).includes(`/c/${"1".repeat(43)}/`) ? 403 : 200 });
  };
  const load = privateSceneSource(
    endpoint,
    "r",
    binding,
    () => "session",
    descriptors,
    assets
  );
  assert.deepEqual(
    (await Promise.all([load("scene.json"), load("scene.glb")])).map((r) => r.status),
    [200, 200]
  );
  assert.equal(issues, 2);
  const drift = privateSceneSource(
    endpoint,
    "r",
    { ...binding, bundleVersionId: "different" },
    () => "session",
    descriptors,
    assets
  );
  await assert.rejects(drift("scene.glb"), /private_scene_descriptor_invalid/);
});

test("private files refresh on elapsed time despite a fast or slow wall clock", async (t) => {
  let time = 100, offset = 3_600_000, issues = 0;
  t.mock.method(performance, "now", () => time);
  t.mock.method(Date, "now", () => serverNow + time + offset);
  const load = privateSceneSource(
    endpoint, "r", binding, () => "session",
    async () => {
      time += 200; // Descriptor request latency counts toward the refresh interval.
      return Response.json(descriptor(++issues, serverNow + time));
    },
    async (url) => new Response(String(url))
  );

  assert.equal(await (await load("scene.json")).text(), `${descriptor(1).baseUrl}scene.json`);
  offset = -3_600_000;
  time = 90_099;
  assert.equal(await (await load("scene.glb")).text(), `${descriptor(1).baseUrl}scene.glb`);
  time = 90_100;
  assert.equal(await (await load("scene.glb")).text(), `${descriptor(2).baseUrl}scene.glb`);
  offset = 3_600_000;
  time = 180_100;
  assert.equal(await (await load("scene.glb")).text(), `${descriptor(3).baseUrl}scene.glb`);
});

test("private file reads reject invalid server times and stop when the server refuses renewal", async () => {
  const invalid = descriptor(1);
  invalid.expiresAt = invalid.issuedAt;
  let issues = 0, reads = 0;
  const load = privateSceneSource(
    endpoint, "r", binding, () => "session",
    async () => {
      switch (++issues) {
        case 1: return Response.json(invalid);
        case 2: return Response.json(descriptor(2));
        default: return new Response(null, { status: 403 });
      }
    },
    async () => {
      reads++;
      return new Response(null, { status: 403 });
    }
  );
  await assert.rejects(load("scene.json"), /private_scene_descriptor_invalid/);
  assert.equal(reads, 0);
  await assert.rejects(load("scene.json"), /private_scene_descriptor:403/);
  assert.equal(reads, 1);
  assert.equal(issues, 3);
});
