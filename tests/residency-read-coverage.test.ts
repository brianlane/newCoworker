import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RESIDENCY_MOVED_TABLES,
  isResidencyPurgedTable
} from "@/lib/residency/tables";
import {
  SCAN_EXCLUDED,
  SCAN_ROOTS,
  scanResidencyReads,
  siteKey
} from "./helpers/residency-read-scan";

/**
 * Residency read coverage: every read of a moved table is a DECISION on
 * record, not an accident.
 *
 * Writes need no guard. The AFTER triggers in
 * 20260804000000_residency_write_journal.sql catch every writer by
 * construction, and that migration explains why it chose triggers over
 * call-site wrappers: "A wrapper approach can miss a writer forever."
 * Reads have no such backstop, which is how three separate sessions each
 * found, and separately fixed, the same class of bug.
 *
 * THE SPLIT THAT MAKES THIS TRACTABLE. residency_purge_business() deletes
 * from only 8 of the 15 moved tables and deliberately KEEPS the other 7,
 * "until the engine's own reads are residency-routed". So:
 *
 *   - Reading a PURGED table centrally is silently incomplete for a vps
 *     tenant. The rows are gone and an empty result reads as "nothing
 *     happened". This is real debt, and it ratchets down.
 *   - Reading a KEPT table centrally is correct, and fresher than the box:
 *     central is still the write ingress and the journal replays one way.
 *     This is NOT debt, and cataloguing it as debt would teach the next
 *     engineer the wrong model.
 *
 * That distinction is load-bearing. src/lib/ai-flows/db.ts:194 justified
 * routing `listAiFlowDefinitions` box-ward on the grounds that "a central
 * read returns nothing" for `ai_flows`. `ai_flows` is a KEPT table. The
 * routing bought no compliance and cost up to a replay tick of staleness
 * against the central createAiFlow/getAiFlow sitting beside it.
 *
 * TO FIX A FAILURE: route the read through @/lib/residency/read, or add an
 * entry with an honest reason. Do NOT add to PURGED_READ_DEBT, which is
 * frozen. "Routing it is annoying" is not a reason; that is what the debt
 * list already covers.
 */

const ROOT = join(__dirname, "..");
const scan = scanResidencyReads(ROOT);

type SiteKey = string;

/**
 * Reads of a PURGED table that stay central on purpose, permanently.
 *
 * The bar is structural impossibility or provable correctness, not
 * convenience.
 */
const PURGED_READ_CENTRAL_BY_DESIGN: Record<SiteKey, string> = {
  "src/lib/db/fleet-activity.ts::getFleetRecentActivity::email_log":
    "cross-tenant admin sweep: selects business_id as a COLUMN with no business_id filter, so there is no single tenant box to route to. Fanning out across the fleet would mean one tunnel round trip per residency tenant on an internal ops page",
  "src/lib/db/fleet-activity.ts::getFleetRecentActivity::sms_outbound_log":
    "cross-tenant admin sweep, same shape as the email_log leg above: no business_id filter, so no single box owns the answer",
  "src/lib/db/fleet-activity.ts::getFleetRecentActivity::voice_call_transcripts":
    "cross-tenant admin sweep, same shape as the email_log leg above: no business_id filter, so no single box owns the answer",
  "vps/voice-bridge/src/index.ts::createSupabaseTranscriptAdapter::voice_call_transcripts":
    "reads back, by id, the transcript row this bridge wrote CENTRALLY seconds earlier for the call in progress. Routing it box-ward would race the journal replayer and usually find nothing: central is the write ingress, so for a read-after-write on the same call central is the only copy guaranteed to have it. The purge only removes TERMINAL calls past the keep window, so this row is never a purge candidate",
  "vps/voice-bridge/src/index.ts::sendIntakeLeadSms::voice_call_transcripts":
    "same read-after-write on the call in flight, keyed by call_control_id, to attach the intake SMS to it",
  "vps/voice-bridge/src/index.ts::sendIntakeLeadSms::voice_call_transcript_turns":
    "the turns of that same in-flight transcript, written by this process moments before and not yet replayed",
  "src/lib/email/delivery.ts::applyEmailDeliveryStatus::email_log":
    "provider-webhook lookup with NO tenant in hand: a Resend receipt carries only its own message id, and the whole point of this read is to DISCOVER which business the mail belonged to, so there is no box to route to. Fanning out across every residency tenant per receipt would be one tunnel round trip each, on the hot path of every delivered email on the account. It is also a read-after-write on a row this system wrote centrally minutes earlier (the send logs it, the receipt lands in seconds), and the journal replays the UPDATE box-ward, so the box still ends up with the receipt. A receipt arriving after the purge keep-floor finds nothing and records nothing, which loses information but never states anything false",
  "src/lib/email/delivery.ts::applyEmailDeliveryStatusByRecipient::email_log":
    "the recipient+subject fallback for the same provider webhook, same shape as the entry above: the receipt names no tenant, discovering the tenant IS the read, so there is no box to route to. It runs only for unmatched FAILURES (a handful a day, not the per-message hot path) over a bounded 4-day window; for a residency tenant the central row can already be purged past the 72h keep floor, in which case the receipt simply stays unattributed, which loses information but never states anything false",
  "src/lib/db/usage.ts::getFleetCalendarMonthUsageByBusiness::voice_call_transcripts":
    "cross-tenant fleet usage rollup, no business_id filter. Degrades only peakConcurrentCalls for a residency tenant; billable minutes come from voice_settlements, which is central and does not move"
};

