---
name: project_business_delete_looks_disposable_traps
description: "HQ has an ACTIVE sub with NULL Stripe ids; sandboxes have no box and no Stripe at all, so \"no Stripe linkage\" deletes HQ"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23ec9b7d-ea4b-4eea-b719-af2b67e5c68b
  modified: 2026-08-23T17:17:36.193Z
---

Before writing any rule that deletes or bulk-edits `businesses` rows, know
which live rows look disposable and are not (verified 2026-08-22):

- **HQ** (`8f3a5c21-...`, New Coworker) has a subscription with
  `status = 'active'` but `stripe_customer_id` AND `stripe_subscription_id`
  both **null**, because it is billed outside Stripe. Any "no Stripe linkage"
  predicate deletes HQ.
- The **five internal sandboxes** (Zoom/Meta/Google/Slack reviewers + Cedar
  Street Dental demo, `e2b7a1c4-0000-4000-8000-00000000000{1..5}`) have **no
  VPS and no Stripe linkage at all**, and are `online`. "Has no box" is not
  evidence a row is disposable.

The only safe discriminator for a never-paid signup is the self-referential
sentinel `pending+<the row's own id>@onboarding.local`. It is one-way: written
only by the INSERT in `/api/business/create`, and
`updateBusinessOwnerEmailIfPending` only swaps it FOR a real address (gated on
`.eq("owner_email", <sentinel>)`). Nothing writes it back.

Cascade shape (145 FKs referencing `businesses`): **138 CASCADE**, **7 SET
NULL**, and **9 tables carry `business_id` with no FK at all** so they orphan.
The 7 SET NULL parents are all cost/audit tables (`hostinger_vps_costs`,
`stripe_fee_monthly`, `telnyx_cost_daily`, `applied_oneshots`, `blog_settings`,
`voice_capacity_alerts`, `vps_inventory`), which is the schema deliberately
preserving money records through a delete. Of the FK-less nine,
`onboarding_drafts` (owner name/email/phone) and `gemini_spend_daily` are the
ones that actually hold rows for a pending signup.

Watch out: `white_glove_intakes` and `white_glove_offers` are **CASCADE**, so
deleting a business destroys attached white-glove work. A prospect intake is
keyed by `recipient_email` with `business_id` null until payment, so it
survives, but only by timing.

See [[project_pr_merge_main_deploy_mechanics]] and
[[project_residency_read_rules]].
