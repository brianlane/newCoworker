import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // tests/e2e/** are live-model tests (real Gemini) with their own config
    // (vitest.e2e.config.ts) and CI job — the unit run stays hermetic.
    exclude: [
      "tests/integration/**",
      "tests/e2e/**",
      "**/gemini-summarize-connectivity-live.test.ts"
    ],
    // Strip live credentials (sourced .env) from the unit-test process so no
    // test can reach a real external service — see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts"],
    // v8 coverage instrumentation slows some orchestrator tests past the
    // default 5s; give every test a generous 15s budget.
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      // `text-summary` prints the 6-line per-suite roll-up at the end of every
      // run so coverage is visible in the terminal without opening the HTML
      // report. `text` keeps the per-file table for quick "where's my gap?"
      // inspection. `html` is the rich, drill-down report consumed by
      // `npm run test:coverage:open`.
      reporter: ["text", "text-summary", "html"],
      include: ["src/lib/**/*.ts", "supabase/functions/_shared/**/*.ts"],
      exclude: ["src/lib/customer-memory/types.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
});
