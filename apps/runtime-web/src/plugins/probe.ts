import { createPluginSupervisor, loadTrustedPluginWasm } from "./host.js";
import { PROBE_FIXTURES, type ProbeFixture } from "./probe-fixtures.js";
import { SandboxError, SANDBOX_LIMITS, type SandboxFailure, type GuestExceptionHint } from "./limits.js";
import { PROBE_EXPECTATIONS, PROBE_FIXTURE_ORDER, assessProbeResult, isProbeFixture } from "./probe-expectations.js";
import { buildProbeReport, portableProbeResult, serializeProbeReport, COMPANION_STATUS,
  COMPANION_PING_INTERVAL_MS, inputDelayMs,
  type ProbeReport, type ProbeDevice, type ReportInput, type ContinuityObservation, type UiObservation, type CompanionOperation } from "./probe-report.js";
import type { PluginSupervisor, InstanceState } from "./supervisor.js";
import type { RoomPluginEvent } from "@vrata/room-plugin-sdk";
import { runResourceProbe } from "./resource-probe-runner.js";
import { buildResourceProbeReport, serializeResourceProbeReport, resourceProbeSummary, type ResourceProbeReport } from "./resource-probe-report.js";
import type { ResourceObservation, ResourcePhase, ResourceBrowserMemory } from "./resource-probe-contract.js";

const ready: RoomPluginEvent = {
  sdkApiVersion: 1, type: "room.ready",
  snapshot: { ownParticipantAlias: "probe-own-alias", arrivalAllowed: false, seats: [] }
};
const connection: RoomPluginEvent = { sdkApiVersion: 1, type: "room.connection", state: "connected" };
export type ProbePhase = "loaded" | "init" | "event" | "dispose" | "complete";
export interface ProbeResult {
  fixture: ProbeFixture; phase: ProbePhase; state: InstanceState; failure: SandboxFailure | null;
  /** Bounded untrusted hint; never an authenticated/proven resource failure. */
  exceptionHint: GuestExceptionHint | null;
  statuses: string[]; elapsedMs: number; executionMs: number | null; jobs: number | null;
  /** Last successful/boot turn's WASM buffer, not total browser memory. */
  wasmMemoryBytes: number | null; hostFramesDuring: number;
}
export interface ProbeSnapshot {
  hostFrames: number; clicks: number; activeInstances: number;
  companionState: InstanceState | null; companionStatuses: string[];
  companionBoot: { executionMs: number; wasmMemoryBytes: number } | null;
}
export interface PluginSandboxProbe {
  fixtures: readonly ProbeFixture[]; limits: typeof SANDBOX_LIMITS;
  run(fixture: ProbeFixture): Promise<ProbeResult>;
  startCompanion(): Promise<void>; companionEvent(): Promise<void>; stopCompanion(): Promise<void>;
  snapshot(): ProbeSnapshot;
  runSuite(): Promise<ProbeReport>;
  getReport(): ProbeReport | null;
  exportReport(): string | null;
  runResources(): Promise<ResourceProbeReport>;
  cancelResources(): void;
  getResourceReport(): ResourceProbeReport | null;
  exportResourceReport(): string | null;
}
declare global { interface Window { pluginSandboxProbe: PluginSandboxProbe } }

// Only this platform diagnostic entry loads the harness. No room boot or source upload.
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("plugin-status"), diagnostic = element("diagnostic"), heartbeat = element("heartbeat"), clickCounter = element("clicks");
const select = element<HTMLSelectElement>("fixture"), deviceSelect = element<HTMLSelectElement>("device-kind");
const runButton = element<HTMLButtonElement>("run"), suiteButton = element<HTMLButtonElement>("run-suite"), downloadButton = element<HTMLButtonElement>("download-report");
const progress = element<HTMLProgressElement>("suite-progress");
const resourceButton = element<HTMLButtonElement>("run-resources"), resourceStopButton = element<HTMLButtonElement>("stop-resources"), resourceDownloadButton = element<HTMLButtonElement>("download-resources");
const resourceProgress = element<HTMLProgressElement>("resource-progress");
let resourceRunning = false, resourceController: AbortController | undefined, resourceReport: ResourceProbeReport | null = null;
let resourceUi: UiObservation | null = null, resourceStartedAtMs = 0, resourceStartFrames = 0, resourceLastFrameAtMs = 0;
const resourceInstances = new Set<PluginSupervisor>();
let hostFrames = 0, clicks = 0, running = false, suiteRunning = false, companionStarting = false, stopped = false;
let companion: PluginSupervisor | undefined, active: PluginSupervisor | undefined;
let companionBoot: ProbeSnapshot["companionBoot"] = null;
const companionStatuses: string[] = [];
let frameId = 0, reportInput: ReportInput | null = null;
let suiteStartFrames = 0, clickCheckOpen = false, suiteStartedAtMs = 0;
let uiObservation: UiObservation | null = null, lastFrameAtMs = 0;

