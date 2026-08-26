---
name: owner-ask-reaches-the-flows
description: "Owner asks that need a flow change: memory never reaches AiFlows, the classifier that escalates the turn, and where each owner surface's tools actually sit"
metadata: 
  node_type: memory
  type: project
  originSessionId: f92ec33f-e800-4569-9e1b-d63077b2e8c1
  modified: 2026-08-24T22:14:04.171Z
---

Brian's framing, 2026-08-24: "aiflows/agents are battling with ai workers to
fulfill the user asks. They should be working together." The fix is never to
make the assistant promise less; it is to make the ask reach the machinery
that can satisfy it.

## The mechanism gap that causes it

**No AiFlow step reads `business_configs.memory_md`.** Verified by grep over
`src/lib/ai-flows/*` and `supabase/functions/ai-flow-worker/index.ts`: zero
readers. So a saved owner rule changes what the COWORKER says on
SMS/voice/chat/webchat, and changes NOTHING an automation sends. Memory
capture and `edit_aiflow` are two mechanisms with disjoint reach, and an ask
routed to the wrong one silently does nothing while sounding done.

Two injection paths for memory, neither reaching flows: ranked/question-scoped
via `lookupBusinessKnowledge` (`selectMemoryForQuestion`), and whole-blob via
`buildBusinessContextBlock` (dashboard chat, owner SMS, email coworker, Slack).

## Which owner surface has which tools

- **Owner SMS goes to the PLATFORM, not the box.** `telnyx-sms-inbound`
  classifies `staff_kind: "owner"`, `sms-inbound-worker` POSTs
  `/api/internal/owner-sms-turn`, which runs the same `runInlineChatTurn`
  engine as dashboard chat with `flowEditSurfaceKind: "text"`. Rowboat is only
  the fallback when that call fails. So an owner text DOES have
  `list_aiflows` / `edit_aiflow`.
- **The box `OwnerCoworker` does not.** Its seeded tools are
  customer_lookup/set_display_name/append_pinned_note plus
  `owner_append_business_memory` (and `dashboard_run_aiflow`). There is NO
  edit adapter under `/api/voice/tools/*`, and
  `tests/agent-tool-seed-parity.test.ts` records `edit_aiflow: null` as a
  by-design seed exemption. Memory-append is literally the only durable thing
  it can do, which is why it always answers that way.

## Why it answered shallowly even WITH the tools

`inline-turn.ts` pins `thinkingLevel: "low"` with `MAX_TOOL_STEPS` 4 (6 from
the dashboard). Its own comment says the heavyweight reasoning lives in the
compile pipeline (`FLOW_COMPILE_THINKING_LEVEL = "high"`), not in this loop.
Right for "text Dave that the showing moved", wrong for "change what all my
lead alerts say". There was no complexity classifier anywhere:
`resolveChatTurnRoute` branches on budget/capability only.

**Shipped PR #1602** (`src/lib/dashboard-chat/ask-classifier.ts`):
`classifyOwnerAsk` returns `automation_change | preference | action |
question`, and only `automation_change` escalates, only when `edit_aiflow` is
declared. That turn gets thinking `high`, +4 tool steps, and a directive that
states the MECHANISM ("automations do not read your memory") rather than just
the rule, because the model's wrong belief is what produced the promise. Every
failure resolves to `UNKNOWN_ASK` = the exact pre-classifier settings.

