import { parseRoomPluginJson, roomPluginUtf8ByteLength, RoomPluginValidationError, validateRoomPluginCapabilities, type RoomPluginConfig } from "@vrata/room-plugin-sdk";
import { createPluginQuickJS } from "./quickjs-module.js";
import { SANDBOX_LIMITS, SandboxError } from "./limits.js";
import { PluginVm } from "./vm.js";
import type { WorkerCommand, WorkerReply } from "./protocol.js";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerCommand>) => void) | null;
  postMessage(reply: WorkerReply): void;
  close(): void;
};
let instance: PluginVm | undefined;
let prepared = false;
let initialized = false;
let busy = false;
let failed = false;

async function command(message: WorkerCommand): Promise<void> {
  if (failed) return;
  const id = message?.id;
  try {
    if (!Number.isSafeInteger(id) || id < 1 || message.version !== 1 || busy) throw new SandboxError("worker_protocol");
    busy = true;
    let turn;
    if (message.type === "prepare") {
      if (prepared || !(message.wasm instanceof WebAssembly.Module)) throw new SandboxError("invalid_input");
      const approvedCapabilities = validateRoomPluginCapabilities(message.approvedCapabilities);
      prepared = true;
      const module = await createPluginQuickJS(message.wasm);
      PluginVm.warmup(module);
      instance = new PluginVm(module, { approvedCapabilities });
      instance.prepare();
      scope.postMessage({ version: 1, type: "prepared", id, wasmMemoryBytes: module.getWasmMemory().buffer.byteLength });
      return;
    }
    if (message.type === "init") {
      if (!instance || initialized ||
          typeof message.source !== "string" || message.source.length > SANDBOX_LIMITS.artifactBytes || roomPluginUtf8ByteLength(message.source) > SANDBOX_LIMITS.artifactBytes ||
          typeof message.configJson !== "string") throw new SandboxError("invalid_input");
      initialized = true;
      const config = parseRoomPluginJson(message.configJson) as RoomPluginConfig;
      turn = instance.init(message.source, config);
    } else {
      if (!instance || !initialized) throw new SandboxError("invalid_lifecycle");
      if (message.type === "event") turn = instance.event(message.eventJson);
      else if (message.type === "dispose") turn = instance.dispose();
      else throw new SandboxError("worker_protocol");
    }
    const turnJson = JSON.stringify(turn);
    if (roomPluginUtf8ByteLength(turnJson) > SANDBOX_LIMITS.messageBytes) throw new SandboxError("message_too_large");
    scope.postMessage({ version: 1, type: "result", id, ok: true, turnJson });
    if (message.type === "dispose") { failed = true; scope.close(); }
  } catch (error) {
    failed = true;
    // Never echo an exception, stack, source, arbitrary message or getter.
    const failure = error instanceof SandboxError ? error.code : error instanceof RoomPluginValidationError ? "invalid_input" : "native_failure";
    try { instance?.close(); } catch { /* Supervisor destroys the entire worker. */ }
    scope.postMessage({ version: 1, type: "result", id, ok: false, failure,
      ...(error instanceof SandboxError && error.exceptionHint ? { exceptionHint: error.exceptionHint } : {}) });
    scope.close();
  } finally { busy = false; }
}

scope.onmessage = (event) => { void command(event.data); };
scope.postMessage({ version: 1, type: "hello" });