function recordFrameGap(now: number) {
  if (!uiObservation) return;
  const gap = now - lastFrameAtMs;
  if (Number.isFinite(gap) && gap >= 0) uiObservation.maxFrameGapMs = Math.max(uiObservation.maxFrameGapMs ?? 0, gap);
  else uiObservation.invalidFrameSamples++;
  lastFrameAtMs = now;
}
function frame() {
  if (!stopped) {
    heartbeat.textContent = String(++hostFrames);
    if (suiteRunning && uiObservation) { recordFrameGap(performance.now()); uiObservation.frameSamples++; uiObservation.framesDuringSuite = hostFrames - suiteStartFrames; }
    if (resourceRunning && resourceUi) {
      const now = performance.now(), gap = now - resourceLastFrameAtMs;
      if (Number.isFinite(gap) && gap >= 0) resourceUi.maxFrameGapMs = Math.max(resourceUi.maxFrameGapMs ?? 0, gap);
      else resourceUi.invalidFrameSamples++;
      resourceLastFrameAtMs = now;
      resourceUi.frameSamples++; resourceUi.framesDuringSuite = hostFrames - resourceStartFrames;
    }
    frameId = requestAnimationFrame(frame);
  }
}
frameId = requestAnimationFrame(frame);
const boundedCode = (error: unknown): SandboxFailure => error instanceof SandboxError ? error.code : "native_failure";
const device = (): ProbeDevice => ({
  category: deviceSelect.value as ProbeDevice["category"], userAgent: navigator.userAgent, language: navigator.language,
  viewport: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio }
});
function buttons() {
  runButton.disabled = suiteButton.disabled = resourceButton.disabled = running || suiteRunning || resourceRunning || companionStarting || stopped;
  select.disabled = deviceSelect.disabled = suiteRunning || resourceRunning;
  downloadButton.disabled = !reportInput || suiteRunning || running || resourceRunning;
  resourceStopButton.disabled = !resourceRunning;
  resourceDownloadButton.disabled = !resourceReport || resourceRunning;
}
function setVerdict(verdict: string, text: string, summary: string) {
  element("verdict").dataset.verdict = verdict; element("verdict").textContent = text; element("verdict-summary").textContent = summary;
}
function describe(fixture: ProbeFixture) {
  const expectation = PROBE_EXPECTATIONS[fixture];
  element("purpose").textContent = expectation.purpose; element("expected").textContent = expectation.expected;
}
function renderResult(result: ProbeResult) {
  const assessment = assessProbeResult(result);
  element("actual").textContent = `${assessment.verdict}: ${assessment.actual} ${assessment.reasons.join(" ")}`;
  element("actual").dataset.verdict = assessment.verdict;
  element("actual-code").textContent = `Состояние плагина: ${result.state}. Фаза: ${result.phase}. Код остановки: ${result.failure ?? "нет"}.${result.exceptionHint ? ` Недоверенная подсказка: ${result.exceptionHint}.` : ""}`;
  element("metrics").textContent = `Полное время: ${result.elapsedMs.toFixed(1)} ms. Исполнение init: ${result.executionMs?.toFixed(1) ?? "не завершилось"} ms. WASM buffer: ${result.wasmMemoryBytes === null ? "не измерен" : `${(result.wasmMemoryBytes / 1048576).toFixed(1)} MiB`}.`;
  diagnostic.textContent = JSON.stringify({ result: portableProbeResult(result), assessment }, null, 2);
}
function currentReport(): ProbeReport | null { return reportInput ? buildProbeReport(reportInput) : null; }
function renderReport() {
  const report = currentReport(); if (!report) return;
  element("results-section").hidden = false;
  const list = element("scenario-results"); list.replaceChildren();
  for (const scenario of report.scenarios) {
    const item = document.createElement("li"), label = document.createElement("strong"), detail = document.createElement("p"), timing = document.createElement("p");
    label.textContent = `${scenario.assessment.verdict} — ${scenario.label}`; label.dataset.verdict = scenario.assessment.verdict;
    detail.textContent = `${scenario.assessment.actual} ${scenario.assessment.reasons.join(" ")}`;
    timing.textContent = `Код: ${scenario.result.failure ?? "нет"}; фаза: ${scenario.result.phase}; плагин: ${scenario.result.state}; время: ${scenario.result.elapsedMs?.toFixed(1) ?? "нет"} ms.`;
    item.append(label, detail, timing); list.append(item);
  }
  if (report.scope === "full-suite") {
    const gap = report.ui.measurements.maxFrameGapMs, input = report.ui.measurements.maxInputDelayMs;
    element("ui-check").textContent = `${report.ui.verdict}: ${report.ui.detail} Максимальный frame gap: ${typeof gap === "number" ? gap.toFixed(1) : "нет"} ms; input delay: ${typeof input === "number" ? input.toFixed(1) : "нет"} ms.`;
    const latency = report.continuity.measurements.maxLatencyMs;
    element("companion-check").textContent = `${report.continuity.verdict}: ${report.continuity.detail} Максимальный ACK: ${typeof latency === "number" ? latency.toFixed(1) : "нет"} ms.`;
  }
  if (!suiteRunning) {
    const text = report.verdict === "PASS" ? report.scope === "single-scenario" ? "PASS — 1 СЦЕНАРИЙ" : "PASS — ПОЛНЫЙ ПРОГОН" : report.verdict === "FAIL" ? "FAIL — ТРЕБУЕТСЯ РАЗБОР" : "ОТЧЁТ НЕПОЛНЫЙ";
    const summary = report.scope === "full-suite"
      ? `Сценарии: ${report.passed} PASS, ${report.failed} FAIL из ${report.expectedScenarios}. ${report.verdict === "INCOMPLETE" ? report.ui.detail : "Это результат диагностики данного браузера, не полный device gate."}`
      : `Проверен один сценарий. ${report.scenarios[0]?.assessment.actual ?? "Нет завершённого результата."} Полная проверка устройства не выполнялась.`;
    setVerdict(report.verdict, text, summary);
    diagnostic.textContent = serializeProbeReport(report);
  }
  document.documentElement.dataset.reportComplete = String(report.complete);
  buttons();
}

