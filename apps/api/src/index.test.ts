import test from "node:test";
import assert from "node:assert/strict";

test("api module exports server starter", async () => {
  const module = await import("./index.js");
  assert.equal(typeof module.startApiServer, "function");
});
