import { test, expect, type Page, type BrowserContext } from "playwright/test";
import { readFile } from "node:fs/promises";
import type { ProbeResult } from "../../apps/runtime-web/src/plugins/probe.js";
import type { ProbeFixture } from "../../apps/runtime-web/src/plugins/probe-fixtures.js";

const workerPath = /\/assets\/room-plugin-worker-[\w-]+\.js(?:\?|$)/;
const canary = "T03_FAKE_ROOM_ADMIN_MEDIA_TOKEN_CANARY";
// A full run creates 37 bounded Worker instances; it is not a single handler.
// Keep this wait within each full-suite test's existing 60-second deadline.
const fullSuiteCompletionWaitMs = 45_000;

async function openProbe(page: Page) {
  await page.goto("/plugin-sandbox-probe.html");
  await expect(page.locator("html")).toHaveAttribute("data-probe-ready", "1");
}
async function run(page: Page, fixture: ProbeFixture): Promise<ProbeResult> {
  return page.evaluate((name) => window.pluginSandboxProbe.run(name), fixture);
}
async function trustedClickWithInvalidTimestamp(page: Page): Promise<void> {
  const previous = await page.evaluateHandle(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp");
    Object.defineProperty(Event.prototype, "timeStamp", { configurable: true, get: () => Number.NaN });
    return descriptor;
  });
  try { await page.getByRole("button", { name: "Проверить отклик интерфейса" }).click(); }
  finally {
    try {
      await page.evaluate((descriptor) => {
        if (descriptor) Object.defineProperty(Event.prototype, "timeStamp", descriptor);
        else Reflect.deleteProperty(Event.prototype, "timeStamp");
      }, previous);
    } finally { await previous.dispose(); }
  }
}
function watchNetwork(context: BrowserContext) {
  const exfil: string[] = [];
  const canaryRequests: string[] = [];
  const wasmCookies: string[] = [];
  const wasmRequests: string[] = [];
  const workers: { url: string; csp: string; source: Promise<string> }[] = [];
  context.on("request", (request) => {
    if (request.url().includes("plugin-exfil.invalid")) exfil.push(request.url());
    if (request.url().includes(canary) || request.postData()?.includes(canary)) canaryRequests.push(request.url());
    if (/\.wasm(?:\?|$)/.test(request.url())) {
      wasmRequests.push(request.url());
      if (request.headers().cookie) wasmCookies.push(request.headers().cookie);
    }
  });
  context.on("response", (response) => {
    if (workerPath.test(response.url())) workers.push({ url: response.url(), csp: response.headers()["content-security-policy"] ?? "", source: response.text() });
  });
  return { exfil, canaryRequests, wasmCookies, wasmRequests, workers };
}

