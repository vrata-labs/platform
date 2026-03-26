import test from "node:test";
import assert from "node:assert/strict";

test("api module exports server starter", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  const module = await import("./index.js");
  assert.equal(typeof module.startApiServer, "function");
  delete process.env.NOAH_DISABLE_AUTOSTART;
});
