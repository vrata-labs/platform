import test from "node:test";
import assert from "node:assert/strict";
import type { KernelCommand, KernelReply } from "./kernel-protocol.js";
import type { WorkerCommand, WorkerReply } from "./protocol.js";
import { SANDBOX_LIMITS } from "./limits.js";

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
let fixtureSequence = 0;
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const turn = (pending = false) => JSON.stringify({ requests: pending ? [{ sdkApiVersion: 1, requestId: "1", operation: "status.set", payload: { text: "owned" } }] : [],
  executionMs: 1, jobs: 0, wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes, lifecycle: pending ? "pending" : "fulfilled" });

async function fixture(mode: "dispose-request" | "pending-init" | "no-hello") {
  const scope = globalThis as unknown as { onmessage?: (event: MessageEvent<KernelCommand>) => void; postMessage?: (reply: KernelReply) => void; close?: () => void; Worker?: unknown };
  const previous = new Map(["onmessage", "postMessage", "close", "Worker"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const guests: GuestDouble[] = [], replies: Array<{ reply: KernelReply; guestStopped: boolean }> = [];
  let closes = 0;
  class GuestDouble {
    onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null; onmessageerror = null; terminated = 0;
    constructor() { guests.push(this); if (mode !== "no-hello") queueMicrotask(() => this.reply({ version: 1, type: "hello", moduleAgeMs: 1 })); }
    reply(reply: WorkerReply) { this.onmessage?.({ data: reply } as MessageEvent<WorkerReply>); }
    postMessage(command: WorkerCommand) {
      queueMicrotask(() => {
        if (command.type === "prepare") this.reply({ version: 1, type: "prepared", id: command.id, wasmMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes, prepareMs: 2 });
        else this.reply({ version: 1, type: "result", id: command.id, ok: true,
          turnJson: turn(command.type === "init" && mode === "pending-init" || command.type === "dispose" && mode === "dispose-request") });
      });
    }
    terminate() { this.terminated++; }
  }
  scope.Worker = GuestDouble;
  scope.postMessage = reply => replies.push({ reply, guestStopped: Boolean(guests[0]?.terminated) });
  scope.close = () => { closes++; };
  try { await import(`./supervisor-worker.js?owned-test=${mode}-${++fixtureSequence}`); }
  catch (error) { restore(); throw error; }
  function restore() {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
  return { guests, replies, closes: () => closes, restore,
    send(command: KernelCommand) { scope.onmessage!({ data: command } as MessageEvent<KernelCommand>); } };
}

test("real trusted kernel stops its guest before dispose result and posts one closure ACK after it", async () => {
  const f = await fixture("dispose-request");
  try {
    f.send({ version: 1, type: "prepare", id: 1, wasm, approvedCapabilities: ["status.set"] }); await flush();
    assert.equal(f.replies.at(-1)?.reply.type, "prepared");
    f.send({ version: 1, type: "init", id: 2, source: "owned-source", config: {} }); await flush();
    assert.equal(f.replies.at(-1)?.reply.type, "result");
    f.send({ version: 1, type: "dispose", id: 3 }); await flush();
    const end = f.replies.slice(-2);
    assert.deepEqual(end.map(row => row.reply.type), ["result", "closed"]);
    assert.ok(end.every(row => row.guestStopped)); assert.equal(f.closes(), 1);
    assert.equal(f.replies.some(row => row.reply.type === "requests"), false, "dispose SDK effects never reach the native broker");
  } finally { f.send({ version: 1, type: "terminate" }); await flush(); f.restore(); }
});

test("terminate during a pending native batch stops the child and suppresses late respond/cancel work", async () => {
  const f = await fixture("pending-init");
  try {
    f.send({ version: 1, type: "prepare", id: 1, wasm, approvedCapabilities: ["status.set"] }); await flush();
    f.send({ version: 1, type: "init", id: 2, source: "owned-source", config: {} }); await flush();
    const request = f.replies.at(-1)!.reply; assert.ok(request.type === "requests");
    f.send({ version: 1, type: "terminate" }); await flush();
    assert.equal(f.guests[0].terminated > 0, true); assert.equal(f.closes(), 1);
    const count = f.replies.length;
    f.send({ version: 1, type: "respond", actionId: request.actionId, batchId: request.batchId,
      responsesJson: '[{"sdkApiVersion":1,"requestId":"1","ok":true,"result":null}]' }); await flush();
    assert.equal(f.replies.length, count); assert.equal(f.replies.at(-1)!.reply.type, "closed");
    assert.equal(f.replies.some(row => row.reply.type === "cancel"), false);
  } finally { f.send({ version: 1, type: "terminate" }); await flush(); f.restore(); }
});

test("guest boot failure closes the owned child before its ACK and ignores a late host response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture("no-hello");
  try {
    f.send({ version: 1, type: "prepare", id: 1, wasm, approvedCapabilities: [] }); await flush();
    t.mock.timers.tick(SANDBOX_LIMITS.workerModuleLoadDeadlineMs); await flush();
    const failure = f.replies.find(row => row.reply.type === "failed")!.reply;
    assert.ok(failure.type === "failed" && failure.channel === "sandbox"); assert.equal(failure.failure, "worker_boot_timeout");
    assert.equal(f.replies.at(-1)?.guestStopped, true); assert.equal(f.closes(), 1);
    const count = f.replies.length;
    f.send({ version: 1, type: "respond", actionId: 1, batchId: 1, responsesJson: "[]" }); await flush(); assert.equal(f.replies.length, count);
  } finally { f.send({ version: 1, type: "terminate" }); await flush(); f.restore(); }
});

test("an idle guest error is reported unsolicited and closes only the owned kernel", async () => {
  const f = await fixture("dispose-request");
  try {
    f.send({ version: 1, type: "prepare", id: 1, wasm, approvedCapabilities: [] }); await flush();
    f.send({ version: 1, type: "init", id: 2, source: "owned-source", config: {} }); await flush();
    f.guests[0].onerror!({ preventDefault() {} } as ErrorEvent); await flush();
    const failure = f.replies.find(row => row.reply.type === "failed")!.reply;
    assert.ok(failure.type === "failed" && failure.channel === "sandbox"); assert.equal(failure.id, null); assert.equal(failure.failure, "worker_error");
    assert.equal(f.replies.at(-1)?.reply.type, "closed"); assert.equal(f.closes(), 1); assert.ok(f.guests[0].terminated);
  } finally { f.send({ version: 1, type: "terminate" }); await flush(); f.restore(); }
});
