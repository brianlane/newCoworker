import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Worker-integration suite: the REAL edge workers (supabase functions
 * serve) against a REAL local Postgres (supabase start), run claiming,
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
 *   AIFLOW_PLATFORM_URL=http://host.docker.internal:8978
 *   NEXT_PUBLIC_APP_URL=https://ncw.example
 *   TELNYX_API_KEY=itest-telnyx-key
 *   TELNYX_API_BASE=http://host.docker.internal:8978
 *   EOF
 *   supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.itest &
 *   ITEST_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r .SERVICE_ROLE_KEY) \
 *     npm run test:worker-integration
 *
 * (CI swaps host.docker.internal for the supabase docker network's gateway
 * IP, Linux containers don't get the Docker Desktop alias.)
 *
 * Any Supabase CLI version works. It did not always: on a CLI whose baseline
 * no longer auto-grants the Data API roles, replaying the migrations left
 * `service_role` with no privileges on the pre-convention tables, and the suite
 * died with "permission denied for table ai_flow_runs" despite a valid service
 * key. The schema now states those grants itself
 * (20260821004100_backfill_service_role_grants.sql), and `preflight.ts` below
 * checks for the stale-stack case up front with a one-line fix instead of
 * letting it surface as a cryptic failure mid-suite. CI still pins the CLI, but
 * for `supabase status` output stability, not for grants.
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
    // Fails fast with an actionable message when the local stack itself is the
    // problem (unreachable, no key, or missing the Data API grants).
    globalSetup: ["./tests/worker-integration/preflight.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // One scenario at a time: every test ticks the SAME worker, and a tick
    // claims every due run, interleaved scenarios would race each other's
    // timer manipulation.
    sequence: { concurrent: false }
  }
});
