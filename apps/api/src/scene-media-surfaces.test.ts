import test from "node:test";
import assert from "node:assert/strict";
import { loadSceneMediaSurfaces } from "./scene-media-surfaces.js";

test("server reads only a bound manifest and returns a compact logical contract", async () => {
  const definition = { surfaceId: "workspace-main", label: "Desk", allowedObjectTypes: ["markdown-board"], transform: { x: 1, y: 2, z: 3 } };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:4000/assets/scene.json");
    assert.equal(init?.headers, undefined);
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ schemaVersion: 1, mediaSurfaces: [definition] }));
  };
  assert.deepEqual(await loadSceneMediaSurfaces("/assets/scene.json", "http://127.0.0.1:4000", fetcher), [{ surfaceId: "workspace-main", label: "Desk", allowedObjectTypes: ["markdown-board"] }]);
});

test("failed, oversized or invalid manifests cannot authorize surfaces", async () => {
  for (const response of [new Response("no", { status: 404 }), new Response("not-json"), new Response(" ".repeat(1024 * 1024 + 1)), new Response(JSON.stringify({ schemaVersion: 1, mediaSurfaces: [{ id: "__proto__" }] }))]) {
    assert.equal(await loadSceneMediaSurfaces("/scene.json", "http://127.0.0.1", async () => response), undefined);
  }
  assert.equal(await loadSceneMediaSurfaces(undefined, "http://127.0.0.1", async () => { throw new Error("must-not-fetch"); }), undefined);
  assert.equal(await loadSceneMediaSurfaces("file:///private.json", "http://127.0.0.1", async () => { throw new Error("must-not-fetch"); }), undefined);
});
