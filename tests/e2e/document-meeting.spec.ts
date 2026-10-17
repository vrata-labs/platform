import { test, expect } from "@playwright/test";
import { rename, unlink, writeFile } from "node:fs/promises";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { createDocumentMeeting, documentPolicyScenario, documentMobilePresentationScenario, documentDelayedResponseScenario } from "./document-meeting-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>>;
test.beforeAll(async () => {
  test.setTimeout(120_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    devRoleQuery: false, stateTokenSecret: "owned-document-meeting-state-secret-32-bytes", documentUploadMaxBytes: 4096
  });
});
test.afterAll(async () => { test.setTimeout(120_000); await fixture?.close(); });

for (const mobile of [false, true]) test(`documents ${mobile ? "Android viewport" : "desktop"}: server limits, preflight, corrupt PDF, actual download and busy feedback`, async ({ browser, request }) => {
  test.setTimeout(180_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile, origin: fixture.origin, adminToken: fixture.adminToken,
    ...(!mobile ? { storageFault: async (action: () => Promise<void>) => {
      const root = fixture.documentStorageRoot, held = `${root}.held`;
      await rename(root, held);
      try { await writeFile(root, "owned-document-storage-fault"); await action(); }
      finally { await unlink(root); await rename(held, root); }
    } } : {}) });
  try { await documentPolicyScenario(meeting); } finally { await meeting.close(); }
});

test("documents Android viewport: own Host PDF renders pages 1-2-3 for Guest, reload and late join", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile: true, origin: fixture.origin, adminToken: fixture.adminToken });
  try { await documentMobilePresentationScenario(meeting); } finally { await meeting.close(); }
});

test("documents ignore delayed successful DELETE and download responses after real authority transitions", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const meeting = await createDocumentMeeting({ browser, request, mobile: false, origin: fixture.origin, adminToken: fixture.adminToken });
  try { await documentDelayedResponseScenario(meeting); } finally { await meeting.close(); }
});
