---
name: research-the-codebase-before-asking-me-to-adjudicate
description: Do not ask the user to choose between options the code already answers; go read it first
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 987de884-a175-4396-a081-0720a7593120
  modified: 2026-07-30T23:27:59.047Z
---

When a question has an answer discoverable in the codebase, find it instead of
presenting it to the user as a judgment call. On 2026-07-30 I asked whether
skin-concern details belonged in `soul_md` or `identity_md` and offered it as a
preference; the reply was "No you need to do more research. Explore the codebase
and the Memory section for each user. You should know the answer to this." The
dashboard Memory editor and `src/lib/memory/kg-sources.ts` answered it outright.

**Why:** Being asked to pick between options is only useful when the choice is
genuinely the user's. When the repo already encodes the answer, an
AskUserQuestion spends their attention on something I could have resolved, and
risks landing on the wrong option by vote rather than by evidence.

**Same rule for anything I flag as OPEN, not just AskUserQuestion.** On
2026-08-24 I closed a summary with "should a cadence keep working a lead a
teammate already claimed? that is a product question for Amy". The reply was
"I thought we already discussed this? Look in past conversations." It was
settled on 2026-08-17 and recorded in the code with Brian's own words quoted:
`scripts/oneshot/amy-needs-follow-up-definition.ts` says a claim deliberately
does NOT stop the cadence ("if someone claims it and they don't reach them it
will work out ... it's only three times"), and `amy-email-followup-cadence.ts`
repeats it. It USED to stop it and was changed on purpose in PR #1438. A
`grep -rn "stop the cadence\|claimed"` over `scripts/oneshot/` would have
found it in one command. Past decisions on this repo live in code comments and
one-shot headers as often as in transcripts, and `search_session_transcripts`
is substring-only so multi-word queries return nothing: search a distinctive
PHRASE (a template line, an error string), not a description of the topic.

**How to apply:** Before AskUserQuestion, and before writing "this is still
open" in a summary, ask what would settle this question factually and whether
it is in the repo. Reserve the tool for business facts I
cannot observe (a customer's hours, an unreleased link, which vendor to use) and
for genuine trade-offs. When I do present a researched conclusion, cite the file
that establishes it. See [[feedback_testing]].
