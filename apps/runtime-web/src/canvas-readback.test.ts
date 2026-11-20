import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readCanvasPixels } from "./canvas-readback.js";
import { captureCanvasDiagnostics } from "./scene-debug.js";

function harness(t: TestContext, options: { alpha?: boolean; premultiplied?: boolean; width?: number; height?: number; pixels?: number[] } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0, id = 0, lost = false, status = 0, incomplete = false, failCopy = false;
  let silentFailure: "allocation" | "read" | "copy" | "copy-loss" | undefined;
  const errors = new Set<number>();
  t.mock.method(performance, "now", () => now);
  const names = ["READ_FRAMEBUFFER_BINDING", "DRAW_FRAMEBUFFER_BINDING", "TEXTURE_BINDING_2D", "PIXEL_UNPACK_BUFFER_BINDING", "PIXEL_PACK_BUFFER_BINDING",
    "PACK_ALIGNMENT", "PACK_ROW_LENGTH", "PACK_SKIP_PIXELS", "PACK_SKIP_ROWS", "SCISSOR_TEST", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "TEXTURE_MAG_FILTER",
    "LINEAR", "NEAREST", "RGB8", "RGBA8", "RGB", "RGBA", "UNSIGNED_BYTE", "FRAMEBUFFER", "COLOR_ATTACHMENT0", "FRAMEBUFFER_COMPLETE",
    "PIXEL_PACK_BUFFER", "PIXEL_UNPACK_BUFFER", "STREAM_READ", "READ_FRAMEBUFFER", "DRAW_FRAMEBUFFER", "READ_BUFFER", "BACK", "COLOR_BUFFER_BIT",
    "SYNC_GPU_COMMANDS_COMPLETE", "ALREADY_SIGNALED", "CONDITION_SATISFIED", "TIMEOUT_EXPIRED", "WAIT_FAILED", "OUT_OF_MEMORY", "INVALID_OPERATION"] as const;
  const constants = Object.fromEntries(names.map((name, index) => [name, index + 1])) as Record<(typeof names)[number], number>;
  const states = new Map<number, unknown>();
  const calls: Array<{ type: string; args: unknown[] }> = [], allocated = new Set<object>();
  const record = (type: string, ...args: unknown[]) => { calls.push({ type, args }); };
  const create = (type: string) => { const resource = { type, id: ++id }; allocated.add(resource); record("create", resource); return resource; };
  const remove = (resource: object) => { assert.ok(allocated.delete(resource)); record("delete", resource); };
  const gl = {
    ...constants, NO_ERROR: 0, drawingBufferWidth: options.width ?? 2, drawingBufferHeight: options.height ?? 2,
    isContextLost: () => lost,
    getError: () => { record("get-error"); const error = errors.values().next().value ?? 0; errors.delete(error); return error; },
    getContextAttributes: () => ({ alpha: options.alpha ?? false, premultipliedAlpha: options.premultiplied ?? true }),
    getParameter: (key: number) => states.get(key),
    isEnabled: (key: number) => Boolean(states.get(key)),
    enable: (key: number) => states.set(key, true), disable: (key: number) => states.set(key, false),
    createTexture: () => create("texture"), createFramebuffer: () => create("framebuffer"), createBuffer: () => create("buffer"),
    deleteTexture: remove, deleteFramebuffer: remove, deleteBuffer: remove, deleteSync: remove,
    bindTexture: (_target: number, value: unknown) => states.set(constants.TEXTURE_BINDING_2D, value),
    bindBuffer: (target: number, value: unknown) => states.set(target === constants.PIXEL_PACK_BUFFER ? constants.PIXEL_PACK_BUFFER_BINDING : constants.PIXEL_UNPACK_BUFFER_BINDING, value),
    bindFramebuffer: (target: number, value: unknown) => {
      if (target !== constants.DRAW_FRAMEBUFFER) states.set(constants.READ_FRAMEBUFFER_BINDING, value);
      if (target !== constants.READ_FRAMEBUFFER) states.set(constants.DRAW_FRAMEBUFFER_BINDING, value);
    },
    texParameteri: () => {}, texImage2D: (...args: unknown[]) => record("texture-image", ...args), framebufferTexture2D: () => {},
    checkFramebufferStatus: () => incomplete ? -1 : constants.FRAMEBUFFER_COMPLETE,
    bufferData: (...args: unknown[]) => { record("buffer-data", ...args); if (silentFailure === "allocation") errors.add(constants.OUT_OF_MEMORY); },
    pixelStorei: (key: number, value: number) => states.set(key, value),
    readBuffer: (value: number) => states.set(constants.READ_BUFFER, value),
    blitFramebuffer: (...args: unknown[]) => record("blit", ...args),
    readPixels: (...args: unknown[]) => {
      record("read-pixels", ...args);
      if (silentFailure === "allocation" || silentFailure === "read") errors.add(constants.INVALID_OPERATION);
    },
    fenceSync: () => create("sync"), flush: () => record("flush"),
    clientWaitSync: (_sync: unknown, flags: number, timeout: number) => {
      assert.equal(flags, 0); assert.equal(timeout, 0); record("wait"); return status;
    },
    getBufferSubData: (_target: number, _offset: number, data: Uint8Array) => {
      assert.ok(status === constants.ALREADY_SIGNALED || status === constants.CONDITION_SATISFIED);
      record("copy"); if (failCopy) throw new Error("copy-failed");
      if (silentFailure === "copy-loss") { lost = true; return; }
      if (silentFailure) { if (silentFailure !== "read") errors.add(constants.INVALID_OPERATION); return; }
      data.set((options.pixels ?? [0, 0, 0, 255, 192, 64, 32, 255, 0, 0, 0, 255, 64, 128, 192, 255]).slice(0, data.length));
    }
  };
  for (const key of [constants.READ_FRAMEBUFFER_BINDING, constants.DRAW_FRAMEBUFFER_BINDING, constants.TEXTURE_BINDING_2D,
    constants.PIXEL_UNPACK_BUFFER_BINDING, constants.PIXEL_PACK_BUFFER_BINDING]) states.set(key, { foreign: key });
  for (const key of [constants.PACK_ALIGNMENT, constants.PACK_ROW_LENGTH, constants.PACK_SKIP_PIXELS, constants.PACK_SKIP_ROWS]) states.set(key, 4);
  states.set(constants.SCISSOR_TEST, true); states.set(constants.READ_BUFFER, constants.BACK);
  status = constants.TIMEOUT_EXPIRED;
  const canvas = { getContext(kind: string) { assert.equal(kind, "webgl2"); return gl; } } as unknown as HTMLCanvasElement;
  return { gl, canvas, states, calls, allocated,
    setLost() { lost = true; }, signal() { status = constants.CONDITION_SATISFIED; }, failWait() { status = constants.WAIT_FAILED; },
    incomplete() { incomplete = true; }, failCopy() { failCopy = true; },
    silentFailure(value: typeof silentFailure) { silentFailure = value; }, errors,
    async tick(ms = 16) { now += ms; t.mock.timers.tick(ms); for (let i = 0; i < 8; i++) await Promise.resolve(); }
  };
}

