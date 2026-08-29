---
name: project-e2e-judge-question-polarity
description: "Phrase judgeReply questions as TRUE = violation; TRUE = good-property questions produce false negatives, and lexical facts belong in a regex"
metadata: 
  node_type: memory
  type: project
  originSessionId: 08cb847f-efb9-4fa8-b371-60dedfb536ae
  modified: 2026-08-14T19:04:21.514Z
---

`tests/e2e/judge.ts` is reliable on questions where TRUE means "the contract
was violated" and unreliable on questions where TRUE means "the good thing
happened". Its docstring says so; two nightlies (2026-08-12 and 2026-08-14)
were lost to ignoring it.

Concretely, on the Amy Kolton suite:

- `acknowledges_criteria` and `future_or_no_day` were both TRUE = good, and
  both returned false on replies that plainly satisfied them.
- Rewriting a question longer and more explicitly made it WORSE, not better.
  Adding a self-referential clause ("...is what the other question already
  catches") took a good-property question from 12/12 to 10/12 correct.
- The fix that worked was narrowing the TRUE case: say "answer TRUE only
  when X", not just a list of what answers false.

**Why:** a false negative on a good-property question fails a green build and
reads as model drift, so the investigation starts in the wrong place. The
mirror risk is worse: before PR #1369 any judge response-shape drift parsed
to `false` on every key, and on a violation question `false` means "no
violation", so a broken judge silently PASSED tests.

A third failure mode, Aug 28 2026: an EXCLUSION clause naming an ACTOR. The
question "does the sender promise to text them later? saying a person from the
TEAM will follow up is false" split its own verdicts on
"someone from the team will make sure you get that text at 6:30 PM Eastern",
sometimes TRUE and sometimes FALSE, because the reply satisfies the exclusion
and the violation at once. Fix: gate on the concrete FEATURE that makes it a
violation, not on who is said to do it. Rewritten as "does it name a TIME at
which a message will reach them, no matter who is said to send it", it scored
0/6 on three acceptable replies and 6/6 on two violations. Ask what the
customer actually hears: they hear a text at 6:30 either way.

**How to apply:** phrase every new question TRUE = violation. Keep
exact-by-nature facts (does the reply name a city, a digit, a URL) as a
regex, which the judge docstring already instructs and which is
deterministic. When a live e2e fails, read the judge verdict against the
reply text before touching a prompt: if the verdict is plainly wrong about
the text, the bug is the question or the judge. To prove any change, A/B the
old and new question text on the SAME captured reply for ~10 draws rather
than re-running the suite, which conflates judge and model variance. See
[[project-run-itest-and-live-e2e-locally]] and
[[feedback-a-failing-old-test-is-evidence]].
