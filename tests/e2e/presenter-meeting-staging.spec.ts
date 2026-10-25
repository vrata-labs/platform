import { expect, test } from "@playwright/test";
import { presenterMeetingScenario } from "./presenter-meeting-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1", "A new host first runs on the Wave 2 catalog; reference rooms with scenes exist after its gated activation");
// Extended staging suite (staging-extended.yml): the heaviest multi-participant media scenario, outside the deploy gate.
test("@staging-extended two sequential Presenters: live controls, own PDFs, reconnect and removal", async ({ browser, request }) => {
  test.setTimeout(480_000);
  expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await presenterMeetingScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});
