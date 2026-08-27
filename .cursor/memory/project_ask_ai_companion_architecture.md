---
name: ask-ai-companion-architecture
description: The Aug 14 2026 Ask AI companion + MCP-to-Gemini bridge - where every seam lives and the rules that keep it safe
metadata: 
  node_type: memory
  type: project
  originSessionId: c74508ec-72f3-4a48-8023-e2517a7c2c97
  modified: 2026-08-15T17:29:46.760Z
---

Shipped Aug 14-15 2026 across PRs #1375, #1379, #1380, #1381, #1382, #1383, #1384, #1386, #1389 (plan: ~/.claude/plans/i-like-the-hostinger-snuggly-pie.md). The goal: owners make one-shot-class edits themselves with just their Gemini coworker.

- **Bridge**: `src/lib/dashboard-chat/mcp-bridge.ts` adapts the MCP catalog into `runInlineChatTurn`'s `extraTools` seam. Partition is a unit-pinned exact disjoint cover of `allMcpTools` (new MCP tool = CI failure until a bridge decision). One tool per capability per surface: update_flow/create_flow/list_flows/run_flow/employee CRUD/etc. are EXCLUDED because inline edit_aiflow/create_aiflow/list_aiflows/run_aiflow/manage_employee own those verbs.
- **Safety rules**: executor pins `business_id` on every call and refuses cross-business fetch ids; args are safeParsed through the tool's own zod schema (the SDK did this on the connector path; handlers do NOT re-parse); declarations are pruned by the caller's role via `MCP_BRIDGE_TOOL_ACTIONS` (mirrors each handler's requireMcpBusinessRole bar); all nine bridged writes pin the turn via the side-effect log. `requireMcpBusinessRole` stamps mcp_connector_status ONLY when `auth.client` is set (bridge omits it, or dashboard turns would light the Claude badge).
- **Surfaces**: dashboard chat route derives EVERYTHING from `getBusinessRoleForEmail` on the caller email, no isAdmin shortcut (PR #1386): an admin in SELF-OWNED view-as resolves owner and gets the full bridge; a foreign-tenant impersonation resolves no role so nothing role-gated declares. The companion UI has NO view-as gate at all (PR #1395, Brian twice asked for less gating): the panel renders the full chat body under any impersonation because /dashboard/chat already does, and the API is the sole authority (admins skip requireBusinessRole; bridge declarations come from the email-role lookup). Owner-SMS operator and Slack owner-verified turns pass role "owner". All pass `maxToolSteps: 6` and append `mcpBridgeToolsPreamble({creationToolsDeclared})` (false on SMS/Slack: no builder card there).
- **Gates**: 7 grouped registry toolKeys on dashboard+slack surfaces (read_business_data, manage_contacts, manage_flows, manage_agents, update_business_profile, update_business_knowledge, manage_coworker_tools), read batched via `getAgentToolStates`. Parity test lists them as inline-only `null` exemptions.
- **Four new MCP tools** (Claude/ChatGPT have them too): update_business_profile (hours+timezone only, NEVER phones), get/update_business_knowledge (owner-only identity_md section splices through the identity editor's exact pipeline; whole-doc rewrites structurally impossible), update_coworker_tool_settings (per-surface agent_tool_settings writes). New tools must also be documented in docs/CHATGPT-SUBMISSION-TESTS.md (a test walks it).
- **Companion UI**: `CompanionLauncher`/`CompanionPanel` under `src/components/dashboard/companion/`, mounted in the dashboard layout, same conversation/thread as /dashboard/chat via the extracted `useDashboardChatTransport` hook; i18n under `dashboard.companion.*`.
- **Session sequence (PR #1389)**: first send of a browser session always opens a NEW thread (sessionStorage `ncw_chat_engaged_${businessId}` per business; send posts `newThread: true`, route deactivates the active thread first). No native confirm()s anywhere: new-conversation is a plain action, delete is two-tap ("Delete?" arms for 4s). Business-switch teardown in the hook aborts watchers, resets all state + loading flags, and every async closure (send/selectThread/deleteThread/startNewConversation/fetchThreads) carries a `businessIdRef` staleness guard so a late response can never paint another tenant's data. Six Bugbot waves hardened exactly these races; touch the hook only with that file's tests open.

Related: [[live-flow-source-of-truth]], [[agent-tool-toggles-are-per-channel]].
