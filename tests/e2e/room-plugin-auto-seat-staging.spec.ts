import { test } from "@playwright/test";
import { runAutoSeatScenario } from "./room-plugin-auto-seat-scenarios";
import { assertExactActivePublicDemoCatalog } from "./public-demo-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("@staging-extended T16 external auto-seat: simultaneous entrants, protocol conflict, reconnect, no ghosts and late ACK after disable", async ({ browser }) => {
  test.setTimeout(600_000);
  const origin = process.env.BASE_URL, adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN;
  if (!origin || !adminToken || process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1") throw new Error("t16_auto_seat_requires_published_active_catalog_and_credentials");
  if (new URL(origin).protocol !== "https:") throw new Error("t16_auto_seat_requires_https");
  await assertExactActivePublicDemoCatalog(origin);
  await runAutoSeatScenario(browser, { origin, adminToken });
});
