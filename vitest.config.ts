import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const isCi = process.env.CI === "true";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // Real-data graph suites rebuild every batch. Keep GitHub's smaller runner
    // from starving parallel workers and timing out otherwise healthy tests.
    maxWorkers: isCi ? 2 : undefined,
    testTimeout: isCi ? 180_000 : 30_000,
    coverage: {
      reporter: ["text", "json", "html"]
    }
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  }
});