/**
 * Reads of a PURGED table from the Deno edge workers.
 *
 * The four reads that carry what the coworker KNOWS about a customer on the
 * inbound text path are now routed to the tenant's box (the cross-channel
 * timeline, the flow-context messages, the last assistant message, and the
 * contact identity that feeds them). What is left here is left for a stated
 * reason, not for lack of effort, and the reasons differ:
 *
 *   * THREE `notifications` dedupe reads filter on JSON-path columns
 *     (`payload->>taskType`). The box validates column names against
 *     /^[a-z_][a-z0-9_]*$/ and rejects those outright, and relaxing that
 *     validator would open a SQL-injection surface on a tenant's box to save
 *     a duplicate owner page. Worst case when they read empty is exactly
 *     that: one duplicate alert.
 *   * TWO `sms_owner_reply_prompts` reads in the webhook are the read half
 *     of a compare-and-swap whose write is central. Routing the read alone
 *     would leave the claim guarding a row it did not read, which is the
 *     lost-update hazard, and both sites also sit in `serve()` with no
 *     try/catch, so a throw would 500 the webhook into a Telnyx redelivery
 *     loop. Read and write must move together, or neither.
 *   * ONE `sms_outbound_log` read RESOLVES the businessId (the international
 *     gateway's inbound router), so there is no tenant to route to yet.
 *
 * All remaining entries are bounded-recency reads inside the purge
 * keep-window, which the 72h floor turns from a coincidence into an enforced
 * invariant.
 */
