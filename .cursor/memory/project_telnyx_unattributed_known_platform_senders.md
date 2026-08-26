---
name: telnyx-unattributed-known-platform-senders
description: "The Costs page unattributed senders +16028384497 (retired intl gateway, 2 test SMS Aug 6 2026, $0.03, NOT a leak) and new_coworker_jut3q1af_agent (RCS agent id) are both platform-owned"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6ff95755-4360-4952-adbc-4d7fd02ccb56
  modified: 2026-08-19T16:28:28.055Z
---

The admin Costs page "Telnyx unattributed (leak check)" bucket has, so far, never
contained a real leak. Both known senders are platform-owned:

- `+16028384497`: the dedicated P2P international SMS gateway long code
  (TELNYX_INTL_GATEWAY_E164). Ordered Aug 6 2026 for the Hong Kong owner-phone
  effort, used for exactly 2 test SMS that same morning (05:25 UTC to the
  then-stale TELNYX_OWNER_PHONE +16029226392, $0.0040; 05:46 UTC to Brian's
  real cell +16026866672, $0.0281; total $0.0321 shown as $0.03 · 2 rec), then
  released the SAME day after Telnyx's verdict that US long codes are
  domestic-only (DELETE /v2/phone_numbers/3020175004303099415, account
  verified empty; env removed from .env, Supabase secrets, Vercel; PR #1205
  code dormant). Re-verified off the account Aug 19 2026.
- `new_coworker_jut3q1af_agent`: the RCS agent id. Not a phone number, so the
  digits-only DID matcher can never attribute it.

**Why:** the sender column (PR #1415) names unattributed spend precisely so a
recurring platform sender stops reading as a fresh leak, but the UI did not
label which senders are known-platform, so Brian read the gateway number as a
leaked number on Aug 19 2026. Fixed in PR #1512 (merged Aug 19): the
PLATFORM_SENDER_LABELS registry in src/lib/admin/costs-view.ts labels both
senders on the page, and unlabeled senders render an orange "worth chasing"
tag. A NEW platform sender must be added to that registry or it will read as
a leak.

**How to apply:** before chasing an "unattributed" sender, check it against
these two. Anything NEW here is worth a real chase (start from the raw
detail_records legs, cli/cld). See [[project_telnyx_number_level_sms_block]]
and [[project_telnyx_billing_model_traps]].
