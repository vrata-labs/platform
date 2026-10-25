import { test } from "@playwright/test";
import { createDocumentMeeting, documentPolicyScenario } from "./document-meeting-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1", "A new host first runs on the Wave 2 catalog; reference rooms with scenes exist after its gated activation");
// The stand adds real storage and the deployed upload policy. The Android layout, presentation pages and delayed
// responses are browser behaviour covered by document-meeting.spec.ts; PDF pages on the stand also render in the
// orchestration, reference and runtime staging scenarios.
test("@staging documents desktop: actual policy, upload failures, own download and busy state", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile: false, origin: process.env.BASE_URL!, adminToken: process.env.STAGING_ADMIN_TOKEN! });
  try { await documentPolicyScenario(meeting); } finally { await meeting.close(); }
});
