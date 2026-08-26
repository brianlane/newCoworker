---
name: project-supabase-start-skips-migrations
description: supabase start reuses the old volume and applies no new migrations; only supabase db reset actually tests one locally
metadata: 
  node_type: memory
  type: project
  originSessionId: 4119963a-ddea-4105-b94f-7b0004cd1a61
  modified: 2026-08-04T22:33:30.521Z
---

To test a migration locally the way the `Worker Integration (local Supabase)`
CI job does, run `supabase db reset`, not `supabase start`.

`supabase start` restores an existing Docker volume when one is present. It
exits 0, prints its normal service table, and applies **zero** migrations, so a
broken migration looks fine and `\df` shows the pre-change schema. `supabase db
reset` rebuilds from scratch and applies all of them in order (312 as of
2026-08-04), which is what CI does.

**Why:** confirmed on 2026-08-04 while fixing the voice_active_sessions leak
(PR #1172). A first `supabase start` looked clean but `grep -c "Applying
migration"` on its log was 0, and the new function was absent from `\df`. The
reset then reproduced the CI failure exactly.

**How to apply:** after `supabase db reset`, verify behavior with `psql
postgresql://postgres:postgres@127.0.0.1:54322/postgres` inside a
`begin; ... rollback;` block. Function bodies can be replaced with a raising
stub inside that transaction to test error-handling paths, since Postgres DDL
is transactional. `businesses` needs `status` in
(online/offline/high_load/wiped) and `tier` in (starter/standard/enterprise).

Related: [[project-migration-restamp-empty-file-trap]].
