---
name: telnyx-spend-sep2026
description: "Why Telnyx auto-recharged Sep 1 after six days, August vs July spend delta, and Amy's offer fan-out as the volume driver"
metadata:
  node_type: memory
  type: project
  originSessionId: bc-fb877b95-cf86-454c-96b1-689f8bfc5886
  modified: 2026-09-01T18:30:00.000Z
---

Investigated 2026-09-01 after receipts for Auto Recharge $28.03 (Aug 26 04:38 UTC) and $28.63 (Sep 1 07:08 UTC), six days apart. Live Telnyx read the same day: balance $28.01 (just after the morning top-up), auto-recharge still enabled at threshold $2.00 / recharge $28.00 / PayPal. There is still no payments API (404). Card receipts can be a few cents above $28 (PayPal fee on the charge); the prepaid credit is $28.

## Auto-recharge is a prepaid floor, not a weekly bill

`GET /v2/payment/auto_recharge_prefs` is the source of truth. The card is charged when the prepaid balance drops below $2, which fills it back to roughly $28. A 6-day gap is expected around two calendar events that never appear on the Costs usage chart (those bars are `/v2/detail_records` only):

- 1st of the month: DID MRC $1.00 + SMS feature MRC $0.10 per number. Six active DIDs as of Sep 1 2026 (KIN `+18257860392` added Aug 24), about $6.60. July's invoice line was $11.16 because that month also had prorations and activations.
- 6th of the month: shared 10DLC campaign $10.00.