const PURGED_READ_ENGINE_CENTRAL: Record<SiteKey, string> = {
  "supabase/functions/_shared/ai_flows/call_guards.ts::countRecentDials::voice_outbound_dial_log":
    "dial-cap backstop over DEFAULT_DIAL_WINDOW_HOURS = 24, inside the keep-window",
  "supabase/functions/_shared/ai_flows/contact_said.ts::loadContactSaid::voice_call_transcripts":
    "prompt context for the current call; a hard failure here would end a live conversation",
  "supabase/functions/_shared/ai_flows/contact_said.ts::loadContactSaid::voice_call_transcript_turns":
    "turns behind the transcript above; same live-call posture",
  "supabase/functions/_shared/aiflow_failure_alert.ts::sendAiflowFailureAlert::notifications":
    "alert dedupe on a live failure; a box round trip here can only suppress or duplicate an alert",
  "supabase/functions/_shared/call_summary_sweep.ts::processCallSummarySweep::voice_call_transcripts":
    "sweep claims recent unsummarized calls, well inside the keep-window",
  "supabase/functions/_shared/customer_reply_alert.ts::sendCustomerReplyAlert::notifications":
    "alert dedupe keyed on the live inbound job id",
  "supabase/functions/_shared/forwarded_call_log.ts::readExistingTranscript::voice_call_transcripts":
    "reads back the transcript row for the call being handled now",
  "supabase/functions/_shared/needs_human.ts::escalateToHuman::notifications":
    "repage dedupe over NEEDS_HUMAN_REPAGE_HOURS = 24, inside the keep-window",
  "supabase/functions/_shared/owner_notify_fallback.ts::sendOwnerNotifyFallback::notifications":
    "fallback notify dedupe for the notification being sent now",
  "supabase/functions/_shared/scheduled_sms.ts::dispatchOne::sms_outbound_log":
    "send dedupe keyed on the scheduled_sms row being dispatched now",
  "supabase/functions/_shared/sms_international_gateway.ts::resolveGatewayInboundBusiness::sms_outbound_log":
    "most recent send, ordered desc limit 1, to attribute a gateway inbound",
  "supabase/functions/ai-flow-worker/index.ts::findDuplicateLeadRun::sms_outbound_log":
    "duplicate-lead detection over recent sends",
  "supabase/functions/ai-flow-worker/index.ts::threadActiveSince::sms_outbound_log":
    "thread activity recency for the run in flight",
  "supabase/functions/call-integrity-sweep/index.ts::<module>::voice_call_transcripts":
    "integrity sweep over recent calls",
  "supabase/functions/call-integrity-sweep/index.ts::<module>::voice_call_transcript_turns":
    "turns behind the sweep's transcripts",
  "supabase/functions/hardware-escalation-advisor/index.ts::<module>::voice_call_transcripts":
    "fleet hardware advisor reading recent call volume; cross-tenant, so no single box owns it either",
  "supabase/functions/notifications-digest/index.ts::fetchActivity::notifications":
    "digest window is bounded and inside the keep-window",
  "supabase/functions/notifications-digest/index.ts::fetchActivity::sms_outbound_log":
    "digest window is bounded and inside the keep-window",
  "supabase/functions/notifications-digest/index.ts::fetchActivity::voice_call_transcripts":
    "digest window is bounded and inside the keep-window",
  "supabase/functions/notifications/index.ts::<module>::notifications":
    "notifications edge function serving the owner's live list",
  "supabase/functions/telnyx-sms-inbound/index.ts::ownerReplyPromptIsNewer::sms_owner_reply_prompts":
    "compares the live owner prompt against the newest one; unanswered prompts are never purged",
  "supabase/functions/telnyx-sms-inbound/index.ts::tryOwnerReplyRelay::sms_owner_reply_prompts":
    "relays against the open owner prompt; unanswered prompts are never purged",
  "supabase/functions/telnyx-voice-call-end/index.ts::decorateTranscriptForVoicemail::voice_call_transcript_turns":
    "decorates the turns of the call that just ended"
};

/**
 * FROZEN DEBT, seeded 2026-08-20. Dashboard-side reads of a PURGED table
 * that a vps tenant would silently get incomplete.
 *
 * This list may only SHRINK. A PR that adds a line here is doing the wrong
 * thing: route it, or justify it above.
 */