test("GPU readback yields until the fence and restores renderer bindings before and after waiting", async t => {
  const h = harness(t), before = new Map(h.states);
  const pending = readCanvasPixels(h.canvas);
  assert.deepEqual(h.states, before); assert.equal(h.calls.some(call => call.type === "copy"), false);
  await h.tick(); assert.equal(h.calls.some(call => call.type === "copy"), false);
  const newerPack = { rendererFrame: 2 }, newerFramebuffer = { rendererFrame: 3 };
  h.states.set(h.gl.PIXEL_PACK_BUFFER_BINDING, newerPack); h.states.set(h.gl.DRAW_FRAMEBUFFER_BINDING, newerFramebuffer);
  h.signal(); await h.tick();
  const pixels = await pending; assert.ok(pixels);
  assert.deepEqual(Array.from(pixels.data), [0, 0, 0, 255, 64, 128, 192, 255, 0, 0, 0, 255, 192, 64, 32, 255]);
  assert.equal(h.states.get(h.gl.PIXEL_PACK_BUFFER_BINDING), newerPack);
  assert.equal(h.states.get(h.gl.DRAW_FRAMEBUFFER_BINDING), newerFramebuffer);
  assert.equal(h.allocated.size, 0);
});

test("opaque MSAA resolve keeps its format and only a bounded RGBA image enters the PBO", async t => {
  const h = harness(t, { width: 1280, height: 720 }); const pending = readCanvasPixels(h.canvas);
  const images = h.calls.filter(call => call.type === "texture-image");
  assert.equal(images[0].args[2], h.gl.RGB8); assert.equal(images[1].args[2], h.gl.RGBA8);
  assert.equal(h.calls.find(call => call.type === "buffer-data")!.args[1], 320 * 180 * 4);
  const blits = h.calls.filter(call => call.type === "blit");
  assert.deepEqual(blits[0].args.slice(0, 8), [0, 0, 1280, 720, 0, 0, 1280, 720]);
  assert.equal(blits[0].args[9], h.gl.NEAREST);
  assert.deepEqual(blits[1].args.slice(0, 8), [0, 0, 1280, 720, 0, 0, 320, 180]);
  assert.equal(blits[1].args[9], h.gl.LINEAR);
  assert.equal(h.calls.find(call => call.type === "read-pixels")!.args[6], 0);
  h.signal(); await h.tick(); const pixels = await pending;
  assert.equal(pixels!.data.length, 320 * 180 * 4); assert.equal(h.allocated.size, 0);
});

