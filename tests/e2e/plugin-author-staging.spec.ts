import { test } from "playwright/test";
import { downloadPublicSdk, runFloorOneAuthorDenial } from "./plugin-author-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("@staging T05 shared floor one denies every plugin route even to a genuinely admitted legacy Host", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN ?? "";
  if (!adminToken) throw new Error("plugin_author_staging_admin_environment_required");
  if (!baseURL || new URL(baseURL).protocol !== "https:" || new URL(baseURL).origin !== baseURL.replace(/\/$/, "")) {
    throw new Error("plugin_author_staging_requires_https_origin");
  }
  const origin = new URL(baseURL).origin;
  const admin = { "x-vrata-admin-token": adminToken };
  // Public SDK compatibility remains available while private author routes are
  // inactive. This downloads the pinned archive, without installing on stage.
  await downloadPublicSdk(request);
  await runFloorOneAuthorDenial(origin, admin, page);
});
