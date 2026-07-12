import test from "node:test";
import assert from "node:assert/strict";

import { fitPdfPageToCanvas } from "./pdf-presentation-object.js";

test("fitPdfPageToCanvas letterboxes landscape PDF without stretching", () => {
  assert.deepEqual(fitPdfPageToCanvas(640, 360, 1920, 1080), {
    scale: 3,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080
  });
  assert.deepEqual(fitPdfPageToCanvas(600, 800, 1920, 1080), {
    scale: 1.35,
    x: 555,
    y: 0,
    width: 810,
    height: 1080
  });
});
