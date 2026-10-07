import { test } from "playwright/test";
import { runPersistedTelemetryRoundTrip } from "./telemetry-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("persisted room diagnostics and XR telemetry round trip through the current API", async ({ baseURL }) => {
  if (!baseURL) throw new Error("telemetry_local_origin_required");
  await runPersistedTelemetryRoundTrip(new URL(baseURL).origin, { "x-vrata-admin-token": "test-admin-token" });
});
