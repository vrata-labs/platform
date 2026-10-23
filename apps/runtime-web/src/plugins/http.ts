import { identityRequirementFromResponse, type IdentityRequirementReason } from "@vrata/shared-types";
import { ROOM_PLUGIN_LIMITS, parseRoomPluginJson } from "@vrata/room-plugin-sdk";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, ROOM_PLUGIN_RUNTIME_CONFIG_BYTES,
  type RoomPluginRuntimeBinding, type RoomPluginRuntimeSnapshot } from "./runtime-dto.js";
import type { RoomPluginTokenProof } from "./token-bound.js";
import { RoomPluginRuntimeError } from "./runtime-errors.js";

export class RoomPluginHttpError extends RoomPluginRuntimeError {
  constructor(readonly disposition: "unsupported" | "denied" | "changed" | "unavailable", readonly identityReason: IdentityRequirementReason | null = null) {
    super("network-unavailable"); this.name = "RoomPluginHttpError";
  }
}

export async function boundedRoomPluginBody(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
  if (length !== null && (!encoding || encoding === "identity") && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => undefined); throw new RoomPluginRuntimeError("network-unavailable");
  }
  if (!response.body) throw new RoomPluginRuntimeError("network-unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) throw new RoomPluginRuntimeError("network-unavailable");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Dedicated bounded fetch. The general session-aware fetch clones JSON errors
 * without a byte cap; this transport classifies only bounded known identity DTOs. */
export function createRoomPluginHttp(input: { apiBaseUrl: string; roomId: string; fetch?: typeof fetch }) {
  const fetcher = input.fetch ?? globalThis.fetch;
  async function load(path: string, proof: RoomPluginTokenProof, signal: AbortSignal, maximum: number, content: boolean): Promise<Uint8Array> {
    if (signal.aborted) throw new RoomPluginHttpError("unavailable");
    const abort = new AbortController();
    const onAbort = () => abort.abort(); signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined, rejectAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new RoomPluginHttpError("unavailable")); });
    abort.signal.addEventListener("abort", rejectAbort, { once: true });
    timer = setTimeout(() => abort.abort(), content ? ROOM_PLUGIN_LIMITS.bindingLeaseMs : 2000);
    const loading = (async () => {
      const response = await Reflect.apply(fetcher, globalThis, [new URL(path, input.apiBaseUrl).href, {
        headers: { authorization: `Bearer ${proof.token}` }, credentials: "omit", redirect: "error", cache: "no-store", signal: abort.signal
      }]) as Response;
      if (response.ok) return boundedRoomPluginBody(response, maximum);
      if (response.status === 404) {
        void response.body?.cancel().catch(() => undefined); throw new RoomPluginHttpError(content ? "changed" : "unsupported");
      }
      if ([401, 403, 409, 426].includes(response.status)) {
        let body: unknown;
        try { body = parseRoomPluginJson(await boundedRoomPluginBody(response, 2048)); } catch { throw new RoomPluginHttpError("unavailable"); }
        const code = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).error : undefined;
        const identity = identityRequirementFromResponse(response.status, body);
        if (code === "plugin_identity_not_active") throw new RoomPluginHttpError("unsupported");
        if (identity || response.status === 401 || response.status === 426) throw new RoomPluginHttpError("denied", identity);
        throw new RoomPluginHttpError(content || code === "plugin_binding_changed" ? "changed" : "denied");
      }
      void response.body?.cancel().catch(() => undefined); throw new RoomPluginHttpError("unavailable");
    })();
    try { return await Promise.race([loading, cancelled]); }
    catch (error) {
      if (error instanceof RoomPluginRuntimeError) throw error;
      throw new RoomPluginHttpError("unavailable");
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", onAbort); abort.signal.removeEventListener("abort", rejectAbort); abort.abort();
    }
  }
  return {
    async snapshot(proof: RoomPluginTokenProof, signal: AbortSignal): Promise<RoomPluginRuntimeSnapshot> {
      const path = `/api/rooms/${encodeURIComponent(input.roomId)}/plugins/runtime`;
      return parseRoomPluginRuntimeSnapshot(await load(path, proof, signal, ROOM_PLUGIN_RUNTIME_CONFIG_BYTES, false), input.roomId);
    },
    content(binding: RoomPluginRuntimeBinding, proof: RoomPluginTokenProof, signal: AbortSignal): Promise<Uint8Array> {
      const path = roomPluginContentPath(input.roomId, binding.packageId);
      if (binding.contentUrl !== path) return Promise.reject(new RoomPluginRuntimeError("invalid-runtime-config"));
      return load(path, proof, signal, ROOM_PLUGIN_LIMITS.artifactBytes, true);
    }
  };
}
