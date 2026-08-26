---
name: project_reachability_gated_vars_are_not_lead_type
description: "Amy's route_lead_type / sms_lead_type / email_intro_type answer 'none' based on CONTACT CHANNEL, so they are useless as a lead-type tag in any no-phone path"
metadata: 
  node_type: memory
  type: project
  originSessionId: f9767aac-0779-42db-bf9c-8499ab2519f5
  modified: 2026-08-16T00:16:45.986Z
---

Found on PR #1398 (Bugbot caught it, verified against the live field
descriptions on 2026-08-15).

Amy's ReferralExchange `browse` step extracts FOUR type-ish vars, and only one
of them is actually the lead's type:

- `lead_type` - buyer / seller / both. The plain question. Safe.
- `route_lead_type` - the type ONLY IF the page shows a text or call option;
  answers **"none"** when the lead is email-only.
- `sms_lead_type` - the type ONLY IF there is a TEXT option; else "none".
- `email_intro_type` - the type ONLY IF there is no text but there is email.

The three qualified ones are REACHABILITY gates wearing a lead-type name. The
bug: a no-phone guard tagged its team alert on `route_lead_type`, which is
"none" exactly and only when that guard fires. The tag would have matched
nobody on every run, and the fail-safe would have widened every alert to the
whole roster, so the seller/buyer narrowing was dead on arrival while looking
like it worked.

**How to apply:** before using any `*_type` var on this account, read its
FIELD DESCRIPTION, not its name. If the description contains "answer exactly:
none", it is conditional on something and cannot be used in a path that runs
precisely when that condition fails. Realtor.com and New Lead Intake declare
`lead_type` unconditionally, so they were fine.

`tests/amy-unreachable-lead-team-alert.test.ts` now asserts no plan tags on
any of the three gated vars. Related: [[project_aiflow_phone_field_trap]]
(a phone-NAMED field gets validated and blanked), [[project_roster_member_tags]],
[[feedback_a_failing_old_test_is_evidence]].
