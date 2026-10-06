import { PROBE_EXPECTATIONS, PROBE_FIXTURE_ORDER, HOSTILE_FIXTURES, assessProbeResult, isProbeFixture, safeFailure, safeHint, safePhase, type ProbeAssessment } from "./probe-expectations.js";
import type { ProbeResult, ProbePhase } from "./probe.js";
import type { ProbeFixture } from "./probe-fixtures.js";
import { SANDBOX_LIMITS } from "./limits.js";

export const COMPANION_STATUS = "Healthy companion still responsive";
export type DeviceCategory = "unspecified" | "quest" | "windows" | "other";
export interface ProbeDevice {
  category: DeviceCategory; userAgent: string; language: string;
  viewport: { width: number; height: number; pixelRatio: number };
}
export interface ContinuityObservation {
  failure: unknown; completedChecks: number; allReady: boolean; finalStatusSeen: boolean; activeAfterCleanup: number; elapsedMs: number;
  operations: readonly CompanionOperation[];
}
export interface CompanionPing { sentOffsetMs: number; ackOffsetMs: number | null; latencyMs: number | null; failure: unknown }
export interface CompanionOperation { fixture: ProbeFixture; phase: ProbePhase; durationMs: number; pings: CompanionPing[] }
export interface UiObservation {
  framesDuringSuite: number; frameSamples: number; maxFrameGapMs: number | null; invalidFrameSamples: number;
  startedVisible: boolean; endedVisible: boolean; hiddenTransitions: number;
  trustedClicks: number; duringClicks: number; afterClicks: number; visibleDuringClicks: number;
  maxInputDelayMs: number | null; invalidInputTimestamps: number;
  clickPhase: "during-suite" | "after-suite" | null;
}
/** No new frame/input SLA: these are measurements. Companion latency uses the
 * already-published native Worker deadline, never a self-calibrated threshold.
 */
export const COMPANION_PING_INTERVAL_MS = SANDBOX_LIMITS.timerMinIntervalMs;
export function inputDelayMs(nowMs: number, eventTimeStamp: number, timeOrigin: number): number | null {
  if (![nowMs, eventTimeStamp, timeOrigin].every((value) => Number.isFinite(value) && value >= 0)) return null;
  const stamp = eventTimeStamp >= timeOrigin && timeOrigin > nowMs ? eventTimeStamp - timeOrigin : eventTimeStamp;
  const delay = nowMs - stamp;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}
