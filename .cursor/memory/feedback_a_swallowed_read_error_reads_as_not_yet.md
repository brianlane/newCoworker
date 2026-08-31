---
name: a-swallowed-read-error-reads-as-not-yet
description: "In a polling verifier, an ignored read error is indistinguishable from 'the thing has not happened yet', so the tool can only ever report failure; make the error fatal"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f1f67a57-4dca-404b-93f1-92aa9191e26a
  modified: 2026-08-30T00:31:46.929Z
---

A poll loop that waits for evidence must treat "I could not read the
evidence" as a DIFFERENT answer from "the evidence is not there yet". If it
swallows the read error, those two collapse into one observation and the
tool can only ever time out and report failure, however healthy the system
is.

Concrete (2026-08-29, debug/push-edge-alert.ts --watch). The loop selected
`created_at` from `notification_link_clicks`, whose timestamp column is
`clicked_at`. PostgREST fails the WHOLE select on an unknown column, so
`data` came back null, and the destructure discarded `error`. It polled for
three minutes and declared the push receipt broken. The receipt had bound
correctly thirteen seconds after the send: right `notification_id`,
`read_at` stamped, `read_by_actor=owner`. The tool was the only thing wrong,
and it was reporting on the exact fix it had been written to prove.

**Why:** this is worse than an ordinary bug because the whole purpose of a
verifier is to be believed. A false negative here sends someone chasing a
bug that does not exist, or, worse, gets a correct fix reverted. Note the
asymmetry: a swallowed error can never produce a false PASS, only a false
FAIL, which is exactly why it survives casual review. Related but distinct
from [[feedback_pipe_exit_code_masks_failures]], where the masking is in the
exit code rather than in the query result.

**How to apply:** in any wait/poll/verify loop, destructure `error` and exit
non-zero on it with the message, never `const { data } = await ...`. Before
trusting a timeout, ask what the loop would do if its query were simply
invalid. And when a verifier reports failure on something you have reason to
think works, check the verifier against a KNOWN-GOOD case before believing
it: that is what `--verify=<notificationId>` exists for on that script, and
it is why re-checking must not cost another real alert. See also
[[feedback_verify_the_column_is_written]] and
[[feedback_assert_the_producer_not_the_fixture]].
