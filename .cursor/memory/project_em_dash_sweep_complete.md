---
name: project-em-dash-sweep-complete
description: "Repo-wide em dash sweep shipped Aug 18 2026; the ~118 left are deliberate, and the CI guard was NOT widened"
metadata: 
  node_type: memory
  type: project
  originSessionId: 050a9946-fd28-4872-aa0f-a6ece9fc1d42
  modified: 2026-08-19T00:56:53.135Z
---

The repo-wide em dash cleanup shipped 2026-08-18 in PRs #1474 (1,761 in
strings, prompts, labels), #1475 (7,192 in comments/JSDoc), and #1487 (dossier
record). Live `ai_flows` copy for Truly Insurance and New Coworker HQ was swept
too, via `strip-em-dashes-flows.ts --apply`, so repo and live rows now agree.

**Do not re-sweep.** The ~118 occurrences still in the tree are deliberate and
were audited individually. Three kinds:

1. Matchers and charset tables that RECOGNIZE a dash someone else typed:
   `gsmSafeSmsText` (drop it and every em dash forces UCS-2, which Telnyx
   rejects with 40302), the WinAnsi PDF set in `documents/typeset.ts`, the
   hours-range parsers, `engine.ts` phone-label regexes.
2. Seven stored identifiers matching a production row byte for byte
   (`NEEDS_HUMAN_TEAM_FLOW_NAME`, `REPLY_FLOW_NAME`, the KYP booking and
   no-show flow names, `Voice routing ...`, the onboarding CRM sentinel).
3. Tests that feed a dash as input, plus the negative guards asserting absence.

Deliberately out of scope, by Brian's call: `supabase/migrations/**`, all
markdown (README still has 143), and `zoom-marketplace-assets/` (generated
third-party scan output).

**The CI guard was NOT widened.** Brian chose to leave
`tests/no-em-dashes.test.ts` on its curated ~25-file list, so a new em dash in
any unguarded file still lands silently. Related: [[feedback-copy-sweeps-must-scan-rendered-source]].
