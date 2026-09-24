import { test } from "@playwright/test";

import { assertExactActivePublicDemoCatalog, runPublicDemoScenario } from "./public-demo-scenarios";

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  launchOptions: {
    args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"]
  }
});

test.describe("@staging public demo production scenario", () => {
  test.describe.configure({ mode: "serial" });
  let origin = "";
  let adminToken = "";

  test.beforeAll(async () => {
    test.setTimeout(30_000);
    const configuredOrigin = process.env.BASE_URL;
    adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN ?? "";
    if (!configuredOrigin) throw new Error("BASE_URL is required for the public demo staging scenario");
    if (!adminToken) throw new Error("STAGING_ADMIN_TOKEN or VRATA_ADMIN_TOKEN is required for the public demo staging scenario");
    const url = new URL(configuredOrigin);
    if (url.protocol !== "https:" || url.origin !== configuredOrigin.replace(/\/$/, "")) {
      throw new Error("public_demo_staging_base_url_must_be_https_origin");
    }
    origin = url.origin;
    await assertExactActivePublicDemoCatalog(origin);
  });

  test("four-party private room with strict real LiveKit audio", async ({ browser }, testInfo) => {
    test.setTimeout(900_000);
    await runPublicDemoScenario({ browser, testInfo, origin, adminToken, staging: true });
  });
});
