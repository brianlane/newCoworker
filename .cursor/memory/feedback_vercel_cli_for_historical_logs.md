---
name: feedback_vercel_cli_for_historical_logs
description: "Use `vercel logs --since/--until/--query --json`, not hand-rolled api.vercel.com log endpoints"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 23ec9b7d-ea4b-4eea-b719-af2b67e5c68b
  modified: 2026-08-23T17:17:43.325Z
---

To read production request/function logs, use the Vercel CLI, not the REST API:

```bash
npx -y vercel@latest logs --since 2026-08-21T21:20:00Z --until 2026-08-21T22:30:00Z --query "<business-id>" --json -n 1000
```

**Why:** on 2026-08-22 I burned several turns guessing at
`api.vercel.com/v1/.../runtime-logs` and `/v1/observability/logs`, which time
out or return `not_found`. The `/v2/deployments/<id>/events` endpoint works but
returns **build** logs only, not runtime requests. Brian had to tell me the CLI
existed. CLI 59.3.0 supports historical queries with `--since`, `--until`,
`--query` (server-side search, e.g. a business id), `--json`, `--status-code`,
and `--level`.

**How to apply:** the repo is already linked (`.vercel/project.json`, project
`new-coworker`, team `new-coworker`), and `VERCEL_TOKEN` is in `.env`. Note the
un-queried form returns only the most recent ~1000 lines in the window, so pass
`--query` to search a wide window, or slice into short `--since`/`--until`
windows when you need everything.

Related: [[feedback_research_before_asking]].
