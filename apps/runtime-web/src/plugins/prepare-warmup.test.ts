import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { TestQuickJSWASMModule, type QuickJSContext } from "quickjs-emscripten-core";
import { createPluginQuickJS } from "./quickjs-module.js";
import { PluginVm } from "./vm.js";
import { PROBE_FIXTURES } from "./probe-fixtures.js";
import { SANDBOX_LIMITS, SandboxError } from "./limits.js";

let compiled: WebAssembly.Module;
before(async () => {
  compiled = await WebAssembly.compile(Uint8Array.from(await readFile(new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")))));
});
const ready = JSON.stringify({ sdkApiVersion: 1, type: "room.ready", snapshot: { ownParticipantAlias: "own", arrivalAllowed: false, seats: [] } });

test("trusted warmup disposes its own realm/runtime before fresh guest lifecycle, without retained quota or callbacks", async () => {
  const module = new TestQuickJSWASMModule(await createPluginQuickJS(compiled));
  const contexts: QuickJSContext[] = [];
  const tracked = {
    newContext() { const context = module.newContext(); contexts.push(context); return context; },
    getWasmMemory: () => module.getWasmMemory()
  };
  PluginVm.warmup(tracked);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].alive, false);
  assert.equal(contexts[0].runtime.alive, false);
  module.assertNoMemoryAllocated();
  const guest = new PluginVm(tracked, { approvedCapabilities: ["status.set"] });
  try {
    assert.equal(contexts.length, 2);
    assert.notEqual(contexts[0], contexts[1]);
    // Warmup used two status requests, but the guest's own native/VM counters
    // must start empty. Both real-clock status turns remain under 50ms.
    const init = guest.init(PROBE_FIXTURES.healthy);
    assert.equal(init.requests.length, 1); assert.ok(init.executionMs <= 50);
    assert.deepEqual({ ...init.requests[0].payload }, { text: "Welcome plugin initialized" });
    const event = guest.event(ready);
    assert.equal(event.requests.length, 1); assert.ok(event.executionMs <= 50);
    assert.deepEqual({ ...event.requests[0].payload }, { text: "Welcome" });
    guest.dispose();
  } finally { guest.close(); module.assertNoMemoryAllocated(); }
});

test("trusted prepare status approval never transfers to a guest with empty approvals", async () => {
  const module = new TestQuickJSWASMModule(await createPluginQuickJS(compiled));
  PluginVm.warmup(module); module.assertNoMemoryAllocated();
  const guest = new PluginVm(module, { approvedCapabilities: [] });
  try {
    const turn = guest.init(`export async function init(context) {
      try { await context.sdk.status.set("MUST NOT COMMIT"); throw new Error("approval leaked"); }
      catch (error) { if (error !== "capability-denied") throw error; }
    }`);
    assert.deepEqual(turn.requests, []);
    guest.dispose();
  } finally { guest.close(); module.assertNoMemoryAllocated(); }
});

test("warmup does not relax the real guest execution, stack, heap or linear-memory fences", async () => {
  const module = new TestQuickJSWASMModule(await createPluginQuickJS(compiled));
  PluginVm.warmup(module);
  assert.equal(SANDBOX_LIMITS.handlerBudgetMs, 50);
  assert.equal(SANDBOX_LIMITS.vmHeapBytes, 16 * 1024 * 1024);
  assert.equal(SANDBOX_LIMITS.vmStackBytes, 32 * 1024);
  assert.equal(SANDBOX_LIMITS.wasmMaxMemoryBytes, 48 * 1024 * 1024);
  for (const [fixture, code, hint] of [
    ["loop", "execution_timeout", undefined], ["heapLimit", "guest_exception", "memory_exhausted"],
    ["stack", "guest_exception", "stack_exhausted"]
  ] as const) {
    const guest = new PluginVm(module, { approvedCapabilities: ["status.set"] });
    try {
      if (fixture === "loop") assert.throws(() => guest.init(PROBE_FIXTURES[fixture]), (error: unknown) => error instanceof SandboxError && ["execution_timeout", "interrupt_limit"].includes(error.code));
      else assert.throws(() => guest.init(PROBE_FIXTURES[fixture]), { code, exceptionHint: hint });
      assert.throws(() => guest.event(ready), { code: "instance_closed" });
    } finally { guest.close(); module.assertNoMemoryAllocated(); }
  }
});
