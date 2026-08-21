# New Coworker: working agreements

These are the standing rules for this repo. They were previously Cursor rules
under `.cursor/rules/`; unlike that directory, this file is tracked, so it
ships to the repo and to every fresh clone. The README carries longer-form
copies of the same contracts under "Start every session from the context
pack", "All work and code modifications must follow this flow", and "Writing a
migration". Keep this file and those sections in step.

Rules scoped to one directory live in a nested `CLAUDE.md` next to the code
they govern (see `supabase/migrations/CLAUDE.md`), which loads only when you
touch files there.

---

## 1. Start from the context pack

Almost every session on this repo used to open the same way: read the
1,700-line README, review the application code, review the last two weeks of
conversations, skim the last two weeks of pull requests. That is the same
orientation re-derived from scratch every time, paid for in tokens, arriving
at the same answer. It is now generated once, mechanically.

**Read [docs/CONTEXT-PACK.md](docs/CONTEXT-PACK.md) first.** It carries:

- a repo map (what lives where, and the tool inventory),
- a line-numbered index of every README section, so "read the README" becomes
  "open the two sections this task needs",
- the last 14 days of pull requests,
- the last 14 days of agent sessions, with the shared opening boilerplate
  stripped and the PRs each session touched,
- a fleet snapshot: every tenant with its full business id, tier, DID, and
  flow counts.

Then open only the raw sources the task actually needs.

### Where it lives, and why it is already in your worktree

The pack is gitignored and generated, never hand-edited, so a fresh worktree
starts without it, and Claude Code opens every session in a fresh worktree.
Two things close that gap: the generator writes the pack into every checkout
(the main one plus all linked worktrees), and the SessionStart hook
(`scripts/sync-context-pack.sh`, wired in `.claude/settings.json`) copies the
main checkout's pack into the session's worktree at startup and prints its
age into the session context. If the hook reports it stale (more than a day
old) or missing:

```bash
npx tsx scripts/context-pack.ts
```

It is read-only, takes a few seconds, and refreshes every checkout at once.
`--days N` widens the window, `--no-fleet` skips the Supabase queries,
`--out -` prints to stdout instead of writing anywhere.

Run it from the main checkout or from a worktree under `.claude/worktrees/`:
`npx` and Node both resolve the main checkout's `node_modules` from above an
app worktree, and `.env` plus the transcript archive resolve through the
shared git common dir. A standalone worktree (`newCoworker-wt-<name>`) needs
its own `node_modules`, same as the rest of the flow.

The session digest reads every transcript archive this repo owns: the Claude
Code archive of the main checkout (`~/.claude/projects/<slug>/`) and of every
worktree session, current or since removed (worktree slugs extend the main
slug), plus the older Cursor one
(`~/.cursor/projects/<slug>/agent-transcripts/`), so history from before the
switch stays visible. `CONTEXT_PACK_TRANSCRIPTS_DIR` overrides the search
with an explicit directory.

### What still deserves the raw sources

The pack orients; it does not replace reading. Go to the source when:

- you are changing code: read the actual files, not a summary of them,
- the task names a specific tenant: read `docs/tenants/<slug>.md` first, then
  the live rows,
- the task depends on a README contract (tool parity, KG source coverage,
  i18n, migration stamps): read that section in full, since the pack only
  links it,
- you need what a past session actually decided: open its transcript by id.

### Keeping it honest

If you find yourself re-deriving something the pack should have told you, the
fix is to improve the generator (`scripts/context-pack.ts`), not to go back to
re-reading everything by hand. Same rule as the rest of this repo: once a
behavior is understood and repeatable, capture it in code.

---

## 2. How work ships here

**No change reaches main except through a PR.** Never commit directly to
main, and never treat "the tests pass locally" as done: that is the middle of
the job, not the end.

The full flow, for every code change, however small:

