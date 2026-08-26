---
name: feedback-truncated-page-is-not-uniqueness
description: "A row limit plus a post-query filter cannot prove a match is unique; the non-qualifying rows fill the page and hide a real second match, so put the discriminating condition in the query"
metadata:
  node_type: memory
  type: feedback
---

When a lookup must answer "exactly one row or nobody", never satisfy it with a
LOOSE query, a row limit, and then a filter in application code. The rows the
filter throws away still consumed the limit, so a real second match can sit
past the cap unseen and the one survivor looks unique when it is not.

Concretely (PR #1618): matching a spoken first name against contacts as
`ilike 'Bobby%'` with `.limit(10)` and then filtering in JS for "equals, or
starts with the name plus a space". A business with ten Bobbyson/Bobbyanne
rows never sees the second real "Bobby Smith", and the meeting is filed on
the wrong person. I had justified the cap as "any name shared by ten people
is ambiguous anyway", which sounds fine and is wrong: the ten were not shared
names, they were rejects.

The fix is to make every returned row already qualify, so a small limit
genuinely detects ambiguity. Two separate single-pattern queries (`Bobby` and
`Bobby %`, counted together, limit 2 each) beat one hand-built PostgREST
`or()` string here, because `or()` is comma-separated and a display name
containing a comma or a quote breaks the parse.

**Why:** the guarantee lives in the query, not in the code after it. A filter
that runs after truncation can only shrink an already-wrong set.

**How to apply:** whenever you write `.limit(n)` on a uniqueness or
existence check, ask what the rows you are about to discard were doing there.
If the query can return rows that fail your test, the limit is not a bound on
the answer, it is a bound on what you can see. Push the test into SQL, or
treat "hit the limit" as ambiguous and refuse. Related:
[[project-postgrest-1000-row-cap]], [[feedback-verify-the-column-is-written]].
