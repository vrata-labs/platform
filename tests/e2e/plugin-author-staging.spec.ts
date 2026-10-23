import { test } from "playwright/test";
import { downloadPublicSdk, runFloorOneAuthorDenial, runFloorTwoAuthorRoutes } from "./plugin-author-scenarios";
import { identityProtocolAt } from "./staging-identity";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("@staging T05 author routes follow the shared floor: floor one denies even a genuine legacy Host, floor two serves v2 Hosts only", async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN ?? "";
  if (!adminToken) throw new Error("plugin_author_staging_admin_environment_required");
  if (!baseURL || new URL(baseURL).protocol !== "https:" || new URL(baseURL).origin !== baseURL.replace(/\/$/, "")) {
    throw new Error("plugin_author_staging_requires_https_origin");
  }
  const origin = new URL(baseURL).origin;
  const admin = { "x-vrata-admin-token": adminToken };
  // The pinned public SDK archive is downloaded on both floors; it is installed
  // only into a throwaway external project, never on the stage host.
  const sdk = await downloadPublicSdk(request);
  if (await identityProtocolAt(origin) === 2) await runFloorTwoAuthorRoutes(origin, admin, page, sdk);
  else await runFloorOneAuthorDenial(origin, admin, page);
});
