import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Worker-integration suite: the REAL ai-flow-worker (supabase functions
 * serve) against a REAL local Postgres (supabase start) — run claiming,
 * park/timeout RPCs, deferrals, revision bumps, step persistence. Excluded
 * from the unit config; CI runs it as the `worker-integration` job (see
 * .github/workflows/ci.yml), and locally:
 *
 *   supabase start
 *   supabase functions serve --env-file supabase/functions/.env.itest &
 *   ITEST_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY) \
 *     npm run test:worker-integration
 *
 * No coverage (the code under test runs in the edge runtime container, not
 * this process). Serial: scenarios share one worker and tick it globally.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/worker-integration/**/*.itest.ts"],
    exclude: [],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // One scenario at a time: every test ticks the SAME worker, and a tick
    // claims every due run — interleaved scenarios would race each other's
    // timer manipulation.
    sequence: { concurrent: false }
  }
});
