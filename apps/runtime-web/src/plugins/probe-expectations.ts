import { PROBE_FIXTURES, type ProbeFixture } from "./probe-fixtures.js";
import { SANDBOX_FAILURES, SANDBOX_LIMITS, type GuestExceptionHint, type SandboxFailure } from "./limits.js";
import type { ProbeResult, ProbePhase } from "./probe.js";

export interface ProbeExpectation {
  label: string;
  purpose: string;
  expected: string;
  mode: "normal" | "contained";
  allowedFailures: readonly SandboxFailure[];
  statuses: readonly string[];
  hint?: GuestExceptionHint;
  phase: ProbePhase;
  observationOnly?: boolean;
}
function normal(label: string, purpose: string, statuses: string[]): ProbeExpectation {
  return { label, purpose, mode: "normal", allowedFailures: [], statuses, phase: "complete",
    expected: "Обычное завершение без ошибки, с ожидаемыми сообщениями. Состояние disposed означает, что проверочный плагин освобождён." };
}
function contained(label: string, purpose: string, allowedFailures: SandboxFailure[], hint?: GuestExceptionHint, phase: ProbePhase = "init"): ProbeExpectation {
  return { label, purpose, mode: "contained", allowedFailures, statuses: [], hint, phase,
    expected: `Опасный сценарий должен быть остановлен без принятых сообщений на фазе ${phase}. Состояние failed здесь ожидаемо. Допустимые коды: ${allowedFailures.join(", ")}.` };
}
function importObservation(label: string): ProbeExpectation {
  return { ...contained(label, "Наблюдает незавершение фиксированной import-программы. Причину ошибки не устанавливает; сеть и CSP проверяются отдельным автоматическим тестом.", ["guest_exception"]), observationOnly: true,
    expected: "Фиксированная программа не завершается на init, экземпляр остановлен без status effects. guest_exception не доказывает import_denied; требуется отдельная автоматическая проверка сети/CSP." };
}

