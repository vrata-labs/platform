import { existsSync } from "node:fs";
import { defineConfig } from "playwright/test";
import base from "./playwright.config";

// Local e2e with hardware WebGL: the repository config with only the browser launch changed.
// Full Chromium (channel "chromium", new headless) on the host GPU instead of
// chromium-headless-shell with SwiftShader. Scenes, DPR, viewports, timeouts and
// assertions come unchanged from the specs and playwright.config.ts.
// Specs that set their own launchOptions replace these and keep their own launch.

// Scenarios that need hardware rendering fail here instead of skipping on a software renderer.
process.env.VRATA_E2E_REQUIRE_HARDWARE_RENDERING = "1";

// WSLg exposes the Windows GPU through /dev/dxg; Mesa reaches it only via the d3d12
// Gallium driver (otherwise llvmpipe). Other hosts keep their own driver selection,
// and an explicitly exported GALLIUM_DRIVER is inherited as is.
const galliumDriver = process.env.GALLIUM_DRIVER === undefined && existsSync("/dev/dxg") ? "d3d12" : undefined;

export default defineConfig(base, {
  use: {
    channel: "chromium",
    launchOptions: {
      args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=gl-egl"],
      ...(galliumDriver ? { env: { ...process.env, GALLIUM_DRIVER: galliumDriver } } : {})
    }
  }
});