interface OperationMonitor { control?: PluginSupervisor; failure: SandboxFailure | null; operations: CompanionOperation[] }
async function observeOperation<T>(monitor: OperationMonitor, fixture: ProbeFixture, phase: ProbePhase, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const operation: CompanionOperation = { fixture, phase, durationMs: 0, pings: [] };
  monitor.operations.push(operation);
  let ended = false, wake: (() => void) | undefined;
  let work: Promise<T>;
  try { work = action(); } catch (error) { work = Promise.reject(error); }
  const pump = (async () => {
    while (!ended && monitor.control && !monitor.failure) {
      const sent = performance.now();
      try {
        if (!isCurrentCompanion(monitor.control) || monitor.control.state !== "ready") throw new SandboxError("instance_closed");
        await monitor.control.event(connection);
        if (monitor.control.state !== "ready") throw new SandboxError("instance_closed");
        const ack = performance.now();
        operation.pings.push({ sentOffsetMs: sent - started, ackOffsetMs: ack - started, latencyMs: ack - sent, failure: null });
      } catch (error) {
        monitor.failure = boundedCode(error);
        operation.pings.push({ sentOffsetMs: sent - started, ackOffsetMs: null, latencyMs: null, failure: monitor.failure });
      }
      if (ended || monitor.failure) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, COMPANION_PING_INTERVAL_MS);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  })();
  try { return await work; }
  finally {
    operation.durationMs = performance.now() - started; ended = true; wake?.();
    // Join the first concurrent ACK for short calls; never defer it until after
    // a failing operation. Cancel periodic timers before the next operation.
    await pump;
  }
}
async function runCase(fixture: ProbeFixture, monitor?: OperationMonitor): Promise<ProbeResult> {
  running = true; buttons(); describe(fixture); status.textContent = "";
  const started = performance.now(), frames = hostFrames, statuses: string[] = [];
  let phase: ProbePhase = "loaded";
  document.documentElement.dataset.activeFixture = fixture;
  document.documentElement.dataset.activePhase = phase;
  const step = async <T>(next: ProbePhase, action: () => Promise<T>): Promise<T> => {
    phase = next; document.documentElement.dataset.activePhase = phase;
    return monitor && PROBE_EXPECTATIONS[fixture].mode === "contained" && PROBE_EXPECTATIONS[fixture].phase === next
      ? observeOperation(monitor, fixture, next, action) : action();
  };
  let instance: PluginSupervisor | undefined;
  let failure: SandboxFailure | null = null, exceptionHint: GuestExceptionHint | null = null;
  let executionMs: number | null = null, jobs: number | null = null, wasmMemoryBytes: number | null = null;
  try {
    const wasm = await loadTrustedPluginWasm();
    instance = active = createPluginSupervisor(["status.set"], (request) => { statuses.push(request.payload.text); status.textContent = `Сообщение плагина: ${request.payload.text}`; });
    const turn = await step("init", () => instance!.init(wasm, PROBE_FIXTURES[fixture], { greeting: "Probe greeting" }));
    executionMs = turn.executionMs; jobs = turn.jobs; wasmMemoryBytes = turn.wasmMemoryBytes;
    if (fixture === "eventLoop" || fixture === "regex" || fixture === "healthy") await step("event", () => instance!.event(ready));
    await step("dispose", () => instance!.dispose());
    phase = "complete";
  } catch (error) { failure = boundedCode(error); exceptionHint = error instanceof SandboxError ? error.exceptionHint ?? null : null; }
  finally { wasmMemoryBytes ??= instance?.wasmMemoryBytes ?? null; instance?.terminate(); active = undefined; running = false; document.documentElement.dataset.activePhase = "idle"; buttons(); }
  const result: ProbeResult = { fixture, phase, state: instance?.state ?? "failed", failure, exceptionHint, statuses,
    elapsedMs: performance.now() - started, executionMs, jobs, wasmMemoryBytes, hostFramesDuring: hostFrames - frames };
  renderResult(result); return result;
}
async function startCompanion(): Promise<PluginSupervisor> {
  companionStarting = true; companionStatuses.length = 0; companionBoot = null; buttons();
  try {
    const wasm = await loadTrustedPluginWasm();
    companion = createPluginSupervisor(["status.set"], (request) => {
      companionStatuses.push(request.payload.text);
      // Keep the original harness status text for existing browser callers.
      element("companion-status").textContent = `Плагин companion: ${request.payload.text}`;
    });
    const turn = await companion.init(wasm, PROBE_FIXTURES.healthy, { greeting: COMPANION_STATUS });
    companionBoot = { executionMs: turn.executionMs, wasmMemoryBytes: turn.wasmMemoryBytes };
    return companion;
  } catch (error) { companion?.terminate(); companion = undefined; throw error; }
  finally { companionStarting = false; buttons(); }
}
async function stopCompanion() {
  const instance = companion; companion = undefined;
  if (instance?.state === "ready") await instance.dispose(); else instance?.terminate();
}
function isCurrentCompanion(instance: PluginSupervisor): boolean { return companion === instance; }

