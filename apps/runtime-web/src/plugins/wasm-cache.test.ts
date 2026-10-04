import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { TrustedWasmModuleCache } from "./wasm-cache.js";
import { createPluginQuickJS } from "./quickjs-module.js";
import { SANDBOX_LIMITS } from "./limits.js";

const minimal = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

test("main-thread module cache fetches/compiles once and returns the same clonable Module", async () => {
  let fetches = 0, compilations = 0;
  const fetchOptions: { credentials?: RequestCredentials; redirect?: RequestRedirect }[] = [];
  const cache = new TrustedWasmModuleCache("https://trusted.invalid/quickjs.wasm", async (_url, options) => {
    fetches++; fetchOptions.push({ credentials: options?.credentials, redirect: options?.redirect }); return new Response(minimal);
  }, async (bytes) => { compilations++; return WebAssembly.compile(bytes); });
  const [one, two] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(one, two); assert.equal(await cache.get(), one);
  assert.ok(structuredClone(one) instanceof WebAssembly.Module);
  assert.equal(fetches, 1); assert.equal(compilations, 1);
  assert.deepEqual(fetchOptions, [{ credentials: "omit", redirect: "error" }]);
});

test("native browser fetch receives its global receiver, not the cache object", async () => {
  const receivers: unknown[] = [];
  const cache = new TrustedWasmModuleCache("https://trusted.invalid/quickjs.wasm", async function (this: unknown) {
    receivers.push(this); return new Response(minimal);
  });
  assert.ok(await cache.get() instanceof WebAssembly.Module);
  assert.equal(receivers.length, 1);
  assert.equal(receivers[0], globalThis);
});

test("fetch and compilation failures reset the cache for explicit retry", async () => {
  for (const failingStage of ["fetch", "compile"]) {
    let fetches = 0, compilations = 0;
    const cache = new TrustedWasmModuleCache("https://trusted.invalid/quickjs.wasm", async () => {
      if (++fetches === 1 && failingStage === "fetch") throw new Error("network");
      return new Response(minimal);
    }, async (bytes) => {
      if (++compilations === 1 && failingStage === "compile") throw new Error("compile");
      return WebAssembly.compile(bytes);
    });
    await assert.rejects(cache.get(), { code: "wasm_load_failed" });
    assert.ok(await cache.get() instanceof WebAssembly.Module);
    assert.equal(fetches, 2);
  }
});

test("cache bounds stalled compilation and oversized input before compile", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const stalled = new TrustedWasmModuleCache("https://trusted.invalid/quickjs.wasm", async (_url, options) => {
    signal = options?.signal as AbortSignal; return new Response(minimal);
  }, () => new Promise(() => {}));
  const rejected = assert.rejects(stalled.get(), { code: "wasm_load_failed" });
  t.mock.timers.tick(SANDBOX_LIMITS.wasmLoadDeadlineMs); await rejected;
  assert.equal(signal?.aborted, true);
  const compileCalls: ArrayBuffer[] = [];
  const excessive = new TrustedWasmModuleCache("https://trusted.invalid/quickjs.wasm", async () => new Response(new Uint8Array(SANDBOX_LIMITS.wasmBytes + 1)), async (bytes) => {
    compileCalls.push(bytes); return WebAssembly.compile(minimal);
  });
  await assert.rejects(excessive.get(), { code: "wasm_load_failed" });
  assert.deepEqual(compileCalls, [], "oversized bytes must not reach compile, even if its error would be normalized");
});

test("real pinned newVariant wasmMemory hook enforces 48MiB, for bytes and compiled-module loading", async () => {
  const bytes = Uint8Array.from(await readFile(new URL(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")))).buffer;
  const compiled = await WebAssembly.compile(bytes);
  for (const input of [bytes, compiled]) {
    const module = await createPluginQuickJS(input);
    const memory = module.getWasmMemory();
    assert.equal(memory.buffer.byteLength, SANDBOX_LIMITS.wasmInitialMemoryBytes);
    memory.grow((SANDBOX_LIMITS.wasmMaxMemoryBytes - memory.buffer.byteLength) / 65536);
    assert.equal(memory.buffer.byteLength, 48 * 1024 * 1024);
    assert.throws(() => memory.grow(1), RangeError);
    assert.equal(memory.buffer.byteLength, 48 * 1024 * 1024);
  }
});