**How to prove a fix like this is real:** temporarily force the pre-fix
behavior and run the e2e. Against pre-fix, the live model reproduced the
production sentence verbatim ("You can review or adjust this anytime at
/dashboard/memory") and the test caught it. A green test that was never seen
red proves nothing here. See [[feedback_prove_prompt_fixes_against_deployed]].

## The fallback is counted and watched (PRs #1605, #1608)

An owner turn that cannot reach the platform engine falls through to the box
Rowboat persona, which has neither the operator tools nor the ask classifier.
The owner is served, quietly worse, and never told.

**Measured 2026-08-24: ZERO fallbacks in 30 days** (30 owner turns, all Amy's).
That measurement is why the box-side flow-edit path was NOT built. Getting it
took an hour, because only the SUCCESS side was telemetried: the difference
between owner-kind jobs and successes was six rows, and every one turned out
to be another tenant's draft approval answered by the WEBHOOK before the
worker picks an engine.

Both sides are counted now. `sms_owner_operator_fallback` carries a reason,
and the vocabulary is grouped three ways, which is the load-bearing part:

- `disabled` / `not_configured` = never ATTEMPTED (a config answer)
- `over_cap` = attempted and DELIBERATELY refused (the spend cap working;
  the route answers 200 with `detail: "over_cap"`, so it is invisible unless
  you read the body)
- `http_error` / `bad_payload` / `request_failed` / anything unknown =
  attempted and FAILED, the only group that pages

Read it with `npx tsx debug/owner-operator-fallback-report.ts --days 30`.
The daily cron sweep watchdog (03:30 UTC) pages at 2 failed in 24h, tuned
against that zero baseline rather than against noise. Vocabulary lives in
`src/lib/cron/owner-operator-fallback.ts`; the Deno writer cannot import it,
so `tests/owner-operator-fallback-lockstep.test.ts` reads the worker source
and pins both lists equal.

**A sustained attempted-and-failed rate is the trigger to revisit the box
path.** A config reason means fix the deployment instead.

## Flow-edit machinery that already exists (do not rebuild it)

`edit_aiflow` is a two-call handshake: stage into `ai_flow_pending_edits`
(15-min TTL, single-use token, `base_updated_at` optimistic check), then apply
the STORED bytes (never recompiled, since regeneration is non-deterministic).
Risk vocabulary `none|wording|behavioral|structural|in_flight` is also a CHECK
constraint. **Text surfaces refuse anything but `wording`** and point at the
dashboard. A non-empty `questions` list blocks staging entirely.
`FLOW_CHANGES_PER_TURN` is 1, counting only calls that COMMIT.

## Open, not built

- The box `OwnerCoworker` still cannot see a flow (its own PR: seed + parity +
  dispatcher + a `/api/voice/tools/*` adapter).
## The four owner surfaces, and their flow-tool bars (PR #1603)

All four callers of `runInlineChatTurn`, after #1603:

| Surface | list/run | edit/undo |
| --- | --- | --- |
| dashboard chat | chat access (staff) | `manage_aiflows` (manager) |
| owner SMS | chat access | toggle only, but the texter IS the verified owner |
| Slack | chat access | `isOwner` |
| email coworker | false | false |

`edit_aiflow`/`undo_aiflow_edit` on dashboard chat had NO role bar at all
until #1603, while every sibling owner-power tool on adjacent lines composed
`canManageSettings`. Chat access is `operate_messages` = STAFF, so a staff
teammate could rewrite live automations through a door where
`/api/aiflows/*` (every route) and every bridged MCP flow handler both
require `manage_aiflows`.

**`list_aiflows`/`run_aiflow` were deliberately LEFT at chat access.**
Running an enabled automation is operating, not reconfiguring: the line
Slack draws in words ("read and act, never reconfigure") and the same
reversibility logic that keeps `set_contact_reply_mode` open. Known
asymmetry, named in a comment rather than silently fixed: the MCP bridge
DOES prune `trigger_flow` and `get_flow` for staff
(`MCP_BRIDGE_TOOL_ACTIONS` puts every flow tool at `manage_aiflows`), so one
staff turn gets `run_aiflow` but not its bridged twin `trigger_flow`.
Narrowing them is a product call about what an operator may set in motion.

**Use `manage_aiflows`, not `manage_settings`,** for anything flow-shaped.
Both resolve to manager today, so it is a naming choice that only matters
when the matrix splits, and then it matters a lot.

Related: [[project_amy_policies]], [[project_ai_flow_edit_hardening]],
[[project_agent_tool_parity_four_way]], [[project_e2e_judge_question_polarity]].
