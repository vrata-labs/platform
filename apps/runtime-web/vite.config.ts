import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        diagnostics: resolve(__dirname, "diagnostics.html"),
        pluginSandboxProbe: resolve(__dirname, "plugin-sandbox-probe.html")
      }
    }
  },
  worker: {
    format: "es",
    rollupOptions: { output: { entryFileNames: "assets/room-plugin-worker-[hash].js", inlineDynamicImports: true } }
  }
});
