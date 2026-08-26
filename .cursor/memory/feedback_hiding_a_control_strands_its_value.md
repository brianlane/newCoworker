---
name: hiding-a-control-strands-its-value
description: "Any 'hide the control when there is no choice' rule strands whatever is already stored in that field; the form keeps submitting it and the save is refused with no way to change it"
metadata:
  node_type: memory
  type: feedback
---

A picker hidden on "is there a choice worth making" strands whatever the
field already holds. The form keeps submitting the stale value, the
server refuses it, and nothing on the page can change it. The user is
locked out of every save, not just that field.

Hit three times in one PR pair (Aug 19 2026, PRs #1526 and #1536), each
found by Bugbot, each after I "fixed" the previous one:

1. **Send from** shown on `mailboxes.length > 1`, but the list leads with
   an "Automatic" entry, so one mailbox made it two long. Count the real
   entries, not the list.
2. Fixed that, and hiding it below two mailboxes then stranded a pinned
   mailbox that got disconnected. `mailboxGone` blocker + render the
   picker whenever the pin does not resolve.
3. Built the meeting picker fresh with the same gate and reproduced the
   identical bug, having just fixed it one field up.

**Why:** the gate answers "is a choice useful?" while the real question
is "can the stored value still be reached?". Those differ exactly when
the stored value has gone stale, which is the case that needs the control
most.

**How to apply:** whenever a control is conditionally rendered, render it
ALSO when its current value is not among the options, and give the stale
value its own explicit option, or the browser shows the first option
while state still holds the dead id and the user resubmits it believing
they cleared it. Pair it with a blocker naming what happened. And when
fixing this on one field, grep for sibling fields with the same shape
before shipping: see [[check-for-a-shared-mechanism-first]].