/** Exhaustive, fixed expectations. A new fixture cannot silently inherit PASS. */
export const PROBE_EXPECTATIONS: Readonly<Record<ProbeFixture, ProbeExpectation>> = Object.freeze({
  healthy: normal("Обычный плагин", "Проверяет запуск, событие комнаты и корректное завершение рабочего плагина.", ["Welcome plugin initialized", "Probe greeting"]),
  globals: normal("Нет доступа к странице, токенам и сети", "Плагин проверяет отсутствие браузерных и системных объектов и заканчивает работу сам. Это нормальный сценарий.", ["VM globals and network unavailable"]),
  primordialTamper: normal("Защита от подмены встроенных функций", "Плагин подменяет Object, JSON, Promise и RegExp. Доверенные сохранённые функции должны продолжить работать.", ["Captured primordials intact"]),
  seatingDenied: normal("Посадка пока запрещена", "Проверяет явный отказ seating API. Реальной посадки и обращения к backend в этом spike нет.", ["Seating backend not integrated"]),
  loop: contained("Бесконечный цикл при запуске", "Проверяет остановку JavaScript, который не возвращается из init.", ["execution_timeout", "interrupt_limit"]),
  eventLoop: contained("Бесконечный цикл в событии", "Проверяет остановку зависшего обработчика события.", ["execution_timeout", "interrupt_limit"], undefined, "event"),
  disposeLoop: contained("Зависание при завершении", "Проверяет остановку плагина, который зациклился в dispose.", ["execution_timeout", "interrupt_limit"], undefined, "dispose"),
  heap: contained("Запрос памяти 64 MiB", "Стресс-проверка большой аллокации. Одна подсказка об ошибке не доказывает, какой именно предел памяти сработал.", ["guest_exception"], "memory_exhausted"),
  heapLimit: contained("Предел памяти VM: запрос 20 MiB", "20 MiB превышает heap limit 16 MiB, но помещается под linear cap 48 MiB. Отдельный Node-контроль с отключённым heap fence проверяет причинную связь.", ["guest_exception"], "memory_exhausted"),
  stack: contained("Глубокая рекурсия JavaScript", "Проверяет раннюю остановку рекурсии при VM stack 32 KiB.", ["guest_exception"], "stack_exhausted"),
  nativeJsonStack: contained("Глубокий JSON в native-коде", "Проверяет защиту стека внутри JSON.parse, а не только в JavaScript-цикле.", ["guest_exception"], "stack_exhausted"),
  nativeJoinStack: contained("Вложенный Array.join в native-коде", "Проверяет защиту стека при преобразовании глубоко вложенных массивов.", ["guest_exception"], "stack_exhausted"),
  promiseFlood: contained("Лавина Promise-задач", "Проверяет предел очереди микрозадач и времени их исполнения.", ["job_limit", "execution_timeout"]),
  oversizeReturn: contained("Слишком большой результат", "Плагин возвращает строку размером 1 MiB. Она не должна попасть в native bridge.", ["message_too_large"]),
  oversizeSdk: contained("Слишком большое сообщение SDK", "Плагин пытается отправить 1 MiB текста через status API.", ["message_too_large"]),
  accessor: contained("Getter в результате", "Getter с бесконечным циклом должен быть отвергнут без вызова.", ["invalid_data"]),
  functionReturn: contained("Функция вместо данных", "Проверяет запрет передачи функции из VM в native bridge.", ["invalid_data"]),
  symbolReturn: contained("Symbol вместо данных", "Проверяет запрет передачи Symbol из VM в native bridge.", ["invalid_data"]),
  unsafeKey: contained("Опасный ключ __proto__", "Проверяет отказ от ключей, пригодных для подмены прототипа.", ["unsafe_key"]),
  toJSON: contained("Опасный toJSON", "Метод сериализации гостя с бесконечным циклом не должен вызываться.", ["invalid_data"]),
  prototype: contained("Пользовательский прототип", "Через bridge разрешены только простые данные, без произвольного прототипа.", ["invalid_data"]),
  cycle: contained("Циклические данные", "Объект с ссылкой на самого себя должен быть отвергнут.", ["invalid_data"]),
  deep: contained("Слишком глубокие данные", "Проверяет ограничение глубины сериализации: максимум 8 уровней.", ["nesting_too_deep"]),
  nodes: contained("Слишком много узлов данных", "Проверяет ограничение объёма обхода, до native-конвертации строки.", ["node_limit"]),
  exceptionGetter: contained("Getter в исключении", "Проверяет безопасную обработку исключения и отмену ранее запрошенного status effect.", ["guest_exception"]),
  exceptionProxy: contained("Зависание при разборе исключения", "Proxy зацикливает getPrototypeOf. Разбор исключения тоже должен укладываться в бюджет VM.", ["execution_timeout", "interrupt_limit"]),
  serializerProxy: contained("Зависание при сериализации", "Proxy зацикливает ownKeys. Сериализация должна быть прервана внутри VM.", ["execution_timeout", "interrupt_limit"]),
  inheritedToJSON: contained("toJSON на общем прототипе", "Подменённый toJSON не должен выполняться; частичный status effect запрещён.", ["invalid_data"]),
  descriptorPoison: contained("Подмена descriptor через прототип", "Проверяет, что accessor нельзя замаскировать как безопасное data property.", ["invalid_data"]),
  bridgeFlood: contained("Лавина обращений к SDK", "Проверяет общий предел bridge: 10 запросов в секунду.", ["bridge_rate_limit"]),
  statusFlood: contained("Лавина сообщений статуса", "Проверяет предел status API: 2 сообщения в секунду.", ["status_rate_limit"]),
  failedAfterJobs: contained("Частичный status перед зависанием", "Сообщение, запрошенное перед лавиной Promise-задач, не должно быть принято host.", ["job_limit", "execution_timeout"]),
  staticImport: importObservation("Статическая import-программа"),
  dynamicImport: importObservation("Динамическая import-программа"),
  generatedImport: importObservation("Import-программа из eval"),
  pending: contained("Promise, который не завершится", "Lifecycle не должен бесконечно ждать незавершённый Promise.", ["pending_promise"]),
  regex: contained("Зависающее регулярное выражение", "Для native-вызова допустимо прерывание VM или уничтожение Worker watchdog. Другой плагин и интерфейс должны продолжить работать.", ["execution_timeout", "worker_timeout"], undefined, "event")
});

