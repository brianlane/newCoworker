---
name: clever-example-offers-not-invented
description: "Clever's referral page Example only cash-offer module was copied into cash_offers and spoken as this seller's real offers; PR #1726 misdiagnosed that as model invention"
metadata:
  type: project
---

## project_clever_example_offers_not_invented

Call-integrity emails on 2026-09-06 flagged transcript `5339954d` (Amy
Laidlaw) for quoting $375,000 and $395,000, "which nothing on this call
supplied". The same pair was the Aug 20 incident (call `60a64ddd`) that
PR #1726 treated as the model inventing a figure.

**The model did not invent them.** The rendered persona on both calls already
said "the offers on your file are $375,000, $395,000" (Aug 20: "$375k, $395k").
That line is `PITCH_CLEVER` interpolating `{{vars.cash_offers}}`. The var is
filled by `browse_extract` on Clever's referral page.

The saved page for that Sep 6 call (`aiflow-screenshots` `.../step-3.html`) has a
module labeled **EXAMPLE ONLY: Cash offer comparison** showing Instant Cash
Offer ZoomCasa $375k, QuickBuy $395k, Listing Estimate $410k-$440k, plus
"These sample numbers are placeholders and are not based on this property"
and "Keep a lookout for the text messages with the quote link for up to 3
cash offers". This page never carries real offers.

**Rate:** 21 of 93 `cash_offers` extractions since Aug 7 2026 returned those
placeholders, and they scale with estimated value ($425k -> $375k/$395k,
$625k -> $550k/$580k, $1M -> $880k/$930k). Only 3 calls voiced the figures
(one on Aug 20, two on Sep 6). Team texts from the
spoke-check flow also carried the samples.

**What shipped (option 1, Sep 6 2026):** drop the interpolated amounts from
the spoken pitch; harden `CASH_OFFERS_FIELD` so the example module answers
'none listed'; one-shot `amy-clever-example-offers.ts` applies both to the
live Clever Accept and spoke-check flows. The sweep splits `briefed_amount`
("quoted a figure from the call brief, check the flow") from
`invented_amount` so this class is not reported as the model guessing.

Do not "fix" this by feeding the AI more numbers from that page. Real offers
ride the Clever Homeward Offers SMS flow (470-221-2279) and arrive after
first contact.

Related: [[project_amy_policies]], `invented_amount` in
`supabase/functions/_shared/call_integrity.ts`.
