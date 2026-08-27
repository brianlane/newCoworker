---
name: clever-status-list-is-forward-only
description: Clever's Provide Update status list is a forward-only progression from the card's current stage, so "We Spoke" is absent on cards already at Spoke; the weekly sweep must post "No Status Change"
metadata:
  type: project
---

Clever's "Provide Update" modal asks "What is the new status?" and the options
it offers depend on the CARD'S CURRENT STAGE. Read live 2026-08-18 in a
signed-in browser, two cards side by side:

| card at "Tried Reaching Out" | card at "Spoke" |
| --- | --- |
| No Status Change | No Status Change |
| **We Spoke** | *(absent)* |
| We Scheduled A Meeting | We Scheduled A Meeting |
| We Met In-Person | We Met In-Person |
| We Signed a Listing Agreement | We Signed a Listing Agreement |
| We Listed the Home For Sale | We Listed the Home For Sale |
| We're Under Contract | We're Under Contract |
| We Closed | We Closed |
| Released: No Longer Pursuing | Released: No Longer Pursuing |

**Why:** the WEEKLY sweep runs over every active deal and most of Amy's 87-card
book is past "Spoke", so a sweep clicking "We Spoke" fails its second action on
the majority of cards. `performForEach` counts a per-item action failure as
`failed` and moves on, so it looks like it ran and updates almost nothing.

**How to apply:**
- The weekly sweep posts **"No Status Change"** (fixed PR #1496): first option at
  every stage, and the truthful one for a compliance ping.
- Choosing "No Status Change" does NOT reveal the
  `select[id="Did you schedule a time to meet in person?"]` control, which only
  the "We Spoke" path shows. That `select_option` action must be REMOVED, not
  retargeted. 8 actions become 7.
- The DAILY (Chris) flow keeps "We Spoke": it fires on arrival day when the card
  is at "New"/"Tried Reaching Out" and the option IS offered.
- An updated card DOES leave "Needs Action" and moves to "Recently Updated"
  ("Items in this list do not need to be updated"), so chained passes work.
  See [[foreach-cap-is-cloudflare-bound]].
- Magic links in Clever's texts are SINGLE-USE and our own daily flow consumes
  them within seconds of arrival, so they can never be reused for debugging.
- Per-lead URLs: `/portal/<portalId>/connection/<connectionId>/`.
