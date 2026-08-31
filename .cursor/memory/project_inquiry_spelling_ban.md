---
name: inquiry-spelling-ban
description: "Platform-wide ban on the British \"enquiry\": where the prompt line rides, what guards it, and the two matchers that keep the old spelling on purpose"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-28T17:35:32.362Z
  originSessionId: a0abefdd-97b5-458c-b475-428106314b94
---

Shipped 2026-08-28 (PR #1701). Amy Laidlaw's leads were being called about
"your enquiry through Clever": the British spelling, spoken to Arizona
homeowners. It had TWO independent sources, and either one alone keeps it
alive. Any future "the AI says X wrong" report should be split the same way.

1. **Stored copy told the model to say it.** Both of Amy's ENABLED flows had it
   baked into spoken personas, voicemail scripts, team `contextTemplate` notes,
   an email body, and a `lead_site_ref` extraction field whose instruction read
   "answer exactly: your recent enquiry". Fifteen `awaiting_reply` runs also
   held the phrase in `context.vars`, so they would have spoken it on their next
   call whatever the definition said. Fixed by
   `scripts/oneshot/heal-inquiry-spelling.ts` (text substitution over the stored
   JSON, NOT a re-seed; flow writes stamp `edit_source`/`edit_actor` so the
   versions trigger snapshots the old bytes, run writes are revision-CAS).
2. **The models drifted into it** on turns no template scripts. Fixed by
   `US_SPELLING_PROMPT_LINE` in
   `supabase/functions/_shared/sms_prompt_lines.ts`.

The line rides the same nine surfaces `NO_EM_DASH_PROMPT_LINE` does: SMS worker
(customer + staff), `OWNER_PREAMBLE` (dashboard chat, owner SMS, Slack owner),
Slack team, messenger, webchat, AiFlow extraction, plus lockstep copies in the
voice bridge (`usSpellingLine`) and `src/lib/agents/core.ts`, and a short inline
form in the blog/weekly-topics/weekly-digest composers. **When adding any new AI
surface, wire both lines.**

`tests/inquiry-spelling.test.ts` guards it, modelled on
`tests/no-em-dashes.test.ts`: whole-file scan of copy-first surfaces (including
EVERY `scripts/oneshot/*-definition.ts`, so a re-seed cannot reintroduce it)
plus a wiring pin on all nine surfaces. Sanctioned occurrences are stripped via
`ALLOWED_LITERALS`, so **keep the "Never write ..." clause on ONE source line**
or the strip stops matching.

Three places keep the old spelling deliberately, because they READ old data
rather than write new copy: `OLD_SITE_FALLBACK` in
`amy-heal-parked-cadence-lead-site.ts`, the rewrite rule in
`heal-inquiry-spelling.ts`, and captured production transcripts under
`tests/e2e/`. Recognizing a spelling is not writing it.

**The trap a spelling sweep sets** (Bugbot caught it): the pre-fix extraction
wrote the spoken fallback PHRASE into `lead_site`. Respelling stored data moves
that sentinel, so any matcher comparing against only the OLD spelling stops
recognizing it and treats it as a real value, recomposing
"your inquiry through your recent inquiry". Fixed with `isFallbackSitePhrase`,
which matches both spellings. Generalize: **after a data respell, audit every
equality check against the pre-respell literal.**

Related: [[em-dash-sweep-complete]], [[amy-policies]],
[[live-flow-source-of-truth]], [[copy-sweeps-must-scan-rendered-source]].