export const PROBE_FIXTURE_ORDER = Object.freeze(Object.keys(PROBE_FIXTURES) as ProbeFixture[]);
export const PROBE_PHASES = ["loaded", "init", "event", "dispose", "complete"] as const;
export const HOSTILE_FIXTURES = Object.freeze(PROBE_FIXTURE_ORDER.filter((fixture) => PROBE_EXPECTATIONS[fixture].mode === "contained"));
export function safePhase(value: unknown): ProbePhase | "unknown_phase" { return typeof value === "string" && (PROBE_PHASES as readonly string[]).includes(value) ? value as ProbePhase : "unknown_phase"; }
export type ProbeVerdict = "PASS" | "FAIL";
export interface ProbeAssessment { verdict: ProbeVerdict; expected: string; actual: string; reasons: string[] }
export function isProbeFixture(value: unknown): value is ProbeFixture {
  return typeof value === "string" && Object.hasOwn(PROBE_EXPECTATIONS, value);
}
export function safeFailure(value: unknown): SandboxFailure | "unknown_failure" | null {
  return value === null ? null : typeof value === "string" && (SANDBOX_FAILURES as readonly string[]).includes(value) ? value as SandboxFailure : "unknown_failure";
}
export function safeHint(value: unknown): GuestExceptionHint | null {
  return value === "memory_exhausted" || value === "stack_exhausted" ? value : null;
}

export function assessProbeResult(result: ProbeResult): ProbeAssessment {
  if (!isProbeFixture(result.fixture)) return { verdict: "FAIL", expected: "Известный фиксированный сценарий.", actual: "Неизвестный сценарий.", reasons: ["У сценария нет фиксированных ожиданий."] };
  const expectation = PROBE_EXPECTATIONS[result.fixture];
  const reasons: string[] = [];
  if (result.phase !== expectation.phase) reasons.push(`Отказ/завершение на фазе ${safePhase(result.phase)}, ожидалась фаза ${expectation.phase}. Нужный lifecycle-этап не подтверждён.`);
  if (result.state !== (expectation.mode === "normal" ? "disposed" : "failed")) reasons.push(expectation.mode === "normal" ? "Обычный плагин не завершён корректно." : "Нет подтверждённого завершения опасного экземпляра.");
  if (expectation.mode === "normal") {
    if (result.failure !== null) reasons.push(`Неожиданная ошибка обычного плагина: ${safeFailure(result.failure)}.`);
    if (result.exceptionHint !== null) reasons.push("У обычного плагина появилась подсказка об исключении.");
  } else {
    if (result.failure === null || !expectation.allowedFailures.includes(result.failure)) reasons.push(`Код остановки ${safeFailure(result.failure) ?? "отсутствует"} не соответствует ожидаемому.`);
    if (expectation.hint && result.exceptionHint !== expectation.hint) reasons.push("Нет ожидаемой ограниченной диагностической подсказки об исключении.");
  }
  if (!Array.isArray(result.statuses) || result.statuses.length !== expectation.statuses.length || result.statuses.some((text, index) => text !== expectation.statuses[index])) {
    reasons.push(expectation.mode === "contained" ? "Host принял сообщение опасного сценария." : "Сообщения обычного плагина не совпали с ожидаемыми.");
  }
  if (!Number.isSafeInteger(result.wasmMemoryBytes) || result.wasmMemoryBytes! < SANDBOX_LIMITS.wasmInitialMemoryBytes || result.wasmMemoryBytes! > SANDBOX_LIMITS.wasmMaxMemoryBytes) reasons.push("Размер измеренного WASM buffer отсутствует или выходит за установленные пределы.");
  if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 || !Number.isSafeInteger(result.hostFramesDuring) || result.hostFramesDuring < 0 ||
      (result.executionMs !== null && (!Number.isFinite(result.executionMs) || result.executionMs < 0 || result.executionMs > SANDBOX_LIMITS.handlerBudgetMs)) ||
      (result.jobs !== null && (!Number.isSafeInteger(result.jobs) || result.jobs < 0 || result.jobs > SANDBOX_LIMITS.jobsPerTurn))) reasons.push("Некорректные измерения времени или исполнения.");
  const verdict = reasons.length ? "FAIL" : "PASS";
  const actual = verdict === "PASS"
    ? expectation.mode === "normal" ? "Рабочий плагин завершён корректно." : expectation.observationOnly
      ? "Фиксированная import-программа не завершилась на init; экземпляр остановлен. Причина исключения не доказана. Проверка сети/CSP выполняется отдельно."
      : `Изоляция сработала: опасный экземпляр остановлен на фазе ${expectation.phase} с кодом ${safeFailure(result.failure)}. failed — состояние этого плагина, а не результат проверки.`
    : "Фактическое поведение не соответствует ожиданию. Это требует разбора на данном браузере.";
  return { verdict, expected: expectation.expected, actual, reasons };
}
