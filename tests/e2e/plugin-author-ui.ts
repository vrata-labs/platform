import { expect, type Locator, type Page } from "@playwright/test";
import type { ExternalArtifact } from "./plugin-author-scenarios";

export async function uploadThroughUi(page: Page, artifact: ExternalArtifact) {
  await page.locator("#room-plugin-upload-input").setInputFiles({ name: `${artifact.pluginId}-${artifact.version}.vrata-plugin.json`,
    mimeType: "application/json", buffer: artifact.bytes });
  await page.locator("#room-plugin-upload-button").click();
  await expect(page.locator("#room-plugin-author-message")).toContainText("Package uploaded", { timeout: 20_000 });
}
export async function chooseVersion(entry: Locator, version: string) {
  const option = entry.locator('[data-role="version"] option', { hasText: version });
  await entry.locator('[data-role="version"]').selectOption(await option.getAttribute("value") ?? "");
}
export async function act(page: Page, entry: Locator, action: string, expected: string) {
  await entry.locator(`[data-action="${action}"]`).click();
  await expect(page.locator("#room-plugin-author-message")).toContainText(expected, { timeout: 20_000 });
}
