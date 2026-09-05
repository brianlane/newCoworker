---
name: project-mcp-marketing-drafts
description: "MCP marketing draft tools write into the Marketing review queue through createProspectDraft; paragraphs only, footer assembled in code, findings empty, auto mode sends"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-05T05:20:00.000Z
---

Connector clients (Claude, ChatGPT, Grok on `/api/mcp`) land outbound
pitches in Dashboard → Marketing → Drafts to review with
`list_marketing_drafts` / `create_marketing_draft` / `update_marketing_draft`
(`src/lib/mcp/tools/marketing-drafts.ts`). They replaced Gmail drafts because
the Gmail API rewrites every https link into a `google.com/url?q=` tracking
wrapper and the compliance footer would have to ride in model output.

What to know before touching it:

- **The caller supplies PARAGRAPHS only.** `createProspectDraft` and
  `editProspectDraft` (`src/lib/outreach/sweep.ts`) run `assembleBody`, so
  the CTA, signature, unsubscribe link, and postal address are appended in
  code. Never add a tool arg for the footer.
- **One write, straight to `drafted`.** `insertDraftedProspect`
  (`src/lib/outreach/db.ts`) never passes through `discovered`, because the
  sweep's probe phase would fetch the prospect's site and either retire the
  row ("no published contact address") or overwrite the pitch. The id is
  minted with `randomUUID()` before the write so the unsubscribe link can
  name it.
- **`findings` is `[]`.** No probe ran, so "Write it again" (regenerate)
  refuses these drafts with "nothing specific enough left to say". That is
  honest, not a bug: the compose path may only claim what a finding recorded.
- **Domain is the suppression key.** `draftDomainFor` derives it from the
  email host unless `domain` is passed, and refuses shared mail hosts
  (`SHARED_MAIL_HOSTS`): filing `gmail.com` would block every later
  Gmail-hosted prospect of the tenant as a duplicate. A unique violation on
  either axis comes back as `duplicate`, and that is the ledger doing its job.
- **`create_marketing_draft` is `writeExternal`.** In `auto` mode the sweep
  sends any drafted row inside the cap and window with no human press, so the
  call puts a cold email in motion; the tools report `mode` for that reason.
  Send itself stays on the dashboard (no `send_marketing_draft`).
- **Role bar is `manage_settings`**, the dashboard outreach routes' bar.
- **Not bridged** into dashboard chat (`MCP_BRIDGE_EXCLUDED`): no Settings
  gate group covers cold outreach. Bridging needs a new toggle plus i18n.

Adding an MCP tool touches five guarded places: `registry.ts`,
`tests/mcp-registry.test.ts` (exhaustive names), `MCP_BRIDGE_EXCLUDED` or
`MCP_BRIDGE_TOOL_GATES`, `docs/CHATGPT-SUBMISSION-TESTS.md` (three
justification lines per tool), and the README tool inventory.
