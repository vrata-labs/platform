import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { QuickJSFFI } from "@jitl/quickjs-wasmfile-release-sync/ffi";
import moduleLoader from "@jitl/quickjs-wasmfile-release-sync/emscripten-module";
import { SANDBOX_LIMITS, SandboxError } from "./limits.js";

export function createPluginWasmMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({
    initial: SANDBOX_LIMITS.wasmInitialMemoryBytes / 65536,
    maximum: SANDBOX_LIMITS.wasmMaxMemoryBytes / 65536
  });
}

/** Static FFI/glue imports: the worker needs no dynamic import, fetch or chunks.
 * Vite resolves the browser condition of emscripten-module; Node uses its ESM glue.
 */
export async function createPluginQuickJS(wasm: ArrayBuffer | WebAssembly.Module) {
  const memory = createPluginWasmMemory();
  const variant = newVariant({
    type: "sync" as const,
    importFFI: async () => QuickJSFFI,
    importModuleLoader: async () => moduleLoader
  }, {
    ...(wasm instanceof ArrayBuffer ? { wasmBinary: wasm } : { wasmModule: wasm }),
    wasmMemory: memory
  });
  const module = await newQuickJSWASMModuleFromVariant(variant);
  // Fail closed if a future glue/variant stops honoring the installed hook.
  if (module.getWasmMemory() !== memory) throw new SandboxError("wasm_load_failed");
  return module;
}
