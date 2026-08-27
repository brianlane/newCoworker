---
name: project_agent_tool_toggles_are_per_channel
description: "agent_tool_settings is keyed per agent_key, and a missing row means enabled, so a channel policy set on SMS does not reach voice"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1853fac1-3d39-4628-a901-cf148cebee2d
  modified: 2026-08-04T01:16:20.751Z
---

`agent_tool_settings` is keyed `(business_id, agent_key, tool_key)`. A
**missing row means "registry default"**, not "off", and for the calendar
tools that default is enabled (`src/lib/agent-tools/registry.ts`). Agent keys:
`dashboard | voice | sms | webchat | email`.

So disabling a tool for one channel leaves every other channel untouched, and
nothing in the product surfaces the divergence.

Live example (Aug 3 2026): `patch-amy-sms-handoff-and-emoji.ts` disabled the
five calendar tools for `agent_key = 'sms'` on Jul 29, deciding Amy's account
nurtures and hands off rather than books. Voice never got those rows, so the
phone coworker went on booking for five more days, correctly following the
`memory_md` rule ("Use the team calendar to schedule consultations/showings by
default") while `soul_md` told SMS the opposite. Closed by
`disable-amy-voice-booking.ts`.

**How to apply:** when setting a channel policy, check every channel, not just
the one that prompted the change. Prefer tool toggles over prompt text as the
enforcement (the bridge withholds the declaration, so the model cannot call it
at all), and reconcile any prose that contradicts the toggle. See
[[feedback_live_flow_source_of_truth]] for the sibling rule about reading live
state before assuming.
