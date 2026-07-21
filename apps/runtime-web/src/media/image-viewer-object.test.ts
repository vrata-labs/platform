import assert from "node:assert/strict";
import test from "node:test";
import { mediaDrawRect } from "./image-viewer-object.js";

test("media draw rectangle preserves aspect ratio for contain and cover", () => {
  assert.deepEqual(mediaDrawRect(400, 200, 100, 100, "contain"), { x: 0, y: 25, width: 100, height: 50 });
  assert.deepEqual(mediaDrawRect(400, 200, 100, 100, "cover"), { x: -50, y: 0, width: 200, height: 100 });
});
