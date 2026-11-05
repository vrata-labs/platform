import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("../tests/e2e/functional-frame-budget.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

async function harness() {
  let now = 0, sequence = 0;
  const frames = new Map(), timers = new Map();
  const window = {
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const context = { exports: {}, window, performance: { now: () => now }, setTimeout: window.setTimeout };
  vm.runInNewContext(source, context);
  await context.exports.installFunctionalFrameBudget({ addInitScript: (callback, arg) => callback(arg) });
  return { window, frames, timers,
    work(ms) { now += ms; },
    frame(timestamp, dispatchAt = timestamp) {
      assert.equal(frames.size, 1);
      now = dispatchAt;
      const [id, callback] = frames.entries().next().value; frames.delete(id); callback(timestamp);
    },
    timer() {
      assert.equal(timers.size, 1);
      const [id, { callback, delay }] = timers.entries().next().value; timers.delete(id); now += delay; callback();
    }
  };
}

test("functional frames keep their idle budget after delayed dispatch and expensive callbacks", async () => {
  const h = await harness(), timestamps = [];
  h.window.requestAnimationFrame(timestamp => {
    timestamps.push(timestamp); h.work(1200);
    h.window.requestAnimationFrame(next => timestamps.push(next));
  });
  h.frame(100, 900);
  assert.deepEqual(timestamps, [100], "runtime callbacks retain the native RAF timestamp");
  assert.equal(h.frames.size, 0, "a callback cannot queue the next native frame while the batch is draining");
  assert.deepEqual([...h.timers.values()].map(value => value.delay), [100], "the idle budget starts after callback completion");
  h.timer(); h.frame(2200);
  assert.deepEqual(timestamps, [100, 2200]);
  assert.equal(h.frames.size + h.timers.size, 0);
});

test("functional frames coalesce requests and preserve cancellation inside a batch", async () => {
  const h = await harness(), calls = [];
  let cancelled;
  h.window.requestAnimationFrame(() => {
    calls.push("first"); h.window.cancelAnimationFrame(cancelled);
    h.window.requestAnimationFrame(() => calls.push("next"));
  });
  cancelled = h.window.requestAnimationFrame(() => calls.push("cancelled"));
  h.frame(0);
  assert.deepEqual(calls, ["first"]);
  assert.equal(h.frames.size, 0); h.timer(); h.frame(100);
  assert.deepEqual(calls, ["first", "next"]);
});

test("cancelling the last functional callback clears native requests and idle timers", async () => {
  const h = await harness();
  const first = h.window.requestAnimationFrame(() => assert.fail("cancelled native callback ran"));
  h.window.cancelAnimationFrame(first);
  assert.equal(h.frames.size + h.timers.size, 0);
  let next;
  h.window.requestAnimationFrame(() => { next = h.window.requestAnimationFrame(() => assert.fail("cancelled idle callback ran")); });
  h.frame(0);
  assert.equal(h.timers.size, 1);
  h.window.cancelAnimationFrame(next);
  assert.equal(h.frames.size + h.timers.size, 0);
});
