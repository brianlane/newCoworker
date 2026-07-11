import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * E2E suite: LIVE Gemini calls exercising the AI contracts unit tests can't
 * — the reply-reasoning trailer round trip and real classify/extract
 * decisions driving full AiFlow executions (tests/e2e/). Requires
 * GOOGLE_API_KEY; excluded from the unit config (vitest.config.ts) so
 * `npm test` stays hermetic. In CI this runs as the gated `e2e` job AFTER
 * every other job passes (see .github/workflows/ci.yml).
 *
 * No coverage (network-dependent paths), no setup-env cred stripping (the
 * whole point is reaching the real model), generous timeouts, and file-serial
 * execution to keep the Gemini rate-limit footprint small.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    exclude: [],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // One live suite at a time: bursty parallel calls trip free-tier / low
    // RPM quotas and turn real regressions into flaky 429 noise.
    fileParallelism: false
  }
});
