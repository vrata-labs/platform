import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { bearer, createExternalAuthorProject, downloadPublicSdk, nativeMarker, pluginPath, privateHttp, type ExternalArtifact } from "./plugin-author-scenarios";
import { enterOwnedPluginRoom, enterPluginRoom, expectPluginStatus, startRoomPluginFixture, useOwnedActor } from "./room-plugin-fixture";

// Room invitations, RS2 and private config must never enter trace/video/snapshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

const statusBody = (suffix: string) =>
  `export function init(context: RoomPluginContext) { return context.sdk.status.set(String(context.config.greeting) + ${JSON.stringify(suffix)}); }`;

async function uploadThroughUi(page: Page, artifact: ExternalArtifact) {
  await page.locator("#room-plugin-upload-input").setInputFiles({ name: `${artifact.pluginId}-${artifact.version}.vrata-plugin.json`,
    mimeType: "application/json", buffer: artifact.bytes });
  await page.locator("#room-plugin-upload-button").click();
  await expect(page.locator("#room-plugin-author-message")).toContainText("Package uploaded", { timeout: 20_000 });
}
async function chooseVersion(entry: Locator, version: string) {
  const option = entry.locator('[data-role="version"] option', { hasText: version });
  await entry.locator('[data-role="version"]').selectOption(await option.getAttribute("value") ?? "");
}
async function act(page: Page, entry: Locator, action: string, expected: string) {
  await entry.locator(`[data-action="${action}"]`).click();
  await expect(page.locator("#room-plugin-author-message")).toContainText(expected, { timeout: 20_000 });
}

test("isolated v2 Host installs, updates, rolls back, disables and deletes external behaviors in the room UI; a Member sees them live", async ({ browser, request }) => {
  test.setTimeout(480_000); const value = await startRoomPluginFixture(2);
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  try {
    const host = await enterOwnedPluginRoom(browser, value);
    await useOwnedActor(host, async () => {
      const member = await enterPluginRoom(browser, value, host.roomId, "member", "Owned plugin runtime Member");
      try {
        const panel = host.page.locator("#room-plugin-author"), message = host.page.locator("#room-plugin-author-message");
        await expect(panel).toBeVisible({ timeout: 15_000 }); await expect(panel).toContainText("No packages uploaded");
        await expect(member.page.locator("#room-plugin-author")).toBeHidden();
        expect(member.requests.workers).toBe(0); expect(member.requests.wasm).toBe(0);

        author = await createExternalAuthorProject(await downloadPublicSdk(request));
        const id = `external.t08-${randomUUID().replaceAll("-", "")}`;
        const v1 = await author.build(id, "1.0.0", ["status.set"], statusBody(" v1"));
        const v2 = await author.build(id, "1.0.1", ["status.set"], statusBody(" v2"));
        await uploadThroughUi(host.page, v1);
        const entry = host.page.locator(`[data-plugin-id="${id}"]`);
        await expect(entry).toContainText("Not enabled in this room"); await expect(entry).toContainText("status.set");
        await expect(entry.locator('[data-capability="status.set"]')).not.toBeChecked();

        // Missing required settings and unconfirmed permissions never reach a binding write.
        await act(host.page, entry, "enable", "Check the settings");
        await entry.locator('[data-config-key="greeting"]').fill("<b>Hello</b>");
        await entry.locator('[data-capability="status.set"]').check();
        await act(host.page, entry, "enable", "Behavior enabled");
        await expectPluginStatus(member.page, "member-first-enable", "<b>Hello</b> v1", 45_000);
        await expectPluginStatus(host.page, "host-first-enable", "<b>Hello</b> v1");
        expect(await member.page.locator("#room-plugin-status-list b").count()).toBe(0);
        expect(member.requests.workers).toBeGreaterThan(0);

        await uploadThroughUi(host.page, v2);
        await chooseVersion(entry, "1.0.1");
        await expect(entry.locator('[data-capability="status.set"]')).toBeChecked();
        await expect(entry.locator('[data-config-key="greeting"]')).toHaveValue("<b>Hello</b>");
        await act(host.page, entry, "enable", "Behavior enabled");
        await expectPluginStatus(member.page, "member-update", "<b>Hello</b> v2");
        await chooseVersion(entry, "1.0.0");
        await act(host.page, entry, "enable", "Behavior enabled");
        await expectPluginStatus(member.page, "member-rollback", "<b>Hello</b> v1");
        await expect(entry).toContainText("Enabled, version 1.0.0");

        // A write made elsewhere replaces stale typed values instead of being overwritten by them.
        await entry.locator('[data-config-key="greeting"]').fill("typed but not saved");
        const library = (await privateHttp(value.origin, pluginPath(host.roomId, "packages"), "GET", bearer(host.session.token)))
          .json<{ revision: number; bindings: Array<{ pluginId: string; packageId: string; version: string; artifactSha256: string }> }>();
        const current = library.bindings.find(binding => binding.pluginId === id)!;
        const external = await privateHttp(value.origin, pluginPath(host.roomId, `bindings/${id}`), "PUT", bearer(host.session.token), {
          expectedRevision: library.revision, packageId: current.packageId, version: current.version, artifactSha256: current.artifactSha256,
          enabled: true, config: { greeting: "Changed elsewhere" }, approvedCapabilities: ["status.set"] });
        expect(external.status).toBe(200);
        await expect(entry.locator('[data-config-key="greeting"]')).toHaveValue("Changed elsewhere", { timeout: 15_000 });
        await expectPluginStatus(member.page, "member-external-write", "Changed elsewhere v1");

        await chooseVersion(entry, "1.0.1");
        await act(host.page, entry, "delete", "Package version deleted");
        await expect(entry.locator('[data-role="version"] option')).toHaveCount(1);
        await expect(entry.locator('[data-action="delete"]')).toHaveCount(0);

        await host.context.setOffline(true);
        await expect(message).toContainText("Offline", { timeout: 10_000 });
        await expect(entry.locator('[data-action="disable"]')).toBeDisabled();
        await host.context.setOffline(false);
        await expect(host.page.locator(`[data-plugin-id="${id}"] [data-action="disable"]`)).toBeEnabled({ timeout: 30_000 });

        await act(host.page, entry, "disable", "Behavior disabled");
        await expect(member.page.locator("#room-plugin-status-list")).not.toContainText("Changed elsewhere", { timeout: 15_000 });
        await expect(entry).toContainText("Disabled, version 1.0.0");

        // A second external package ID runs through the same SDK without any platform build.
        const secondId = `external.t08b-${randomUUID().replaceAll("-", "")}`;
        await uploadThroughUi(host.page, await author.build(secondId, "1.0.0", ["status.set"], statusBody(" second")));
        const second = host.page.locator(`[data-plugin-id="${secondId}"]`);
        await second.locator('[data-config-key="greeting"]').fill("Second");
        await second.locator('[data-capability="status.set"]').check();
        await act(host.page, second, "enable", "Behavior enabled");
        await expectPluginStatus(member.page, "member-second-package", "Second second");

        await act(host.page, entry, "unbind", "Behavior removed");
        await expect(entry).toContainText("Not enabled in this room");
        await act(host.page, entry, "delete", "Package version deleted");
        await expect(entry).toHaveCount(0);
        await expect(member.page.locator("#room-plugin-status-list")).toContainText("Second second");
        for (const page of [host.page, member.page]) expect(await page.evaluate(marker => Reflect.has(window, marker), nativeMarker)).toBe(false);
        await author.assertNotExecuted();
      } finally { await member.context.close(); }
    });
  } finally { await author?.close(); await value.close(); }
});
