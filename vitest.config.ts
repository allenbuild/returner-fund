import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const isCi = process.env.CI === "true";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // Several suites materialize the complete multi-batch graph. A single
    // worker keeps direct Vitest invocations from duplicating that graph in
    // memory; the npm test runner recycles the worker between bounded batches.
    maxWorkers: 1,
    fileParallelism: false,
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
