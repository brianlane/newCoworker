---
name: vfm-second-brand-kyp
description: "VFM runs inside the KYP tenant; applied state, email-only mode, and the two pending items (Liz's phone, vault sync fix)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d09c6ca-d098-49e0-a3fa-4c7cce4b8861
  modified: 2026-08-19T16:42:55.702Z
---

James Lee's second business, Vantage Flow Media (VFM), runs INSIDE the KYP
Ads tenant (056034a7) by his explicit decision: same login, same DID, same
box, no new business record, standard features only. Shipped via PR #1263
(2026-08-10); design and constraints in docs/tenants/kyp-ads.md ("Second
brand" section).

Applied to live (2026-08-10, ledgered):
- `businesses.lead_auto_assign = true` (route_to_team pin = hard assignment)
- VFM lead flow `e7efd4d6`, enabled, **email-only mode** (all teammate
  touches go to liz@lizdev.com via send_email), parser agent `7675c3f3`
- Vault brand edit: DB write landed, box sync initially FAILED (see below)

Also applied 2026-08-10: the vault brand edit is fully live (PR #1267 fixed
the sync; sections verified in /opt/rowboat/vault/identity.md and soul.md
on box 1869876), and a simulated test run (test_mode trigger, run
c162bde0) played all 21 steps correctly with zero CRM pollution.

Multi-Calendly-connection support shipped 2026-08-13 (PR #1349, deployed):
a business can link one Calendly connection per ACCOUNT, and booking
detection (precheck, goals, calendar triggers, booking context) unions
across all of them.

Liz's Calendly connected 2026-08-14 (row 835dcc6c, "Elizabeth Stone",
liz@lizdev.com, active, real-time invitee.created webhook minted within
30s). Her bookings are now native alongside James's. The flow is
processing real leads (live volume since Aug 12; runs park in the nudge
ladder as designed). Known limitation seen live: an Indian (+91) lead's
run failed Aug 12 pre-PR-#1334; intl leads still get zero automated
outreach, Liz is FYI'd by email only.

Pending, ONE item:
1. **Liz's mobile number** (never provided). When it arrives: re-run
   `apply-vfm-team.ts` with `--phone`, then `seed-vfm-lead-aiflow.ts
   --force --enable --assignee-name Liz` to switch the flow to roster mode
   (route_to_team hard-assign + SMS to Liz + reply pages to her). Until
   then, reply pages outside parked waits fall back to James, whose +852
   number cannot receive SMS at all (Telnyx non-NANP block), so the
   email-only flow steps are the only reliable channel.

Standing product rules (owner's words): the assistant presents as James's
Assistant, never asks which business a contact means; VFM price points
($100/$150/$200 per week per channel under test) must NEVER be quoted
anywhere, only the $30/day ad-spend floor is sayable; drive every lead to
[[kyp-ads]] Liz's Calendly (calendly.com/elizabethastone/30min). The flow
itself still learns the call time from the lead's replies (run_agent
parse), a design from before Liz's connection existed; her bookings ARE
platform-visible since 2026-08-14.

State found 2026-08-19 (James chat review; fixes in PR #1514):
- Flow e7efd4d6 regenerated 2026-08-18 by AI edit (actor james@kypads.com,
  one version row): now a 5-touch value ladder, waits +1d/+2d/+2d/+3d, then
  +1d to the "went quiet" flag. The applied cadence and copy differ from
  the drafts James approved in chat (edit_aiflow regenerates); the AI's
  post-apply summary was accurate.
- Liz email split INSIDE the flow: s_bad_phone_alert, s_fyi (new-lead
  notification), and s_outcome go to liz@lizdev.com; only s_final_flag goes
  to liz@vfmedia.io. On Aug 18 the AI told James the initial notification
  was updated to liz@vfmedia.io; it was not.
- Two DISABLED drafts named "Adapted automation" (7a6918af, 7ffc3fd0) are
  the "VFM Calendly booking follow-up" James asked for; 7ffc3fd0 (calendar
  trigger contains calendly.com/elizabethastone/30min, conf email+SMS,
  2h-before check, no-response alert to liz@vfmedia.io) supersedes the
  other. NOTHING VFM-branded runs on Liz's bookings until one is enabled.
- James's own roster number is +85260100607 (Hong Kong) since Jul 30 chat:
  team/lead-offer SMS to him cannot deliver; notification_preferences
  still holds +15145188192; whatsapp_connections is EMPTY. The dossier's
  "get WhatsApp connected" item is still open.
