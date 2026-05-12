import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Narrow config so `vitest exclude` doesn't block explicitly running the
 * Gemini live ping (see npm script `test:gemini-live`). No coverage — network only.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/gemini-summarize-connectivity-live.test.ts"],
    exclude: [],
    testTimeout: 40_000
  }
});
