import { expect, test } from "@playwright/test";
import { startReferenceTemplateFixture } from "./reference-template-fixture";

// An activated floor admits only v2 sessions and refuses anonymous room reads. The public page
// must still diagnose a public room end to end, and must not leak the issued session or identity.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("public diagnostics admits a v2 session on an activated floor and keeps stored reports protected", async ({ page, request }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires isolated PostgreSQL");
  test.setTimeout(120_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { devRoleQuery: false, identityProtocol: 2 });
  try {
    const headers = { "x-vrata-admin-token": fixture.adminToken };
    const created = await request.post(`${fixture.origin}/api/rooms`, { headers, data: {
      tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Public diagnostics", visibility: "public", guestAllowed: true
    } });
    expect(created.status()).toBe(201);
    const { roomId } = await created.json() as { roomId: string };
    expect((await request.get(`${fixture.origin}/api/rooms/${roomId}/manifest`)).status()).toBe(409);

    await page.goto(`${fixture.origin}/diagnostics?roomId=${roomId}&autorun=1&skipMic=1&skipMedia=1&timeoutMs=5000`);
    await expect.poll(() => page.evaluate(() => (window as Window & {
      __VRATA_CONNECTIVITY_DIAGNOSTICS__?: { summary?: { failed: number } };
    }).__VRATA_CONNECTIVITY_DIAGNOSTICS__?.summary?.failed ?? null), { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(0);

    const reportText = await page.locator("#diagnostics-json").inputValue();
    for (const code of ["api_ok", "admin_details_protected", "state_token_ok", "room_state_ws_ok", "microphone_skipped", "media_skipped"]) {
      expect(reportText).toContain(`"${code}"`);
    }
    expect(reportText).toContain("accessToken=[redacted]");
    expect(/rs2\.|ri2\.|Bearer\s+[A-Za-z0-9._-]+/.test(reportText)).toBe(false);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await fixture.close();
  }
});
