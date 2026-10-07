import type { IncomingMessage } from "node:http";

export class RoomPluginRequestBodyError extends Error {
  constructor(readonly code: "plugin_body_too_large" | "plugin_body_invalid" | "plugin_body_aborted" | "plugin_body_timeout") {
    super(code); this.name = "RoomPluginRequestBodyError";
  }
}

/** Original bytes only: no setEncoding, UTF-8 replacement, JSON reserialization or unbounded chunks. */
export function readRoomPluginRequestBytes(request: IncomingMessage, maxBytes: number, deadlineMs = 15_000): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
    throw new RangeError("invalid_plugin_body_limits");
  }
  return new Promise((resolve, reject) => {
    let done = false, size = 0, buffer: Buffer | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const length = request.headers["content-length"];
    let declared: number | undefined;
    const detach = () => {
      if (timer) clearTimeout(timer);
      request.off("data", data); request.off("end", end); request.off("error", aborted);
      request.off("aborted", aborted); request.off("close", closed);
    };
    const fail = (code: RoomPluginRequestBodyError["code"]) => {
      if (done) return;
      done = true; request.pause(); detach(); reject(new RoomPluginRequestBodyError(code));
    };
    const aborted = () => fail("plugin_body_aborted");
    const closed = () => { if (!request.readableEnded) aborted(); };
    const data = (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array)) return fail("plugin_body_invalid");
      // Check before any allocation/copy, including an oversized first chunk.
      if (chunk.byteLength > maxBytes - size) return fail("plugin_body_too_large");
      if (declared !== undefined && chunk.byteLength > declared - size) return fail("plugin_body_invalid");
      buffer ??= Buffer.allocUnsafe(declared ?? maxBytes);
      buffer.set(chunk, size); size += chunk.byteLength;
    };
    const end = () => {
      if (done) return;
      if (declared !== undefined && size !== declared) return fail("plugin_body_invalid");
      done = true; detach(); resolve(buffer ? new Uint8Array(buffer.subarray(0, size)) : new Uint8Array());
    };
    if (length !== undefined) {
      if (typeof length !== "string" || !/^(0|[1-9][0-9]*)$/.test(length) || request.headers["transfer-encoding"] !== undefined) {
        return fail("plugin_body_invalid");
      }
      declared = Number(length);
      if (!Number.isSafeInteger(declared) || declared > maxBytes) return fail("plugin_body_too_large");
    }
    if (request.aborted || request.destroyed && !request.readableEnded) return aborted();
    if (request.readableEnded) return end();
    request.on("data", data); request.once("end", end); request.once("error", aborted);
    request.once("aborted", aborted); request.once("close", closed);
    timer = setTimeout(() => fail("plugin_body_timeout"), deadlineMs); timer.unref();
  });
}
