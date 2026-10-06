import { test, expect } from "playwright/test";
import { readFile } from "node:fs/promises";

for (const mode of ["local", "@staging"]) {
  test.describe(`plugin resource probe ${mode}`, () => {
    test("production Workers complete 100 dual-instance cycles, real sustained CPU and both cumulative budget stops", async ({ page, context, baseURL }, testInfo) => {
      test.setTimeout(330_000);
      const canary = "RESOURCE_REPORT_FAKE_PRIVATE_TOKEN_CANARY";
      await context.addCookies([{ name: "fake_room_token", value: canary, url: baseURL! }]);
      await page.addInitScript((value) => { localStorage.setItem("roomToken", value); sessionStorage.setItem("adminToken", value); }, canary);
      await page.goto("/plugin-sandbox-probe.html");
      await expect(page.locator("html")).toHaveAttribute("data-probe-ready", "1");
      await page.locator("#device-kind").selectOption("android");
      await page.getByRole("button", { name: "Проверить ресурсы (2–3 мин)", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-resource-ready", "0");
      await page.getByRole("button", { name: "Проверить отклик под нагрузкой", exact: true }).click();
      await expect(page.getByRole("button", { name: "Проверить все сценарии", exact: true })).toBeDisabled();
      await expect(page.locator("html")).toHaveAttribute("data-resource-ready", "1", { timeout: 310_000 });
      const report = await page.evaluate(() => window.pluginSandboxProbe.getResourceReport());
      expect(report?.verdict, JSON.stringify(report)).toBe("PASS");
      expect(report?.complete).toBe(true);
      expect(report?.deviceGate).toBe("NOT_EVALUATED");
      expect(report?.scope).toBe("resource-benchmark");
      expect(report?.device.category).toBe("android"); // Manual label is not real-device evidence.
      expect(report?.cycleSummary.completed).toBe(100);
      expect(report?.observations.cycles).toHaveLength(100);
      for (const cycle of report!.observations.cycles) {
        expect(cycle.failure).toBeNull(); expect(cycle.phase).toBe("complete"); expect(cycle.state).toBe("disposed");
        expect(cycle.activeDuring).toBe(2); expect(cycle.activeAfter).toBe(1);
        expect(cycle.overlappingLinear?.primaryBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
        expect(cycle.overlappingLinear?.companionBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
      }
      expect(report?.observations.sustained?.elapsedMs).toBeGreaterThanOrEqual(60_000);
      expect(report?.observations.sustained?.failure).toBeNull();
      expect(report?.observations.secondBudget?.failure).toBe("execution_budget_second");
      expect(report?.observations.minuteBudget?.failure).toBe("execution_budget_minute");
      for (const budget of [report!.observations.secondBudget!, report!.observations.minuteBudget!]) {
        expect(budget.phase).toBe("event"); expect(budget.state).toBe("failed"); expect(budget.activeAfter).toBe(1);
        expect(budget.turns.length).toBeGreaterThan(0);
        for (const sample of budget.turns) expect(sample.turn?.executionMs).toBeLessThanOrEqual(50);
      }
      expect(report?.observations.instancesCreated).toBe(104); expect(report?.observations.instancesClosed).toBe(104);
      expect(report?.observations.activeAfterCleanup).toBe(0);
      expect(report?.observations.cleanupEvidence).toBe("INSTANCE_COUNTERS_ONLY");
      expect(report?.checks.ui.verdict).toBe("PASS");
      expect(report?.observations.ui?.visibleDuringClicks).toBeGreaterThan(0);
      expect(report?.limits.handlerBudgetMs).toBe(50); expect(report?.limits.workerResponseDeadlineMs).toBe(500);
      expect(report?.limits.vmStackBytes).toBe(32 * 1024);
      expect(report?.browserMemory.method).toBe("measureUserAgentSpecificMemory");
      for (const sample of report!.browserMemory.samples) if (sample.status !== "MEASURED") expect(sample.bytes).toBeNull();
      expect(await page.evaluate(() => window.pluginSandboxProbe.snapshot().activeInstances)).toBe(0);
      const completed = JSON.stringify(report);
      await page.getByRole("button", { name: "Проверить отклик под нагрузкой", exact: true }).click();
      expect(JSON.stringify(await page.evaluate(() => window.pluginSandboxProbe.getResourceReport()))).toBe(completed);
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Скачать ресурсный JSON", exact: true }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe("vrata-sandbox-resource-report.json");
      const json = await readFile((await download.path())!, "utf8");
      expect(json).not.toContain(canary);
      expect(JSON.parse(json)).toEqual(report);
      await testInfo.attach("resource-benchmark.json", { body: json, contentType: "application/json" });
    });

    test("synthetic DURING input is ignored and cancellation closes only owned resource Workers", async ({ page }) => {
      await page.goto("/plugin-sandbox-probe.html");
      await expect(page.locator("html")).toHaveAttribute("data-probe-ready", "1");
      await page.getByRole("button", { name: "Проверить ресурсы (2–3 мин)", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.pluginSandboxProbe.snapshot().activeInstances)).toBe(2);
      await expect(page.locator("html")).toHaveAttribute("data-resource-ready", "0");
      await page.evaluate(() => document.getElementById("resource-ui-button")!.click());
      await page.getByRole("button", { name: "Остановить ресурсный прогон", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-resource-ready", "1");
      const report = await page.evaluate(() => window.pluginSandboxProbe.getResourceReport());
      expect(report?.verdict, JSON.stringify(report)).toBe("INCOMPLETE");
      expect(report?.abort).toBe("cancelled"); expect(report?.failure).toBeNull();
      expect(report?.observations.activeAfterCleanup).toBe(0);
      expect(report?.observations.instancesCreated).toBe(report?.observations.instancesClosed);
      expect(report?.observations.ui?.trustedClicks).toBe(0);
      expect(report?.observations.ui?.duringClicks).toBe(0);
      expect(report?.observations.ui?.visibleDuringClicks).toBe(0);
      expect(report?.deviceGate).toBe("NOT_EVALUATED");
      await expect(page.getByRole("button", { name: "Скачать ресурсный JSON", exact: true })).toBeEnabled();
      const healthy = await page.evaluate(() => window.pluginSandboxProbe.run("healthy"));
      expect(healthy.failure).toBeNull(); expect(healthy.state).toBe("disposed");
    });

    test("hidden resource page cannot manufacture acceptance from a synthetic click or device label", async ({ page }) => {
      await page.addInitScript(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
      await page.goto("/plugin-sandbox-probe.html");
      await expect(page.locator("html")).toHaveAttribute("data-probe-ready", "1");
      await page.locator("#device-kind").selectOption("quest");
      await page.getByRole("button", { name: "Проверить ресурсы (2–3 мин)", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-resource-ready", "1");
      await page.evaluate(() => document.getElementById("resource-ui-button")!.click());
      const report = await page.evaluate(() => window.pluginSandboxProbe.getResourceReport());
      expect(report?.verdict, JSON.stringify(report)).toBe("INCOMPLETE"); expect(report?.abort).toBe("page-hidden");
      expect(report?.complete).toBe(false); expect(report?.deviceGate).toBe("NOT_EVALUATED");
      expect(report?.observations.ui?.duringClicks).toBe(0);
      expect(report?.observations.instancesCreated).toBe(0);
      expect(await page.evaluate(() => window.pluginSandboxProbe.snapshot().activeInstances)).toBe(0);
    });
  });
}
