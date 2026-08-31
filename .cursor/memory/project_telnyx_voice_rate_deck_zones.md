---
name: telnyx-voice-rate-deck-zones
description: Telnyx Global Voice Conversational outbound termination is zoned by NPA-NXX; US Zone 5 is 14x baseline and our flat 0.9c/min cost assumption does not model it
metadata: 
  node_type: memory
  type: project
  originSessionId: e309beb5-9a76-4242-94c0-2a62832aad63
  modified: 2026-08-28T19:05:56.185Z
---

Read off the `Global Voice Conversational` rate deck Telnyx emailed 2026-08-28 (effective 2026-08-31T18:00:00 UTC), downloaded from `portal.telnyx.com/downloads/global_conversational/` as `global_conver_e0c150a973.csv`: 262,073 rate rows, 224 countries, 34.6 MB.

- Outbound TERMINATION is priced per destination NPA-NXX, not per country. The deck lists only EXCEPTIONS plus NPA-level defaults; a prefix absent from the deck falls to its NPA-level zone row.
- US zones (all `60/60`, i.e. full-minute rounding, per leg):
  Zone 1 lower-48 `$0.005` (328 NPA-level rows) - Zone 2 Hawaii `$0.01` - Zone 3 Alaska `$0.07` - Zone 4 high cost `$0.01` (8,847 prefixes) - Zone 5 high cost `$0.07` (6,818 prefixes) - Zone 6 high cost `$0.181` (36 prefixes) - Toll Free `$0.00` (7 rows).
  So ~15,700 US prefixes terminate ABOVE baseline, and Zone 5 is 14x Zone 1.
- Canada zones: Zone 1 `$0.005` (50 NPA-level) - Zone 2 `$0.009` - Zone 3 `$0.02` - Zone 4 `$0.061` - Zone 5 `$0.121` - N11 `$0.75`.
- Our operating NPAs all contain high-cost carve-outs: 928 has 64 Zone 5 prefixes, 520 has 18, 480 has 5; Montreal 438 has 21 Canada Zone 5 (`$0.121`); Ontario 519 has 9.
- Rural is where it bites. Densest high-cost NPAs: 605 SD (243), 701 ND (231), 712 IA (202), 218 MN (201), 580 OK (200), 406 MT (152).
- WHY IT MATTERS: `ENTERPRISE_UNIT_COSTS.voiceTelnyxCentsPerMinute = 0.9` in src/lib/plans/enterprise-pricing.ts is a FLAT all-in figure back-calibrated from the Jun/Jul 2026 invoices, whose mix was overwhelmingly Phoenix metro. It carries no zone term. A single Zone 5 outbound minute costs 7 cents of termination alone, ~8x that whole assumption and more than double the 3.15c/min all-in (Telnyx 0.9 + Gemini 2.25). Margin looks fine until a tenant works a rural farm list.
- `60/60` billing means a 12-second call that hit voicemail still bills a full minute at the zone rate, on both legs. See [[telnyx-no-call-duration]] and [[amd-false-negatives-and-prompt-ended]].
- Telnyx emails only the NEW deck, never a diff, so "what changed" is unanswerable unless a prior deck was kept. Snapshot each deck if this is ever to be tracked.
- Deck-wide: 260,916 rows bill 60/60, only 1,158 bill 1/1. 3,994 rows carry a `Price Per Call` (none of them NANP). Ceiling rates are satellite `$15.00` (`882`, `87077` BGAN) and FI short codes `$13.92`.

See [[telnyx-billing-model-traps]] for how voice actually lands on the invoice (adjunct lines never appear in `/v2/detail_records`).

## Measured exposure, 2026-08-28

Zone-matched every outbound leg we have ever placed against the deck (longest-prefix match on `1`+NPA+NXX), plus every dialable contact.

- HISTORY IS CLEAN. 104 legs (90 `voice_call_transcripts` outbound where `caller_e164` holds the DESTINATION, plus 14 `forwarded_to_e164` transfer legs), 142 billed minutes, **100% US Zone 1**. Zero high-cost minutes. All 90 AI outbound calls belong to Amy Laidlaw Real Estate; no other tenant has placed one.
- Corroborated by actuals: `telnyx_cost_daily` `record_type='sip-trunking'` over the same Jun 29 - Aug 27 window is 12,600 outbound billed seconds (210 min) at $1.12, i.e. **$0.005333/min** against a $0.005 Zone 1 rate, `carrier_fee_micros` = 0. The $0.07 excess over a pure-Zone-1 $1.05 is about 14 Zone 4 minutes or one Zone 5 minute. My transcript sample covers 142 of those 210 minutes (~68%), so a little non-Zone-1 traffic sits in the unsampled remainder.
- FORWARD RISK IS SMALL BUT REAL. Of 573 dialable contacts: 78.0% US Zone 1, 10.6% CA Zone 1, 7.5% CA Zone 2 (`$0.009`), 1.4% US Zone 4, 1.0% CA Zone 3, 0.7% US Zone 5, 0.2% CA Zone 5. 11.2% sit above baseline but most of that is cheap Canada Zone 2. Blended forward termination rate **$0.00619/min, 1.24x baseline**.
- The tail is 5 contacts at >= `$0.07`/min: four Amy US Zone 5, one KYP Ads CA Zone 5 (`$0.121`, where a 5-minute call is $0.60 of termination alone).
- SCALE CHECK: one 3-minute call to all 573 contacts costs $10.64 at zone rates vs $8.59 flat, a $2.05 delta. At today's volume the flat `voiceTelnyxCentsPerMinute = 0.9` is FINE. It only breaks if a tenant works a rural list, where a Zone 5 minute is 10.0c all-in vs the 3.15c model (3.2x) and Zone 6 is 21.1c (6.7x).
- Caveats: `voice_settlements.telnyx_reported_duration_seconds` is 0 on 63 of 173 rows (see [[telnyx-no-call-duration]]), so those fell back to `billable_seconds`; contacts are a proxy for the callable universe, not a call plan.

