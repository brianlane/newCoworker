---
name: migration-heal-traps
description: migration restamp and heal dangers: zero-byte restamps, renaming APPLIED DDL, pipefail ledger misread
metadata:
  type: project
---

## migration-restamp-empty-file-trap

`scripts/new-migration.sh` creates an EMPTY scaffold. When a PR's migration
stamp goes stale (another migration reached production first) and you
re-stamp, the SQL content must be moved into the new file explicitly, and the
old copy deleted only after `wc -c` shows the new file is non-empty. PR
#1077 (merged 2026-07-31) shipped a zero-byte migration this way: the restamp
commit added only the scaffold, then a cleanup commit deleted the only file
holding the DDL. No CI guard flags an empty .sql file, so it merged green and
the column was missing in production until fix PR #1091 recovered the DDL
from the pre-restamp commit.

**Why:** an empty migration passes every check (grants test skips files with
no create table, drift check only compares filenames against the remote
ledger), so the failure is silent until the code that needs the DDL hits
production.

**How to apply:** after any restamp, `wc -c` the surviving migration file and
diff its content against the original before committing. A version already
applied to production can never be deleted or renamed, only carried forward;
a never-applied version may be deleted freely. See also
[[aiflow-phone-field-trap]] for the other repo-specific silent trap.

## migration-heal-restamped-applied-migration

At 2026-08-19 22:48:59Z a migration-order-heal commit (09cbdb529, pushed
straight to main) renamed `20260420100000_voice_telnyx_platform.sql`, applied
in April, 92KB of platform DDL, to a fresh Aug 22 stamp, off a ledger read
that wrongly claimed the version unapplied. The remote ledger row existed,
once, applied: the rename violated the heal's own contract.

Consequences while the bad commit was on main: every push-to-main deploy
tries to RE-APPLY that DDL to production and also fails on the orphaned
remote ledger row. Production itself stayed fine (last good deploy 507f2280
plus follow-up edge deploys).

RESOLVED same day by PR #1532 (5342ccde7, main run green): the migration is
back at its April stamp matching its ledger row, the heal's ledger read is
race-free (herestrings), a 14-day age guard stops any future rename of an old
stamp, and the stamp guard understands pure-rename restores. Ledger verified
canonical afterwards (370 rows, no dupes, 20260420100000 present).

Signature to recognize instead of re-diagnosing: a main deploy failing on a
migration whose NAME is new but whose CONTENT is old platform DDL, plus a
remote schema_migrations row for the ORIGINAL stamp with no matching file.
Check `git log --follow` on the migration file before believing the deploy
error. Related: [[migration-restamp-empty-file-trap]] (re-stamping can also
ship a zero-byte file).

Root cause of the bad ledger read was under investigation by the Clever-sweep
session (worktree amys-aiflows-review-66d959) on Aug 19; script hardening was
to follow. Verify the heal script's current state before trusting it in a
deploy sequence.

## heal-pipefail-incident

**The incident (2026-08-19 ~22:49Z).** The push-to-main order heal renamed
`20260420100000_voice_telnyx_platform.sql`, an APPLIED 92KB platform
migration, to a fresh stamp and pushed it to main (`[skip ci]`, so the broken
tree was never tested). Every subsequent deploy failed (`db push`: remote
version with no local file), and two tests pin that filename, so main's Test
Suite went red for every PR. Deploys froze until the ledger was repaired by
hand and PR #1532 restored the name.

**Root cause:** `if printf '%s\n' "$applied" | grep -qx "$v"` under
`set -o pipefail`. `grep -q` exits at its first match; when printf is still
writing at that instant it takes EPIPE (exit 141), pipefail promotes that to
the pipeline's status, and the `if` reads a FOUND version as ABSENT. A
loaded-runner timing race: silent for months, then one bad evening. The
giveaway in the log: `printf: write error: Broken pipe`.

**How to apply:**
- **Never pipe into `grep -q` (or `head`, or anything early-exiting) under
  pipefail when the pipeline's status gates a decision.** Use a herestring
  (`grep -qx "$v" <<< "$set"`): no writer process, nothing to take EPIPE.
  Code-shape tests in `tests/migration-order-heal.test.ts` pin both the heal
  and the stamp guard against the pattern.
- The failure-watch retry attempt can MASK the causal attempt: attempt 2 read
  correctly (its `comm` used process substitution, no early-exit consumer)
  and reported a different, downstream error. **Pull attempt 1's logs via
  `gh api .../runs/<id>/attempts/1/logs`** before diagnosing from the default
  (latest-attempt) log view.
- Repairing the ledger with `supabase migration repair`: **applied-first,
  reverted-second**, so an interruption leaves the harmless both-rows state
  and never a state where db push re-applies DDL.
- Guards added: the heal refuses candidates stamped more than
  `MIGRATION_HEAL_MAX_AGE_DAYS` (14) below the applied head (a true
  merge-window casualty is hours old; the incident file was 124 days old);
  the stamp guard allows a below-head file only as a PURE RENAME
  (byte-identical to a base file the PR removes), which is how a stamp
  restore ships through a PR.
- A `[skip ci]` bot commit means nobody tests the resulting tree; if a bot
  commit renames files, run the suite against main's tip before trusting it.
  Related: [[project_migration_restamp_empty_file_trap]],
  [[project_main_failure_watch_twice_heuristic]],
  [[feedback_pipe_exit_code_masks_failures]].
