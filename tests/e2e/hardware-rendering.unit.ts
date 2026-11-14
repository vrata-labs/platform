import { test } from "node:test";
import assert from "node:assert/strict";
import { hardwareRenderingDecision, readWebglRenderer, requireHardwareRendering, type WebglRendererInfo } from "./hardware-rendering.ts";

const software = [
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  "ANGLE (Mesa, llvmpipe (LLVM 19.1.1, 256 bits), OpenGL 4.5)",
  "softpipe",
  "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)"
];
const hardware = [
  "ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce GTX 1060 6GB), OpenGL ES 3.1)",
  "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
  "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)"
];
const info = (renderer: string | null): WebglRendererInfo => ({ api: "webgl2", renderer, vendor: "vendor" });

test("software renderer is skipped with the renderer in the reason, or fails when hardware is required", () => {
  for (const renderer of software) {
    const skipped = hardwareRenderingDecision(info(renderer), false);
    assert.equal(skipped.action, "skip");
    assert.match(skipped.reason!, /^requires hardware rendering/);
    assert.ok(skipped.reason!.includes(renderer));
    const failed = hardwareRenderingDecision(info(renderer), true);
    assert.equal(failed.action, "fail");
    assert.ok(failed.reason!.includes(renderer));
    assert.match(failed.reason!, /VRATA_E2E_REQUIRE_HARDWARE_RENDERING=1/);
  }
});

test("hardware renderer runs in both modes", () => {
  for (const renderer of hardware) for (const required of [false, true]) {
    assert.deepEqual(hardwareRenderingDecision(info(renderer), required), { action: "run", reason: null });
  }
});

test("missing WebGL never skips; an unidentified renderer runs unless hardware is required", () => {
  for (const required of [false, true]) {
    const decision = hardwareRenderingDecision({ api: null, renderer: null, vendor: null }, required);
    assert.equal(decision.action, "fail");
    assert.match(decision.reason!, /webgl_unavailable/);
  }
  assert.deepEqual(hardwareRenderingDecision(info(null), false), { action: "run", reason: null });
  assert.equal(hardwareRenderingDecision(info(null), true).action, "fail");
});

test("only the exact value 1 requires hardware rendering", () => {
  assert.equal(requireHardwareRendering({ VRATA_E2E_REQUIRE_HARDWARE_RENDERING: "1" }), true);
  for (const value of [undefined, "", "0", "true"]) {
    assert.equal(requireHardwareRendering({ VRATA_E2E_REQUIRE_HARDWARE_RENDERING: value }), false);
  }
});

// Execute the actual page function against a minimal fake document.
function withCanvas(contexts: Record<string, unknown>, run: () => void) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true,
    value: { createElement: () => ({ getContext: (api: string) => contexts[api] ?? null }) } });
  try { run(); }
  finally {
    if (saved) Object.defineProperty(globalThis, "document", saved);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function fakeContext(debug: boolean) {
  const calls = { lost: 0 };
  const gl = {
    getExtension: (name: string) => name === "WEBGL_debug_renderer_info"
      ? (debug ? { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 } : null)
      : name === "WEBGL_lose_context" ? { loseContext: () => { calls.lost++; } } : null,
    getParameter: (key: number) => key === 1 ? "Renderer X" : "Vendor Y"
  };
  return { gl, calls };
}

test("page function reads unmasked strings, falls back to webgl and releases the context", () => {
  const webgl2 = fakeContext(true);
  withCanvas({ webgl2: webgl2.gl }, () => {
    assert.deepEqual(readWebglRenderer(), { api: "webgl2", renderer: "Renderer X", vendor: "Vendor Y" });
  });
  assert.equal(webgl2.calls.lost, 1);
  const webgl = fakeContext(false);
  withCanvas({ webgl: webgl.gl }, () => {
    assert.deepEqual(readWebglRenderer(), { api: "webgl", renderer: null, vendor: null });
  });
  assert.equal(webgl.calls.lost, 1);
  withCanvas({}, () => assert.deepEqual(readWebglRenderer(), { api: null, renderer: null, vendor: null }));
});
