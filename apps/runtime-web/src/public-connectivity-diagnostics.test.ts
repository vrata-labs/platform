import assert from "node:assert/strict";
import test from "node:test";

import { createReportSummary, redactConnectivityReport, redactString, withTimeout, type PublicDiagnosticCheck } from "./public-connectivity-diagnostics.js";

test("redactString redacts sensitive query values", () => {
  assert.equal(
    redactString("wss://state.example.test?roomId=demo&accessToken=secret-token&participantId=p1"),
    "wss://state.example.test?roomId=demo&accessToken=[redacted]&participantId=p1"
  );
});

test("redactConnectivityReport redacts secret-like keys recursively", () => {
  const redacted = redactConnectivityReport({
    token: "secret",
    nested: {
      livekitUrl: "wss://livekit.example.test",
      inviteLink: "https://example.test/invite?invite=secret"
    }
  }) as { token?: string; nested?: { livekitUrl?: string; inviteLink?: string } };
  assert.equal(redacted.token, "[redacted]");
  assert.equal(redacted.nested?.livekitUrl, "wss://livekit.example.test");
  assert.equal(redacted.nested?.inviteLink, "[redacted]");
});

test("createReportSummary counts check statuses", () => {
  const checks = [
    { status: "ok" },
    { status: "failed" },
    { status: "skipped" },
    { status: "ok" }
  ] as PublicDiagnosticCheck[];
  assert.deepEqual(createReportSummary(checks), { ok: 2, failed: 1, skipped: 1 });
});

test("withTimeout rejects slow checks with stable timeout message", async () => {
  await assert.rejects(
    () => withTimeout(new Promise((resolve) => setTimeout(resolve, 50)), 1),
    /connectivity_check_timeout/
  );
});
