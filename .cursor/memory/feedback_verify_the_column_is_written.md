---
name: feedback_verify_the_column_is_written
description: "Before building a feature that READS something, confirm a CALLER or WRITER actually exists in production; five times a feature shipped dead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40416682-0de3-4391-a713-4b717801572b
  modified: 2026-08-14T16:26:22.174Z
---

Aug 10 2026. I built `{{trigger.thread_has_our_reply}}`, which asks whether
`email_log` has an **outbound** row with a matching `thread_id`. Bugbot pointed
out that nothing writes `thread_id` on outbound rows. Production confirmed it:
**0 of the newest 15** outbound rows had one, across every surface. The feature
was dead on arrival, and it was the second dead-on-arrival feature in the same
workstream (`run_agent` from a flow had never once succeeded).

Worse, I had already printed the evidence. Diagnostics I ran hours earlier
showed `thread=-` on every outbound row and I read straight past it, because I
was looking for something else.

**Why the tests did not catch it:** I mocked the lookup. That proved the
consumer reacts correctly to a value and nothing at all about the value ever
existing. This is [[feedback_assert_the_producer_not_the_fixture]] one layer
further back: I had even driven the real `emailTriggerScope`, which made me
feel covered, while the seam BEHIND it (does any writer populate the column the
lookup matches on?) stayed untested.

**How to apply.** Before writing code that reads a column, a field, or a row
type, run one query against production:

```
select count(*) filter (where <col> is not null), count(*) from <table> where <scope>;
```

If the answer is zero, the feature you are about to build cannot work, and
finding that out first changes the design rather than the postmortem. Same
check for a table you assume is populated (`agent_runs where source='flow'`
was the earlier one).

Then test the WRITE, not just the read: assert the INSERT payload carries the
column, and assert any response that carries the value between two services
still has it. A value that crosses a service boundary (route computes it, the
Deno worker writes the row) is lost unless something explicitly hands it over,
and neither side's tests will notice.

**Fourth instance, Aug 12 2026, with a new twist.** The call page's
AnsweringMachineBadge read `voice_call_transcripts.voicemail_left`,
`answering_machine_result` AND `voicemail_verbatim_score`; none had a working
writer. The twist: `answering_machine_result` DID have a writer, but it ran
mid-call while the bridge created the transcript row lazily at stream end, so
the PostgREST update matched zero rows on every call and reported success
(see [[project_postgrest_write_matching_zero_rows]]). "A writer exists" is not
enough: confirm the write LANDS, with `.select()` or a production count.

**Fifth instance, Aug 14 2026, with no database in it at all.** The Google
migration plan required Disconnect to revoke the grant at Google. I wrote
`revokeGoogleToken`, tested it thoroughly, and wired it only into the OAuth
callback's failure-rollback paths. The owner's Disconnect button never called
it, so for a day Disconnect deleted our tokens and left the grant live on the
user's Google account. What hid it: the helper's own doc-comment described the
shipped behavior ("for owner-initiated disconnect", "this is what makes
Disconnect actually mean disconnected"), so every later read of that file
confirmed the feature was done. **A doc-comment describing an integration is
not evidence the integration exists.** Generalize the rule past columns: for any
plan item, grep for CALLERS of the thing you built, not for the thing itself.
`grep -rn "revokeGoogleToken" src` answered it in one command and I only ran it
because I was chasing an unrelated question.

Related: [[feedback_assert_the_producer_not_the_fixture]] is the same failure
about function seams; this one is about the database. [[feedback_testing]] pins
100% coverage, which does not help: every line here was covered.