## Shipped, PR #1713, merged ab23efd6 (2026-08-28)

- `scripts/generate-voice-zone-rates.ts` turns a deck CSV into `src/lib/plans/voice-zone-rates.generated.ts` (22,233 NANP prefixes, 13 zones). THE GENERATED FILE IS THE DIFFABLE BASELINE. Refresh with `npx tsx scripts/generate-voice-zone-rates.ts <deck>.csv` and read the git diff; that is the only per-prefix answer to "what changed", because Telnyx emails only the new deck.
- THREE PARSER TRAPS the deck sets, all of which drop rows SILENTLY:
  1. `"1"` is the NANP CATCH-ALL at Zone 1. Drop it and every unlisted US number resolves to "unknown" instead of $0.005.
  2. `"1XXX310"` rows are WILDCARDS (X = any digit), how Canada prices N11 service codes at 75c/min. A `/^1\d+$/` filter kills all six.
  3. Wrapping the prefix blob across lines and joining with `+` fuses the last prefix of one line to the first of the next unless each chunk carries a TRAILING SPACE. The generator now round-trips its own output and throws on a count mismatch.
- SURCHARGE, NOT REPLACEMENT. `estimateEnterpriseMonthlyCost` takes optional `voiceDestinations` and charges only `blend - 0.5c`. `voiceTelnyxCentsPerMinute` (0.9) was calibrated on traffic measured as 100% Zone 1, so it ALREADY contains a Zone 1 termination rate; charging the full zone rate bills it twice. With no list the estimate is byte-for-byte unchanged.
- `margin.ts` line ~253 has a SECOND rate-estimate fallback that stays Zone 1 by assumption on purpose (the synced-actuals path supersedes it whenever real spend exists). Do not "fix" it without threading per-tenant contact lists into the single fleet cost model.
- `debug/measure-voice-zone-exposure.ts` reproduces the whole analysis (`--json`, `--since=YYYY-MM-DD`). Uses `pg` + `sessionDbUrl()` read-only, NOT PostgREST: PostgREST cannot embed `voice_settlements` in `voice_call_transcripts` (no declared FK, they share `call_control_id`).
- `.github/workflows/telnyx-voice-rate-cutover.yml` runs Mondays through 2026, measures effective c/min since the cutover day, and opens a PR moving the constant when drift exceeds 0.05c/min on 60+ billed minutes. It runs AFTER the cutover, never at it: at the effective instant no post-cutover call exists and the MDR sync has not run.
- THE WILDCARD TRAP IS THE ONE THAT BIT. Canada's `1XXX310` (also 211/311/411/511/711) compiled literally is "any three digits", so it won at length 7 against EVERY NANP number with one of those exchanges, US included: `+1 602 310 0000` in Phoenix priced at 75c/min instead of 0.5c, 150x too expensive. The wildcard means "any CANADIAN area code". The generator now EXPANDS wildcards at generation time against the area codes the deck gives that ISO, which is exact because US and CA area codes are disjoint (343 vs 53, zero overlap); 6 rows become 318 concrete prefixes and the runtime does exact lookup only. Bugbot found this, not the tests: my own test used a 555 exchange and missed it.
- A FREE-TEXT NUMBER LIST MUST NOT BE SPLIT ON `[^\d+]`. That shreds `(602) 838-4497` into three fragments, none of which parse, so the blend prices nothing, falls back to baseline, and a pasted rural list is quoted as lower-48 traffic SILENTLY. `parseDestinationList` splits only on separators BETWEEN entries (newline, comma, semicolon, tab), retries a space-separated entry only when every piece is independently valid, and passes an unparseable entry through so it lands in the `unpriced` count.
- A RECALIBRATING ROUTINE NEEDS A MOVING COMPARISON POINT. Measuring drift against a PINNED baseline and adding it to the current constant re-applies the same delta every run after the first PR merges, compounding forever. `.github/telnyx-rate-calibration.json` holds the point and the drift script REWRITES it in the same commit as the constant. Test idempotence by running the decision twice on one measurement; the second must report ~0 drift.
- CI PATTERN WORTH REUSING: the workflow needs no new secret. It builds the IPv4 session-pooler URL from the existing `SUPABASE_DB_PASSWORD` plus `project_id` in `supabase/config.toml`. And it pushes the branch with `MIGRATION_HEAL_SSH_KEY`, not `GITHUB_TOKEN`, because a branch pushed by the Actions token cannot trigger the `pull_request` workflows in ci.yml.
