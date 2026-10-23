import type { RoomPluginCapability, RoomPluginConfig, RoomPluginEvent } from "@vrata/room-plugin-sdk";
import type { GuestExceptionHint, SandboxFailure, SandboxHostPhase } from "./limits.js";
import type { PluginActionResult } from "./supervisor.js";

export type KernelBridgeFailure = "kernel-transport-timeout" | "kernel-unsupported" | "kernel-protocol";
export type KernelCommand =
  | { version: 1; id: number; type: "prepare"; wasm: WebAssembly.Module; approvedCapabilities: readonly RoomPluginCapability[] }
  | { version: 1; id: number; type: "init"; source: string; config: RoomPluginConfig }
  | { version: 1; id: number; type: "event"; event: RoomPluginEvent }
  | { version: 1; id: number; type: "dispose" }
  | { version: 1; type: "respond"; actionId: number; batchId: number; responsesJson: string }
  | { version: 1; type: "terminate" };
export type KernelReply =
  | { version: 1; type: "prepared"; id: number; wasmMemoryBytes: number; startupTiming: KernelStartupTiming }
  | { version: 1; type: "result"; id: number; result: PluginActionResult }
  | { version: 1; type: "failed"; id: number | null; channel: "sandbox"; failure: SandboxFailure; exceptionHint?: GuestExceptionHint; hostPhase?: SandboxHostPhase; wasmMemoryBytes?: number; startupTiming?: KernelStartupTiming }
  | { version: 1; type: "failed"; id: number | null; channel: "bridge"; failure: KernelBridgeFailure }
  | { version: 1; type: "requests"; actionId: number; batchId: number; requestsJson: string }
  | { version: 1; type: "cancel"; actionId: number; batchId: number }
  | { version: 1; type: "closed" };
export interface KernelStartupTiming { moduleAgeMs: number | null; prepareMs: number | null }

/** Transport observation is not the guest's security watchdog. The kernel's
 * 3s/500ms/5s limits remain inside the independent trusted Worker. */
export const KERNEL_TRANSPORT_TIMEOUT_MS = 10_000;
export const KERNEL_TERMINATE_ACK_MS = 3000;
export const KERNEL_EFFECT_MARGIN_MS = 1;