for (const failure of ["context-loss", "resize", "fence-failure", "deadline"] as const) {
  test(`${failure} returns no fabricated pixels and releases every GPU resource`, async t => {
    const h = harness(t), before = new Map(h.states); const pending = readCanvasPixels(h.canvas);
    if (failure === "context-loss") h.setLost();
    if (failure === "resize") h.gl.drawingBufferWidth++;
    if (failure === "fence-failure") h.failWait();
    await h.tick(failure === "deadline" ? 10_000 : 16);
    assert.equal(await pending, null); assert.equal(h.allocated.size, 0);
    assert.deepEqual(h.states, before); assert.equal(h.calls.some(call => call.type === "copy"), false);
  });
}

test("an incomplete framebuffer restores state and releases partial allocations", async t => {
  const h = harness(t), before = new Map(h.states); h.incomplete();
  assert.equal(await readCanvasPixels(h.canvas), null); assert.equal(h.allocated.size, 0); assert.deepEqual(h.states, before);
});

test("a copy exception restores the current pack binding and releases signaled resources", async t => {
  const h = harness(t), before = new Map(h.states); h.failCopy();
  const rejected = assert.rejects(readCanvasPixels(h.canvas), /copy-failed/);
  h.signal(); await h.tick(); await rejected;
  assert.equal(h.allocated.size, 0); assert.deepEqual(h.states, before);
});

for (const failure of ["allocation", "read", "copy", "copy-loss"] as const) {
  test(`a non-throwing ${failure} failure returns null and restores bindings without fabricated pixels`, async t => {
    const h = harness(t), before = new Map(h.states); h.silentFailure(failure);
    const pending = readCanvasPixels(h.canvas);
    assert.deepEqual(h.states, before);
    const newerPack = { rendererFrame: 2 };
    h.states.set(h.gl.PIXEL_PACK_BUFFER_BINDING, newerPack);
    h.signal(); await h.tick();
    assert.equal(await pending, null); assert.equal(h.allocated.size, 0);
    assert.equal(h.states.get(h.gl.PIXEL_PACK_BUFFER_BINDING), newerPack);
    assert.equal(h.calls.some(call => call.type === "copy"), failure === "copy" || failure === "copy-loss");
    h.states.set(h.gl.PIXEL_PACK_BUFFER_BINDING, before.get(h.gl.PIXEL_PACK_BUFFER_BINDING));
    assert.deepEqual(h.states, before);
  });
}

test("an existing GL error rejects the capture without pre-clearing or draining the caller's errors", async t => {
  const h = harness(t), before = new Map(h.states);
  h.errors.add(h.gl.INVALID_OPERATION); h.errors.add(h.gl.OUT_OF_MEMORY);
  assert.equal(await readCanvasPixels(h.canvas), null);
  assert.equal(h.calls.filter(call => call.type === "get-error").length, 1);
  assert.deepEqual([...h.errors], [h.gl.OUT_OF_MEMORY]);
  assert.equal(h.allocated.size, 0); assert.deepEqual(h.states, before);
});

for (const alpha of [false, true]) {
  test(`a healthy ${alpha ? "transparent zero" : "opaque black"} frame remains a successful observation`, async t => {
    const rgba = [0, 0, 0, alpha ? 0 : 255];
    const h = harness(t, { width: 1, height: 1, alpha, pixels: rgba }), before = new Map(h.states);
    const pending = readCanvasPixels(h.canvas); h.signal(); await h.tick();
    const pixels = await pending; assert.ok(pixels); assert.deepEqual(Array.from(pixels.data), rgba);
    assert.equal(h.allocated.size, 0); assert.deepEqual(h.states, before);
  });
}

test("scene diagnostics do not report failed PBO allocation as a black screenshot", async t => {
  const h = harness(t), before = new Map(h.states); h.silentFailure("allocation");
  const pending = captureCanvasDiagnostics({ canvas: h.canvas, includeImage: false });
  h.signal(); await h.tick();
  assert.equal(await pending, null); assert.equal(h.allocated.size, 0); assert.deepEqual(h.states, before);
});

for (const premultiplied of [false, true]) {
  test(`transparent framebuffer preserves alpha with premultipliedAlpha=${premultiplied}`, async t => {
    const h = harness(t, { width: 1, height: 1, alpha: true, premultiplied, pixels: [32, 64, 96, 128] });
    const pending = readCanvasPixels(h.canvas); h.signal(); await h.tick(); const pixels = await pending;
    assert.deepEqual(Array.from(pixels!.data), premultiplied ? [64, 128, 191, 128] : [32, 64, 96, 128]);
    assert.equal(h.calls.find(call => call.type === "texture-image")!.args[2], h.gl.RGBA8);
    assert.equal(h.allocated.size, 0);
  });
}

test("an unavailable or already lost WebGL context never starts a synchronous fallback", async t => {
  assert.equal(await readCanvasPixels({ getContext: () => null } as unknown as HTMLCanvasElement), null);
  const h = harness(t); h.setLost();
  assert.equal(await readCanvasPixels(h.canvas), null); assert.equal(h.allocated.size, 0); assert.deepEqual(h.calls, []);
});
