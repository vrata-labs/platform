import { SANDBOX_LIMITS, SandboxError } from "./limits.js";

/** Trusted fixed asset only. Compilation is cached on the main thread; callers
 * clone a compiled Module into each worker, rather than recompiling guest-side.
 */
export class TrustedWasmModuleCache {
  private current?: Promise<WebAssembly.Module>;
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch,
    private readonly compile: (bytes: ArrayBuffer) => Promise<WebAssembly.Module> = (bytes) => WebAssembly.compile(bytes)) {}

  get(): Promise<WebAssembly.Module> {
    if (this.current) return this.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new SandboxError("wasm_load_failed")); }, SANDBOX_LIMITS.wasmLoadDeadlineMs);
    });
    const loading = (async () => {
      // Window.fetch is receiver-sensitive in Chromium. Do not call it as a
      // method of the cache object (Node's fetch would silently permit that).
      const response = await Reflect.apply(this.fetcher, globalThis, [this.url, { signal: abort.signal, credentials: "omit", redirect: "error" }]);
      if (!response.ok || !response.body) throw new SandboxError("wasm_load_failed");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > SANDBOX_LIMITS.wasmBytes) throw new SandboxError("wasm_load_failed");
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return this.compile(bytes.buffer);
    })();
    const pending = Promise.race([loading, deadline]).catch(() => { throw new SandboxError("wasm_load_failed"); })
      .finally(() => clearTimeout(timer));
    this.current = pending;
    void pending.catch(() => { if (this.current === pending) this.current = undefined; });
    return pending;
  }
}
