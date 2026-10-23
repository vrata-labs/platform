import { test } from "playwright/test";
import { runPersistedTelemetryRoundTrip } from "./telemetry-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("@staging persisted room diagnostics and XR telemetry round trip on the deployed API", async ({ baseURL }) => {
  test.setTimeout(120_000);
  const token = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN;
  if (!token || !baseURL || new URL(baseURL).protocol !== "https:") throw new Error("telemetry_staging_environment_required");
  await runPersistedTelemetryRoundTrip(new URL(baseURL).origin, { "x-vrata-admin-token": token });
});
