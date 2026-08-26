---
name: project-supabase-ipv6-direct-host
description: "Supabase's direct DB host is IPv6-only and unreachable from GitHub runners; CI DDL must go through the IPv4 session pooler in us-east-2"
metadata: 
  node_type: memory
  type: project
  originSessionId: c9de52df-55f3-4de1-8e50-2ff568cd40eb
  modified: 2026-08-07T16:50:29.084Z
---

`db.glwmorjxzkzpcfffwvkk.supabase.co` publishes **only an AAAA record**, no A
record. GitHub's hosted runners have no IPv6 route, so any Supabase CLI path
that reaches for the direct connection fails with `dial tcp [2600:...]:5432:
connect: network is unreachable`. This is not intermittent infrastructure
weather: the direct host can never work from CI.

Fixed in PR #1210 (Aug 6 2026): `.github/scripts/supabase-deploy.sh` builds an
explicit `--db-url` and passes it to `db push`, the PR dry-run drift check, and
(via exported `SUPABASE_DB_URL`) the ledger read in
`.github/scripts/migration-order-heal.sh`.

**Region drift: resolved Aug 7 2026.** The local `.env` was corrected and Brian
confirmed Vercel's own variables were already right, so this is history rather
than an open item. `.env.example` now carries a documented `DIRECT_DATABASE_URL`
(it previously had none, which is why the drift went unnoticed), and PR #1224
made the debug readers refuse a transaction-pooler fallback outright.

**The pooler region is us-east-2, verified, not assumed.**
`aws-1-us-east-1.pooler.supabase.com` answers `tenant/user
postgres.glwmorjxzkzpcfffwvkk not found`; `aws-1-us-east-2` serves it. Several
entries in the local `.env` (`DATABASE_URL`, `POSTGRES_URL`,
`POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`) point at us-east-1 and are
wrong. `DIRECT_DATABASE_URL` is correct. This matters because
`debug/cron-http-stats.ts` falls back from `DIRECT_DATABASE_URL` to
`DATABASE_URL`, and that fallback is broken.

**Port 5432, never 6543.** 5432 is the session pooler; the transaction pooler
on 6543 cannot run migrations.

**Why the ledger read is the dangerous one:** `migration list` failing this way
returns empty, and `migration-order-heal.sh` cannot tell an empty result apart
from "no ledger", so it warns `could not read the applied ledger` and silently
skips the heal. Only `db push` failing right after kept that from mattering.
If you ever see that warning, suspect connectivity, not an empty ledger.

**Why:** a merge that fails here means production never got the deploy at all,
since migrations, edge functions, and the Vercel app all ride the one job.

**How to apply:** never point a CI Supabase command at the direct host. Percent-
encode the password in any `--db-url` (the CLI requires it, and a rotation with
an `@` or `/` would silently build a malformed URL).

Related: [[project-main-run-watch-trap]], [[project-migration-restamp-empty-file-trap]]