const resourceLabels: Record<ResourcePhase, string> = {
  wasm: "Загрузка доверенного WASM", companion: "Запуск контрольного экземпляра", cycles: "Циклы init → event → dispose",
  sustained: "Минута обычной нагрузки", "budget-second": "CPU-бюджет 100 ms/s", "budget-minute": "CPU-бюджет 2 s/min",
  cleanup: "Закрытие экземпляров", complete: "Прогон завершён"
};
const resourceCheckLabels = {
  provenance: "Полнота и корректность наблюдений", lifecycle: "100 полных циклов", sustained: "60 секунд обычной нагрузки",
  secondBudget: "Остановка по CPU-бюджету секунды", minuteBudget: "Остановка по CPU-бюджету минуты",
  companion: "Отклик контрольного экземпляра", ui: "Видимый интерфейс и клик во время нагрузки", cleanup: "Закрытие собственных экземпляров"
};
function renderResourceReport(report: ResourceProbeReport) {
  const verdict = element("resource-verdict"); verdict.dataset.verdict = report.verdict;
  verdict.textContent = report.verdict === "PASS" ? "PASS — РЕСУРСНЫЙ ПРОГОН" : report.verdict === "FAIL" ? "FAIL — ТРЕБУЕТСЯ РАЗБОР" : "ОТЧЁТ НЕПОЛНЫЙ";
  element("resource-summary").textContent = `Полных циклов: ${report.cycleSummary.completed}/${report.cycleSummary.requested}. Время: ${report.elapsedMs === null ? "не измерено" : `${(report.elapsedMs / 1000).toFixed(1)} s`}. ${resourceProbeSummary(report)}`;
  const checks = element("resource-checks"); checks.replaceChildren();
  for (const key of Object.keys(resourceCheckLabels) as (keyof typeof resourceCheckLabels)[]) {
    const item = document.createElement("li"); item.dataset.verdict = report.checks[key].verdict;
    item.textContent = `${resourceCheckLabels[key]}: ${report.checks[key].verdict}`; checks.append(item);
  }
  const buffers = report.cycleSummary.overlappingLinearBytes;
  const mib = (bytes: number | null) => bytes === null ? "не измерено" : `${(bytes / 1048576).toFixed(1)} MiB`;
  element("resource-memory").textContent = `Одновременно живые WASM buffer (максимум наблюдений): основной ${mib(buffers.primaryBytes.max)}, контрольный ${mib(buffers.companionBytes.max)}, сумма ${mib(buffers.combinedLinearBytes.max)}. Это не память всего браузера. Browser memory API: ${report.browserMemory.measurement === "NOT_MEASURED" ? "НЕ ИЗМЕРЕНО — API недоступен или измерение не завершилось" : report.browserMemory.measurement === "PARTIAL" ? "частичные измерения в JSON" : "измерения в JSON"}. Счётчики закрытия не доказывают физическое освобождение памяти.`;
}
async function readResourceBrowserMemory(phase: ResourceBrowserMemory["samples"][number]["phase"]): Promise<ResourceBrowserMemory["samples"][number]> {
  const api = performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: unknown }> };
  if (!crossOriginIsolated || typeof api.measureUserAgentSpecificMemory !== "function") return { phase, status: "UNAVAILABLE", bytes: null };
  try {
    const measurement = await api.measureUserAgentSpecificMemory();
    const bytes = measurement.bytes;
    return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0
      ? { phase, status: "MEASURED", bytes } : { phase, status: "ERROR", bytes: null };
  } catch { return { phase, status: "ERROR", bytes: null }; }
}
async function runResources(): Promise<ResourceProbeReport> {
  if (companion || running || suiteRunning || resourceRunning || companionStarting || stopped) throw new SandboxError("invalid_input");
  resourceRunning = true; clickCheckOpen = false; resourceReport = null;
  resourceController = new AbortController(); resourceStartFrames = hostFrames;
  resourceStartedAtMs = resourceLastFrameAtMs = performance.now();
  resourceUi = { framesDuringSuite: 0, frameSamples: 0, maxFrameGapMs: null, invalidFrameSamples: 0,
    startedVisible: document.visibilityState === "visible", endedVisible: false, hiddenTransitions: 0,
    trustedClicks: 0, duringClicks: 0, afterClicks: 0, visibleDuringClicks: 0, maxInputDelayMs: null, invalidInputTimestamps: 0, clickPhase: null };
  document.documentElement.dataset.resourceReady = "0";
  element("resource-verdict").dataset.verdict = "PENDING"; element("resource-verdict").textContent = "РЕСУРСНАЯ ПРОВЕРКА ИДЁТ";
  element("resource-summary").textContent = "Оставьте страницу видимой и нажмите кнопку отклика во время прогона.";
  element("resource-checks").replaceChildren(); resourceProgress.value = 0; buttons();
  let observation: ResourceObservation;
  try {
    observation = await runResourceProbe({
      loadWasm: loadTrustedPluginWasm,
      createInstance: () => { const instance = createPluginSupervisor([]); resourceInstances.add(instance); return instance; },
      signal: resourceController.signal, crossOriginIsolated, readBrowserMemory: readResourceBrowserMemory,
      onProgress: (phase, completed, total) => {
        element("resource-status").textContent = `${resourceLabels[phase]}: ${phase === "sustained" ? `${(completed / 1000).toFixed(0)}/${total / 1000} s` : `${completed}/${total}`}`;
        resourceProgress.value = total ? completed * 100 / total : 0;
        document.documentElement.dataset.resourcePhase = phase;
      }
    }, { runId: crypto.randomUUID(), device: device(), startedAt: new Date().toISOString() });
    const now = performance.now(), gap = now - resourceLastFrameAtMs;
    if (Number.isFinite(gap) && gap >= 0) resourceUi.maxFrameGapMs = Math.max(resourceUi.maxFrameGapMs ?? 0, gap);
    else resourceUi.invalidFrameSamples++;
    resourceUi.endedVisible = document.visibilityState === "visible";
    resourceUi.framesDuringSuite = hostFrames - resourceStartFrames;
    observation.ui = resourceUi;
    resourceReport = buildResourceProbeReport(observation);
    renderResourceReport(resourceReport);
    return resourceReport;
  } finally {
    for (const instance of resourceInstances) instance.terminate(); resourceInstances.clear();
    resourceRunning = false; resourceController = undefined;
    document.documentElement.dataset.resourceReady = "1"; buttons();
  }
}

