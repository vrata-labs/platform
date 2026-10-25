import { expect, test } from "@playwright/test";
import { nativeToolCaptureScenario, toolOrchestrationScenario } from "./tool-orchestration-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] } });
test("@staging independent wall, replacement consent and real PDF/screen transport", async ({ browser, request }) => {
  test.skip(process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1", "A new host first runs on the Wave 2 catalog; reference rooms with scenes exist after its gated activation");
  test.setTimeout(600_000); expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await toolOrchestrationScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});

// Extended staging suite (staging-extended.yml): heavy, outside the deploy gate.
test("@staging-extended original native screen capture publishes decoded monitor frames", async ({ browser, request }) => {
  test.setTimeout(300_000); expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await nativeToolCaptureScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});
// Unsupported capture (getDisplayMedia replaced in the page) and boot presence (server rules) run locally in
// tool-orchestration.spec.ts; the stand added nothing to either.