const PURGED_READ_DEBT: Record<SiteKey, string> = {
  "src/app/dashboard/messages/page.tsx::DashboardMessagesPage::scheduled_sms":
    "pending and history panes; listScheduledSmsForDashboard next door is already routed, so this is the odd one out",
  "src/lib/ai-flows/doc-source.ts::resolveFlowDocumentSource::email_log":
    "resolves a flow's source email; uses .contains() on an array column, so it needs the widened grammar first",
  "src/lib/ai-flows/email-poll.ts::threadsWeHaveRepliedOn::email_log":
    "reply-detection over prior sends; uses .filter(), so it needs the widened grammar first",
  "src/lib/call-summaries/summarizer.ts::summarizeCallTranscript::voice_call_transcripts":
    "reads the transcript it is about to summarize; read-modify-write, so the read and the write must move together",
  "src/lib/call-summaries/summarizer.ts::summarizeCallTranscript::voice_call_transcript_turns":
    "turns feeding the same summary; moves with the transcript read above",
  "src/lib/customer-memory/db.ts::listSmsHistoryForCustomer::sms_outbound_log":
    "SMS history for one contact, straightforwardly routable",
  "src/lib/db/activity.ts::fetchActivityFeedInput::email_log":
    "activity feed; the whole module is the biggest single block of dashboard debt",
  "src/lib/db/activity.ts::fetchActivityFeedInput::sms_outbound_log":
    "activity feed: outbound SMS leg of the same three-channel fetch",
  "src/lib/db/activity.ts::fetchActivityFeedInput::voice_call_transcripts":
    "activity feed: voice leg of the same three-channel fetch",
  "src/lib/db/activity.ts::getActivityForContacts::sms_outbound_log":
    "per-contact activity rollup, SMS leg; routable once the module is taken as a whole",
  "src/lib/db/activity.ts::getActivityForContacts::voice_call_transcripts":
    "per-contact activity rollup, voice leg; routable once the module is taken as a whole",
  "src/lib/db/activity.ts::getContactActivity::email_log":
    "single-contact activity; uses .or(), so it needs the widened grammar first",
  "src/lib/db/activity.ts::getContactActivity::sms_outbound_log":
    "single-contact activity timeline, SMS leg",
  "src/lib/db/activity.ts::getContactActivity::voice_call_transcripts":
    "single-contact activity timeline, voice leg",
  "src/lib/db/email-log.ts::getEmailLogThreadIdentity::email_log":
    "thread identity lookup, left central while four readers in this same file were routed",
  "src/lib/db/email-log.ts::organizeTenantEmailLog::email_log":
    "reads flags then writes them back; read-modify-write, so the read and the write must move together",
  "src/lib/db/email-log.ts::threadsAnsweredByFlow::email_log":
    "uses .not(col, 'is', null), which the box grammar cannot express at all today",
  "src/lib/db/notifications.ts::listRecentAlertsAbout::notifications":
    "flood-gate read, left central while getNotifications in this same file was routed; on a vps tenant the purged rows read as zero recent alerts, so the gate fails OPEN and sends, which is the safe direction",
  "src/lib/db/notifications.ts::hasRecentNotificationForContact::notifications":
    "dedupe check, left central while getNotifications in this same file was routed",
  "src/lib/email/replay.ts::replayInboundEmails::email_log":
    "operator replay tool reading prior inbound mail"
};

/** Seed count, in KEYS. Edit downward only. */
const PURGED_READ_DEBT_CEILING = 20;

/**
 * Reads of a KEPT-central table that are deliberately served from the box.
 *
 * These are not bugs. Serving a residency tenant's own dashboard from their
 * own box is the thing the deal buys, and central would be correct too. The
 * trade each one accepts is up to a replay tick of staleness plus a new 5xx
 * path when the tunnel is down, in exchange for on-box serving. Recorded so
 * the trade stays visible rather than becoming folklore.
 */
const KEPT_TABLE_ROUTED_BOX_WARD: Record<SiteKey, string> = {
  "src/lib/analytics/deals.ts::getDealsOverview::contacts":
    "deals overview card reads the tenant's own box (PR #1563)",
  "src/lib/analytics/employee-performance.ts::fetchContacts::contacts":
    "team performance card reads the tenant's own box (PR #1547)",
  "src/lib/analytics/engagement.ts::fetchContacts::contacts":
    "engagement card reads the tenant's own box (PR #1563)",
  "src/lib/analytics/lead-sources.ts::fetchContacts::contacts":
    "lead sources card reads the tenant's own box (PR #1563)",
  "src/lib/analytics/monthly-summary.ts::countNewContacts::contacts":
    "monthly summary card reads the tenant's own box (PR #1563)",
  "src/lib/analytics/quote-funnel.ts::fetchContacts::contacts":
    "quote funnel card reads the tenant's own box (PR #1563)",
  "src/lib/analytics/renewal-pipeline.ts::fetchContacts::contacts":
    "renewal pipeline card reads the tenant's own box (PR #1563)",
  "src/lib/analytics/retention.ts::fetchContacts::contacts":
    "retention card reads the tenant's own box (PR #1563)",
  "src/lib/contacts/lookup.ts::listContactsByLeadPhone::contacts":
    "Tasks board and leads grid read the tenant's own box (PR #1565)",
  "src/lib/contacts/lookup.ts::listContactsByEmail::contacts":
    "Tasks board and leads grid read the tenant's own box (PR #1565)",
  "src/lib/contacts/lookup.ts::listTaggedContacts::contacts":
    "Tasks board and leads grid read the tenant's own box (PR #1565)",
  "src/lib/contacts/lookup.ts::contactExistsForBusiness::contacts":
    "document routes' cross-tenant contact guard (PR #1565)",
  "src/lib/analytics/flow-funnels.ts::fetchFlows::ai_flows":
    "flow funnel card reads the tenant's own box; the only other ai_flows reader in this file is the routed sends leg, so the file is internally consistent",
  "src/lib/ai-flows/db.ts::listAiFlowDefinitions::ai_flows":
    "AiFlows pages read the tenant's own box (PR #1567 routed the rest of this file's readers, so it is now internally consistent)",
  "src/lib/ai-flows/db.ts::fetchFlows::ai_flows":
    "AiFlows list page reads the tenant's own box, via listAiFlows's inner fetchFlows (PR #1567)",
  "src/lib/ai-flows/db.ts::getAiFlow::ai_flows":
    "single flow read for the AiFlows pages, on the tenant's own box (PR #1567)",
  "src/lib/ai-flows/db.ts::enqueueAiFlowRun::ai_flows":
    "enqueue gate re-reads the flow from the tenant's own box (PR #1567). NOTE the residual read-after-write window: createAiFlow and updateAiFlow write CENTRAL and replicate by journal, so a flow created or edited and then immediately enqueued can miss the newest definition by up to one replay tick. Inherent to box reads plus central writes, not specific to this call"
};