export function assessCompanionOperation(operation: CompanionOperation): boolean {
  if (!isProbeFixture(operation.fixture) || PROBE_EXPECTATIONS[operation.fixture].mode !== "contained" ||
      operation.phase !== PROBE_EXPECTATIONS[operation.fixture].phase || !Number.isFinite(operation.durationMs) || operation.durationMs < 0 || operation.pings.length === 0) return false;
  let previousSent: number | undefined;
  for (const ping of operation.pings) {
    if (ping.failure !== null || !Number.isFinite(ping.sentOffsetMs) || ping.sentOffsetMs < 0 || ping.sentOffsetMs > operation.durationMs ||
        ping.ackOffsetMs === null || !Number.isFinite(ping.ackOffsetMs) || ping.ackOffsetMs < ping.sentOffsetMs ||
        ping.latencyMs === null || !Number.isFinite(ping.latencyMs) || ping.latencyMs < 0 || ping.latencyMs > SANDBOX_LIMITS.workerResponseDeadlineMs ||
        (previousSent !== undefined && ping.sentOffsetMs - previousSent < COMPANION_PING_INTERVAL_MS)) return false;
    previousSent = ping.sentOffsetMs;
  }
  // Short operations join an immediately launched concurrent ping, even when
  // its ACK arrives just after the operation. Long calls must have an ACK while
  // the hostile operation is still running, not just a post-failure ping.
  return operation.durationMs < SANDBOX_LIMITS.workerResponseDeadlineMs || operation.pings.some((ping) => ping.ackOffsetMs! <= operation.durationMs);
}
export interface ReportCheck { verdict: "PASS" | "FAIL" | "PENDING"; detail: string; measurements: Record<string, string | number | boolean | null> }
export function assessContinuity(observation: ContinuityObservation | null): ReportCheck {
  if (!observation) return { verdict: "PENDING", detail: "Контрольный плагин ещё не проверен.", measurements: {} };
  const operations = observation.operations;
  const concurrent = operations.length === HOSTILE_FIXTURES.length && new Set(operations.map((operation) => operation.fixture)).size === HOSTILE_FIXTURES.length && operations.every(assessCompanionOperation);
  const latencies = operations.flatMap((operation) => operation.pings.flatMap((ping) => ping.latencyMs === null ? [] : [ping.latencyMs]));
  const maxLatencyMs = latencies.length ? Math.max(...latencies) : null;
  const pass = concurrent && observation.failure === null && observation.completedChecks === PROBE_FIXTURE_ORDER.length && observation.allReady && observation.finalStatusSeen && observation.activeAfterCleanup === 0 && Number.isFinite(observation.elapsedMs) && observation.elapsedMs >= 0;
  return { verdict: pass ? "PASS" : "FAIL", detail: pass ? "Контрольный плагин отвечал параллельно опасным операциям и после каждого сценария; ACK не превысили 500 ms. Итоговый status получен, экземпляр освобождён." : `Параллельная непрерывность не подтверждена: проверьте покрытие операций, ACK и максимум задержки (предел 500 ms). Код: ${safeFailure(observation.failure) ?? "нет"}.`,
    measurements: { completedChecks: observation.completedChecks, operationsObserved: operations.length, concurrentOperationsValid: concurrent, maxLatencyMs,
      pingIntervalMs: COMPANION_PING_INTERVAL_MS, allReady: observation.allReady, finalStatusSeen: observation.finalStatusSeen, activeAfterCleanup: observation.activeAfterCleanup, elapsedMs: observation.elapsedMs, failure: safeFailure(observation.failure) } };
}
export function assessUi(observation: UiObservation | null): ReportCheck {
  if (!observation) return { verdict: "PENDING", detail: "Интерфейс ещё не проверен.", measurements: {} };
  const visible = observation.startedVisible && observation.endedVisible && observation.hiddenTransitions === 0;
  const validFrames = Number.isSafeInteger(observation.framesDuringSuite) && observation.framesDuringSuite >= 2 && observation.frameSamples === observation.framesDuringSuite &&
    observation.invalidFrameSamples === 0 && observation.maxFrameGapMs !== null && Number.isFinite(observation.maxFrameGapMs) && observation.maxFrameGapMs >= 0;
  const validClick = Number.isSafeInteger(observation.duringClicks) && observation.duringClicks > 0 && observation.visibleDuringClicks > 0 &&
    observation.trustedClicks >= observation.duringClicks && observation.maxInputDelayMs !== null && Number.isFinite(observation.maxInputDelayMs) && observation.maxInputDelayMs >= 0 && observation.invalidInputTimestamps === 0;
  return { verdict: !visible || !validFrames || observation.invalidInputTimestamps > 0 ? "FAIL" : validClick ? "PASS" : "PENDING",
    detail: !visible ? "Страница скрывалась во время прогона: отзывчивость видимого интерфейса не подтверждена. Повторите с открытой страницей." : !validFrames ? "Недостаточно валидных кадров за полный прогон. Один RAF не подтверждает отзывчивость." : observation.invalidInputTimestamps > 0 ? "Задержка ввода не измерена корректно: timestamp недопустим." : validClick ? "Во время видимого прогона зарегистрированы кадры и настоящий клик. Frame gap и задержка ввода записаны как измерения, без отдельного FPS/250 ms SLA." : "Нужен настоящий клик ПОКА ИДЁТ прогон. Клик после завершения — отдельное наблюдение и не подтверждает отзывчивость во время нагрузки; повторите прогон.",
    measurements: { framesDuringSuite: observation.framesDuringSuite, frameSamples: observation.frameSamples, maxFrameGapMs: observation.maxFrameGapMs,
      invalidFrameSamples: observation.invalidFrameSamples, startedVisible: observation.startedVisible, endedVisible: observation.endedVisible, hiddenTransitions: observation.hiddenTransitions,
      trustedClicks: observation.trustedClicks, duringClicks: observation.duringClicks, afterClicks: observation.afterClicks, visibleDuringClicks: observation.visibleDuringClicks,
      maxInputDelayMs: observation.maxInputDelayMs, invalidInputTimestamps: observation.invalidInputTimestamps,
      clickPhase: observation.clickPhase === "during-suite" || observation.clickPhase === "after-suite" ? observation.clickPhase : null } };
}
export interface ReportInput {
  scope: "single-scenario" | "full-suite";
  device: ProbeDevice; startedAt: string; completedAt: string | null;
  results: readonly ProbeResult[];
  continuity: ContinuityObservation | null; ui: UiObservation | null;
}
export interface PortableResult {
  fixture: string; phase: string; state: string; failure: string | null; exceptionHint: string | null;
  statuses: string[]; elapsedMs: number | null; executionMs: number | null; jobs: number | null;
  wasmMemoryBytes: number | null; hostFramesDuring: number | null;
}
export interface ProbeReport {
  schemaVersion: 1; scope: ReportInput["scope"]; verdict: "PASS" | "FAIL" | "INCOMPLETE"; complete: boolean;
  deviceGate: "NOT_EVALUATED"; device: ProbeDevice; startedAt: string; completedAt: string | null;
  passed: number; failed: number; expectedScenarios: number;
  missing: string[]; duplicates: string[];
  scenarios: { label: string; result: PortableResult; assessment: ProbeAssessment }[];
  continuity: ReportCheck; ui: ReportCheck; limitations: readonly string[];
  companionOperations: { fixture: string; phase: string; durationMs: number | null; pings: { sentOffsetMs: number | null; ackOffsetMs: number | null; latencyMs: number | null; failure: string | null }[] }[];
  limits: { vmHeapBytes: number; vmStackBytes: number; wasmInitialMemoryBytes: number; wasmMaxMemoryBytes: number;
    handlerBudgetMs: number; workerResponseDeadlineMs: number; workerModuleLoadDeadlineMs: number };
}
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
const date = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;

