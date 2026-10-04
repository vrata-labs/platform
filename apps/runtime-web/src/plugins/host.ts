import wasmUrl from "@jitl/quickjs-wasmfile-release-sync/wasm?url";
import { validateRoomPluginCapabilities, type RoomPluginConfig, type RoomPluginRequest, type RoomPluginCapability } from "@vrata/room-plugin-sdk";
import { SandboxError } from "./limits.js";
import { PluginSupervisor, type SandboxWorker } from "./supervisor.js";
import { TrustedWasmModuleCache } from "./wasm-cache.js";

const trustedWasm = new TrustedWasmModuleCache(wasmUrl);
export function loadTrustedPluginWasm(): Promise<WebAssembly.Module> { return trustedWasm.get(); }

type StatusSink = (request: Extract<RoomPluginRequest, { operation: "status.set" }>) => void;

export async function startPluginSandbox(
  source: string, config: RoomPluginConfig, approvedCapabilities: readonly RoomPluginCapability[], onStatus?: StatusSink
): Promise<PluginSupervisor> {
  // No default approval and no Worker allocation before validating authority DTO.
  let approved: readonly RoomPluginCapability[];
  try { approved = validateRoomPluginCapabilities(approvedCapabilities); }
  catch { throw new SandboxError("invalid_input"); }
  const module = await loadTrustedPluginWasm();
  const supervisor = createPluginSupervisor(approved, onStatus);
  try { await supervisor.init(module, source, config); return supervisor; }
  catch (error) { supervisor.terminate(); throw error; }
}

export function createPluginSupervisor(approvedCapabilities: readonly RoomPluginCapability[], onStatus?: StatusSink): PluginSupervisor {
  let approved: readonly RoomPluginCapability[];
  try { approved = validateRoomPluginCapabilities(approvedCapabilities); }
  catch { throw new SandboxError("invalid_input"); }
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "room-plugin" });
  return new PluginSupervisor(worker as unknown as SandboxWorker, approved, onStatus);
}