/**
 * Files allowed to read ONE kept-central table both box-ward and centrally.
 *
 * Default is that they may not. For a kept table both copies hold the same
 * rows, so mixing means some readers see a stale box and some see fresh
 * central for identical content: pure inconsistency, no compliance gain.
 *
 * Empty, and worth keeping empty. src/lib/ai-flows/db.ts was the one entry
 * here; PR #1567 routed its remaining readers, so the file now agrees with
 * itself and the exception was deleted rather than left to rot.
 */
const MIXED_ROUTING_EXCEPTIONS: Record<string, string> = {};

/**
 * `.from(<expression>)` sites, where the table is not a literal and no
 * scanner can tell what it resolves to.
 */
const DYNAMIC_TABLE_SITES: Record<string, string> = {
  "src/app/api/public/v1/events/route.ts::GET":
    "WEBHOOK_EVENT_SOURCES: resolves to sms_outbound_log, voice_call_transcripts and email_log, all PURGED. Real debt, and invisible to a literal scan",
  "src/lib/mcp/tools/read.ts::<module>":
    "WEBHOOK_EVENT_SOURCES again, same three purged tables. Real debt",
  "supabase/functions/_shared/webhook_dispatch.ts::runWebhookDispatchTick":
    "WEBHOOK_EVENT_SOURCES again, from the edge. Held at engine posture with the rest of supabase/functions",
  "src/lib/account/deletion.ts::getAccountDeletionImpact":
    "iterates a table list to count what account deletion would remove; central is the copy being deleted, and the journal replicates the deletes box-ward",
  "src/lib/onboarding/abandoned-signup-cleanup.ts::countFor":
    "counts rows across a guard list that includes three PURGED tables (sms_outbound_log, voice_call_transcripts, email_log). Correct by construction rather than by routing: the sweep only loads facts for a business still carrying the pending+<id>@onboarding.local sentinel, which has therefore never provisioned a box, so its data_residency_mode is supabase and residency_purge_business has never run against it. Central is the only copy that has ever existed. The counts are also a REFUSAL signal, so the failure direction is safe: a miscount can only spare a row, never delete one",
  "src/lib/admin/deleted-items.ts::readDeletedRows":
    "already residency-aware: the enclosing module resolves isVpsReadMode and calls readMovedRows on the box path",
  "src/lib/billing/usage-pack-clawback.ts::listOpenMembershipGrantSourceIds":
    "billing control plane; the tables it iterates are central and do not move",
  "src/lib/todos/db.ts::assertRefInBusiness":
    "ownership assertion across several ref tables; contacts among them is KEPT central, so this is correct",
  "supabase/functions/telnyx-voice-call-end/index.ts::wtLookupName":
    "generic single-column lookup helper; engine posture"
};

/**
 * Postgres functions whose BODY touches a moved table. These execute inside
 * CENTRAL Postgres and cannot reach a tenant box at all, so they are
 * structurally unroutable: the fix, when one is needed, is to move the
 * function or replace it with an application-level read.
 *
 * Derived by parsing the migrations, so a new one fails here rather than at
 * the first residency deal.
 */
