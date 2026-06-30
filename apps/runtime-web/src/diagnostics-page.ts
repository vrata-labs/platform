import { runPublicConnectivityDiagnostics, type PublicConnectivityReport, type PublicDiagnosticCheck } from "./public-connectivity-diagnostics.js";

const query = new URLSearchParams(window.location.search);

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`diagnostics_dom_missing:${selector}`);
  }
  return element;
}

const roomIdInput = mustElement<HTMLInputElement>("#diagnostics-room-id");
const runButton = mustElement<HTMLButtonElement>("#diagnostics-run");
const copyButton = mustElement<HTMLButtonElement>("#diagnostics-copy");
const summaryEl = mustElement<HTMLElement>("#diagnostics-summary");
const resultsEl = mustElement<HTMLElement>("#diagnostics-results");
const jsonEl = mustElement<HTMLTextAreaElement>("#diagnostics-json");
const copyStatusEl = mustElement<HTMLElement>("#diagnostics-copy-status");

roomIdInput.value = query.get("roomId") || query.get("room") || "demo-room";

function renderCheck(check: PublicDiagnosticCheck): void {
  const existing = resultsEl.querySelector<HTMLElement>(`[data-check-name="${check.name}"]`);
  const item = existing ?? document.createElement("article");
  const header = document.createElement("div");
  const label = document.createElement("strong");
  const status = document.createElement("span");
  const code = document.createElement("div");
  const message = document.createElement("p");
  const duration = document.createElement("small");

  item.className = `diagnostics-check diagnostics-check-${check.status}`;
  item.dataset.checkName = check.name;
  item.replaceChildren();
  header.className = "diagnostics-check-header";
  label.textContent = check.label;
  status.textContent = check.status.toUpperCase();
  code.className = "diagnostics-check-code";
  code.textContent = check.code;
  message.textContent = check.message;
  duration.textContent = `${check.durationMs} ms`;
  header.append(label, status);
  item.append(header, code, message, duration);
  if (!existing) {
    resultsEl.appendChild(item);
  }
}

function renderReport(report: PublicConnectivityReport): void {
  summaryEl.textContent = `OK ${report.summary.ok} / Failed ${report.summary.failed} / Skipped ${report.summary.skipped}`;
  jsonEl.value = JSON.stringify(report, null, 2);
  copyButton.disabled = false;
  copyStatusEl.textContent = "Redacted JSON report ready for GitHub issues.";
  (window as Window & { __VRATA_CONNECTIVITY_DIAGNOSTICS__?: PublicConnectivityReport }).__VRATA_CONNECTIVITY_DIAGNOSTICS__ = report;
}

async function copyDiagnosticsReport(): Promise<void> {
  if (!jsonEl.value) {
    copyStatusEl.textContent = "Run checks before copying the report.";
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(jsonEl.value);
    } else {
      jsonEl.select();
      document.execCommand("copy");
      jsonEl.blur();
    }
    copyStatusEl.textContent = "Redacted JSON report copied.";
  } catch (_error: unknown) {
    copyStatusEl.textContent = "Copy failed; select the redacted JSON report manually.";
  }
}

async function runDiagnostics(): Promise<void> {
  resultsEl.replaceChildren();
  jsonEl.value = "";
  copyButton.disabled = true;
  runButton.disabled = true;
  summaryEl.textContent = "Running checks...";
  copyStatusEl.textContent = "Report pending.";
  try {
    const report = await runPublicConnectivityDiagnostics({
      apiBaseUrl: query.get("apiBaseUrl") || window.location.origin,
      roomId: roomIdInput.value.trim() || "demo-room",
      timeoutMs: Number.parseInt(query.get("timeoutMs") ?? "8000", 10) || 8000,
      skipMicrophone: query.get("skipMic") === "1",
      skipMedia: query.get("skipMedia") === "1",
      roomStateUrlOverride: query.get("failwss") === "1" ? "ws://127.0.0.1:9" : undefined,
      onCheck: renderCheck
    });
    renderReport(report);
  } catch (error) {
    summaryEl.textContent = "Diagnostics failed to run";
    jsonEl.value = JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => {
  void runDiagnostics();
});

copyButton.addEventListener("click", () => {
  void copyDiagnosticsReport();
});

if (query.get("autorun") === "1") {
  void runDiagnostics();
}
