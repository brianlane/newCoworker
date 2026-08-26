---
name: project_postgrest_write_matching_zero_rows
description: "A PostgREST update/delete matching zero rows returns no error, so a write without .select() reports false success"
metadata: 
  node_type: memory
  type: project
  originSessionId: 64cdd32d-3958-4ee5-bdef-c8b99b59e166
  modified: 2026-08-12T07:29:57.754Z
---

A supabase-js `.update()` or `.delete()` that matches **nothing** resolves with
`error: null`. There is no "0 rows affected" signal unless you ask for one. So
`if (error) fail()` reads a no-op as a success.

The write side of [[project_postgrest_1000_row_cap]]: same silent-lying family,
opposite direction.

**How to apply:** any write whose outcome the code then reports, ledgers, or acts
on must chain `.select("id")` and check the returned length. The repo already
does this where it matters, and those are the shapes to copy:
`updateWorkspaceConnectionTokens` and `updateWorkspaceConnectionAccessToken` in
`src/lib/db/workspace-oauth-connections.ts` both return a boolean derived from
`data?.length`.

**Use it as a compare-and-swap, not just a check.** Putting the precondition in
the `.eq()` match and verifying a row came back turns the write into a CAS. In
Aug 2026 `scripts/oneshot/import-google-nango-tokens.ts` flipped connection rows
from Nango to first-party while the dashboard connect button was live, so an
owner could reconnect mid-run and write a fresher grant. Without
`.eq("transport", "nango")` in the match the one-shot would have overwritten it
with an older token; without `.select()` it would have reported that as migrated
and written a ledger row. Bugbot caught both halves on #1328.

The damage multiplier is what a false success unlocks next: that script's own
next step was reclaiming the Nango seat, which destroys the rollback path. Ask
what a wrongly-reported success authorizes, not just whether the row changed.
Related: [[feedback_verify_the_column_is_written]].
