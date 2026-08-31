---
name: project-supabase-ipv6-direct-host
description: "Supabase's direct DB host is IPv6-only and unreachable from GitHub runners; CI DDL must go through the IPv4 session pooler in us-east-2"
metadata: 
  node_type: memory
  type: project
  originSessionId: c9de52df-55f3-4de1-8e50-2ff568cd40eb
  modified: 2026-08-27T00:00:00.000Z
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
postgres.glwmorjxzkzpcfffwvkk not found`; `aws-1-us-east-2` serves it.
**Re-checked 2026-08-27: every local `.env` entry now points at us-east-2**
(`DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`,
`POSTGRES_URL_NON_POOLING`, `DIRECT_DATABASE_URL`), so the old warning that
several were on us-east-1 no longer holds and the
`debug/cron-http-stats.ts` fallback from `DIRECT_DATABASE_URL` to
`DATABASE_URL` is no longer broken.

**`SUPABASE_DB_URL` is not in `.env` at all.** Scripts that need raw SQL
(PostgREST cannot read `information_schema` or `pg_catalog`) ask for that
name specifically, `debug/generate-residency-ddl.ts` among them. Export it
yourself from `DIRECT_DATABASE_URL` (identical to `POSTGRES_URL_NON_POOLING`:
session pooler, 5432, us-east-2) before the run:
`export SUPABASE_DB_URL="$DIRECT_DATABASE_URL"`. Verified working
2026-08-27: the generator read the catalog and its 189 columns matched the
live PostgREST OpenAPI exactly, which is also how you confirm you read the
right database.

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
