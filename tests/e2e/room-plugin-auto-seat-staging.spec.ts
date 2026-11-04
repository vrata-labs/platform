import { test } from "@playwright/test";
import { runAutoSeatScenario, runPendingAutoSeatScenario } from "./room-plugin-auto-seat-scenarios";
import { assertExactActivePublicDemoCatalog } from "./public-demo-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });

async function publishedOrigin() {
  const origin = process.env.BASE_URL, adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN;
  if (!origin || !adminToken || process.env.VRATA_REFERENCE_CATALOG_ACTIVE !== "1") throw new Error("t16_auto_seat_requires_published_active_catalog_and_credentials");
  if (new URL(origin).protocol !== "https:") throw new Error("t16_auto_seat_requires_https");
  await assertExactActivePublicDemoCatalog(origin);
  return { origin, adminToken };
}

test("@staging-extended T16 external auto-seat: simultaneous entrants, protocol conflict, reconnect and no ghosts", async ({ browser }) => {
  test.setTimeout(600_000);
  // A reference room cannot take a lighter scene, so two entrants keep the real room affordable.
  await runAutoSeatScenario(browser, await publishedOrigin(), 2);
});

test("@staging-extended T16 external auto-seat pending retirement suppresses intermediate late accept and leaves no ghosts", async ({ browser }) => {
  test.setTimeout(300_000);
  await runPendingAutoSeatScenario(browser, await publishedOrigin());
});
