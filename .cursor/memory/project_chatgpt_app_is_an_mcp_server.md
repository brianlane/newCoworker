---
name: project-chatgpt-app-is-an-mcp-server
description: "A ChatGPT app IS a remote MCP server at /api/mcp/chatgpt; rejected Aug 19 for missing reviewer sandbox, resubmitted same night; reviewer test texts land on Brian's phone AS DESIGNED"
metadata: 
  node_type: memory
  type: project
  originSessionId: 829c625c-bcb6-4c1a-8235-98fab892df47
  modified: 2026-08-20T03:42:47.360Z
---

Shipped Aug 11 2026. OpenAI retired `ai-plugin.json`; a ChatGPT app today **is**
a remote MCP server plus listing metadata, so the Claude connector was most of
the product already. Ours is live at `/api/mcp/chatgpt`, verified end to end in
production (discovery, DCR, consent, token exchange, tool calls returning real
data).

**Why: adding it needs a PAID ChatGPT plan.** The connector UI does not work on
Free, which cost a round trip to discover.

**Submitted Aug 14 2026 and REJECTED Aug 19**: "unable to complete your
sign-in or OAuth flow. Please ensure valid, working credentials are included."
The OAuth code was fine (verified end to end against production). There was no
sandbox tenant at all, so the Testing step's credentials field was empty.
`debug/openai-reviewer-setup.ts` (#1533) now builds it. **Build the sandbox
BEFORE filling the form**, and note the reviewer-sandbox scripts for zoom and
slack mint passwords with base64url, which Supabase's four-character-class rule
rejects at random on a rerun. The Cloudflare path-based skip rule was applied
that day (rule 1 edited in place, since the free plan caps custom rules at 5
and 4 were used).

**The Submit step of the form does not save.** Every other step persists on
Continue or a section switch; Submit keeps the release notes in browser state
only, so a reload returns an empty field. Paste them in the same sitting you
submit. Its release notes are PUBLIC copy ("may be publicly displayed on the
plugin details page"), not reviewer notes. Both are written up in
`docs/CHATGPT-SUBMISSION-TESTS.md`.

**That doc is a FIFTH lockstep contract on `allMcpTools`, and it is the one
that gets missed.** `tests/chatgpt-submission-doc.test.ts` asserts a
bidirectional exact cover: every registered tool needs its own
`### \`tool_name\`` section, each stating all three annotation values
(`**Read Only: True**` and so on, matching what the registry actually
advertises) plus a written justification per value. It fails on a tool that is
re-annotated AND on a tool that is merely added, so **adding one MCP tool means
three new doc bullets, not zero**. The four contracts a search usually turns up
are `tests/mcp-registry.test.ts` (exhaustive literal name list),
`tests/mcp-tool-metadata-guard.test.ts` (a count canary, currently 41, plus
forced annotations by name prefix), `tests/dashboard-chat-mcp-bridge.test.ts`
(bridged + excluded must be an exact disjoint cover), and the tool file itself.
The doc is the fifth. Budget for it up front: on PR #1616 it surfaced only as
four red tests after everything else was green.

What OpenAI demands that Claude never did: per-tool `title`, three annotations
(`readOnlyHint`/`destructiveHint`/`openWorldHint`, the most-cited rejection
cause), `outputSchema` + `structuredContent`, and `search`/`fetch` (required
only OUTSIDE Developer Mode, so passing in dev mode proves nothing).

**Resubmitted Aug 19 2026 ~7:57 PM Phoenix** (two "Submission Received" emails,
ids C-E4PeoyzDiJco and C-GBJzIN1VRFXD). Sandbox: "Cedar Street Dental (demo)",
business `e2b7a1c4-0000-4000-8000-000000000005`, owner login
openai.reviewer@newcoworker.com. Per #1535 its sends come FROM +16023131823
(the New Coworker HQ DID) and the contact "Maria Alvarez" is seeded to Brian's
real phone +16026866672 (his choice, `--sms-target`), so a reviewer running
test case 5 texts Brian. **A text like "We can fit you in Thursday at 2:00 PM
Arizona time." arriving on Brian's phone from +16023131823 is the OpenAI
reviewer executing the submitted test plan, not a bug** (verified Aug 19: the
send logged with source `mcp_chatgpt`, `mcp_connector_status.last_seen_at`
matched it under the reviewer login, and a fresh reviewer sign-in followed).
Sandbox texts and real HQ owner alerts share that from-number, so they
interleave in one phone thread; a reply in that thread goes to HQ's inbound,
never to the sandbox.

See [[project-mcp-annotate-what-a-call-sets-in-motion]] and
[[project-supabase-oauth-server-capabilities]].
