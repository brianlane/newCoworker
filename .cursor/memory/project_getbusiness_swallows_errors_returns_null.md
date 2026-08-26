---
name: project-getbusiness-swallows-errors-returns-null
description: getBusiness returns null on ANY error, so `business?.flag === true` turns a DB blip into a definite false; keep unknown distinct from false in any gate
metadata:
  type: project
---

`getBusiness` in `src/lib/db/businesses.ts` ends with `if (error) return null`.
It never throws. So a transient database error is indistinguishable from "no
such business", and both arrive as `null`.

That makes the natural-looking read a trap for any safety gate:

```ts
hipaaMode = business?.hipaa_mode === true;   // WRONG: a DB blip becomes false
hipaaMode = business ? business.hipaa_mode === true : undefined;  // right
```

Caught while building the PHI-free notification redaction (PR #1467): the first
version would have failed OPEN on a read hiccup and sent patient content to
vendors with no BAA, while looking correct and passing every test.

**Rule: when a boolean drives a fail-closed decision, keep `undefined`
(unknown) distinct from `false` (known-negative), and decide explicitly what
unknown means.** It is not always "redact": the PHI access log deliberately
fails the other way, because over-logging writes other tenants' identifiers
into a table built for a duty they are not under. State the direction and the
reason at the call site.

Related: [[feedback_verify_the_column_is_written]],
[[project_postgrest_write_matching_zero_rows]].
