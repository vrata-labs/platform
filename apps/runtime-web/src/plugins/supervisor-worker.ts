import { parseRoomPluginJson, validateRoomPluginCapabilities, validateRoomPluginResponse, roomPluginUtf8ByteLength,
  type RoomPluginRequest, type RoomPluginResponse } from "@vrata/room-plugin-sdk";
import { PluginSupervisor, type SandboxWorker } from "./supervisor.js";
import { SANDBOX_LIMITS, SandboxError } from "./limits.js";
import type { KernelCommand, KernelReply } from "./kernel-protocol.js";

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<KernelCommand>) => void) | null; postMessage(reply: KernelReply): void; close(): void };
let guest: Worker | undefined, kernel: PluginSupervisor | undefined, wasm: WebAssembly.Module | undefined;
let current: Extract<KernelCommand, { id: number }> | undefined, closing = false, batchSequence = 0, scheduled = false;
interface Rpc { request: RoomPluginRequest; signal: AbortSignal; resolve(value: RoomPluginResponse): void; reject(error: SandboxError): void }
const queued: Rpc[] = [];
const batches = new Map<number, { actionId: number; requests: Rpc[]; cancel(): void }>();

function shutdown(): void {
  if (closing) return; closing = true;
  kernel?.terminate(); guest?.terminate();
  for (const value of queued.splice(0)) value.reject(new SandboxError("instance_closed"));
  for (const batch of batches.values()) batch.cancel();
  scope.postMessage({ version: 1, type: "closed" }); scope.close();
}
function fail(error: unknown): void {
  if (closing) return;
  if (error instanceof SandboxError) scope.postMessage({ version: 1, type: "failed", id: current?.id ?? null, channel: "sandbox",
    failure: error.code, exceptionHint: error.exceptionHint, hostPhase: error.hostPhase,
    wasmMemoryBytes: kernel?.wasmMemoryBytes, startupTiming: kernel?.startupTiming });
  else scope.postMessage({ version: 1, type: "failed", id: current?.id ?? null, channel: "bridge", failure: "kernel-protocol" });
  shutdown();
}
function flush(): void {
  scheduled = false;
  if (!current || closing) { for (const rpc of queued.splice(0)) rpc.reject(new SandboxError("instance_closed")); return; }
  const requests = queued.splice(0), actionId = current.id, batchId = ++batchSequence;
  if (!requests.length) return;
  const cancel = () => {
    const batch = batches.get(batchId); if (!batch) return;
    batches.delete(batchId); for (const rpc of requests) { rpc.signal.removeEventListener("abort", cancel); rpc.reject(new SandboxError("instance_closed")); }
    if (!closing) scope.postMessage({ version: 1, type: "cancel", actionId, batchId });
  };
  batches.set(batchId, { actionId, requests, cancel });
  for (const rpc of requests) rpc.signal.addEventListener("abort", cancel, { once: true });
  if (requests.some(rpc => rpc.signal.aborted)) { cancel(); return; }
  const requestsJson = JSON.stringify(requests.map(rpc => rpc.request));
  if (roomPluginUtf8ByteLength(requestsJson) > SANDBOX_LIMITS.messageBytes) { fail(new SandboxError("worker_protocol")); return; }
  scope.postMessage({ version: 1, type: "requests", actionId, batchId, requestsJson });
}
function dispatch(request: RoomPluginRequest, signal: AbortSignal): Promise<RoomPluginResponse> {
  if (closing || !current || signal.aborted || queued.length >= SANDBOX_LIMITS.requestQueueSize) return Promise.reject(new SandboxError("instance_closed"));
  const result = new Promise<RoomPluginResponse>((resolve, reject) => queued.push({ request, signal, resolve, reject }));
  if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  return result;
}
function respond(message: Extract<KernelCommand, { type: "respond" }>): void {
  const batch = batches.get(message.batchId);
  if (!batch) { if (kernel?.state === "failed" || closing) return; throw new SandboxError("worker_protocol"); }
  if (batch.actionId !== message.actionId || current?.id !== message.actionId) throw new SandboxError("worker_protocol");
  const raw = parseRoomPluginJson(message.responsesJson);
  if (!Array.isArray(raw) || raw.length !== batch.requests.length) throw new SandboxError("worker_protocol");
  const responses = raw.map(validateRoomPluginResponse);
  if (responses.some((response, index) => response.requestId !== batch.requests[index].request.requestId)) throw new SandboxError("worker_protocol");
  batches.delete(message.batchId);
  for (const [index, rpc] of batch.requests.entries()) { rpc.signal.removeEventListener("abort", batch.cancel); rpc.resolve(responses[index]); }
}
async function command(message: Extract<KernelCommand, { id: number }>): Promise<void> {
  if (closing) return;
  if (current || !Number.isSafeInteger(message.id) || message.id < 1) throw new SandboxError("worker_protocol");
  current = message;
  try {
    if (message.type === "prepare") {
      if (kernel || !(message.wasm instanceof WebAssembly.Module)) throw new SandboxError("invalid_input");
      if (typeof Worker !== "function") { scope.postMessage({ version: 1, type: "failed", id: message.id, channel: "bridge", failure: "kernel-unsupported" }); shutdown(); return; }
      const approved = validateRoomPluginCapabilities(message.approvedCapabilities);
      wasm = message.wasm;
      guest = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "room-plugin-vm" });
      kernel = new PluginSupervisor(guest as unknown as SandboxWorker, approved, undefined, { dispatch, onFailure: fail });
      await kernel.prepare(wasm);
      scope.postMessage({ version: 1, type: "prepared", id: message.id, wasmMemoryBytes: kernel.wasmMemoryBytes!, startupTiming: kernel.startupTiming });
    } else {
      if (!kernel || !wasm) throw new SandboxError("invalid_lifecycle");
      const result = message.type === "init" ? await kernel.init(wasm, message.source, message.config)
        : message.type === "event" ? await kernel.event(message.event) : await kernel.dispose();
      if (message.type === "dispose") { kernel.terminate(); guest?.terminate(); }
      scope.postMessage({ version: 1, type: "result", id: message.id, result });
      if (message.type === "dispose") shutdown();
    }
  } finally { current = undefined; }
}
scope.onmessage = event => {
  if (closing) return;
  const message = event.data;
  try {
    if (!message || message.version !== 1) throw new SandboxError("worker_protocol");
    if (message.type === "terminate") { shutdown(); return; }
    if (message.type === "respond") { respond(message); return; }
    if (!["prepare", "init", "event", "dispose"].includes(message.type)) throw new SandboxError("worker_protocol");
    void command(message).catch(fail);
  } catch (error) { fail(error); }
};
