---
name: project_fleet_fallback_composition_audit
description: "Aug 27 2026 fleet-wide audit of the fallback-composition bug class; every finding fixed same day (PR #1673 cadence, PR #1680 KYP/Clever/HomeLight)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 83b038a6-335d-4a45-bf3b-3ff17b069e83
  modified: 2026-08-27T21:19:12.805Z
---

**Fleet audit, Aug 27 2026** (right after PR #1673 fixed Amy's cadence): rendered every template of all 40 enabled ai_flows (6 businesses; Truly Insurance and Scar Fairy had zero enabled flows) against each flow's instructed extraction fallbacks. Both fallback conventions parsed: "answer exactly: X" tails AND the quoted forms ("'none' if nothing", "or 'none'", "return exactly 'none'"), which are the fleet's dominant convention. Each hit was reachability-checked via its full `when`/branch-condition ancestry and against practice (recent ai_flow_runs context.vars), plus full-history server-side greps of sms_outbound_log and email_log and a 124-session voice_handoff_sessions scan back to Jun 29 2026.

Results:
- The ONLY garble that ever reached a lead or the team by voice/SMS was the fixed cadence one: 16 calls Aug 12-26 and 8 SMS (team FOLLOW-UP REPLY and lead voicemail-mention texts). ZERO occurrences after the Aug 27 apply.
- FIRED, team-facing only: Amy's HomeLight Referral emails to amy@amylaidlaw.com composed junk 6 times Jul 31-Aug 14 (subject "{{vars.lead_name}} QT HL CC DAVE" rendered "none QT HL CC DAVE"; bodies "Lead: Amy C. () none"). Root cause is HomeLight portal extraction missing (lead_phone at "none" on 19 of 25 recent runs), see [[project_homelight_portal_traps]]. FIXED Aug 27 by patch-homelight-team-copy-labels.ts (fact labels; the QT subject deliberately untouched, its tokens are Amy's filing convention).
- LATENT, never fired, all FIXED Aug 27 (PR #1680, applied 21:17Z, ledgered): KYP Ads Booking confirmation + Pre-call reminder could tell the LEAD "call on none at none your time" (now guarded specific/generic pairs behind booking_details_known / reminder_details_known via patch-kyp-booking-missing-details.ts; the booking SMS nests in a confirm_sms_gate branch because a step carries one `when`); Clever Lead - Accept buyer whisper "at about none" (now "Budget: {{vars.price}}" via patch-clever-accept-whisper-budget.ts); HomeLight "none none none" claim SMS (same labels patch).
- CLEARED as unreachable: every "email at none" / "delivery-failure notice for none" hit sits behind a `lead_email contains "@"` branch condition.
- CLEARED as engine-provided (never flow-produced, so not silence holes): claimed_agent, claimed_agent_phone, claimed_agent_eta_minutes, actions_taken, `${saveAs}_label` and `${saveAs}_reason` from place_ai_call (call_outcome_meta.ts:74), approval_note, group_lead_phone, foreach `<id>_left`/`<id>_updated`, and wait_for_call capturePrefix vars like call_phone/call_email.
- Pattern done right: New Coworker's prospect_name falls back to 'there', composing "Hi there".

**Why:** Fix decisions need the fired-vs-latent split and the cleared-classes list; re-deriving them means re-running the whole sweep.

**How to apply:** Every finding is fixed as of Aug 27 2026; nothing on this list is open. When the class reappears, pick the fix by audience: spoken lead-facing surfaces get the two-var pattern in [[project_amy_policies]] or a guarded specific/generic pair behind a details-known gate field (a `when` guard can test one var only, so a pair needing two conditions nests in a branch); team-only surfaces get labelled facts ("Phone: none"). The render technique lives in tests/amy-needs-follow-up-definition.test.ts ("fallback composition" describe) and tests/oneshot-fallback-copy-patches.test.ts. Any new sweep must parse the quoted fallback forms, walk guard ancestry before claiming reachability, and grep sms_outbound_log/email_log history to separate fired from latent.