const harness: PluginSandboxProbe = {
  fixtures: PROBE_FIXTURE_ORDER, limits: SANDBOX_LIMITS,
  async run(fixture) {
    if (!isProbeFixture(fixture) || running || suiteRunning || resourceRunning || companionStarting || stopped) throw new SandboxError("invalid_input");
    clickCheckOpen = false;
    const startedAt = new Date().toISOString(), capturedDevice = device();
    select.value = fixture;
    reportInput = { scope: "single-scenario", device: capturedDevice, startedAt, completedAt: null, results: [], continuity: null, ui: null };
    setVerdict("PENDING", "ПРОВЕРЯЕТСЯ", PROBE_EXPECTATIONS[fixture].label);
    const result = await runCase(fixture);
    reportInput = { scope: "single-scenario", device: capturedDevice, startedAt, completedAt: new Date().toISOString(), results: [result], continuity: null, ui: null };
    renderReport(); return result;
  },
  async startCompanion() {
    if (companion || running || suiteRunning || resourceRunning || companionStarting || stopped) throw new SandboxError("invalid_input");
    await startCompanion();
  },
  async companionEvent() { if (!companion) throw new SandboxError("instance_closed"); await companion.event(ready); },
  stopCompanion,
  snapshot() { return { hostFrames, clicks, activeInstances: Number(!!companion) + Number(!!active) + [...resourceInstances].filter((instance) => instance.state !== "failed" && instance.state !== "disposed").length,
    companionState: companion?.state ?? null, companionStatuses: [...companionStatuses], companionBoot }; },
  async runSuite() {
    if (companion || running || suiteRunning || resourceRunning || companionStarting || stopped) throw new SandboxError("invalid_input");
    suiteRunning = clickCheckOpen = true; suiteStartFrames = hostFrames; suiteStartedAtMs = lastFrameAtMs = performance.now();
    uiObservation = { framesDuringSuite: 0, frameSamples: 0, maxFrameGapMs: null, invalidFrameSamples: 0,
      startedVisible: document.visibilityState === "visible", endedVisible: false, hiddenTransitions: 0,
      trustedClicks: 0, duringClicks: 0, afterClicks: 0, visibleDuringClicks: 0, maxInputDelayMs: null, invalidInputTimestamps: 0, clickPhase: null };
    document.documentElement.dataset.suiteReady = "0";
    reportInput = { scope: "full-suite", device: device(), startedAt: new Date().toISOString(), completedAt: null, results: [], continuity: null, ui: null };
    progress.value = 0; progress.max = PROBE_FIXTURE_ORDER.length;
    setVerdict("PENDING", "ПОЛНАЯ ПРОВЕРКА ИДЁТ", "Опасные экземпляры будут остановлены. Нажмите кнопку отклика; это отдельная ручная проверка.");
    buttons(); renderReport();
    const continuityStarted = performance.now();
    let continuityFailure: SandboxFailure | null = null, completedChecks = 0, allReady = true, finalStatusSeen = false;
    let control: PluginSupervisor | undefined;
    try { control = await startCompanion(); }
    catch (error) { continuityFailure = boundedCode(error); allReady = false; }
    const monitor: OperationMonitor = { control, failure: continuityFailure, operations: [] };
    try {
      for (const [index, fixture] of PROBE_FIXTURE_ORDER.entries()) {
        if (stopped) break;
        element("suite-status").textContent = `${index + 1}/${PROBE_FIXTURE_ORDER.length}: ${PROBE_EXPECTATIONS[fixture].label}`;
        select.value = fixture;
        const result = await runCase(fixture, monitor);
        reportInput.results = [...reportInput.results, result]; progress.value = index + 1;
        if (control && !continuityFailure && !monitor.failure) {
          try {
            if (!isCurrentCompanion(control) || control.state !== "ready") throw new SandboxError("instance_closed");
            // Real lifecycle ack after EVERY fixture, without status flooding.
            await control.event(connection); completedChecks++;
            if (control.state !== "ready") throw new SandboxError("instance_closed");
          } catch (error) { continuityFailure = boundedCode(error); allReady = false; }
        }
        renderReport();
      }
      if (control && !continuityFailure) {
        await control.event(ready);
        finalStatusSeen = companionStatuses.at(-1) === COMPANION_STATUS && control.state === "ready";
      }
    } catch (error) { continuityFailure = boundedCode(error); allReady = false; }
    finally {
      try { await stopCompanion(); } catch (error) { continuityFailure ??= boundedCode(error); allReady = false; }
      active?.terminate(); active = undefined;
      const continuity: ContinuityObservation = { failure: continuityFailure, completedChecks, allReady, finalStatusSeen,
        operations: monitor.operations, activeAfterCleanup: harness.snapshot().activeInstances, elapsedMs: performance.now() - continuityStarted };
      continuity.failure ??= monitor.failure;
      reportInput.continuity = continuity;
      recordFrameGap(performance.now());
      uiObservation.endedVisible = document.visibilityState === "visible";
      uiObservation.framesDuringSuite = hostFrames - suiteStartFrames;
      reportInput.ui = uiObservation;
      reportInput.completedAt = new Date().toISOString();
      suiteRunning = false;
      element("suite-status").textContent = `Сценарии завершены: ${reportInput.results.length}/${PROBE_FIXTURE_ORDER.length}. ${uiObservation.duringClicks ? "Результат готов." : "Клика во время прогона нет. Повторите прогон и нажмите отклик ПОКА он идёт."}`;
      document.documentElement.dataset.suiteReady = "1"; renderReport();
      // Later real clicks are retained as AFTER evidence, never promoted into
      // during-suite responsiveness, even for an already failed/complete run.
      clickCheckOpen = true;
    }
    return currentReport()!;
  },
  getReport: currentReport,
  exportReport() { const report = currentReport(); return report ? serializeProbeReport(report) : null; },
  runResources,
  cancelResources() { resourceController?.abort("cancelled"); },
  getResourceReport() { return resourceReport; },
  exportResourceReport() { return resourceReport ? serializeResourceProbeReport(resourceReport) : null; }
};
window.pluginSandboxProbe = Object.freeze(harness);
for (const fixture of harness.fixtures) {
  const option = document.createElement("option"); option.value = fixture; option.textContent = PROBE_EXPECTATIONS[fixture].label; select.append(option);
}
describe(select.value as ProbeFixture);
select.addEventListener("change", () => { if (isProbeFixture(select.value)) describe(select.value); });
function recordClick(event: MouseEvent) {
  clickCounter.textContent = String(++clicks);
  if (event.isTrusted && resourceRunning && resourceUi) {
    const now = performance.now(), delay = inputDelayMs(now, event.timeStamp, performance.timeOrigin);
    resourceUi.trustedClicks++; resourceUi.duringClicks++; resourceUi.clickPhase = "during-suite";
    if (delay === null) resourceUi.invalidInputTimestamps++;
    else resourceUi.maxInputDelayMs = Math.max(resourceUi.maxInputDelayMs ?? 0, delay);
    if (delay !== null && now - delay >= resourceStartedAtMs && document.visibilityState === "visible") resourceUi.visibleDuringClicks++;
    element("resource-summary").textContent = "Настоящий клик во время ресурсной нагрузки записан. Дождитесь отчёта.";
  }
  if (event.isTrusted && clickCheckOpen && reportInput?.scope === "full-suite" && uiObservation) {
    uiObservation.trustedClicks++;
    uiObservation.clickPhase ??= suiteRunning ? "during-suite" : "after-suite";
    if (suiteRunning) {
      const now = performance.now(), delay = inputDelayMs(now, event.timeStamp, performance.timeOrigin);
      if (delay === null) uiObservation.invalidInputTimestamps++;
      else uiObservation.maxInputDelayMs = Math.max(uiObservation.maxInputDelayMs ?? 0, delay);
      uiObservation.duringClicks++;
      if (delay !== null && now - delay >= suiteStartedAtMs && document.visibilityState === "visible") uiObservation.visibleDuringClicks++;
      element("ui-check").textContent = "Настоящий клик во время прогона записан. Итоговые frame gap и input delay появятся в отчёте.";
    } else {
      uiObservation.afterClicks++;
      reportInput.ui = uiObservation;
      renderReport();
    }
  }
}
element("ui-button").addEventListener("click", recordClick);
element("resource-ui-button").addEventListener("click", recordClick);
document.addEventListener("visibilitychange", () => {
  if (suiteRunning && uiObservation && document.visibilityState !== "visible") uiObservation.hiddenTransitions++;
  if (resourceRunning && resourceUi && document.visibilityState !== "visible") resourceUi.hiddenTransitions++;
});
function showHarnessFailure(error: unknown) { setVerdict("FAIL", "FAIL — ЗАПУСК НЕ УДАЛСЯ", `Код: ${boundedCode(error)}. Это не ожидаемая остановка опасного сценария.`); buttons(); }
runButton.addEventListener("click", () => { void harness.run(select.value as ProbeFixture).catch(showHarnessFailure); });
suiteButton.addEventListener("click", () => { void harness.runSuite().catch(showHarnessFailure); });
resourceButton.addEventListener("click", () => { void harness.runResources().catch((error: unknown) => {
  element("resource-verdict").dataset.verdict = "FAIL"; element("resource-verdict").textContent = "FAIL — ЗАПУСК НЕ УДАЛСЯ";
  element("resource-summary").textContent = `Код: ${boundedCode(error)}. Сохраните наблюдение; это не ожидаемая остановка опасного сценария.`;
}); });
resourceStopButton.addEventListener("click", () => harness.cancelResources());
resourceDownloadButton.addEventListener("click", () => {
  const json = harness.exportResourceReport(); if (!json) return;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "vrata-sandbox-resource-report.json"; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
downloadButton.addEventListener("click", () => {
  const json = harness.exportReport(); if (!json) return;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "vrata-sandbox-device-report.json"; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", () => { stopped = true; resourceController?.abort("pagehide"); cancelAnimationFrame(frameId); active?.terminate(); companion?.terminate(); }, { once: true });
document.documentElement.dataset.probeReady = "1";
