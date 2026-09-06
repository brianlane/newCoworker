---
name: project-mcp-outreach-drafts
description: "MCP outreach queue tools write into the Marketing review queue through upsertProspectDraft; paragraphs only, footer assembled in code, upsert re-pitches only pre-send rows, findings empty, auto mode sends"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-06T04:00:00.000Z
---

Connector clients (Claude, ChatGPT, Grok on `/api/mcp`) land outbound
pitches in Dashboard → Marketing → Drafts to review with
`list_outreach_queue` / `upsert_outreach_prospect` / `update_outreach_draft`
(`src/lib/mcp/tools/outreach-drafts.ts`). Names were aligned with the
Outbound Prospecting team's vocabulary on 2026-09-05 (Brian's ask); the
`marketing_*` names never shipped. They replaced Gmail drafts because the
Gmail API rewrites every https link into a `google.com/url?q=` tracking
wrapper and the compliance footer would have to ride in model output.

What to know before touching it:

- **The caller supplies PARAGRAPHS only.** `upsertProspectDraft` and
  `editProspectDraft` (`src/lib/outreach/sweep.ts`) run `assembleBody`, so
  the CTA, signature, unsubscribe link, and postal address are appended in
  code. Never add a tool arg for the footer.
- **The CTA is the one appended line a caller may decide about.** Since Sep
  2026 the first email closes on "Just reply if you want to hear more." by
  default (`outreach_settings.booking_link_on_first_touch = false`, panel
  checkbox "Put the booking link in the first email"); the day-5 nudge always
  carries the link. `include_booking_link` on `upsert_outreach_prospect` and
  `update_outreach_draft` overrides per draft and is STORED on the row
  (`outreach_prospects.include_booking_link`, null = tenant default), so Save
  draft, Write it again, and a re-pitch that says nothing keep it.
  `list_outreach_queue` reports the tenant default and each row's override.
  `pitch_body` is assembled at draft time and sent verbatim, so flipping the
  setting does NOT touch waiting drafts: `reassemble-outreach-drafts.ts
  --business <uuid>` rebuilds them (HQ had 21 in auto mode at the change).
- **Upsert means re-pitch, never re-send.** A new domain inserts. A row the
  domain or email already belongs to is re-pitched in place ONLY while it is
  `discovered` or `drafted` (`REPITCHABLE_STATUSES`); sent, replied, booked,
  unsubscribed, skipped, and failed are refused as `duplicate` with the
  status named. A domain and an email pointing at two different rows is also
  refused, since "re-pitch" has no single answer there.
- **One write, straight to `drafted`.** `insertDraftedProspect`
  (`src/lib/outreach/db.ts`) never passes through `discovered`, because the
  sweep's probe phase would fetch the prospect's site and either retire the
  row ("no published contact address") or overwrite the pitch. The id is
  minted with `randomUUID()` before the write so the unsubscribe link can
  name it. The re-pitch path uses `transitionProspect` guarded on the status
  just read.
- **`findings` is `[]`** on insert and untouched on re-pitch. No probe ran, so
  "Write it again" (regenerate) refuses these drafts with "nothing specific
  enough left to say". That is honest, not a bug: the compose path may only
  claim what a finding recorded.
- **Domain is the suppression key.** `draftDomainFor` derives it from the
  email host unless `domain` is passed, and refuses shared mail hosts
  (`SHARED_MAIL_HOSTS`): filing `gmail.com` would block every later
  Gmail-hosted prospect of the tenant.
- **`upsert_outreach_prospect` is `mutateExternal`.** Destructive because it
  replaces an existing pre-send draft; open-world because in `auto` mode the
  sweep sends any drafted row inside the cap and window with no human press.
  The tools report `mode` for that reason. Send itself stays on the
  dashboard (no send tool).
- **Role bar is `manage_settings`**, the dashboard outreach routes' bar.
- **Not bridged** into dashboard chat (`MCP_BRIDGE_EXCLUDED`): no Settings
  gate group covers cold outreach. Bridging needs a new toggle plus i18n.

Adding an MCP tool touches five guarded places: `registry.ts`,
`tests/mcp-registry.test.ts` (exhaustive names), `MCP_BRIDGE_EXCLUDED` or
`MCP_BRIDGE_TOOL_GATES`, `docs/CHATGPT-SUBMISSION-TESTS.md` (three
justification lines per tool), and the README tool inventory. A tool whose
call can reach a stranger's inbox also belongs in the pinned OPEN_WORLD list
in `tests/mcp-tool-metadata-guard.test.ts`.
