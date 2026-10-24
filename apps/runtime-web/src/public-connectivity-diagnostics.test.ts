import assert from "node:assert/strict";
import test from "node:test";

import { createReportSummary, redactConnectivityReport, redactString, runPublicConnectivityDiagnostics, withTimeout, type PublicDiagnosticCheck } from "./public-connectivity-diagnostics.js";

test("redactString redacts sensitive query values", () => {
  assert.equal(
    redactString("wss://state.example.test?roomId=demo&accessToken=secret-token&participantId=p1"),
    "wss://state.example.test?roomId=demo&accessToken=[redacted]&participantId=p1"
  );
});

test("redactString redacts issued v2 proofs and bearer values in free text", () => {
  const text = redactString("failed: Bearer rs2.abc.def at /x?identityCredential=ri2.secret&roomId=r and ri2.other.value");
  assert.equal(/rs2\.|ri2\.|abc\.def/.test(text), false);
  assert.match(text, /Bearer \[redacted\]/);
  assert.match(text, /identityCredential=\[redacted\]&roomId=r/);
  const quoted = redactString("x_rs2.abc.def and rs2%2Eabc%2Edef; GET /a?token=secret-value HTTP 500");
  assert.equal(/abc|secret-value/.test(quoted), false);
  assert.match(quoted, /HTTP 500$/, "the rest of an error message stays readable");
  const header = redactString("GET /a?authorization=Bearer opaque-secret HTTP 500");
  assert.equal(header.includes("opaque-secret"), false);
  assert.match(header, /HTTP 500$/);
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

test("a stored-report answer whose body stalls is reported as a timeout on floor 2", async () => {
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health") return Response.json({ status: "ok", features: { identityProtocolVersion: 2 } });
    if (path.endsWith("/diagnostics")) {
      // Headers arrive; the body never finishes until the check's own bound aborts it.
      const body = new ReadableStream({ start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      } });
      return new Response(body, { status: 409, headers: { "content-type": "application/json" } });
    }
    return Response.json({ error: "identity_required", reason: "invite_required" }, { status: 403 });
  }) as typeof fetch;
  const report = await runPublicConnectivityDiagnostics({ apiBaseUrl: "http://diagnostics.test", roomId: "room-1", timeoutMs: 50,
    skipMicrophone: true, skipMedia: true, fetchImpl, WebSocketImpl: undefined });
  const admin = report.checks.find(check => check.name === "adminDetails");
  assert.equal(admin?.code, "connectivity_check_timeout");
  assert.equal(admin?.status, "failed");
});