const RPC_SURFACES: Record<string, string> = {
  record_customer_interaction:
    "reads and writes contacts, which is KEPT central, so this is correct today. It becomes the blocker the day contacts is purged",
  merge_customer_memories:
    "merges contacts rows; contacts is KEPT central, so correct today",
  aggregate_ai_flow_library_candidates:
    "cross-tenant library aggregation over ai_flows: platform control plane, not one tenant's content",
  claim_due_scheduled_sms:
    "claims scheduled_sms rows. Only TERMINAL scheduled_sms is purged and this claims due-and-pending rows, so it is correct today",
  voice_try_finalize_settlement:
    "reads voice_call_transcripts and its turns, both PURGED, on the billing settlement path. The sharpest RPC on this list: settlement of a call older than keep-hours would find nothing. Bounded today because settlement runs at call end, far inside the window",
  residency_purge_business:
    "the purge itself: it is SUPPOSED to touch central copies of moved tables, that is its job",
  residency_journal_row:
    "the journal trigger itself: reads the parent row to resolve business_id before journaling",
  residency_backfill_business:
    "the backfill itself: reads central rows to seed a tenant box before the parity gate"
};

// ── migration scan for the RPC surface ──────────────────────────────────

function sqlFunctionsTouchingMovedTables(): Map<string, string[]> {
  const dir = join(ROOT, "supabase", "migrations");
  const found = new Map<string, string[]>();
  const fnRe = /create\s+or\s+replace\s+function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\$\$;/gi;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(fnRe)) {
      const body = m[2];
      const tables = RESIDENCY_MOVED_TABLES.filter((t) =>
        new RegExp(String.raw`\b(from|join|update|into|delete\s+from)\s+(public\.)?"?${t}"?\b`, "i").test(
          body
        )
      );
      if (tables.length > 0) found.set(m[1], [...tables]);
    }
  }
  return found;
}

// ── helpers ─────────────────────────────────────────────────────────────

const purgedUnrouted = scan.sites.filter((s) => !s.routed && isResidencyPurgedTable(s.table));
const keptRouted = scan.sites.filter((s) => s.routed && !isResidencyPurgedTable(s.table));

function decidedPurgedKeys(): Set<SiteKey> {
  return new Set([
    ...Object.keys(PURGED_READ_CENTRAL_BY_DESIGN),
    ...Object.keys(PURGED_READ_ENGINE_CENTRAL),
    ...Object.keys(PURGED_READ_DEBT)
  ]);
}

const FIX_HINT =
  "\n\nRoute it through @/lib/residency/read (see src/lib/contacts/lookup.ts for the pattern), " +
  "or add an entry to this file with an honest reason. Do NOT add to PURGED_READ_DEBT: it is frozen " +
  "and only shrinks.";

// ── the gate ────────────────────────────────────────────────────────────

