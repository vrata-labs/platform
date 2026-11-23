import assert from "node:assert/strict";
import test from "node:test";
import { privateSceneSource } from "./private-scene-source.js";

test("concurrent private file reads share one renewal, keep the exact version and send no room credentials to the asset origin", async () => {
  const binding = { bundleVersionId: "pinned", contentHash: "sha256:pinned" };
  let issues = 0;
  const descriptors: typeof fetch = async (url, init) => {
    assert.equal(url, "https://app.example/api/rooms/r/delivery-descriptor");
    assert.deepEqual(init?.headers, { authorization: "Bearer session" });
    const baseUrl = `https://assets.example/c/${String(++issues).repeat(43)}/`;
    return Response.json({
      ...binding,
      roomId: "r",
      purpose: "view",
      baseUrl,
      manifestUrl: `${baseUrl}scene.json`,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      refreshAfter: new Date(Date.now() + 60000).toISOString()
    });
  };
  const assets: typeof fetch = async (url, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.headers, undefined);
    return new Response(null, { status: String(url).includes(`/c/${"1".repeat(43)}/`) ? 403 : 200 });
  };
  const load = privateSceneSource(
    "https://app.example/api/rooms/r/delivery-descriptor",
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
    "https://app.example/api/rooms/r/delivery-descriptor",
    "r",
    { ...binding, bundleVersionId: "different" },
    () => "session",
    descriptors,
    assets
  );
  await assert.rejects(drift("scene.glb"), /private_scene_descriptor_invalid/);
});