1. **Worktree + branch.** `git worktree add -b <branch>
   /Users/brianlane/newCoworker-wt-<name> origin/main`. Never work in the
   main checkout. The worktree needs `node_modules` (symlink the main
   checkout's, or `npm ci`); `.env` resolves automatically through
   `debug/_shared.ts`.
2. **Make the change**, with tests. `npm test` must pass and coverage is
   pinned at 100% for `src/lib/**`, so new logic there needs new assertions.
   `npx tsc --noEmit` and `npx eslint .` too. **Touching
   `vps/voice-bridge/`? The root `tsc` does NOT cover it** (the root tsconfig
   excludes it; it is its own package with its own compiler), so also run
   `cd vps/voice-bridge && npx tsc --noEmit`. Its build otherwise runs for
   the first time inside the Docker image at REDEPLOY, which is after the
   merge: on 2026-08-17 a type error there passed every gate, merged green,
   and then failed the redeploy on all four boxes, leaving main green and the
   fix not live. CI now runs that compiler too, so this is belt-and-braces.
3. **Open the PR** and label it for the weekly blog digest: `blog: feature`
   if customers should read about it, `blog: skip` for bug fixes, internal,
   UI cleanup, or ops work. The label is authoritative; unlabeled PRs fall to
   an AI classifier.
4. **Babysit CI and Bugbot to green.** Do not walk away at "pushed". Bugbot
   reliably finds real bugs here and re-reviews every push, so expect more
   than one round. See the PR merge policy below for what counts as green.
5. **Merge** (squash), then **watch the push-to-main run to green**: it
   applies migrations and deploys, and a failure there means production did
   not update.
6. **Post-merge, still manual when the change calls for it:** a VPS redeploy
   if `vps/` changed, and running any new `scripts/oneshot/` script. The
   redeploy scripts are **not interchangeable**: each one ships a single
   subtree, so picking the wrong one silently deploys nothing and the change
   looks live when it is not.

   | Changed subtree | Script |
   | --- | --- |
   | `vps/chat-worker/` | `tsx debug/update-all-vps.ts` (whole fleet) |
   | `vps/voice-bridge/` | `tsx debug/redeploy-voice-bridge.ts --all` (whole fleet) |
   | `vps/aiflow-render/` | `tsx debug/redeploy-aiflow-render.ts --business-id <uuid>` (one tenant) |

   Only aiflow-render still lacks a fleet sweep: loop it one run per distinct
   unrotated `business_id` in `vps_ssh_keys`, and check `voice_active_sessions`
   for calls in flight first, since recreating a container drops them. A row
   counts as a live call only when `ended_at is null` AND `last_seen_at` is
   recent: the bridge heartbeats it every 15s, so anything quiet for more than
   a couple of minutes is a leaked row, not a caller.
   `redeploy-voice-bridge.ts --all` does both of those for you (it skips a
   tenant that is mid-call and exits non-zero, so a skip never reads as done,
   and it ages out rows silent for over two hours with a warning rather than
   letting a leak block redeploys forever).
   Dry-run any sweep first, and verify boxes with
   `tsx debug/box-verify.ts <businessId>`.
7. **Remove the worktree. Mandatory.** Kill anything running out of it,
   re-anchor your shell to `/Users/brianlane/newCoworker` FIRST, then
   `git worktree remove`, `git worktree prune`, and delete the branch. A shell
   left inside a deleted worktree fails every later command and looks like a
   dead terminal backend.

Continue through all of it without stopping to ask permission between steps.

### Do not stop early

A plan or a summary that ends at "run the tests" is incomplete. The change is
not shipped until the PR is merged, main is green, and the worktree is gone.
If you are in plan mode, the plan should say so.

### Repo-specific traps worth knowing before you start

- **Migrations:** never hand-write the version stamp. `bash
  scripts/new-migration.sh <name>`. New tables need explicit Data API grants
  in the same file. Both rules are detailed in
  `supabase/migrations/CLAUDE.md`.
- **i18n:** user-facing strings live in `messages/en.json` AND
  `messages/es.json`, and a parity test fails when they drift.
- **Tenant changes** (flows, seeds, one-shots) must update the matching
  dossier in `docs/tenants/`, which CI enforces.
- **New coworker tools** must satisfy the parity contract, and **new content
  surfaces** must register in the KG source registry. Both are CI-guarded.
- **Data-residency reads:** the 15 `RESIDENCY_MOVED_TABLES` split in two, and
  the halves have opposite rules. `residency_purge_business()` DELETES from 8
  of them, so a central read of `email_log`, `sms_outbound_log`,
  `voice_call_transcripts` (+turns), `voice_outbound_dial_log`,
  `notifications`, `scheduled_sms`, or `sms_owner_reply_prompts` is silently
  incomplete for a `vps` tenant: route it through `@/lib/residency/read`. The
  other 7 (`contacts`, `sms_rowboat_threads`, `dashboard_chat_*`, `ai_flows`,
  `aiflow_url_memory`) are deliberately KEPT central, so a central read of
  those is correct and in fact fresher than the box; do not route one on its
  own. WRITES need nothing either way, the journal triggers catch every
  writer by construction. `tests/residency-read-coverage.test.ts` enforces
  this and `npx tsx debug/residency-read-report.ts` shows the current state.
- **`package.json` overrides** each have a documented reason in
  `docs/DEPENDENCY-OVERRIDES.md`. Adding, changing, or removing an override
  means updating that file in the same PR.

---

## 3. PR merge policy

Never merge a pull request until ALL of the following hold:

1. **Every check is green, none skipped.** All CI jobs (tests, lint, build,
   Vercel) AND the Cursor Bugbot review must show passing/complete. A check
   stuck in "skipping"/"pending" counts as NOT passing: wait for it or
   re-trigger it (`git commit --allow-empty` push, or re-run from the Checks
   tab). Do not use admin/auto-merge to bypass a queued or skipped check.
2. **Every review comment thread is resolved.** For each Bugbot or human
   comment: fix it in the same PR (or reply explaining why it is not an
   issue), then mark the thread resolved on GitHub. Check with:
   `gh api graphql` on `reviewThreads(first: 50) { nodes { isResolved } }`.
   Zero unresolved threads before merge.
3. **Findings that surface after merge still get fixed.** If Bugbot posts a
   comment after the merge happened, treat it as an open bug: fix it in the
   next PR and resolve the thread, never leave threads dangling.

When the user asks to merge and a check is skipped or a thread is unresolved,
say so and finish the checklist first instead of merging.

### Checks appear in waves: "all green" can be a false green

`ci.yml` gates jobs on earlier jobs (`vercel-deploy` needs the six core jobs,
`e2e` and `indexnow-ping` need `vercel-deploy`), and GitHub creates a check
only when its job is created. A check that does not exist yet cannot show as
pending, so `gh pr checks` can read all-pass while later jobs have not been
born. Observed twice on PR #1181: the list was fully green before
`Vercel Deploy` existed, and again before `E2E (live AI + AiFlows)` existed.

Since Aug 2026 a GitHub ruleset ("main: PRs with all checks green") makes
this structural for the 20 stable check contexts: they are required, so an
uncreated one blocks the merge as "expected", and squash is the only allowed
merge method. Unresolved-thread blocking is enforced by the same ruleset. Two
things it deliberately does NOT cover, so the manual policy above still
applies: the Cursor Bugbot conclusion (Bugbot does not run on Dependabot PRs,
so requiring it would deadlock automerge), and anything on a repo where the
ruleset is disabled. Before merging, still confirm zero checks pending on two
consecutive polls about 30s apart, `mergeStateStatus` is `CLEAN` (it reads
`UNSTABLE` while any check is pending or expected), and Bugbot is literally
`SUCCESS`.

### Reading the Cursor Bugbot check conclusion

The `Cursor Bugbot` check's GitHub conclusion is meaningful. Do not read it as
"passed" unless it is literally `SUCCESS`:

- **`SUCCESS`**: Bugbot reviewed and there are no open Bugbot findings.
  Passing.
- **`NEUTRAL`** (shows as "skipping" in `gh pr checks`): Bugbot has **open,
  unresolved review conversations** on the PR. This is NOT a pass. Do not
  merge. Fetch the threads (`reviewThreads` via `gh api graphql`), then for
  each: fix it in the same PR or reply explaining why it is not an issue, and
  mark the thread resolved. Once every Bugbot thread is resolved, Bugbot flips
  to `SUCCESS`.

So a `NEUTRAL`/"skipping" Bugbot means "go resolve my comments", not
"re-trigger me". Re-triggering an unaddressed Bugbot just returns `NEUTRAL`
again.

---

## 4. No em dashes, ever

Never type an em dash in anything you produce: code, comments, user-facing
copy, SMS/email templates, AI prompts, i18n catalogs, docs, README text,
PR titles and bodies, commit messages, chat replies, and plan files. Use a
comma, a period, or a colon instead. This applies in every context; there is
no "allowed" placement.

This also covers generated content: every AI worker/model prompt must carry
the no-em-dash instruction so models never emit one. Use the shared line
(`NO_EM_DASH_PROMPT_LINE` in `supabase/functions/_shared/sms_prompt_lines.ts`,
with lockstep copies where a surface cannot import it) instead of writing a
new phrasing.

`tests/no-em-dashes.test.ts` enforces the rule in CI for the guarded
user-facing surfaces (message catalogs, email templates, prompt-line modules,
one-shot flow copy, and all of `.github/workflows/`, which composes the deploy
failure email and the PR preview comment). Legacy instances elsewhere are
cleaned opportunistically:
never add new ones, and sweep a file you are already editing when it is cheap
to do so.

---

## 5. Product terminology: "AI coworker", never "AI receptionist"

New Coworker is an **AI coworker**, never an "AI receptionist". Do not
introduce the phrase "AI receptionist" (any casing) anywhere: user-facing
copy, SMS/email text, SEO keywords, AI prompts, code comments, docs, PR
titles, or marketing text. All instances were removed in PR #725. Keep it that
way.

```text
BAD:  your AI receptionist couldn't take a live call
GOOD: your AI coworker couldn't take a live call
```

Scope note: this bans the specific product label "AI receptionist". Standalone
"receptionist" is still allowed where it describes a role or a comparison, not
the product, e.g. the voice persona's system instruction ("You are the phone
receptionist for {business}", which tests assert on) and pricing copy
comparing cost against "a receptionist or answering service".