/** Explicit whitelist projection: no URL, cookies, room/participant context,
 * request source, error stack or arbitrary guest status text enters the export.
 */
export function portableProbeResult(result: ProbeResult): PortableResult {
  const known = isProbeFixture(result.fixture);
  const permitted = known ? PROBE_EXPECTATIONS[result.fixture].statuses : [];
  return {
    fixture: known ? result.fixture : "unknown_fixture",
    phase: safePhase(result.phase),
    state: ["booting", "ready", "disposing", "disposed", "failed"].includes(result.state) ? result.state : "unknown_state",
    failure: safeFailure(result.failure), exceptionHint: safeHint(result.exceptionHint),
    statuses: Array.isArray(result.statuses) ? result.statuses.map((status) => permitted.includes(status) ? status : "[неожиданный текст скрыт]") : [],
    elapsedMs: finite(result.elapsedMs), executionMs: finite(result.executionMs), jobs: finite(result.jobs),
    wasmMemoryBytes: finite(result.wasmMemoryBytes), hostFramesDuring: finite(result.hostFramesDuring)
  };
}
export function buildProbeReport(input: ReportInput): ProbeReport {
  const scenarios = input.results.map((result) => ({ label: isProbeFixture(result.fixture) ? PROBE_EXPECTATIONS[result.fixture].label : "Неизвестный сценарий", result: portableProbeResult(result), assessment: assessProbeResult(result) }));
  const counts = new Map<string, number>();
  for (const result of input.results) {
    const key = isProbeFixture(result.fixture) ? result.fixture : "unknown_fixture";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = input.scope === "full-suite" ? PROBE_FIXTURE_ORDER.filter((fixture) => !counts.has(fixture)) : [];
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([fixture]) => fixture);
  const continuity = assessContinuity(input.continuity), ui = assessUi(input.ui);
  const complete = date(input.completedAt) !== null && scenarios.length > 0 && duplicates.length === 0 &&
    (input.scope === "single-scenario" ? scenarios.length === 1 : missing.length === 0 && scenarios.length === PROBE_FIXTURE_ORDER.length && continuity.verdict !== "PENDING" && ui.verdict !== "PENDING");
  const failed = scenarios.filter((scenario) => scenario.assessment.verdict === "FAIL").length;
  const verdict = failed || duplicates.length || (input.scope === "full-suite" && (continuity.verdict === "FAIL" || ui.verdict === "FAIL")) ? "FAIL" : complete ? "PASS" : "INCOMPLETE";
  return {
    schemaVersion: 1, scope: input.scope, verdict, complete, deviceGate: "NOT_EVALUATED",
    device: {
      category: ["unspecified", "quest", "windows", "other"].includes(input.device.category) ? input.device.category : "unspecified",
      userAgent: text(input.device.userAgent, 512), language: text(input.device.language, 48),
      viewport: { width: finite(input.device.viewport.width) ?? 0, height: finite(input.device.viewport.height) ?? 0, pixelRatio: finite(input.device.viewport.pixelRatio) ?? 0 }
    },
    startedAt: date(input.startedAt) ?? "", completedAt: date(input.completedAt),
    passed: scenarios.length - failed, failed, expectedScenarios: input.scope === "full-suite" ? PROBE_FIXTURE_ORDER.length : 1,
    missing, duplicates, scenarios, continuity, ui,
    companionOperations: input.continuity?.operations.map((operation) => ({ fixture: isProbeFixture(operation.fixture) ? operation.fixture : "unknown_fixture",
      phase: safePhase(operation.phase), durationMs: finite(operation.durationMs),
      pings: operation.pings.map((ping) => ({ sentOffsetMs: finite(ping.sentOffsetMs), ackOffsetMs: finite(ping.ackOffsetMs), latencyMs: finite(ping.latencyMs), failure: safeFailure(ping.failure) })) })) ?? [],
    limits: {
      vmHeapBytes: SANDBOX_LIMITS.vmHeapBytes, vmStackBytes: SANDBOX_LIMITS.vmStackBytes,
      wasmInitialMemoryBytes: SANDBOX_LIMITS.wasmInitialMemoryBytes, wasmMaxMemoryBytes: SANDBOX_LIMITS.wasmMaxMemoryBytes,
      handlerBudgetMs: SANDBOX_LIMITS.handlerBudgetMs, workerResponseDeadlineMs: SANDBOX_LIMITS.workerResponseDeadlineMs,
      workerModuleLoadDeadlineMs: SANDBOX_LIMITS.workerModuleLoadDeadlineMs
    },
    limitations: [
      "PASS относится только к выполненным диагностическим сценариям этого отчёта. Полный device gate не оценивался.",
      "Категория Quest или Windows выбирается вручную. User-Agent и клик сами по себе не подтверждают прохождение проверки.",
      "WASM buffer — линейная память экземпляра, не вся память Worker или браузера и не прямое измерение heap VM.",
      "exceptionHint — ограниченная недоверенная подсказка. Она не доказывает причину исключения.",
      "Незавершение фиксированной import-программы не доказывает import_denied. Сеть и CSP проверяются отдельным автоматическим тестом.",
      "Frame gap и input delay — измерения всего прогона, не новый FPS или 250 ms SLA. Клик после прогона не заменяет клик во время.",
      "Этот ручной отчёт не заменяет автоматическую сетевую/CSP-проверку, длительное тестирование устройства и дальнейшую проверку комнатных функций."
    ]
  };
}
export function serializeProbeReport(report: ProbeReport): string { return JSON.stringify(report, null, 2); }
