import { createPluginSupervisor, loadTrustedPluginWasm } from "./host.js";
import { PROBE_FIXTURES, type ProbeFixture } from "./probe-fixtures.js";
import { SandboxError, SANDBOX_LIMITS, type SandboxFailure, type GuestExceptionHint } from "./limits.js";
import type { PluginSupervisor, InstanceState } from "./supervisor.js";
import type { RoomPluginEvent } from "@vrata/room-plugin-sdk";

const ready: RoomPluginEvent = {
  sdkApiVersion: 1, type: "room.ready",
  snapshot: { ownParticipantAlias: "probe-own-alias", arrivalAllowed: false, seats: [] }
};
export interface ProbeResult {
  fixture: ProbeFixture;
  state: InstanceState;
  failure: SandboxFailure | null;
  /** Bounded untrusted hint; never an authenticated/proven resource failure. */
  exceptionHint: GuestExceptionHint | null;
  statuses: string[];
  elapsedMs: number;
  executionMs: number | null;
  jobs: number | null;
  /** Last successful turn's WASM buffer measurement, not total browser memory. */
  wasmMemoryBytes: number | null;
  hostFramesDuring: number;
}
export interface ProbeSnapshot {
  hostFrames: number; clicks: number; activeInstances: number;
  companionState: InstanceState | null; companionStatuses: string[];
  companionBoot: { executionMs: number; wasmMemoryBytes: number } | null;
}
export interface PluginSandboxProbe {
  fixtures: readonly ProbeFixture[];
  limits: typeof SANDBOX_LIMITS;
  run(fixture: ProbeFixture): Promise<ProbeResult>;
  startCompanion(): Promise<void>;
  companionEvent(): Promise<void>;
  stopCompanion(): Promise<void>;
  snapshot(): ProbeSnapshot;
}
declare global { interface Window { pluginSandboxProbe: PluginSandboxProbe } }

// This entry is deliberately absent from room boot. Parent build/API integration
// exposes a platform diagnostic page, never an arbitrary-code upload endpoint.
const status = document.querySelector<HTMLElement>("#plugin-status")!;
const diagnostic = document.querySelector<HTMLElement>("#diagnostic")!;
const heartbeat = document.querySelector<HTMLElement>("#heartbeat")!;
const clickCounter = document.querySelector<HTMLElement>("#clicks")!;
const select = document.querySelector<HTMLSelectElement>("#fixture")!;
let hostFrames = 0, clicks = 0, running = false, companionStarting = false, stopped = false;
let companion: PluginSupervisor | undefined;
let companionBoot: ProbeSnapshot["companionBoot"] = null;
let active: PluginSupervisor | undefined;
const companionStatuses: string[] = [];
let frameId = 0;
function frame() {
  if (stopped) return;
  heartbeat.textContent = String(++hostFrames);
  frameId = requestAnimationFrame(frame);
}
frameId = requestAnimationFrame(frame);
document.querySelector("#ui-button")!.addEventListener("click", () => { clickCounter.textContent = String(++clicks); });

function boundedCode(error: unknown): SandboxFailure { return error instanceof SandboxError ? error.code : "native_failure"; }
const harness: PluginSandboxProbe = {
  fixtures: Object.freeze(Object.keys(PROBE_FIXTURES) as ProbeFixture[]),
  limits: SANDBOX_LIMITS,
  async run(fixture) {
    if (typeof fixture !== "string" || !Object.hasOwn(PROBE_FIXTURES, fixture) || running || companionStarting || stopped) throw new SandboxError("invalid_input");
    running = true;
    const started = performance.now(), frames = hostFrames;
    const statuses: string[] = [];
    let instance: PluginSupervisor | undefined;
    let failure: SandboxFailure | null = null;
    let exceptionHint: GuestExceptionHint | null = null;
    let executionMs: number | null = null, jobs: number | null = null;
    let wasmMemoryBytes: number | null = null;
    try {
      const wasm = await loadTrustedPluginWasm();
      instance = active = createPluginSupervisor(["status.set"], (request) => {
        statuses.push(request.payload.text);
        status.textContent = `Плагин diagnostic: ${request.payload.text}`;
      });
      const turn = await instance.init(wasm, PROBE_FIXTURES[fixture], { greeting: "Probe greeting" });
      executionMs = turn.executionMs; jobs = turn.jobs;
      wasmMemoryBytes = turn.wasmMemoryBytes;
      if (fixture === "eventLoop" || fixture === "regex") await instance.event(ready);
      if (fixture === "healthy") await instance.event(ready);
      await instance.dispose();
    } catch (error) { failure = boundedCode(error); exceptionHint = error instanceof SandboxError ? error.exceptionHint ?? null : null; }
    finally {
      wasmMemoryBytes ??= instance?.wasmMemoryBytes ?? null;
      instance?.terminate(); active = undefined; running = false;
    }
    const result: ProbeResult = {
      fixture, state: instance?.state ?? "failed", failure, exceptionHint,
      statuses, elapsedMs: performance.now() - started, executionMs, jobs, wasmMemoryBytes,
      hostFramesDuring: hostFrames - frames
    };
    diagnostic.textContent = JSON.stringify(result, null, 2);
    return result;
  },
  async startCompanion() {
    if (companion || running || companionStarting || stopped) throw new SandboxError("invalid_input");
    companionStarting = true;
    companionStatuses.length = 0;
    companionBoot = null;
    try {
      const wasm = await loadTrustedPluginWasm();
      companion = createPluginSupervisor(["status.set"], (request) => {
        companionStatuses.push(request.payload.text);
        document.querySelector("#companion-status")!.textContent = `Плагин companion: ${request.payload.text}`;
      });
      const turn = await companion.init(wasm, PROBE_FIXTURES.healthy, { greeting: "Healthy companion still responsive" });
      companionBoot = { executionMs: turn.executionMs, wasmMemoryBytes: turn.wasmMemoryBytes };
    } catch (error) { companion?.terminate(); companion = undefined; throw error; }
    finally { companionStarting = false; }
  },
  async companionEvent() {
    if (!companion) throw new SandboxError("instance_closed");
    await companion.event(ready);
  },
  async stopCompanion() {
    const instance = companion;
    companion = undefined;
    if (instance?.state === "ready") await instance.dispose();
    else instance?.terminate();
  },
  snapshot() {
    return {
      hostFrames, clicks, activeInstances: Number(!!companion) + Number(!!active),
      companionState: companion?.state ?? null, companionStatuses: [...companionStatuses], companionBoot
    };
  }
};
window.pluginSandboxProbe = Object.freeze(harness);
for (const fixture of harness.fixtures) {
  const option = document.createElement("option"); option.value = option.textContent = fixture; select.append(option);
}
document.querySelector("#run")!.addEventListener("click", () => { void harness.run(select.value as ProbeFixture).catch((error: unknown) => { diagnostic.textContent = boundedCode(error); }); });
window.addEventListener("pagehide", () => {
  stopped = true; cancelAnimationFrame(frameId); active?.terminate(); companion?.terminate();
}, { once: true });
document.documentElement.dataset.probeReady = "1";
