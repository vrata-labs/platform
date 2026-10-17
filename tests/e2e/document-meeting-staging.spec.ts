import { test } from "@playwright/test";
import { createDocumentMeeting, documentPolicyScenario, documentMobilePresentationScenario, documentDelayedResponseScenario } from "./document-meeting-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
for (const mobile of [false, true]) test(`@staging documents ${mobile ? "Android viewport" : "desktop"}: actual policy, upload failures, own download and busy state`, async ({ browser, request }) => {
  test.setTimeout(180_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
  try { await documentPolicyScenario(meeting); } finally { await meeting.close(); }
});
test("@staging documents Android viewport: own Host PDF pages, Guest reload and late join", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile: true, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
  try { await documentMobilePresentationScenario(meeting); } finally { await meeting.close(); }
});
test("@staging documents retire delayed successful responses on role loss and session end", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile: false, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
  try { await documentDelayedResponseScenario(meeting); } finally { await meeting.close(); }
});