for (const mode of ["local", "@staging"]) {
test.describe(`plugin sandbox ${mode}`, () => {
test("real Worker boots transferred WASM under restricted production CSP; VM cannot access network or token canaries", async ({ page, context, baseURL }) => {
  const network = watchNetwork(context);
  await context.route("**/plugin-exfil.invalid/**", (route) => route.abort());
  await context.addCookies([{ name: "fake_room_token", value: canary, url: baseURL! }]);
  await page.addInitScript((token) => {
    (window as unknown as { hostCanary: string }).hostCanary = token;
    localStorage.setItem("roomToken", token); sessionStorage.setItem("adminToken", token);
  }, canary);
  await openProbe(page);
  const globals = await run(page, "globals");
  expect(globals.failure, JSON.stringify(globals)).toBeNull();
  expect(globals.state).toBe("disposed");
  expect(globals.phase).toBe("complete");
  expect(globals.statuses).toEqual(["VM globals and network unavailable"]);
  expect(globals.wasmMemoryBytes).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { hostCanary: string }).hostCanary)).toBe(canary);
  const healthy = await run(page, "healthy");
  expect(healthy.failure, JSON.stringify(healthy)).toBeNull();
  expect(healthy.statuses).toEqual(["Welcome plugin initialized", "Probe greeting"]);
  expect(network.workers.length).toBeGreaterThanOrEqual(2);
  for (const worker of network.workers) {
    expect(worker.csp).toMatch(/default-src\s+'none'/);
    expect(worker.csp).toMatch(/script-src\s+'wasm-unsafe-eval'(?:\s*;|\s*$)/);
    expect(worker.csp).toMatch(/connect-src\s+'none'/);
    expect(worker.csp).toMatch(/worker-src\s+'none'/);
    expect(await worker.source).not.toMatch(/\bimport\s*\(/);
  }
  expect(network.exfil).toEqual([]);
  expect(network.canaryRequests).toEqual([]);
  expect(network.wasmCookies).toEqual([]);
  expect(network.wasmRequests).toHaveLength(1);
});

test("catastrophic regex/native call terminates only its Worker while companion and host UI remain usable", async ({ page, context }) => {
  const network = watchNetwork(context);
  await openProbe(page);
  await page.evaluate(() => window.pluginSandboxProbe.startCompanion());
  const before = await page.evaluate(() => window.pluginSandboxProbe.snapshot());
  const hostile = run(page, "regex");
  await page.getByRole("button", { name: "Проверить отклик интерфейса" }).click();
  await expect(page.locator("#clicks")).toHaveText("1");
  const result = await hostile;
  expect(["worker_timeout", "execution_timeout"]).toContain(result.failure);
  expect(result.state, JSON.stringify(result)).toBe("failed");
  expect(result.phase).toBe("event");
  expect(result.statuses).toEqual([]);
  // Separate, measured WASM buffers. This is not a whole-browser memory bound.
  expect(result.wasmMemoryBytes).toBeGreaterThan(0);
  expect(before.companionBoot?.wasmMemoryBytes).toBeGreaterThan(0);
  const after = await page.evaluate(() => window.pluginSandboxProbe.snapshot());
  expect(after.hostFrames).toBeGreaterThan(before.hostFrames);
  expect(after.companionState).toBe("ready");
  expect(after.activeInstances).toBe(1);
  await page.evaluate(() => window.pluginSandboxProbe.companionEvent());
  await expect(page.locator("#companion-status")).toHaveText("Плагин companion: Healthy companion still responsive");
  await page.evaluate(() => window.pluginSandboxProbe.stopCompanion());
  expect(network.exfil).toEqual([]);
});

test("real Worker contains distinct malicious payload/job/getter/import probes with concrete failures and no partial status effects", async ({ page, context }) => {
  const network = watchNetwork(context);
  await context.route("**/plugin-exfil.invalid/**", (route) => route.abort());
  await openProbe(page);
  const cases: [ProbeFixture, string[]][] = [
    ["loop", ["execution_timeout", "interrupt_limit"]], ["eventLoop", ["execution_timeout", "interrupt_limit"]],
    ["disposeLoop", ["execution_timeout", "interrupt_limit"]], ["heap", ["guest_exception"]], ["heapLimit", ["guest_exception"]], ["stack", ["guest_exception"]],
    ["nativeJsonStack", ["guest_exception"]], ["nativeJoinStack", ["guest_exception"]],
    ["promiseFlood", ["job_limit", "execution_timeout"]], ["failedAfterJobs", ["job_limit", "execution_timeout"]],
    ["oversizeReturn", ["message_too_large"]], ["oversizeSdk", ["message_too_large"]],
    ["accessor", ["invalid_data"]], ["toJSON", ["invalid_data"]], ["inheritedToJSON", ["invalid_data"]],
    ["descriptorPoison", ["invalid_data"]], ["exceptionGetter", ["guest_exception"]],
    ["exceptionProxy", ["execution_timeout", "interrupt_limit"]], ["serializerProxy", ["execution_timeout", "interrupt_limit"]],
    ["bridgeFlood", ["bridge_rate_limit"]], ["statusFlood", ["status_rate_limit"]],
    ["staticImport", ["guest_exception"]], ["dynamicImport", ["guest_exception"]], ["generatedImport", ["guest_exception"]]
  ];
  for (const [fixture, failures] of cases) {
    // Independent test expectation. Discovery must not execute app/SDK code:
    // staging verifies published assets without building a local runtime.
    const expectedPhase = fixture === "eventLoop" ? "event" : fixture === "disposeLoop" ? "dispose" : "init";
    const result = await run(page, fixture);
    expect(failures, JSON.stringify(result)).toContain(result.failure);
    expect(result.state).toBe("failed");
    expect(result.phase, JSON.stringify(result)).toBe(expectedPhase);
    expect(result.statuses).toEqual([]);
    if (["stack", "nativeJsonStack", "nativeJoinStack"].includes(fixture)) expect(result.exceptionHint, JSON.stringify(result)).toBe("stack_exhausted");
    if (fixture === "heap" || fixture === "heapLimit") {
      // Fixed allocation fixtures; the exception hint itself is untrusted and
      // does not prove which fence fired. Node's heap-off control isolates that.
      expect(result.exceptionHint, JSON.stringify(result)).toBe("memory_exhausted");
      expect(result.wasmMemoryBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
      expect(result.wasmMemoryBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
    }
  }
  const healthy = await run(page, "primordialTamper");
  expect(healthy.failure, JSON.stringify(healthy)).toBeNull();
  expect(healthy.statuses).toEqual(["Captured primordials intact"]);
  await page.getByRole("button", { name: "Проверить отклик интерфейса" }).click();
  await expect(page.locator("#clicks")).toHaveText("1");
  expect(network.exfil).toEqual([]);
  expect(network.canaryRequests).toEqual([]);
});
test("compiled Worker boot respects measured 32KiB VM stack and bounded 48MiB memory", async ({ page }, testInfo) => {
  await openProbe(page);
  expect(await page.evaluate(() => window.pluginSandboxProbe.limits.vmStackBytes)).toBe(32 * 1024);
  const measurements: ProbeResult[] = [];
  for (const fixture of ["stack", "nativeJsonStack", "nativeJoinStack", "heapLimit", "heap"] as const) {
    const result = await run(page, fixture);
    measurements.push(result);
    expect(result.failure, JSON.stringify(result)).toBe("guest_exception");
    expect(result.exceptionHint, JSON.stringify(result)).toBe(fixture === "heap" || fixture === "heapLimit" ? "memory_exhausted" : "stack_exhausted");
    expect(result.state).toBe("failed");
    expect(result.phase, JSON.stringify(result)).toBe("init");
    expect(result.wasmMemoryBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(result.wasmMemoryBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
  }
  const healthy = await run(page, "healthy");
  expect(healthy.failure, JSON.stringify(healthy)).toBeNull();
  expect(healthy.wasmMemoryBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  expect(healthy.wasmMemoryBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
  const limits = await page.evaluate(() => window.pluginSandboxProbe.limits);
  await testInfo.attach("stack-and-memory-measurements.json", {
    body: JSON.stringify({ limits, measurements, healthy }, null, 2), contentType: "application/json"
  });
});

test("manual Russian UI separates hostile PASS from plugin failed and exports a readable single-scenario report", async ({ page }) => {
  await page.addInitScript((token) => {
    localStorage.setItem("roomToken", token); sessionStorage.setItem("adminToken", token);
    (window as unknown as { hostCanary: string }).hostCanary = token;
  }, canary);
  await openProbe(page);
  await page.locator("#fixture").selectOption("loop");
  await expect(page.locator("#purpose")).toContainText("init");
  await expect(page.locator("#expected")).toContainText("failed здесь ожидаемо");
  await page.getByRole("button", { name: "Запустить сценарий" }).click();
  await expect(page.locator("#verdict")).toHaveText("PASS — 1 СЦЕНАРИЙ");
  await expect(page.locator("#actual-code")).toContainText("Состояние плагина: failed");
  await expect(page.locator("#actual")).toContainText("Изоляция сработала");
  await page.locator("#fixture").selectOption("healthy");
  await page.getByRole("button", { name: "Запустить сценарий" }).click();
  await expect(page.locator("#actual-code")).toContainText("Состояние плагина: disposed");
  await expect(page.locator("#verdict")).toHaveText("PASS — 1 СЦЕНАРИЙ");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать JSON-отчёт" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("vrata-sandbox-device-report.json");
  const json = await readFile((await download.path())!, "utf8");
  expect(json).not.toContain(canary);
  const report = JSON.parse(json);
  expect(report.scope).toBe("single-scenario"); expect(report.verdict).toBe("PASS");
  expect(report.deviceGate).toBe("NOT_EVALUATED"); expect(report.scenarios[0].result.fixture).toBe("healthy");
});

test("full suite requires a trusted visible DURING click and records concurrent companion ACKs", async ({ page }) => {
  test.setTimeout(60000);
  await openProbe(page);
  await page.locator("#device-kind").selectOption("quest");
  await page.getByRole("button", { name: "Проверить все сценарии" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-suite-ready", "0");
  await page.getByRole("button", { name: "Проверить отклик интерфейса" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-suite-ready", "1", { timeout: fullSuiteCompletionWaitMs });
  await expect(page.locator("#verdict")).toHaveText("PASS — ПОЛНЫЙ ПРОГОН");
  const report = await page.evaluate(() => window.pluginSandboxProbe.getReport());
  expect(report?.expectedScenarios).toBe(37); expect(report?.scenarios).toHaveLength(37);
  expect(report?.failed, JSON.stringify(report)).toBe(0);
  expect(report?.continuity.verdict, JSON.stringify(report)).toBe("PASS");
  expect(report?.companionOperations).toHaveLength(33);
  expect(report?.continuity.measurements.maxLatencyMs).toBeLessThanOrEqual(500);
  expect(report?.complete).toBe(true); expect(report?.ui.verdict).toBe("PASS");
  expect(report?.ui.measurements.clickPhase).toBe("during-suite");
  expect(report?.ui.measurements.visibleDuringClicks).toBeGreaterThan(0);
  expect(report?.ui.measurements.maxFrameGapMs).toBeGreaterThanOrEqual(0);
  expect(report?.ui.measurements.maxInputDelayMs).toBeGreaterThanOrEqual(0);
  expect(report?.deviceGate).toBe("NOT_EVALUATED");
  expect(await page.evaluate(() => window.pluginSandboxProbe.snapshot().activeInstances)).toBe(0);
  await expect(page.getByRole("button", { name: "Скачать JSON-отчёт" })).toBeEnabled();
  // Real browser-trusted AFTER click, deliberately invalid timestamp. Completed
  // DURING measurements/verdict/time must not be re-evaluated from this input.
  await trustedClickWithInvalidTimestamp(page);
  const after = await page.evaluate(() => window.pluginSandboxProbe.getReport());
  const { trustedClicks, afterClicks, ...duringMeasurements } = report!.ui.measurements;
  const { trustedClicks: trustedAfter, afterClicks: afterCount, ...preservedMeasurements } = after!.ui.measurements;
  expect(preservedMeasurements).toEqual(duringMeasurements);
  expect(trustedAfter).toBe(Number(trustedClicks) + 1);
  expect(afterCount).toBe(Number(afterClicks) + 1);
  expect(after?.completedAt).toBe(report?.completedAt);
  expect(after?.ui.verdict).toBe(report?.ui.verdict);
  expect(after?.verdict).toBe(report?.verdict);
  expect(after?.complete).toBe(report?.complete);
});

test("Quest UA and after-suite/synthetic clicks cannot manufacture during responsiveness", async ({ page }) => {
  test.setTimeout(60000);
  await openProbe(page);
  await page.locator("#device-kind").selectOption("quest");
  await page.getByRole("button", { name: "Проверить все сценарии" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-suite-ready", "1", { timeout: fullSuiteCompletionWaitMs });
  const before = await page.evaluate(() => window.pluginSandboxProbe.getReport());
  await page.evaluate(() => document.getElementById("ui-button")!.click());
  await trustedClickWithInvalidTimestamp(page);
  const report = await page.evaluate(() => window.pluginSandboxProbe.getReport());
  expect(report?.failed, JSON.stringify(report)).toBe(0);
  expect(report?.ui.verdict).toBe("PENDING"); expect(report?.verdict).toBe("INCOMPLETE");
  expect(report?.ui.measurements.duringClicks).toBe(0); expect(report?.ui.measurements.afterClicks).toBe(1);
  expect(report?.ui.measurements.maxInputDelayMs).toBe(before?.ui.measurements.maxInputDelayMs);
  expect(report?.ui.measurements.invalidInputTimestamps).toBe(before?.ui.measurements.invalidInputTimestamps);
  expect(report?.completedAt).toBe(before?.completedAt);
  expect(report?.deviceGate).toBe("NOT_EVALUATED");
  await expect(page.locator("#verdict")).toHaveText("ОТЧЁТ НЕПОЛНЫЙ");
});

test("simulated hidden document fails UI evidence even with a browser-trusted during click", async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
  await openProbe(page);
  await page.getByRole("button", { name: "Проверить все сценарии" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-suite-ready", "0");
  await page.getByRole("button", { name: "Проверить отклик интерфейса" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-suite-ready", "1", { timeout: fullSuiteCompletionWaitMs });
  const report = await page.evaluate(() => window.pluginSandboxProbe.getReport());
  expect(report?.ui.verdict).toBe("FAIL"); expect(report?.verdict).toBe("FAIL");
  expect(report?.ui.measurements.startedVisible).toBe(false);
  expect(report?.deviceGate).toBe("NOT_EVALUATED");
  await expect(page.locator("#verdict")).toHaveText("FAIL — ТРЕБУЕТСЯ РАЗБОР");
});
});
}
