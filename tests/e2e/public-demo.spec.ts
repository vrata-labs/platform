import { test } from "@playwright/test";

import { runPublicDemoScenario } from "./public-demo-scenarios";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

type Fixture = Awaited<ReturnType<typeof startReferenceTemplateFixture>>;

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  launchOptions: {
    args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"]
  }
});

test.describe("public demo local functional scenario", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: Fixture | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;
    if (!postgresUrl) throw new Error("VRATA_TEST_POSTGRES_URL is required; public demo local setup cannot run without PostgreSQL");
    try {
      fixture = await startReferenceTemplateFixture(postgresUrl, { devRoleQuery: false });
    } catch {
      throw new Error("public_demo_local_postgres_fixture_setup_failed");
    }
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await fixture?.close();
  });

  test("four-party private room, notes, slides, and controls (voice not accepted locally)", async ({ browser }, testInfo) => {
    test.setTimeout(1_200_000);
    if (!fixture) throw new Error("public_demo_local_fixture_missing");
    await runPublicDemoScenario({
      browser,
      testInfo,
      origin: fixture.origin,
      adminToken: fixture.adminToken,
      staging: false
    });
  });
});
