import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerCommand, WorkerReply } from "./protocol.js";

test("real worker entry maps SDK validation errors to invalid_input and closes before module/guest execution", async () => {
  // Trusted platform-worker entry only; this import never loads plugin source.
  const scope = globalThis as unknown as {
    onmessage?: (event: MessageEvent<WorkerCommand>) => void;
    postMessage?: (reply: WorkerReply) => void;
    close?: () => void;
  };
  const previous = { onmessage: scope.onmessage, postMessage: scope.postMessage, close: scope.close };
  const replies: WorkerReply[] = [];
  let closed = false;
  scope.postMessage = (reply) => replies.push(reply);
  scope.close = () => { closed = true; };
  try {
    await import("./worker.js");
    assert.deepEqual(replies.shift(), { version: 1, type: "hello" });
    scope.onmessage!({ data: {
      version: 1, id: 1, type: "prepare",
      wasm: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      approvedCapabilities: ["unknown-capability"]
    } } as unknown as MessageEvent<WorkerCommand>);
    assert.equal(closed, true);
    assert.deepEqual(replies, [{ version: 1, type: "result", id: 1, ok: false, failure: "invalid_input" }]);
  } finally {
    scope.onmessage = previous.onmessage; scope.postMessage = previous.postMessage; scope.close = previous.close;
  }
});
