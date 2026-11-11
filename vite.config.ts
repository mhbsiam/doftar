import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // When this copy was built. See `builtLabel` in src/actions.ts.
  define: { __BUILD_MS__: Date.now() },
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
