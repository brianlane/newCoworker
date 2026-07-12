import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Worker-integration suite: the REAL edge workers (supabase functions
 * serve) against a REAL local Postgres (supabase start) — run claiming,
 * park/timeout RPCs, deferrals, revision bumps, step persistence, the
 * sms-inbound-worker reply pipeline (against the suite's fake Rowboat on
 * :8977), goal-event jumps, and needs-human escalation through the real
 * notifications function. Excluded from the unit config; CI runs it as the
 * `worker-integration` job (see .github/workflows/ci.yml), and locally:
 *
 *   supabase start
 *   cat > supabase/functions/.env.itest <<'EOF'
 *   INTERNAL_CRON_SECRET=itest-cron-secret
 *   ROWBOAT_CHAT_URL_TEMPLATE=http://host.docker.internal:8977/chat
 *   ROWBOAT_DEFAULT_PROJECT_ID=itest-project
 *   ROWBOAT_VPS_CHAT_BEARER=itest-rowboat-bearer
 *   EOF
 *   supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.itest &
 *   ITEST_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY) \
 *     npm run test:worker-integration
 *
 * (CI swaps host.docker.internal for the supabase docker network's gateway
 * IP — Linux containers don't get the Docker Desktop alias.)
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
