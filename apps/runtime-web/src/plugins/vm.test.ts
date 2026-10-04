import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { TestQuickJSWASMModule } from "quickjs-emscripten-core";
import { createPluginQuickJS } from "./quickjs-module.js";
import { PluginVm } from "./vm.js";
import { ExecutionBudget, SANDBOX_LIMITS, SandboxError, type SandboxFailure } from "./limits.js";
import { PROBE_FIXTURES, type ProbeFixture } from "./probe-fixtures.js";

let module: TestQuickJSWASMModule;
let compiledWasm: WebAssembly.Module;
const approvedCapabilities = ["status.set"] as const;
before(async () => {
  const binary = await readFile(new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")));
  compiledWasm = await WebAssembly.compile(Uint8Array.from(binary));
  module = new TestQuickJSWASMModule(await createPluginQuickJS(compiledWasm));
});
const ready = JSON.stringify({ sdkApiVersion: 1, type: "room.ready", snapshot: { ownParticipantAlias: "own-alias", arrivalAllowed: false, seats: [] } });

function failed(fixture: ProbeFixture, codes: SandboxFailure[]): void {
  const usesRealDeadline = ["loop", "exceptionProxy", "serializerProxy"].includes(fixture);
  const vm = new PluginVm(module, usesRealDeadline ? { approvedCapabilities } : { approvedCapabilities, clock: () => 0 });
  try {
    assert.throws(() => vm.init(PROBE_FIXTURES[fixture]), (error: unknown) => {
      assert.ok(error instanceof SandboxError);
      assert.ok(codes.includes(error.code), `${fixture}: actual ${error.code}, expected ${codes.join(" or ")}`);
      return true;
    });
    assert.throws(() => vm.event(ready), { code: "instance_closed" });
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
}

test("real release-sync QuickJS runs the current standalone welcome-status ESM ABI", async () => {
  const source = await readFile(new URL("../../../../packages/room-plugin-sdk/examples/welcome-status/entry.js", import.meta.url), "utf8");
  // ABI/leak assertions use a deterministic clock so unrelated Node test-file
  // scheduling cannot consume a guest deadline. Deadline probes use real time.
  const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
  try {
    const init = vm.init(source, { greeting: "Hello from config" });
    assert.equal(init.requests[0]?.operation, "status.set");
    assert.deepEqual({ ...init.requests[0]?.payload }, { text: "Welcome plugin initialized" });
    assert.deepEqual({ ...vm.event(ready).requests[0]?.payload }, { text: "Hello from config" });
    assert.deepEqual(vm.dispose().requests, []);
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("100 real init/event/dispose cycles release every context/runtime/handle", () => {
  for (let i = 0; i < 100; i++) {
    const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
    try {
      assert.equal(vm.init(PROBE_FIXTURES.healthy).requests.length, 1);
      assert.equal(vm.event(ready).requests.length, 1);
      vm.dispose();
    } finally { vm.close(); }
    module.assertNoMemoryAllocated();
  }
});

test("two independent VM instances and ambient globals do not share authority", () => {
  const companion = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
  const hostile = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
  try {
    companion.init(PROBE_FIXTURES.healthy);
    assert.deepEqual({ ...hostile.init(PROBE_FIXTURES.globals).requests[0]?.payload }, { text: "VM globals and network unavailable" });
    hostile.close();
    assert.deepEqual({ ...companion.event(ready).requests[0]?.payload }, { text: "Welcome" });
  } finally { companion.close(); hostile.close(); module.assertNoMemoryAllocated(); }
});

for (const [fixture, codes] of [
  ["loop", ["execution_timeout", "interrupt_limit"]],
  ["heap", ["guest_exception"]], ["stack", ["guest_exception"]],
  ["promiseFlood", ["job_limit", "execution_timeout"]],
  ["oversizeReturn", ["message_too_large"]], ["oversizeSdk", ["message_too_large"]],
  ["accessor", ["invalid_data"]], ["toJSON", ["invalid_data"]],
  ["prototype", ["invalid_data"]], ["cycle", ["invalid_data"]],
  ["deep", ["nesting_too_deep"]], ["nodes", ["node_limit"]],
  ["exceptionGetter", ["guest_exception"]], ["exceptionProxy", ["execution_timeout", "interrupt_limit"]],
  ["serializerProxy", ["execution_timeout", "interrupt_limit"]],
  ["inheritedToJSON", ["invalid_data"]], ["descriptorPoison", ["invalid_data"]],
  ["bridgeFlood", ["bridge_rate_limit"]], ["statusFlood", ["status_rate_limit"]],
  ["failedAfterJobs", ["job_limit", "execution_timeout"]],
  ["staticImport", ["guest_exception"]], ["dynamicImport", ["guest_exception"]],
  ["generatedImport", ["guest_exception"]], ["pending", ["pending_promise"]]
] as [ProbeFixture, SandboxFailure[]][]) {
  test(`real VM contains ${fixture} with a specific bounded failure`, () => failed(fixture, codes));
}

test("captured primordials survive guest replacement before serialization", () => {
  const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
  try { assert.deepEqual({ ...vm.init(PROBE_FIXTURES.primordialTamper).requests[0]?.payload }, { text: "Captured primordials intact" }); }
  finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("seating returns explicit denial; no simulated backend claim or native request", () => {
  const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
  try {
    const turn = vm.init(PROBE_FIXTURES.seatingDenied);
    assert.equal(turn.requests.length, 1);
    assert.equal(turn.requests[0]?.operation, "status.set");
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("an instance cannot be initialized twice or leak overwritten helper handles", () => {
  const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
  try {
    vm.init(PROBE_FIXTURES.healthy);
    assert.throws(() => vm.init(PROBE_FIXTURES.healthy), { code: "invalid_lifecycle" });
    assert.throws(() => vm.event(ready), { code: "instance_closed" });
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("32KiB VM guard contains JS recursion and native C deep JSON/join without native failure", () => {
  assert.equal(SANDBOX_LIMITS.vmStackBytes, 32 * 1024);
  for (const fixture of ["stack", "nativeJsonStack", "nativeJoinStack"] as const) {
    const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
    try {
      assert.throws(() => vm.init(PROBE_FIXTURES[fixture]), { code: "guest_exception", exceptionHint: "stack_exhausted" });
      assert.throws(() => vm.event(ready), { code: "instance_closed" });
    } finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("20MiB allocation detects the 16MiB VM heap fence; heap-off mutant still hits the independent 48MiB linear cap at 64MiB", async () => {
  assert.equal(SANDBOX_LIMITS.vmHeapBytes, 16 * 1024 * 1024);
  assert.equal(SANDBOX_LIMITS.wasmMaxMemoryBytes, 48 * 1024 * 1024);
  assert.ok(SANDBOX_LIMITS.wasmInitialMemoryBytes + 20 * 1024 * 1024 < SANDBOX_LIMITS.wasmMaxMemoryBytes);
  for (const { fixture, heapFence } of [
    { fixture: "heapLimit", heapFence: true },
    { fixture: "heapLimit", heapFence: false },
    { fixture: "heap", heapFence: false }
  ] as const) {
    // Fresh real WASM memory per case. Mutation intercepts only this context's
    // heap-limit setter; production sources and the 48MiB linear cap stay fixed.
    const isolated = new TestQuickJSWASMModule(await createPluginQuickJS(compiledWasm));
    const limitCalls: number[] = [];
    const heapControl = {
      newContext() {
        const context = isolated.newContext();
        const setMemoryLimit = context.runtime.setMemoryLimit.bind(context.runtime);
        context.runtime.setMemoryLimit = (limit) => {
          limitCalls.push(limit);
          setMemoryLimit(heapFence ? limit : -1);
        };
        return context;
      },
      getWasmMemory: () => isolated.getWasmMemory()
    };
    const vm = new PluginVm(heapControl, { approvedCapabilities, clock: () => 0 });
    try {
      if (!heapFence && fixture === "heapLimit") {
        const turn = vm.init(PROBE_FIXTURES[fixture]);
        assert.deepEqual(turn.requests, []);
        assert.ok(turn.wasmMemoryBytes >= 20 * 1024 * 1024);
        assert.ok(turn.wasmMemoryBytes <= SANDBOX_LIMITS.wasmMaxMemoryBytes);
      } else {
        // The hint is bounded, untrusted diagnostic data, not the causal proof.
        // The otherwise identical heap-off success above isolates the VM fence.
        assert.throws(() => vm.init(PROBE_FIXTURES[fixture]), { code: "guest_exception", exceptionHint: "memory_exhausted" });
        assert.throws(() => vm.event(ready), { code: "instance_closed" });
      }
      assert.ok(limitCalls.length > 0, "heap-control mutation was exercised");
      assert.ok(isolated.getWasmMemory().buffer.byteLength <= SANDBOX_LIMITS.wasmMaxMemoryBytes);
    } finally { vm.close(); isolated.assertNoMemoryAllocated(); }
  }
});

test("exception names/messages cannot spoof a proven native memory/stack failure", () => {
  for (const source of [
    "export function init() { throw new Error('out of memory'); }",
    "export function init() { throw new RangeError('stack overflow'); }",
    "export function init() { throw { name: 'InternalError', message: 'out of memory' }; }",
    "export function init() { throw new InternalError('out of memory'); }"
  ]) {
    const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
    try { assert.throws(() => vm.init(source), { code: "guest_exception" }); }
    finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("VM independently denies status with explicit empty approvals and rejects missing approvals", () => {
  assert.throws(() => new PluginVm(module, {} as never), { code: "invalid_input" });
  const vm = new PluginVm(module, { approvedCapabilities: [], clock: () => 0 });
  try {
    const turn = vm.init(`export async function init(context) {
      try { await context.sdk.status.set("MUST NOT COMMIT"); throw new Error("default allow"); }
      catch (error) { if (error !== "capability-denied") throw error; }
    }`);
    assert.deepEqual(turn.requests, []);
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("SDK config/event validation failures are invalid_input, never native_failure", () => {
  for (const eventJson of ["{}", "[".repeat(9) + "0" + "]".repeat(9)]) {
    const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
    try {
      vm.init("export function init() {}");
      assert.throws(() => vm.event(eventJson), { code: "invalid_input" });
    } finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("fatal event/dispose loops close the instance without restarting", () => {
  for (const fixture of ["eventLoop", "disposeLoop"] as const) {
    const vm = new PluginVm(module, { approvedCapabilities });
    try {
      vm.init(PROBE_FIXTURES[fixture]);
      assert.throws(() => fixture === "eventLoop" ? vm.event(ready) : vm.dispose(), (error: unknown) => error instanceof SandboxError && ["execution_timeout", "interrupt_limit"].includes(error.code));
      assert.throws(() => vm.event(ready), { code: "instance_closed" });
    } finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("all native getString calls receive pre-bounded trusted primitive strings, including huge thrown values", () => {
  let conversions = 0;
  const observations: { type: string; length?: number }[] = [];
  const trackedModule = {
    newContext() {
      const context = module.newContext();
      const original = context.getString.bind(context);
      context.getString = (handle) => {
        const type = context.typeof(handle);
        if (type !== "string") { observations.push({ type }); return ""; }
        const length = context.getProp(handle, "length");
        let size: number;
        try { size = context.getNumber(length); }
        finally { length.dispose(); }
        observations.push({ type, length: size });
        // Record violations before conversion without throwing an assertion that
        // the component could normalize into an expected guest failure.
        if (!Number.isInteger(size) || size < 0 || size > SANDBOX_LIMITS.messageBytes) return "";
        conversions++;
        return original(handle);
      };
      return context;
    },
    getWasmMemory: () => module.getWasmMemory()
  };
  for (const [source, code] of [
    [PROBE_FIXTURES.oversizeReturn, "message_too_large"],
    [PROBE_FIXTURES.oversizeSdk, "message_too_large"],
    ["export function init() { throw new Error('x'.repeat(1024 * 1024)); }", "guest_exception"],
    ["export function init() { throw 'x'.repeat(1024 * 1024); }", "guest_exception"]
  ]) {
    const vm = new PluginVm(trackedModule, { approvedCapabilities, clock: () => 0 });
    try { assert.throws(() => vm.init(source), { code }); }
    finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
  assert.ok(conversions > 0);
  assert.ok(observations.length > 0);
  for (const observation of observations) {
    assert.equal(observation.type, "string", "no native coercion of a guest object");
    assert.ok(Number.isInteger(observation.length) && observation.length! >= 0 && observation.length! <= SANDBOX_LIMITS.messageBytes, "size bound BEFORE getString");
  }
});

test("serializer rejects non-enumerables, functions, symbols, reserved keys, sparse arrays and nonfinite numbers", () => {
  for (const expression of [
    "Object.defineProperty({}, 'x', { value: 1 })", "{ x() {} }", "{ [Symbol('x')]: 1 }",
    "JSON.parse('{\"__proto__\":1}')", "[,,]", "{ x: Infinity }", "{ x: undefined }"
  ]) {
    const vm = new PluginVm(module, { approvedCapabilities, clock: () => 0 });
    try {
      assert.throws(() => vm.init(`export function init() { return (${expression}); }`), (error: unknown) => error instanceof SandboxError && ["invalid_data", "unsafe_key"].includes(error.code));
    } finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("invalid callbacks/top-level await/async rejected values are not coerced", () => {
  for (const source of [
    "export const init = 1;", "await new Promise(() => {}); export function init() {}",
    "export async function init() { throw { get message() { while(true) {} } }; }"
  ]) {
    const vm = new PluginVm(module, { approvedCapabilities });
    try { assert.throws(() => vm.init(source), (error: unknown) => error instanceof SandboxError && ["invalid_lifecycle", "pending_promise", "guest_exception"].includes(error.code)); }
    finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("fake-clock sustained real VM turns deterministically exhaust cumulative second budget below 50ms/turn", () => {
  let now = 0;
  let ticking = false;
  const clock = () => { if (ticking) now += 1; return now; };
  const vm = new PluginVm(module, { approvedCapabilities, clock });
  try {
    vm.init("export function init() {} export function onEvent() { let n = 0; for (let i = 0; i < 10; i++) n += i; }");
    ticking = true;
    let turns = 0;
    assert.throws(() => {
      for (; turns < 30; turns++) assert.ok(vm.event(ready).executionMs < SANDBOX_LIMITS.handlerBudgetMs);
    }, { code: "execution_budget_second" });
    assert.ok(turns > 0 && turns < 30);
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("rolling budgets enforce 100ms/s and 2s/min, with deterministic expiry", () => {
  const second = new ExecutionBudget();
  for (let i = 0; i < 5; i++) assert.equal(second.charge(i * 100, 20), undefined);
  assert.equal(second.charge(500, 1), "execution_budget_second");
  assert.equal(second.charge(1500, 20), undefined);
  const minute = new ExecutionBudget();
  for (let i = 0; i < 100; i++) assert.equal(minute.charge(i * 500, 20), undefined);
  assert.equal(minute.charge(50000, 20), "execution_budget_minute");
  assert.equal(minute.charge(110000, 20), undefined);
});

test("fake-clock sustained real VM events spaced below the second limit exhaust the minute limit", () => {
  let now = 0;
  let ticking = false;
  const vm = new PluginVm(module, { approvedCapabilities, clock: () => { if (ticking) now += 2; return now; } });
  try {
    vm.init("export function onEvent() {}");
    ticking = true;
    let turns = 0;
    assert.throws(() => {
      for (; turns < 120; turns++) {
        now = turns * 500;
        assert.ok(vm.event(ready).executionMs < SANDBOX_LIMITS.handlerBudgetMs);
      }
    }, { code: "execution_budget_minute" });
    assert.ok(turns > 20 && turns < 120);
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});
