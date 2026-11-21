import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // When this copy was built. See `builtLabel` in src/actions.ts.
  define: { __BUILD_MS__: Date.now() },
  plugins: [react(), pdfjsAssets()],
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

/**
 * pdf.js fetches its CJK cmaps, standard fonts and wasm decoders at runtime (see
 * util/pdf.ts). In dev they are served straight from node_modules; a build copies
 * them into the output next to the worker.
 */
function pdfjsAssets(): Plugin {
  const pkg = join("node_modules", "pdfjs-dist");
  const dirs = ["cmaps", "standard_fonts", "wasm"];
  let outDir = "dist";
  return {
    name: "pdfjs-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        const dir = dirs.find((d) => url === `/${d}/` || url.startsWith(`/${d}/`));
        if (!dir) return next();
        const base = resolve(pkg, dir);
        const file = resolve(base, decodeURIComponent(url.slice(dir.length + 2)));
        // A dev-server convenience: serve only what lives under the asset dir.
        if (!file.startsWith(base + sep)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of dirs) {
        const from = join(pkg, dir);
        if (!existsSync(from)) continue;
        const to = join(outDir, dir);
        mkdirSync(to, { recursive: true });
        for (const f of readdirSync(from)) copyFileSync(join(from, f), join(to, f));
      }
    },
  };
}
