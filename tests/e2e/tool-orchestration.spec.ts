import { expect, test } from "@playwright/test";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { startLocalLiveKitFixture } from "./local-livekit-fixture";
import { bootDiagnosticsPresenceScenario, nativeToolCaptureScenario, toolOrchestrationScenario, unsupportedCaptureAttemptScenario } from "./tool-orchestration-scenarios";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const STATE_SECRET = "owned-t14-orchestration-state-secret-32-bytes";

test.use({ trace: "off", screenshot: "off", video: "off", launchOptions: { args: ["--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"] } });
// Only identity v2: floor 1 is not a supported product path, and a v1 twin repeated the whole scenario.
for (const protocol of [2] as const) test(`v${protocol} independent wall, revision-bound consent and PDF/screen capture lifecycle`, async ({ browser, request }) => {
  test.setTimeout(600_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const livekit = await startLocalLiveKitFixture();
  try {
    const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false, livekitUrl: livekit.url, stateTokenSecret: STATE_SECRET });
    try {
      if (protocol === 2) {
        // The common floor is untouched. Raise only the policy relation that is
        // proven to belong to this fixture's disposable schema.
        expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
        const { Pool } = createRequire(resolve("apps/api/package.json"))("pg");
        const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
        try {
          const policy = await pool.query("select current_schema() as schema, n.nspname as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='room_identity_protocol_policy'::regclass");
          expect(policy.rows).toEqual([{ schema: fixture.schema, owner: fixture.schema }]);
          const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
          await new PostgresStorage(pool).identityProtocol.raise(2);
        } finally { await pool.end(); }
      }
      await toolOrchestrationScenario({ browser, request, origin: fixture.origin, adminToken: fixture.adminToken, expectedProtocol: protocol });
    }
    finally { await fixture.close(); }
  } finally { await livekit.close(); }
});

test("original native getDisplayMedia runs from the click and its monitor reaches a viewer", async ({ browser, request }) => {
  test.setTimeout(300_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const livekit = await startLocalLiveKitFixture();
  try {
    const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false, livekitUrl: livekit.url, stateTokenSecret: STATE_SECRET });
    try { await nativeToolCaptureScenario({ browser, request, origin: fixture.origin, adminToken: fixture.adminToken }); }
    finally { await fixture.close(); }
  } finally { await livekit.close(); }
});

test("unsupported capture remains disabled after completion and later surface snapshots without disabling microphone", async ({ browser, request }) => {
  test.setTimeout(180_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false, stateTokenSecret: STATE_SECRET });
  try { await unsupportedCaptureAttemptScenario({ browser, request, origin: fixture.origin, adminToken: fixture.adminToken }); }
  finally { await fixture.close(); }
});

test("pending boot diagnostics cannot expire API presence after the scene has loaded", async ({ browser, request }) => {
  test.setTimeout(180_000); expect(!!process.env.VRATA_TEST_POSTGRES_URL).toBe(true);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false, stateTokenSecret: STATE_SECRET });
  try { await bootDiagnosticsPresenceScenario({ browser, request, origin: fixture.origin, adminToken: fixture.adminToken }); }
  finally { await fixture.close(); }
});
