import { expect, test } from "@playwright/test";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { presenterMeetingScenario } from "./presenter-meeting-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("two sequential Presenters receive and lose live controls through normal invitations", async ({ browser, request }) => {
  test.setTimeout(480_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false });
  try { await presenterMeetingScenario({ browser, request, origin: fixture.origin, adminToken: fixture.adminToken }); }
  finally { await fixture.close(); }
});
