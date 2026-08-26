---
name: project-run-itest-and-live-e2e-locally
description: "Both the worker-integration itest and the live-AI e2e DO run locally; the exact recipe, and the toggle that makes PRs skip e2e"
metadata: 
  node_type: memory
  type: project
  originSessionId: 08cb847f-efb9-4fa8-b371-60dedfb536ae
  modified: 2026-08-20T04:13:47.977Z
---

Both suites run on this machine. An earlier note here claimed
`GOOGLE_API_KEY` was empty in `.env`; that was wrong, produced by
`grep -oE '^GOOGLE_API_KEY='`, which prints only the matched text up to the
`=` and can never show the value. The key is there. Check a secret's presence
with a length, never with a `-o` grep that stops at the delimiter.

**Live AI e2e:**

```bash
export GOOGLE_API_KEY=$(grep '^GOOGLE_API_KEY=' .env | sed 's/^GOOGLE_API_KEY=//')
npx vitest run --config vitest.e2e.config.ts tests/e2e/<file>.e2e.test.ts
```

**Worker-integration itest** (needs Docker running):

```bash
npx supabase start && npx supabase db reset   # reset is what applies migrations
cat > supabase/functions/.env.itest <<'EOF'
INTERNAL_CRON_SECRET=itest-cron-secret
ROWBOAT_CHAT_URL_TEMPLATE=http://host.docker.internal:8977/chat
ROWBOAT_DEFAULT_PROJECT_ID=itest-project
ROWBOAT_VPS_CHAT_BEARER=itest-rowboat-bearer
AIFLOW_PLATFORM_URL=http://host.docker.internal:8978
NEXT_PUBLIC_APP_URL=https://ncw.example
TELNYX_API_KEY=itest-telnyx-key
TELNYX_API_BASE=http://host.docker.internal:8978
EOF
npx supabase functions serve --no-verify-jwt --env-file supabase/functions/.env.itest &
export ITEST_SERVICE_ROLE_KEY=$(npx supabase status -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['SERVICE_ROLE_KEY'])")
npx vitest run --config vitest.worker-integration.config.ts tests/worker-integration/<file>.itest.ts
```

Without `ITEST_SERVICE_ROLE_KEY` the globalSetup preflight fails with "no
service-role key" before any test runs. Without the `functions serve` step
every `tickWorker()` dies with `worker tick 401: unauthorized` (the served
runtime needs `INTERNAL_CRON_SECRET=itest-cron-secret` from the env file;
`supabase start` alone serves functions WITHOUT it). The full recipe lives in
the header comment of `vitest.worker-integration.config.ts`. Two more traps
learned 2026-08-19: an aborted invocation leaves queued runs behind, and the
next invocation's first `tickWorker()` spends its batch budget on that
backlog, failing fresh tests with stale-looking state (re-run after a drain,
or `db reset`); and the harness has NO Telnyx capture, sends fail and are
caught per recipient, so a routing step that must complete cannot let a send
failure throw.

**Why:** a PR proves nothing about live model behavior on its own. The Admin
"CI live e2e" toggle reads `nightly-only`
(`curl -s https://www.newcoworker.com/api/public/ci-e2e-mode`), so
`e2e-scope.sh` emits `skip=true` for every PR and push run.

**How to apply:** prove a prompt change by running the affected e2e file
locally several times, since these tests are often only ~50% reproducible;
one green run is weak evidence. Back it with a deterministic unit test on the
prompt property too. To prove against CI instead, `workflow_dispatch`
`e2e-nightly.yml` on **main after merge**, never a branch: its failure step is
`if: failure()` with no branch gate, so a red branch run emails
team@newcoworker.com with a subject that reads as a main failure. See
[[feedback-prove-prompt-fixes-against-deployed]] and
[[project-fixed-future-date-is-a-time-bomb]].
