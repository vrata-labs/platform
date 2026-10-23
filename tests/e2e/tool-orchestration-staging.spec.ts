import { expect, test } from "@playwright/test";
import { bootDiagnosticsPresenceScenario, nativeToolCaptureScenario, toolOrchestrationScenario, unsupportedCaptureAttemptScenario } from "./tool-orchestration-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] } });
test("@staging independent wall, replacement consent and real PDF/screen transport", async ({ browser, request }) => {
  test.setTimeout(600_000); expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await toolOrchestrationScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});

test("@staging original native screen capture publishes decoded monitor frames", async ({ browser, request }) => {
  test.setTimeout(300_000); expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await nativeToolCaptureScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});

test("@staging unsupported capture stays disabled while board and microphone capabilities remain available", async ({ browser, request }) => {
  test.setTimeout(180_000); expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await unsupportedCaptureAttemptScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});

test("@staging pending boot diagnostics do not stop admitted participant heartbeats", async ({ browser, request }) => {
  test.setTimeout(180_000); expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await bootDiagnosticsPresenceScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});
