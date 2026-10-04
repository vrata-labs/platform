import type { RoomPluginCapability } from "@vrata/room-plugin-sdk";
import type { GuestExceptionHint, SandboxFailure } from "./limits.js";

export type WorkerCommand =
  | { version: 1; id: number; type: "prepare"; wasm: WebAssembly.Module; approvedCapabilities: readonly RoomPluginCapability[] }
  | { version: 1; id: number; type: "init"; source: string; configJson: string }
  | { version: 1; id: number; type: "event"; eventJson: string }
  | { version: 1; id: number; type: "dispose" };

export type WorkerReply =
  | { version: 1; type: "hello" }
  | { version: 1; type: "prepared"; id: number; wasmMemoryBytes: number }
  | { version: 1; type: "result"; id: number; ok: true; turnJson: string }
  | { version: 1; type: "result"; id: number; ok: false; failure: SandboxFailure; exceptionHint?: GuestExceptionHint };
