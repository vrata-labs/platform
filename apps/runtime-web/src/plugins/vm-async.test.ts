import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TestQuickJSWASMModule } from "quickjs-emscripten-core";
import { createPluginQuickJS } from "./quickjs-module.js";
import { PluginVm, type VmTurn } from "./vm.js";
import { SandboxError } from "./limits.js";

let module: TestQuickJSWASMModule;
before(async () => {
  const bytes = await readFile(new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")));
  module = new TestQuickJSWASMModule(await createPluginQuickJS(await WebAssembly.compile(Uint8Array.from(bytes))));
});
const answer = (id: string, error?: string) => JSON.stringify([{ sdkApiVersion: 1, requestId: id,
  ...(error ? { ok: false, error } : { ok: true, result: null }) }]);
function statusText(turn: VmTurn): string {
  const request = turn.requests[0]; assert.ok(request?.operation === "status.set"); return request.payload.text;
}

test("real async init waits for broker acknowledgement and resumes a separately bounded turn", () => {
  const vm = new PluginVm(module, { approvedCapabilities: ["status.set"], clock: () => 0 });
  try {
    const first = vm.init("export async function init(c) { await c.sdk.status.set('first'); await c.sdk.status.set('second'); }");
    assert.equal(first.lifecycle, "pending"); assert.equal(statusText(first), "first");
    const second = vm.respond(answer(first.requests[0].requestId));
    assert.equal(second.lifecycle, "pending"); assert.equal(statusText(second), "second");
    assert.notEqual(second.requests[0].requestId, first.requests[0].requestId);
    const complete = vm.respond(answer(second.requests[0].requestId));
    assert.equal(complete.lifecycle, "fulfilled"); assert.deepEqual(complete.requests, []);
    assert.equal(vm.dispose().lifecycle, "fulfilled");
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("host denial is a stable promise rejection inside the VM, never a fabricated success", () => {
  const vm = new PluginVm(module, { approvedCapabilities: ["status.set"], clock: () => 0 });
  try {
    const first = vm.init("export async function init(c) { try { await c.sdk.status.set('attempt'); throw 'false-success'; } catch(e) { if(e !== 'offline') throw e; await c.sdk.status.set('denied'); } }");
    const denied = vm.respond(answer(first.requests[0].requestId, "offline"));
    assert.equal(denied.lifecycle, "pending"); assert.equal(statusText(denied), "denied");
    assert.equal(vm.respond(answer(denied.requests[0].requestId)).lifecycle, "fulfilled");
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("a pending lifecycle with no outstanding SDK request still fails closed", () => {
  const vm = new PluginVm(module, { approvedCapabilities: ["status.set"], clock: () => 0 });
  try { assert.throws(() => vm.init("export function init() { return new Promise(() => {}); }"), { code: "pending_promise" }); }
  finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("unknown, replayed and duplicate response IDs cannot settle another VM request", () => {
  for (const mode of ["unknown", "duplicate", "replay"] as const) {
    const vm = new PluginVm(module, { approvedCapabilities: ["status.set"], clock: () => 0 });
    try {
      const first = vm.init("export async function init(c) { await c.sdk.status.set('first'); await c.sdk.status.set('second'); }");
      const response = JSON.parse(answer(first.requests[0].requestId))[0];
      if (mode === "replay") vm.respond(JSON.stringify([response]));
      const bytes = mode === "unknown" ? answer("999") : JSON.stringify(mode === "duplicate" ? [response, response] : [response]);
      assert.throws(() => vm.respond(bytes), { code: "worker_protocol" });
    } finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("response continuations keep the original execution and interrupt limits", () => {
  const vm = new PluginVm(module, { approvedCapabilities: ["status.set"] });
  try {
    const first = vm.init("export async function init(c) { await c.sdk.status.set('begin'); while(true) {} }");
    assert.throws(() => vm.respond(answer(first.requests[0].requestId)), (error: unknown) =>
      error instanceof SandboxError && ["execution_timeout", "interrupt_limit"].includes(error.code));
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("outstanding SDK promises are bounded across multiple response turns", () => {
  let now = 0;
  const vm = new PluginVm(module, { approvedCapabilities: ["seating.claimSelfOnEntry"], clock: () => now });
  try {
    const first = vm.init("let c; function more() { for(let i=0;i<10;i++) c.sdk.seating.claimSelfOnEntry('seat').then(more); } export function init(context) { c=context; more(); }");
    assert.equal(first.requests.length, 10); assert.equal(first.lifecycle, "pending");
    now = 1001; vm.respond(JSON.stringify([{ sdkApiVersion: 1, requestId: first.requests[0].requestId, ok: true, result: "accepted" }]));
    now = 2002; vm.respond(JSON.stringify([{ sdkApiVersion: 1, requestId: first.requests[1].requestId, ok: true, result: "accepted" }]));
    now = 3003;
    assert.throws(() => vm.respond(JSON.stringify([{ sdkApiVersion: 1, requestId: first.requests[2].requestId, ok: true, result: "accepted" }])), { code: "bridge_queue_limit" });
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});

test("100 pending-response shutdown cycles release every retained lifecycle handle", () => {
  for (let i = 0; i < 100; i++) {
    const vm = new PluginVm(module, { approvedCapabilities: ["status.set"], clock: () => 0 });
    try { assert.equal(vm.init("export async function init(c) { await c.sdk.status.set('pending'); }").lifecycle, "pending"); }
    finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("poisoned descriptor prototypes cannot reject an SDK promise before its broker acknowledgement", () => {
  for (const property of ["writable", "enumerable", "get", "set"]) {
    const vm = new PluginVm(module, { approvedCapabilities: ["status.set"], clock: () => 0 });
    try {
      const first = vm.init(`let reads=0; export async function init(c) {
        Object.defineProperty(Object.prototype, ${JSON.stringify(property)}, { get() { reads++; throw 'descriptor-poison'; }, configurable:true });
        await c.sdk.status.set('held'); if(reads) throw 'poison-ran';
      }`);
      assert.equal(first.lifecycle, "pending"); assert.equal(statusText(first), "held");
      assert.equal(vm.respond(answer(first.requests[0].requestId)).lifecycle, "fulfilled");
    } finally { vm.close(); module.assertNoMemoryAllocated(); }
  }
});

test("payload Proxy traps cannot reenter the trusted SDK request bookkeeping", () => {
  const vm = new PluginVm(module, { approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"], clock: () => 0 });
  try {
    assert.throws(() => vm.init(`export function init(c) {
      const seat = new Proxy({}, { getPrototypeOf() { try { c.sdk.status.set('MUST NOT COMMIT'); } catch {} return Object.prototype; } });
      try { c.sdk.seating.claimSelfOnEntry(seat); } catch {}
    }`), { code: "invalid_data" });
  } finally { vm.close(); module.assertNoMemoryAllocated(); }
});
