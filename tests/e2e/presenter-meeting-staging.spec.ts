import { expect, test } from "@playwright/test";
import { presenterMeetingScenario } from "./presenter-meeting-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("@staging two sequential Presenters: live controls, own PDFs, reconnect and removal", async ({ browser, request }) => {
  test.setTimeout(480_000);
  expect(!!process.env.BASE_URL && !!process.env.STAGING_ADMIN_TOKEN).toBe(true);
  await presenterMeetingScenario({ browser, request, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
});
