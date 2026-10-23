import wasmUrl from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { validateRoomPluginCapabilities, type RoomPluginConfig, type RoomPluginRequest, type RoomPluginCapability } from "@vrata/room-plugin-sdk";
import { SandboxError } from "./limits.js";
import { PluginKernelClient, type KernelWorker } from "./kernel-client.js";
import type { SupervisorOptions } from "./supervisor.js";
import { TrustedWasmModuleCache } from "./wasm-cache.js";

const trustedWasm = new TrustedWasmModuleCache(wasmUrl);
export function loadTrustedPluginWasm(): Promise<WebAssembly.Module> { return trustedWasm.get(); }

type StatusSink = (request: Extract<RoomPluginRequest, { operation: "status.set" }>) => void;
export interface PluginSandboxStartOptions extends SupervisorOptions { signal?: AbortSignal }
export type PluginSandbox = Pick<PluginKernelClient, "init" | "event" | "dispose" | "terminate" | "state" | "failure" | "exceptionHint" | "wasmMemoryBytes" | "busy" | "startupTiming">;

export async function startPluginSandbox(
  source: string, config: RoomPluginConfig, approvedCapabilities: readonly RoomPluginCapability[], onStatus?: StatusSink,
  options: PluginSandboxStartOptions = {}
): Promise<PluginSandbox> {
  // No default approval and no Worker allocation before validating authority DTO.
  let approved: readonly RoomPluginCapability[];
  try { approved = validateRoomPluginCapabilities(approvedCapabilities); }
  catch { throw new SandboxError("invalid_input"); }
  if (options.signal?.aborted) throw new SandboxError("instance_closed");
  const wasmStarted = performance.now();
  let module: WebAssembly.Module;
  try { module = await loadTrustedPluginWasm(); }
  catch {
    throw new SandboxError("wasm_load_failed", undefined, undefined,
      { moduleAgeMs: null, prepareMs: null, prepareRoundTripMs: null, wasmLoadMs: Math.max(0, performance.now() - wasmStarted) });
  }
  const wasmLoadMs = performance.now() - wasmStarted;
  if (options.signal?.aborted) throw new SandboxError("instance_closed");
  const supervisor = createPluginSupervisor(approved, onStatus, { ...options, wasmLoadMs });
  const abort = () => supervisor.terminate(); options.signal?.addEventListener("abort", abort, { once: true });
  try { await supervisor.init(module, source, config); return supervisor; }
  catch (error) { supervisor.terminate(); throw error; }
  finally { options.signal?.removeEventListener("abort", abort); }
}

export function createPluginSupervisor(approvedCapabilities: readonly RoomPluginCapability[], onStatus?: StatusSink,
  options: SupervisorOptions & { wasmLoadMs?: number } = {}): PluginSandbox {
  let approved: readonly RoomPluginCapability[];
  try { approved = validateRoomPluginCapabilities(approvedCapabilities); }
  catch { throw new SandboxError("invalid_input"); }
  const worker = new Worker(new URL("./supervisor-worker.ts", import.meta.url), { type: "module", name: "room-plugin-kernel" });
  return new PluginKernelClient(worker as unknown as KernelWorker, approved, onStatus, options);
}
