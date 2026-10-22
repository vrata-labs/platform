export type RoomPluginRuntimeFailure =
  | "invalid-runtime-config" | "invalid-artifact" | "integrity-failed"
  | "insecure-context" | "network-unavailable" | "lease-expired" | "host-unavailable"
  | "kernel-transport-timeout" | "kernel-unsupported" | "kernel-protocol";

/** Fixed host diagnostics only: never attach response bodies, config or source. */
export class RoomPluginRuntimeError extends Error {
  constructor(readonly code: RoomPluginRuntimeFailure, readonly startupTiming?: SandboxStartupTiming) { super(code); this.name = "RoomPluginRuntimeError"; }
}
import type { SandboxStartupTiming } from "./limits.js";
