---
name: feedback-measure-the-machine-not-the-plan
description: "Brian: when reasoning about capacity pressure, worry about CPU/RAM, not what the tenant is spending, because they can just buy packs"
metadata:
  node_type: memory
  type: feedback
---

When I proposed adding "projected AI spend near cap" as a hardware
escalation signal, Brian corrected it: for AI budget pressure the concern is
**CPU and RAM, not tenant spending, since they can just buy packs**.

**Why:** spend is self-healing. Packs and auto-reload cover an overage
without the hardware changing, so predicting a spend threshold predicts a
billing event, not a machine event. What matters is where the WORK ends up.
The AI budget earns a place in the hardware section only because exhausting
it relocates inference onto the tenant's own vCPUs, not because the number
is large.

**How to apply:** for any "is this resource under pressure" question, ask
what physically happens at exhaustion. If the answer is "we bill them" or
"we refuse the request", it is a billing signal. If the answer is "the work
moves onto hardware we own", it is a capacity signal. Prefer a measured
reading (load per core, available MiB, turns actually served locally) over a
ratio against an entitlement. Related:
[[project-escalation-advisor-hardware-vs-usage]].
