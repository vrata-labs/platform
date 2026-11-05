import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Exercise the compiled production reader in a real GPU-backed browser canvas.
// The separate runtime/public-demo scenarios still prove application integration.
// Playwright loads every spec for any --grep, and published suites run without a
// build, so the compiled reader is read only when these tests actually execute.
let readerSource = "";
test.beforeAll(() => {
  readerSource = readFileSync(resolve("apps/runtime-web/dist/canvas-readback.js"), "utf8")
    .replace("export async function readCanvasPixels", "async function readCanvasPixels");
});

for (const attributes of [
  { alpha: false, premultipliedAlpha: true },
  { alpha: true, premultipliedAlpha: true },
  { alpha: true, premultipliedAlpha: false }
]) {
  test(`canvas diagnostics preserve real pixels and renderer state: ${JSON.stringify(attributes)}`, async ({ page }) => {
    const result = await page.evaluate(async ({ source, attributes }) => {
      const read = new Function(`${source}\nreturn readCanvasPixels;`)() as
        (canvas: HTMLCanvasElement) => Promise<{ width: number; height: number; data: Uint8ClampedArray } | null>;
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      document.body.append(canvas);
      const gl = canvas.getContext("webgl2", { ...attributes, antialias: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL2 required");
      const resources = { textures: [] as WebGLTexture[], buffers: [] as WebGLBuffer[], framebuffers: [] as WebGLFramebuffer[] };
      try {
        gl.enable(gl.SCISSOR_TEST);
        const alpha = attributes.alpha ? 0.5 : 1;
        const factor = attributes.premultipliedAlpha ? alpha : 1;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          gl.scissor(x * 80, y * 45, 80, 45);
          gl.clearColor(x / 8 * factor, y / 8 * factor, (x + y) / 16 * factor, alpha);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        // The former synchronous path is the pixel reference, not a substitute
        // for measuring the new path under application load.
        const scratch = document.createElement("canvas"); scratch.width = 320; scratch.height = 180;
        const context = scratch.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(canvas, 0, 0, 320, 180);
        const reference = context.getImageData(0, 0, 320, 180).data;
        const texture = gl.createTexture()!, pack = gl.createBuffer()!, unpack = gl.createBuffer()!;
        const readFramebuffer = gl.createFramebuffer()!, drawFramebuffer = gl.createFramebuffer()!, laterFramebuffer = gl.createFramebuffer()!;
        resources.textures.push(texture); resources.buffers.push(pack, unpack);
        resources.framebuffers.push(readFramebuffer, drawFramebuffer, laterFramebuffer);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack); gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 8); gl.pixelStorei(gl.PACK_ROW_LENGTH, 7);
        gl.pixelStorei(gl.PACK_SKIP_ROWS, 2); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 3);
        const state = () => [gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
          gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING), gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
          gl.getParameter(gl.PACK_ALIGNMENT), gl.getParameter(gl.PACK_ROW_LENGTH), gl.getParameter(gl.PACK_SKIP_ROWS), gl.getParameter(gl.PACK_SKIP_PIXELS), gl.isEnabled(gl.SCISSOR_TEST)];
        const before = state();
        const pending = read(canvas);
        const restoredBeforeYield = before.every((value, index) => state()[index] === value);
        // Simulate the next renderer frame while the GPU fence is pending.
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, laterFramebuffer);
        const afterFrame = state();
        const pixels = await pending;
        if (!pixels) throw new Error("actual pixels missing");
        const restoredAfterYield = afterFrame.every((value, index) => state()[index] === value);
        const stats = (data: Uint8ClampedArray) => {
          const sums = [0, 0, 0, 0]; let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            for (let c = 0; c < 4; c++) sums[c] += data[i + c];
            if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 24) dark++;
          }
          const count = data.length / 4, center = (90 * 320 + 160) * 4;
          return { average: sums.map(sum => sum / count), dark: dark / count, center: Array.from(data.slice(center, center + 4)) };
        };
        const actual = stats(pixels.data), expected = stats(reference);
        return { width: pixels.width, height: pixels.height, restoredBeforeYield, restoredAfterYield,
          error: gl.getError(), averageDelta: actual.average.map((value, index) => Math.abs(value - expected.average[index])),
          darkDelta: Math.abs(actual.dark - expected.dark), centerDelta: actual.center.map((value, index) => Math.abs(value - expected.center[index])) };
      } finally {
        for (const resource of resources.textures) gl.deleteTexture(resource);
        for (const resource of resources.buffers) gl.deleteBuffer(resource);
        for (const resource of resources.framebuffers) gl.deleteFramebuffer(resource);
        gl.getExtension("WEBGL_lose_context")?.loseContext(); canvas.remove();
      }
    }, { source: readerSource, attributes });
    expect(result.width).toBe(320); expect(result.height).toBe(180);
    expect(result.restoredBeforeYield).toBe(true); expect(result.restoredAfterYield).toBe(true);
    expect(result.error).toBe(0);
    expect(Math.max(...result.averageDelta)).toBeLessThanOrEqual(2);
    expect(Math.max(...result.centerDelta)).toBeLessThanOrEqual(2);
    expect(result.darkDelta).toBeLessThanOrEqual(0.01);
  });
}

test("canvas diagnostics release a pending readback when the real context is lost", async ({ page }) => {
  expect(await page.evaluate(async source => {
    const read = new Function(`${source}\nreturn readCanvasPixels;`)() as (canvas: HTMLCanvasElement) => Promise<unknown>;
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true })!;
    gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const pending = read(canvas); gl.getExtension("WEBGL_lose_context")!.loseContext();
    return await pending === null;
  }, readerSource)).toBe(true);
});
