import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

/** Screenshot tests (`npm run test:visual`): UI parts drawn in WebKit at a wide and a split-view width. */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.visual.tsx"],
    setupFiles: ["src/test/visualSetup.ts"],
    // Files sharing the browser at once can delay a render past the fixed waits in src/test/mount.tsx.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { locale: "en-US", timezoneId: "UTC" } }),
      instances: [{ browser: "webkit" }],
      viewport: { width: 1200, height: 800 },
    },
  },
});