describe("residency read coverage", () => {
  it("every central read of a PURGED table is a recorded decision", () => {
    const decided = decidedPurgedKeys();
    const undecided = [...new Set(purgedUnrouted.filter((s) => !decided.has(siteKey(s))).map((s) => `${siteKey(s)}  (${s.file}:${s.line})`))].sort();
    expect(
      undecided,
      "These read a table that residency_purge_business() DELETES from central. " +
        "For a vps tenant the rows are gone, so the result is silently incomplete: " +
        "an empty list, not an error." + FIX_HINT
    ).toEqual([]);
  });

  it("every box-ward read of a KEPT-central table is a recorded decision", () => {
    const undecided = [...new Set(keptRouted
      .filter((s) => !(siteKey(s) in KEPT_TABLE_ROUTED_BOX_WARD))
      .map((s) => `${siteKey(s)}  (${s.file}:${s.line})`))].sort();
    expect(
      undecided,
      "These route a table the purge deliberately KEEPS central. Central holds every row " +
        "and is fresher, so box-ward serving is a product choice (the tenant's own box) that " +
        "costs staleness and a 5xx path. That can be right, but it must be on record: " +
        "add an entry to KEPT_TABLE_ROUTED_BOX_WARD saying why."
    ).toEqual([]);
  });

  it("no file reads one KEPT-central table both box-ward and centrally", () => {
    const byFileTable = new Map<string, { routed: number; central: number }>();
    for (const s of scan.sites) {
      if (isResidencyPurgedTable(s.table)) continue;
      const key = `${s.file}::${s.table}`;
      const v = byFileTable.get(key) ?? { routed: 0, central: 0 };
      if (s.routed) v.routed++;
      else v.central++;
      byFileTable.set(key, v);
    }
    const mixed = [...byFileTable]
      .filter(([key, v]) => v.routed > 0 && v.central > 0 && !(key in MIXED_ROUTING_EXCEPTIONS))
      .map(([key, v]) => `${key} (routed=${v.routed}, central=${v.central})`)
      .sort();
    expect(
      mixed,
      "Both copies of a kept-central table hold the same rows, so mixing means some readers " +
        "see a stale box and others see fresh central for identical content: inconsistency for " +
        "no compliance gain. Where the central readers include a writer, create-then-read also " +
        "loses the row for a replay tick. Make the file agree with itself, in either direction."
    ).toEqual([]);
  });

  it("every dynamic .from(expr) read has a recorded decision", () => {
    const undecided = scan.dynamic
      .filter((d) => !(`${d.file}::${d.fn}` in DYNAMIC_TABLE_SITES))
      .map((d) => `${d.file}::${d.fn} (${d.file}:${d.line}) arg=${d.argText}`)
      .sort();
    expect(
      undecided,
      "A non-literal table name is invisible to this scan, so it needs a human decision. " +
        "WEBHOOK_EVENT_SOURCES is the cautionary case: it resolves to three PURGED tables."
    ).toEqual([]);
  });

  it("every SQL function touching a moved table has a recorded decision", () => {
    const found = sqlFunctionsTouchingMovedTables();
    expect(
      found.size,
      "found no SQL functions at all: the migration parser broke, it did not pass"
    ).toBeGreaterThanOrEqual(5);
    const undecided = [...found.keys()].filter((n) => !(n in RPC_SURFACES)).sort();
    expect(
      undecided,
      "These run inside CENTRAL Postgres and cannot reach a tenant box, so they are " +
        "structurally unroutable. Record the decision: correct today, or a blocker to name."
    ).toEqual([]);
  });

  // ── ratchets ──────────────────────────────────────────────────────────

  it("debt only shrinks: no stale entries", () => {
    const live = new Set(purgedUnrouted.map(siteKey));
    const stale = [
      ...Object.keys(PURGED_READ_CENTRAL_BY_DESIGN),
      ...Object.keys(PURGED_READ_ENGINE_CENTRAL),
      ...Object.keys(PURGED_READ_DEBT)
    ]
      .filter((k) => !live.has(k))
      .sort();
    expect(
      stale,
      "These entries name a site that is gone or now routed. Delete the entry, and lower " +
        "PURGED_READ_DEBT_CEILING if it came off the debt list. An exemption that outlives its " +
        "call site is how a guard rots into decoration."
    ).toEqual([]);
  });

  it("debt never grows", () => {
    expect(
      Object.keys(PURGED_READ_DEBT).length,
      "PURGED_READ_DEBT grew. Route the read instead, or justify it in one of the two " +
        "central-by-design blocks above."
    ).toBeLessThanOrEqual(PURGED_READ_DEBT_CEILING);
  });

  it("no stale KEPT-table or mixed-routing entries", () => {
    const liveKept = new Set(keptRouted.map(siteKey));
    expect(Object.keys(KEPT_TABLE_ROUTED_BOX_WARD).filter((k) => !liveKept.has(k)).sort()).toEqual([]);
    // Must test for still-MIXED, not merely still-present. An earlier
    // version checked that the file/table pair existed at all, which stayed
    // green through the very change (#1567) that resolved the mix and made
    // the entry stale.
    const stillMixed = new Set<string>();
    const tally = new Map<string, { routed: number; central: number }>();
    for (const s2 of scan.sites) {
      if (isResidencyPurgedTable(s2.table)) continue;
      const key = `${s2.file}::${s2.table}`;
      const v = tally.get(key) ?? { routed: 0, central: 0 };
      if (s2.routed) v.routed++;
      else v.central++;
      tally.set(key, v);
    }
    for (const [key, v] of tally) if (v.routed > 0 && v.central > 0) stillMixed.add(key);
    expect(
      Object.keys(MIXED_ROUTING_EXCEPTIONS).filter((k) => !stillMixed.has(k)).sort(),
      "this file no longer mixes routed and central reads: delete the exception"
    ).toEqual([]);
  });

  it("no stale dynamic or RPC entries", () => {
    const liveDynamic = new Set(scan.dynamic.map((d) => `${d.file}::${d.fn}`));
    expect(Object.keys(DYNAMIC_TABLE_SITES).filter((k) => !liveDynamic.has(k)).sort()).toEqual([]);
    const liveRpc = sqlFunctionsTouchingMovedTables();
    expect(Object.keys(RPC_SURFACES).filter((n) => !liveRpc.has(n)).sort()).toEqual([]);
  });

  it("each site is in exactly one state, and every reason is real prose", () => {
    const blocks: Array<[string, Record<string, string>]> = [
      ["PURGED_READ_CENTRAL_BY_DESIGN", PURGED_READ_CENTRAL_BY_DESIGN],
      ["PURGED_READ_ENGINE_CENTRAL", PURGED_READ_ENGINE_CENTRAL],
      ["PURGED_READ_DEBT", PURGED_READ_DEBT],
      ["KEPT_TABLE_ROUTED_BOX_WARD", KEPT_TABLE_ROUTED_BOX_WARD],
      ["MIXED_ROUTING_EXCEPTIONS", MIXED_ROUTING_EXCEPTIONS],
      ["DYNAMIC_TABLE_SITES", DYNAMIC_TABLE_SITES],
      ["RPC_SURFACES", RPC_SURFACES]
    ];
    for (const [label, block] of blocks) {
      for (const [key, why] of Object.entries(block)) {
        expect(why.trim().length, `${label}["${key}"]: a reason, not a shrug`).toBeGreaterThan(25);
      }
    }
    const purgedBlocks = [
      PURGED_READ_CENTRAL_BY_DESIGN,
      PURGED_READ_ENGINE_CENTRAL,
      PURGED_READ_DEBT
    ];
    const seen = new Set<string>();
    for (const block of purgedBlocks) {
      for (const key of Object.keys(block)) {
        expect(seen.has(key), `${key}: pick one state`).toBe(false);
        seen.add(key);
      }
    }
  });

  // ── self-checks: a guard that inspects nothing must not pass ──────────

  it("the scan still sees the repo it is supposed to see", () => {
    expect(scan.filesParsed, "parsed almost nothing: the walker broke").toBeGreaterThan(300);
    expect(scan.sites.length, "found almost no reads: the table matcher broke").toBeGreaterThan(150);
    // Without this, a regression that classifies every chain as a write turns
    // the whole gate green with an empty read set.
    expect(scan.writeSites, "found no writes: the verb classifier broke").toBeGreaterThan(100);
    expect(
      scan.sites.filter((s) => s.routed).length,
      "found no routed reads: the routing detector broke"
    ).toBeGreaterThan(25);
    expect(scan.dynamic.length, "found no dynamic sites: the fallback broke").toBeGreaterThan(0);
    expect([...SCAN_ROOTS]).toEqual(["src", "supabase/functions", "vps/voice-bridge/src"]);
    expect(
      [...SCAN_EXCLUDED],
      "the exclusion list grew: nothing may be quietly scanned out of this guard"
    ).toEqual(["src/lib/residency/"]);
  });

  it("classifies two known controls correctly", () => {
    // Positive: a hand-verified routed reader.
    const routedControl = scan.sites.find(
      (s) => siteKey(s) === "src/lib/contacts/lookup.ts::listContactsByLeadPhone::contacts"
    );
    expect(routedControl?.routed, "the routed detector stopped detecting").toBe(true);
    // Negative: same FILE routes four readers, this one is central. A
    // file-level check calls this clean, which is the bug this guard exists
    // to avoid.
    const centralControl = scan.sites.find(
      (s) => siteKey(s) === "src/lib/db/email-log.ts::threadsAnsweredByFlow::email_log"
    );
    expect(centralControl, "the unrouted detector stopped detecting").toBeDefined();
    expect(centralControl?.routed).toBe(false);
  });

  it("accounts for every moved table", () => {
    const seen = new Set(scan.sites.map((s) => s.table));
    const unseen = RESIDENCY_MOVED_TABLES.filter((t) => !seen.has(t)).sort();
    // dashboard_chat_activity is a single upsert-only counter row
    // (src/lib/db/dashboard-chat.ts:441), so it genuinely has no reader.
    // Anything ELSE missing means the table matcher broke and every
    // assertion above went vacuously green.
    expect(unseen).toEqual(["dashboard_chat_activity"]);
  });
});
