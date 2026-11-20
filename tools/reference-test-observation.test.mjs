import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Use the repository's TypeScript compiler, not Node's optional TS loader (CI is Node 22).
const source = ts.transpileModule(readFileSync(new URL("../tests/e2e/reference-test-observation.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText;
const { observeReferenceTest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("timings preserve the result/rejection and expose an in-flight evaluation without another page call", async () => {
  const page = new EventEmitter(); let clock = 10;
  const observation = observeReferenceTest(page, () => clock);
  let complete;
  const pending = observation.measure("occupied-ray", () => new Promise(resolve => { complete = resolve; }));
  clock = 5065;
  assert.deepEqual(observation.snapshot().timings, [{ phase: "occupied-ray", startedAtMs: 0, elapsedMs: 5055, status: "pending" }]);
  complete(null);
  assert.equal(await pending, null);
  const error = new Error("private detail must not enter snapshot");
  await assert.rejects(observation.measure("room-state", async () => { throw error; }), value => value === error);
  assert.equal(observation.snapshot().timings.at(-1).status, "rejected");
  assert.ok(!JSON.stringify(observation.snapshot()).includes(error.message));
  observation.stop();
});

test("passive socket observation filters unrelated transports and never retains URLs or frames", () => {
  const page = new EventEmitter(); const observation = observeReferenceTest(page, () => 1);
  const socket = url => Object.assign(new EventEmitter(), { url: () => url });
  page.emit("websocket", socket("invalid"));
  page.emit("websocket", socket("wss://example.test/rtc?accessToken=private"));
  const state = socket("wss://example.test/?roomId=secret-room&participantId=secret-person&accessToken=private");
  page.emit("websocket", state); state.emit("framereceived", { payload: "private-frame" });
  state.emit("socketerror", "private-error"); state.emit("close");
  assert.deepEqual(observation.snapshot().sockets.map(row => row.event), ["created", "error", "closed"]);
  assert.ok(!/private|secret/.test(JSON.stringify(observation.snapshot())));
  observation.stop(); observation.stop();
  assert.equal(page.listenerCount("websocket"), 0);
  assert.equal(state.listenerCount("close"), 0);
  assert.equal(state.listenerCount("socketerror"), 0);
  state.emit("close");
  assert.equal(observation.snapshot().sockets.length, 3);
});

test("diagnostics have finite retention even if a predicate repeatedly fails", async () => {
  const page = new EventEmitter(); const observation = observeReferenceTest(page, () => 1);
  for (let index = 0; index < 100; index++) {
    await observation.measure("occupied-ray", async () => "not-null");
    const socket = Object.assign(new EventEmitter(), { url: () => "wss://test/?roomId=r&participantId=p" });
    page.emit("websocket", socket); socket.emit("close");
  }
  assert.equal(observation.snapshot().timings.length, 48);
  assert.equal(observation.snapshot().sockets.length, 48);
  observation.stop();
});
