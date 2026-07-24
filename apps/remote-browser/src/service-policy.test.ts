import assert from "node:assert/strict";
import test from "node:test";
import { canStartRemoteBrowserSession, resolveRemoteBrowserEnabled, resolveRemoteBrowserFrameTokenSecret, resolveRemoteBrowserServicePolicy, scheduleRemoteBrowserSessionExpiry, validateRemoteBrowserSessionIdentity } from "./service-policy.js";

test("remote browser is disabled by default in production and explicit elsewhere", () => {
  assert.equal(resolveRemoteBrowserEnabled({ NODE_ENV: "production" }), false);
  assert.equal(resolveRemoteBrowserEnabled({ NODE_ENV: "development" }), true);
  assert.equal(resolveRemoteBrowserEnabled({ NODE_ENV: "production", REMOTE_BROWSER_ENABLED: "true" }), true);
  assert.equal(resolveRemoteBrowserEnabled({ NODE_ENV: "development", REMOTE_BROWSER_ENABLED: "false" }), false);
});

test("remote browser service policy clamps resource limits", () => {
  assert.deepEqual(resolveRemoteBrowserServicePolicy({
    NODE_ENV: "production",
    REMOTE_BROWSER_MAX_SESSIONS: "100",
    REMOTE_BROWSER_SESSION_TTL_SECONDS: "1",
    REMOTE_BROWSER_VIEWPORT_WIDTH: "9000",
    REMOTE_BROWSER_VIEWPORT_HEIGHT: "10"
  }), {
    enabled: false,
    maxSessions: 16,
    sessionTtlMs: 30_000,
    viewport: { width: 1920, height: 180 }
  });
});

test("remote browser session identity is bound to its object", () => {
  assert.equal(validateRemoteBrowserSessionIdentity({ sessionId: "remote-browser:object-1", executorInstanceId: "remote-browser:object-1:instance:generation-1", mediaParticipantId: "remote-browser:object-1", objectId: "object-1" }), true);
  assert.equal(validateRemoteBrowserSessionIdentity({ sessionId: "remote-browser:object-2", executorInstanceId: "remote-browser:object-1:instance:generation-1", mediaParticipantId: "remote-browser:object-1", objectId: "object-1" }), false);
  assert.equal(validateRemoteBrowserSessionIdentity({ sessionId: "remote-browser:object-1", executorInstanceId: "remote-browser:other:instance:generation-1", mediaParticipantId: "remote-browser:object-1", objectId: "object-1" }), false);
});

test("remote browser frame secret fails closed in production", () => {
  assert.equal(resolveRemoteBrowserFrameTokenSecret({ NODE_ENV: "production" }), null);
  assert.equal(resolveRemoteBrowserFrameTokenSecret({ NODE_ENV: "development" }), "dev-remote-browser-secret");
  assert.equal(resolveRemoteBrowserFrameTokenSecret({ NODE_ENV: "production", REMOTE_BROWSER_TOKEN_SECRET: "configured" }), "configured");
});

test("remote browser capacity permits replacement but rejects excess sessions", () => {
  assert.equal(canStartRemoteBrowserSession(2, false, 2), false);
  assert.equal(canStartRemoteBrowserSession(2, true, 2), true);
  assert.equal(canStartRemoteBrowserSession(1, false, 2), true);
});

test("remote browser expiry scheduler runs cleanup callback", async () => {
  let expired = false;
  await new Promise<void>((resolve) => {
    const timer = scheduleRemoteBrowserSessionExpiry(5, () => { expired = true; resolve(); });
    timer.ref?.();
  });
  assert.equal(expired, true);
});
