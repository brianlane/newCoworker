---
name: extraction-prompt-style-lines
description: "A style rule added to buildExtractionPrompt can silently break person-role extraction; the extraction surface takes its own shorter, scoped spelling line"
metadata: 
  node_type: memory
  type: project
  originSessionId: e309beb5-9a76-4242-94c0-2a62832aad63
  modified: 2026-08-28T21:46:54.228Z
---

Found 2026-08-28 chasing a red nightly. PR #1701 wired
`US_SPELLING_PROMPT_LINE` onto all nine AI surfaces, including AiFlow field
extraction. On the extraction surface it broke the Pamela replay
(`tests/e2e/clever-seller-name.e2e.test.ts`): the extractor went back to
answering **"Amy"**, the tenant's own agent, for "the seller's first name",
which is the exact Jul 2026 incident the person-role disambiguation
instruction exists to prevent.

**A style rule is not free on an extraction prompt.** Measured on the live
model, 10 samples per cell, layer 1 = the flow's vague original field
description, layer 3 = the worker's `withSelfNameRetryHint` fallback:

| spelling line on `buildExtractionPrompt` | L1 seller | L3 retry hint | wrote British |
|---|---|---|---|
| none (pre-#1701) | 10/10 | 10/10 | **10/10 BAD** |
| the full line (#1701 as shipped) | **2/10** | 10/10 | 0/10 |
| full line + a scope clause | **0/10** | 10/10 | 0/10 |
| inquiry clause only | 10/10 | **3/8** | 0/10 |
| inquiry clause + scope clause (SHIPPED) | 10/10 | 10/10 | 0/10 |

Two edits, both load-bearing, neither sufficient alone:

1. **Drop the trailing list of other British spellings** (canceled, organize,
   neighbor, ...). Its presence is what costs the role instruction its grip.
   Reordering the lines was tried FIRST and scored 0/8, so it is not about
   position.
2. **Say the rule governs spelling only.** Without that, the retry hint starts
   returning `""`: the hint plus a bare "write in American English" together
   read as licence to compose, and an extractor that composes stops answering.

`US_SPELLING_PROMPT_LINE_EXTRACTION` in
`supabase/functions/_shared/sms_prompt_lines.ts` carries both. Composing
surfaces (SMS, voice bridge, owner chat, webchat, messenger, Slack, document
agents) keep the full line: they have no role-extraction to lose.
`tests/inquiry-spelling.test.ts` pins the extraction surface to the exact
constant, because a bare `US_SPELLING_PROMPT_LINE` substring check passes on
the extraction constant BY ACCIDENT.

**How to apply:** before adding any global style line to a prompt that also
carries a disambiguation or selection instruction, score the affected e2e
layers on the live model. `buildClassifyPrompt` deliberately carries neither
style line; do not "fix" that for consistency without measuring first. See
[[feedback_score_prompt_changes_against_outcomes]] and
[[feedback_prove_prompt_fixes_against_deployed]] for the method, and
[[project_inquiry_spelling_ban]] for what #1701 was solving.
