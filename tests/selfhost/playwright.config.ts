import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const origin = process.env.T17_SELFHOST_ORIGIN;
const output = process.env.T17_SELFHOST_OUTPUT;
if (!origin || new URL(origin).hostname !== "127.0.0.1" || new URL(origin).protocol !== "http:") {
  throw new Error("t17_requires_owned_loopback_selfhost");
}
if (!output || !isAbsolute(output) || !process.env.T17_SELFHOST_CONTROL || !process.env.VRATA_ADMIN_TOKEN
  || process.env.T17_BROWSER_LOCK_HELD !== "1") throw new Error("t17_requires_private_runner_and_browser_lock");
const galliumDriver = process.env.GALLIUM_DRIVER === undefined && existsSync("/dev/dxg") ? "d3d12" : undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "runtime-lifecycle.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  outputDir: `${output}/playwright-output`,
  reporter: [["list"], ["json", { outputFile: `${output}/playwright.private.json` }]],
  use: {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: "off",
    video: "off",
    screenshot: "off",
    // Same hardware launch route as playwright.gpu.config.ts; no base webServer
    // or fixture/render-budget overrides are imported into the self-host gate.
    launchOptions: {
      args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=gl-egl"],
      env: galliumDriver ? { ...process.env, GALLIUM_DRIVER: galliumDriver } : process.env
    }
  }
  // Deliberately no webServer, fixture API, frame-budget override or fake media.
});