The Costs page 7-day window (Aug 26 to Sep 2) showed $11.55 of usage. That is real, and it is not the recharge trigger by itself. Sep 1 07:08 is MRC posting on a bucket that the previous week of usage had already drawn down. Same shape as the Aug 1 reload (PR #1110): previous top-up Jul 21, balance briefly hit -$0.85 when MRC posted. Historical spacing: Jul 21, Aug 1 (MRC day), Aug 26, Sep 1 (MRC day). Mid-August receipts may exist; usage of $58.89 in August cannot fit in a single $28 bucket plus the Aug 1 top-up.

The Costs "Telnyx This Month, by Type + Direction" widget is the calendar month. On Sep 1 it showed inbound 8 / outbound 23 because September had only just started, not because spend collapsed.

Live after the Sep 1 charge: $28.01. At August's ~$1.90/day usage, the next 10DLC debit on Sep 6 plus a few busy days can empty the bucket again around Sep 10-12. Raise the recharge amount if weekly card charges are the annoyance; the $2 floor is working as configured.

## How much we are spending (MDR usage, `telnyx_cost_daily`)

| Month | Fleet usage | Messages | Amy | KYP |
| --- | --- | --- | --- | --- |
| June 2026 | $6.98 | 542 | $6.98 | (not yet) |
| July 2026 | $30.78 | 2,027 | $20.30 (1,289 msgs) | $6.49 (339) |
| August 2026 | $58.89 | 3,187 | $44.28 (2,306 msgs, 234 voice min) | $12.53 (724) |
| Sep 1 (partial) | $0.47 | 31 | $0.39 | $0.05 |

July all-in invoice was $54.86 (usage $30.78 + MRC/activations $11.62 + 10DLC $10 + adjuncts $0.39 + tax $2.05). August's invoice is not out yet; a like-for-like estimate is usage $58.89 + ~$7 MRC (6 numbers, KIN prorated from Aug 24) + $10 10DLC + ~$1 voice adjuncts + tax, roughly $80. The 7-day dashboard window Aug 26-Sep 2 is $11.55 (Amy $8.96 / 78%).

## Delta, and what drove it

July to August usage: +$28.11 (+91%). Amy +$23.98 (+118%). KYP +$6.03 (+93%). Per-segment rate did not move (~$0.0084). Volume did.

Amy's `agent_offer` sends went 101 (July) to 464 (Aug 1-28) because the Aug 10-15 team-routing work (PRs #1270, #1272, #1317, #1397) fans every offer out to all four roster members. That fan-out is what Amy asked for. In the Aug 26-Sep 1 window her `sms_outbound_log` is still offer-heavy: 142 `agent_offer` of 255 logged outbound (plus 33 coworker replies that live only on `sms_inbound_jobs`). Aug 31 was the spike day: 38 offers, 114 MDR messages, $2.34.

Two cost-side fixes already shipped and do not explain this recharge (they reduce the per-message bill going forward):

1. U+202F GSM-7 cliff, PR #1741, merged Aug 29. One invisible space in `Intl.DateTimeFormat` clock times re-encoded whole messages as UCS-2. 867 wasted segments Jun 1-Aug 29, 8.2% of outbound.
2. `amy-shorten-offer-templates.ts`, applied Aug 29 16:25 UTC (the Amy dossier previously said NOT YET APPLIED; the `applied_oneshots` ledger is the source). Mechanical shortening, about $0.91/mo on her August offer traffic. The engine U+202F fix is worth more (~$3.99/mo for Amy).

RCS agent `new_coworker_jut3q1af_agent` is still LIVE in the testing phase (`NON_CONVERSATIONAL`, one tester device). Production RCS fees ($600 + $100/mo) were deferred Jul 18 and are not in this bill. Truly Insurance's DID is still on the account; their August usage was ~$0 (churned traffic, number still rents).

## How to re-measure

- Live: `GET /v2/balance` and `GET /v2/payment/auto_recharge_prefs`. No charges ledger.
- Usage: `telnyx_cost_daily` (cost_micros already includes carrier_fee).
- Amy send mix: `sms_outbound_log` AND `sms_inbound_jobs.assistant_reply_text` (see [[project_sms_send_logging_split]]).
- Invoice PDFs via `GET /v2/invoices/{id}?action=link` once Telnyx issues August.

## Membership revenue vs costs, and the 3,000-unit idea (Sep 1 2026)

Follow-up to the auto-recharge question: should Standard's SMS cap move from 5,000 to 3,000?

**No.** 5,000 is already the unit form of the old 3,000-message cap. The Aug 5 weighted-metering migration (PR #1189) says so in the SQL header: `standard 3,000 messages -> 5,000 units`, holding the canvas worst-case dollars ($43.94 vs planned $47.70 at $0.008787/part). Cutting to 3,000 units would be a 40% cut in the priced allowance, not a return to the old 3,000 messages. Constants: `SMS_MONTHLY_CAP_STANDARD = 5000` in `sms_monthly_limits.ts`, lockstep `nonenterprise_monthly_sms_cap`.

**Fleet membership still prints money.** Four paying Standard tenants, day-current MRR **$852**: Scar Fairy $279, KYP Ads $279, KIN $195 (monthly intro), Amy $99 (biennial intro; renewal is $189). September 1 Costs-page margin of $693.80 / 81.4% is an artifact: revenue and hosting are the full month, Telnyx usage that morning was $0.48. A like-for-like August month is about **$852 revenue vs ~$220 cost (~74% margin)**: hosting $101.45, Telnyx usage $58.89, DID $7.70, 10DLC $10, Stripe fees $32.73, Gemini a few dollars, tax/adjuncts a few more.

Amy is the tight row, not the fleet. August: revenue $99, Telnyx $44.28, hosting $14.99, DID $1.10, Stripe $2.88, Gemini $0.39: about **+$35**. At her $189 renewal the same usage is about **+$125**. The other three paying tenants barely use SMS (KYP August 1,212 units / 24% of cap, KIN 15, Scar Fairy 3) and print $160 to $245/mo each.

**A 3,000-unit cap would only bind Amy, and it would stop her product.** Calendar August she used **3,997 units** (1,498 outbound messages, 2.67 units/msg after weighted metering went live), 80% of 5,000 and 133% of 3,000. Her live billing window started Aug 28 and already has 831 units in five days (~166/day), on pace for ~5,000 by period end (~Sep 27). 3,000 would hard-stop lead-facing texts around Sep 14 (`try_reserve_sms_outbound_slot` is a customer-facing stop; operational owner alerts still send). SMS packs exist at $0.02/text (consumed in units after the cap), which is the right overage path: ~2x our $0.0088/part cost, and self-healing per [[feedback_measure_the_machine_not_the_plan]].

Truly's canceled DID still rents $1.10. HQ has $0 membership revenue and still costs hosting. Neither is an SMS-cap problem.

Related: [[project_weighted_sms_metering]], [[project_sms_window_anchored_to_billing_period]].
