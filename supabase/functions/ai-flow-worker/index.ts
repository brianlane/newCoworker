/**
 * ai-flow-worker — async executor for AiFlow runs (Phase 5).
 *
 * Scheduled by pg_cron (see 20260608010000_schedule_ai_flow_worker.sql), auth'd
 * with INTERNAL_CRON_SECRET via _shared/cron_auth.ts. Each invocation:
 *
 *   1. reclaim_stale_ai_flow_runs  — recover runs whose worker died mid-flight.
 *   2. claim_ai_flow_runs          — lease queued runs (FOR UPDATE SKIP LOCKED).
 *   3. for each run: load the flow definition and execute steps sequentially
 *      from `current_step`, driving the run state machine:
 *        queued -> running -> (awaiting_approval ->) done | failed.
 *
 * All PURE decisions (templating, trigger/step planning, SSRF host checks, page
 * extraction parsing, compliance copy) come from the unit-tested
 * supabase/functions/_shared/ai_flows/* modules; this file is the thin IO half:
 * fetch, Telnyx send, Gemini extract, DB writes.
 *
 * Failure model:
 *   - planStep "missing input" / unsafe URL / disabled flow → FAIL (no retry).
 *   - transient IO errors (fetch/Telnyx/RPC throw) → re-queue until MAX_ATTEMPTS,
 *     then dead-letter as failed.
 *   - approval_gate (not yet approved) → awaiting_approval, run paused.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { isSelfPhone, scrubSelfPhones } from "../_shared/ai_flows/extracted_contact.ts";
import { systemLog } from "../_shared/system_log.ts";
import { telnyxSendSms, telnyxSendGroupMms } from "../_shared/telnyx_sms_compliance.ts";
import { sendOperationalSms } from "../_shared/sms_operational_meter.ts";
import { resolveRcsAgentId } from "../_shared/channel_settings.ts";
import {
  buildClassifyPrompt,
  buildExtractionPrompt,
  CLASSIFY_UNCLEAR,
  parseClassifyChoice,
  buildNowScope,
  evaluateSmsTrigger,
  evaluateStepCondition,
  extractLeadIdentity,
  extractLinkByText,
  extractLabeledPhones,
  filterRosterByAvailability,
  flowTriggers,
  groupLeadPhone,
  htmlToText,
  isE164,
  isExecutableDefinition,
  isPhoneFieldName,
  localClock,
  normalizeNanpToE164,
  parseExtractionJson,
  parseRoutedAgent,
  pickRosterAgent,
  renderTemplate,
  senderPinnedByFromMatches,
  type NowScope,
  type RoutedAgent
} from "../_shared/ai_flows/engine.ts";
import { callRowboatChatOnce } from "../_shared/sms_rowboat.ts";
import { resolveRowboatBearerForBusiness } from "../_shared/gateway_token.ts";
import {
  CALL_NOT_PLACED_SENTINEL,
  MAX_WAIT_MINUTES,
  SHARE_URL_TOKEN,
  planStep,
  type StepAction
} from "../_shared/ai_flows/steps.ts";
import { resolveContactRef, resolveFromMatchesRefValues } from "../_shared/ai_flows/contact_ref.ts";
import {
  normalizeBrowseUrl,
  parseActionResponse,
  parseRenderResponse,
  renderErrorFields,
  renderErrorKind
} from "../_shared/ai_flows/browse.ts";
import {
  isRecipientOptedOut,
  prepareSmsBody
} from "../_shared/ai_flows/compliance.ts";
import {
  approvalSmsInstruction,
  buildApprovalGateOptions
} from "../_shared/ai_flows/approval_options.ts";
import { sendCapAlertOnce, smsCapPeriodKey } from "../_shared/cap_alerts.ts";
import { sendAiflowFailureAlert } from "../_shared/aiflow_failure_alert.ts";
import {
  deleteShortLinks,
  linkSmsLinksToOutboundLog,
  shortenSmsBodyUrls
} from "../_shared/sms_short_links.ts";
import {
  formatInTimeZone,
  nextTimeOfDayMs,
  offerRespondByMs,
  parseHHMM,
  smsQuietDecision,
  timeWindowDecision
} from "../_shared/ai_flows/quiet_hours.ts";
import { flattenSteps, isOnActivePath } from "../_shared/ai_flows/branching.ts";
import { applyGoalEvent, goalReachedVar } from "../_shared/ai_flows/goal_events.ts";
import { isTestModeTrigger, simulateTestAction } from "../_shared/ai_flows/test_mode.ts";
import { tenantScreenshotPath } from "../_shared/ai_flows/screenshot_guard.ts";
import { isBackfillSkipExistingTrigger } from "../_shared/ai_flows/backfill.ts";
import { enqueueContactEventRuns } from "../_shared/ai_flows/contact_events.ts";
import {
  birthdayDedupeKey,
  birthdayDue,
  contactAge,
  localYearIn
} from "../_shared/ai_flows/birthday.ts";
import { scheduleDue, type ScheduleConfig } from "../_shared/ai_flows/schedule.ts";
import {
  capMicrosForTier,
  geminiCostMicrosFromTokens,
  readActiveChatCreditMicros,
  readChatSpendMicros,
  resolveChatPeriodStart,
  type SpendSupabase
} from "../_shared/chat_spend_cap.ts";
import type {
  AiFlowDefinition,
  BrowseAuth,
  ExtractField,
  FlowStep,
  FlowTimeWindow,
  SmsTrigger
} from "../_shared/ai_flows/types.ts";
import { multiOfferHeadsUpLine, type OfferRouting } from "../_shared/ai_flows/routing.ts";
import { parseEtaMinutes } from "../_shared/ai_flows/claim_timeframe.ts";

// The actual createClient(url, key) call infers SupabaseClient<any, "public", any>,
// but `ReturnType<typeof createClient>` resolves to <unknown, never, GenericSchema>
// (TS instantiates the generic at its constraints, not its defaults), which is NOT
// assignable. Use a permissive client type so helpers accept the real client.
type Supabase = SupabaseClient<any, any, any>;

const MAX_ATTEMPTS = 4;
const CLAIM_LIMIT = 3;
const FETCH_TIMEOUT_MS = 20_000;
// The /api/internal/aiflow-email-poll and aiflow-calendar-poll routes declare
// maxDuration = 60; give each kick headroom beyond that so the worker never
// aborts a still-running poll.
const EMAIL_POLL_KICK_TIMEOUT_MS = 75_000;
// telnyx-voice-originate dials Telnyx (POST /v2/calls) then reserves budget; a
// few seconds is typical, so allow generous headroom before aborting a sweep.
const OUTBOUND_ORIGINATE_TIMEOUT_MS = 25_000;
// route_to_team: how many times one step entry will ask Rowboat for a sendable
// next agent (skipping opted-out picks) before giving up to the owner fallback.
const ROUTE_MAX_LOOKUPS = 6;
const ROWBOAT_ROUTE_TIMEOUT_MS = Number(
  Deno.env.get("AIFLOW_ROUTE_ROWBOAT_TIMEOUT_MS") ?? "30000"
);
// Render-service calls can run several navigations plus a login, so they need a
// far larger budget than a static fetch. Must exceed the render service's
// per-navigation timeout (AIFLOW_RENDER_TIMEOUT_MS, default 30s) times the
// worst-case nav count (initial + login + re-nav) or the worker aborts a render
// that would have succeeded.
const RENDER_FETCH_TIMEOUT_MS = Number(
  Deno.env.get("AIFLOW_RENDER_FETCH_TIMEOUT_MS") ?? "120000"
);
// A forEachLink browse runs up to MAX_FOREACH_ITEMS (render-side, default 25)
// sequential `networkidle` navigations plus per-item actions inside ONE HTTP
// response, so the single-page budget would abort the worker fetch mid-loop and
// leave the Clever portal partially updated. Give it a much larger,
// independently configurable budget (default 10 min). The render service and
// any tunnel in front of it must allow a response this long too.
const RENDER_FOREACH_FETCH_TIMEOUT_MS = Number(
  Deno.env.get("AIFLOW_RENDER_FOREACH_FETCH_TIMEOUT_MS") ?? "600000"
);
const MAX_REDIRECTS = 5;

// Storage bucket (private) for browse_extract screenshots; the worker writes
// `${businessId}/${runId}/step-${index}.jpg`, the send_email step downloads it
// by path to attach, and route_to_team signs a short-lived URL so Telnyx can
// fetch it as MMS media. Created by 20260609020000_aiflow_screenshots_bucket.sql.
const SCREENSHOT_BUCKET = "aiflow-screenshots";
// MMS signed-URL lifetime: Telnyx fetches the media at send time (plus carrier
// retries), so an hour is generous. Never templated into user-visible copy.
const SCREENSHOT_MMS_URL_TTL_S = 60 * 60;

// Storage bucket (private) for generate_image outputs; the worker writes
// `${businessId}/${uuid}.png` and saves a signed URL into the step's var so a
// later send_sms (mediaUrlVar → MMS) or send_email body can use it. Created by
// 20260819000000_generated_images_bucket.sql. 32 days: the URL may sit in a
// deferred run's context across sleeps/wait_for_reply, which cap at 30 days
// (MAX_WAIT_MINUTES) — the TTL must outlive the longest possible deferral
// plus delivery headroom so the consuming send never holds a dead link.
const GENERATED_IMAGES_BUCKET = "generated-images";
const GENERATED_IMAGE_URL_TTL_S = 32 * 24 * 60 * 60;
// Image model + flat per-image list prices (micro-USD). Image models bill per
// generated image (not per text token), so metering uses these flat costs;
// an unknown override model assumes the priciest tier (never undercount).
const GEMINI_IMAGE_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-lite-image";
const IMAGE_COST_MICROS: Record<string, number> = {
  "gemini-3.1-flash-lite-image": 34_000,
  "gemini-3.1-flash-image": 67_000,
  "gemini-3-pro-image": 134_000
};
const DEFAULT_IMAGE_COST_MICROS = 134_000;

/**
 * Resolve the render-service URL for a given tenant.
 *
 * The render service is deployed PER-TENANT (one headless-Chromium sidecar on
 * each business's own VPS, exposed at `render-<businessId>.<zone>`), so the
 * shared worker templates the businessId into the URL — exactly like
 * ROWBOAT_CHAT_URL_TEMPLATE does for per-tenant Rowboat. A static
 * `AIFLOW_RENDER_URL` (no `{businessId}` placeholder) still works for
 * single-host / local setups: the substitution is then a no-op.
 *
 * Returns null when neither var is configured (browse falls back to a static
 * fetch, which cannot drive a login form — see browseStep).
 */
function resolveRenderUrl(businessId: string): string | null {
  const tmpl =
    Deno.env.get("AIFLOW_RENDER_URL_TEMPLATE") ?? Deno.env.get("AIFLOW_RENDER_URL");
  if (!tmpl) return null;
  return tmpl.replace(/\{businessId\}/g, encodeURIComponent(businessId));
}

/**
 * Thrown when the render service reports a login failure (bad creds / MFA /
 * captcha). That is a permanent setup error, so the worker fails the run rather
 * than retrying it up to MAX_ATTEMPTS.
 */
class BrowseLoginError extends Error {}
/**
 * Thrown by fetchPage when the render service reports a transient render_failed.
 * Carries the failure screenshot (when the service captured one) so a debug-enabled
 * browse step can surface the stuck page in the run timeline instead of dropping it
 * into the silent retry path.
 */
class RenderFailedError extends Error {
  screenshotBase64?: string;
  pageSource?: string;
  constructor(message: string, screenshotBase64?: string, pageSource?: string) {
    super(message);
    this.screenshotBase64 = screenshotBase64;
    this.pageSource = pageSource;
  }
}
/**
 * Thrown when the tenant's shared AI budget (owner chat + SMS + AiFlows) is
 * exhausted for the period — a permanent, owner-actionable state, so the run
 * fails immediately instead of burning retries.
 */
class SpendCapError extends Error {}

/**
 * A THROWN (transient → retryable) step error that still carries diagnostics
 * (e.g. a screenshot/source path of the page the step failed on) so the run
 * loop can record them on the failed step row. Without this, a thrown error
 * goes through the silent retry path and the eventual dead-lettered step shows
 * no page state. `message` is preserved verbatim so last_error / retry
 * classification are unchanged.
 */
class StepDiagnosticError extends Error {
  result?: Record<string, unknown>;
  constructor(message: string, result?: Record<string, unknown>) {
    super(message);
    this.name = "StepDiagnosticError";
    if (result && Object.keys(result).length > 0) this.result = result;
  }
}
const GEMINI_MODEL = Deno.env.get("AIFLOW_EXTRACT_MODEL") ?? "gemini-2.5-flash-lite";

// AiFlow Gemini/Rowboat usage meters into the SAME owner_chat_model_spend pool
// (and the same cap env var) as dashboard chat + SMS, so one fuse covers every
// metered AI surface. See _shared/chat_spend_cap.ts for the rationale.
const AIFLOW_SPEND_METERING_ENABLED =
  (Deno.env.get("AIFLOW_SPEND_METERING_ENABLED") ?? "true").trim().toLowerCase() !== "false";
const CHAT_SPEND_CAP_MICROS = (() => {
  const n = Number(Deno.env.get("OWNER_CHAT_SPEND_CAP_MICROS"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10_000_000;
})();

type RunRow = {
  id: string;
  flow_id: string;
  business_id: string;
  status: string;
  context: Record<string, unknown>;
  current_step: number;
  attempt_count: number;
  error_retry_count: number;
};

type Scope = {
  vars: Record<string, unknown>;
  trigger: Record<string, unknown>;
  /**
   * Relative-date tokens ({{now.*}}), computed once per run in the business
   * timezone. Derived only — buildContext omits it from the persisted context.
   */
  now?: NowScope;
  // The AI coworker's own mailbox, exposed to templates as {{coworker.email}}
  // (e.g. for a body signature or a self-CC). Derived from tenant_mailboxes each
  // run; never persisted in run.context (buildContext omits it).
  coworker?: { email: string };
  // Per-flow opt-in (options.captureStepScreenshots): capture a screenshot on
  // every browse step — and a before/at-failure pair when a browse_action breaks
  // — for the dashboard run "investigate" view. Default off so most flows pay no
  // extra capture latency/storage; turned on for flows being debugged.
  captureScreenshots?: boolean;
  // Flow-level business-hours gate (definition.timeWindow): communication steps
  // outside the window defer the run to the next open slot. Derived from the
  // definition each claim; never persisted in run.context (buildContext omits it).
  timeWindow?: FlowTimeWindow;
  // Test run ("Test with a contact"): side-effecting actions are simulated and
  // waits resolve instantly. Derived from trigger.test_mode each claim (the
  // trigger scope persists verbatim, so the flag survives parks/resumes).
  testMode?: boolean;
};

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await assertCronAuth(req))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return new Response("Server misconfigured", { status: 500 });

  const supabase = createClient(supabaseUrl, serviceKey);

  await supabase.rpc("reclaim_stale_ai_flow_runs", { p_stale_minutes: 15 });
  // Re-queue route_to_team runs whose agent offer deadline lapsed so the next
  // claim escalates them to the following agent (status-driven, like reclaim).
  await supabase.rpc("escalate_overdue_agent_offers");
  // Re-queue wait_for_reply runs whose timeout lapsed with the no-reply
  // sentinel ("" in the step's saveAs var) so the flow's no-reply branch runs.
  await supabase.rpc("resume_overdue_reply_waits");
  // Re-queue place_ai_call runs whose call-end webhook never arrived before
  // the wait ceiling, with the no_answer sentinel (lost-webhook backstop).
  await supabase.rpc("resume_overdue_call_waits");

  // Non-SMS trigger sources, all failure-isolated so a bad schedule or a
  // mailbox/calendar outage never stalls run processing below. The email and
  // calendar polls are started here but awaited after the run loop: a busy
  // mailbox can take the route most of its 60s budget, and overlapping them
  // with run execution keeps the tick from stretching by that long
  // (kickTriggerPoll never throws).
  await enqueueDueScheduledRuns(supabase);
  // Birthday-trigger sweep (once per contact per year; dedupe-key bounded).
  await enqueueDueBirthdayRuns(supabase);
  // Scheduled outbound voice calls run on the call path (not the run engine),
  // so they get their own sweep. It calls telnyx-voice-originate with the shared
  // INTERNAL_CRON_SECRET bearer (the same secret this worker is authed with),
  // NOT the service-role key. Failure-isolated like the schedule sweep.
  await enqueueDueOutboundCalls(supabase, supabaseUrl, Deno.env.get("INTERNAL_CRON_SECRET") ?? "");
  const triggerPolls = Promise.all([
    kickTriggerPoll("/api/internal/aiflow-email-poll"),
    kickTriggerPoll("/api/internal/aiflow-calendar-poll")
  ]);

  const { data: claimed, error: claimErr } = await supabase.rpc("claim_ai_flow_runs", {
    p_limit: CLAIM_LIMIT
  });
  if (claimErr) {
    console.error("claim_ai_flow_runs", claimErr);
    await triggerPolls;
    return new Response("Claim failed", { status: 500 });
  }

  const runs = (claimed ?? []) as RunRow[];
  let processed = 0;
  for (const run of runs) {
    try {
      await executeRun(supabase, run);
    } catch (e) {
      await handleRunThrow(supabase, run, e);
    }
    processed += 1;
  }

  await triggerPolls;
  return json({ ok: true, processed });
});

/** Run as many steps as possible; persist terminal/paused state. */
async function executeRun(supabase: Supabase, run: RunRow): Promise<void> {
  // Kill switch: if the owner paused the business, do NOT execute side-effecting
  // steps (send_sms / notify_owner / http_call) — including for runs that were
  // already queued or are resuming after approval. Defer by re-queuing without
  // burning an attempt so the run resumes cleanly once they unpause. Best-effort
  // so a transient write failure here just leaves the run for stale reclaim.
  const { data: bizRow } = await supabase
    .from("businesses")
    .select("is_paused")
    .eq("id", run.business_id)
    .maybeSingle();
  if ((bizRow as { is_paused?: boolean } | null)?.is_paused) {
    try {
      // claim_ai_flow_runs already bumped attempt_count when it leased this run;
      // give it back so deferring while paused doesn't drain the retry budget
      // (otherwise a transient failure right after unpause could dead-letter).
      await updateRun(supabase, run.id, {
        status: "queued",
        claimed_at: null,
        attempt_count: Math.max(0, run.attempt_count - 1)
      });
    } catch (e) {
      console.error("executeRun defer-paused updateRun", e);
    }
    await telemetryRecord(supabase, "ai_flow_run_deferred_paused", {
      run_id: run.id,
      business_id: run.business_id
    });
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "info",
      event: "ai_flow_run_deferred_paused",
      message: "Run deferred: business is paused (kill switch)",
      payload: { run_id: run.id, flow_id: run.flow_id }
    });
    return;
  }

  const { data: flowRow, error: flowErr } = await supabase
    .from("ai_flows")
    .select("definition, enabled")
    .eq("id", run.flow_id)
    .maybeSingle();
  if (flowErr) throw new Error(`load flow: ${flowErr.message}`);
  const flow = flowRow as { definition?: unknown; enabled?: boolean } | null;
  // Owner disabled the flow after this run was queued (or mid-flight): stop.
  // Disabling must halt already-queued/approval-resumed runs, not just new
  // triggers, so they can't keep sending SMS / browsing / calling integrations.
  // EXCEPTION: test runs ("Test with a contact") execute on DISABLED flows by
  // design — testing a draft before switching it on is the point, and every
  // side-effecting action is simulated anyway. A missing flow row (deleted)
  // still cancels either way.
  if (!flow || (!flow.enabled && !isTestModeTrigger(asRecord(run.context.trigger)))) {
    try {
      // Free the trigger's dedupe slot before canceling: if the owner
      // re-enables the flow while the scheduled occurrence is still due or
      // the email message is still inside the poll lookback, it can fire
      // again instead of being silently swallowed by the unique
      // (flow_id, dedupe_key) index. Email runs also leave an evaluation
      // marker that would skip the message on later polls — clear it too.
      const { data: dkRow } = await supabase
        .from("ai_flow_runs")
        .select("dedupe_key")
        .eq("id", run.id)
        .maybeSingle();
      const dedupeKey = (dkRow as { dedupe_key?: string | null } | null)?.dedupe_key;
      await updateRun(supabase, run.id, {
        status: "canceled",
        last_error: "flow disabled",
        claimed_at: null,
        dedupe_key: null
      });
      if (dedupeKey?.startsWith("email:")) {
        await supabase
          .from("ai_flow_email_seen")
          .delete()
          .eq("flow_id", run.flow_id)
          .eq("message_id", dedupeKey.slice("email:".length));
      }
    } catch (e) {
      console.error("executeRun cancel-disabled updateRun", e);
    }
    await telemetryRecord(supabase, "ai_flow_run_canceled_disabled", {
      run_id: run.id,
      business_id: run.business_id
    });
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "info",
      event: "ai_flow_run_canceled_disabled",
      message: "Run canceled: flow was disabled after the run was queued",
      payload: { run_id: run.id, flow_id: run.flow_id }
    });
    return;
  }
  const definition = flow.definition;
  if (!isExecutableDefinition(definition)) {
    await failRun(supabase, run, "flow definition is missing or invalid");
    return;
  }
  const def: AiFlowDefinition = definition;

  const testMode = isTestModeTrigger(asRecord(run.context.trigger));
  const scope: Scope = {
    vars: asRecord(run.context.vars),
    trigger: asRecord(run.context.trigger),
    captureScreenshots: def.options?.captureStepScreenshots === true,
    // A test run must finish in seconds: its sends are simulated anyway, so
    // the business-hours gate (which would defer the run to the next open
    // slot) is skipped entirely.
    ...(def.timeWindow && !testMode ? { timeWindow: def.timeWindow } : {})
  };
  if (testMode) scope.testMode = true;
  // Default the claim sentinel to "none" so a claim-gated step
  // (when: { var: "claimed_agent", notEquals: "none" }) stays CLOSED until a
  // route_to_team actually records a claim — an absent var would otherwise trim
  // to "" and spuriously satisfy notEquals. Only seed when missing so a resume
  // (route_to_team waits across invocations) never clobbers a real claim that
  // was already persisted into run.context.vars.
  if (scope.vars.claimed_agent === undefined) {
    scope.vars.claimed_agent = "none";
  }
  // Same seeding rule for the claimer's phone ("none") and stated ETA ("0"):
  // closed/zero until a route_to_team actually records a claim, never
  // clobbering a persisted claim on resume.
  if (scope.vars.claimed_agent_phone === undefined) {
    scope.vars.claimed_agent_phone = "none";
  }
  if (scope.vars.claimed_agent_eta_minutes === undefined) {
    scope.vars.claimed_agent_eta_minutes = "0";
  }
  // Engine-provided {{vars.group_lead_phone}}: in a group-text trigger (e.g. a
  // referral service's intro thread) the lead's number never appears in the
  // message TEXT — it's the one thread participant who is neither the sender
  // (the service) nor any of the business's own numbers. Seeded once at run
  // start ("" for non-group triggers or an ambiguous roster) and persisted via
  // buildContext like every other var, so parks/resumes never recompute it.
  // Two safety gates, both required:
  //   - GROUP threads only (3+ participants, the same > 2 rule the inbound
  //     webhook stamps trigger.group with): a 1:1 thread always has a
  //     two-number roster, and an empty/unparseable trigger.from there would
  //     otherwise leave the customer as the sole "group lead".
  //   - The sender must be PINNED by a from_matches trigger condition
  //     (senderPinnedByFromMatches): "roster minus sender minus us = the lead"
  //     only holds when the author declared who the sender is. Without a pin
  //     the sender could BE the lead — and the remainder would be the referral
  //     service, a mis-target this var must never carry.
  if (scope.vars.group_lead_phone === undefined) {
    const participants = Array.isArray(scope.trigger.participants)
      ? scope.trigger.participants
      : [];
    const from = typeof scope.trigger.from === "string" ? scope.trigger.from : "";
    let pinned = false;
    if (participants.length > 2 && from) {
      const triggers = flowTriggers(def);
      // from_matches saved-person refs resolve to live identity values, same
      // as trigger evaluation. Resolution failure fails CLOSED (no pin, var
      // seeds "") — a lookup blip must never mislabel a lead.
      let refValues: ReadonlyMap<string, string[]> | undefined;
      const refConds = triggers
        .filter((t): t is SmsTrigger => t.channel === "sms")
        .flatMap((t) => t.conditions)
        .filter((c) => c.type === "from_matches" && c.ref);
      if (refConds.length > 0) {
        try {
          refValues = await resolveFromMatchesRefValues(supabase, run.business_id, refConds);
        } catch (e) {
          console.error("group_lead_phone ref resolution", e);
        }
      }
      pinned = senderPinnedByFromMatches(triggers, from, refValues);
    }
    scope.vars.group_lead_phone = pinned
      ? groupLeadPhone(participants, [
          from,
          typeof scope.trigger.to === "string" ? scope.trigger.to : "",
          ...(await businessSelfNumbers(supabase, run.business_id))
        ])
      : "";
  }
  // Resolve (and self-heal) the business's dedicated AI mailbox up front so every
  // outbound email sends AS the coworker — never the platform identity — and so
  // flows can reference {{coworker.email}} in templates.
  const mailbox = await ensureMailboxIdentity(supabase, run.business_id);
  scope.coworker = { email: mailbox.address };
  // Relative-date tokens ({{now.*}}) in the business timezone, so a step can
  // template a follow-up like "tomorrow afternoon" without hard-coding dates.
  try {
    const { data: tzRow } = await supabase
      .from("businesses")
      .select("timezone")
      .eq("id", run.business_id)
      .maybeSingle();
    const tz = (tzRow as { timezone?: string | null } | null)?.timezone ?? null;
    scope.now = buildNowScope(Date.now(), tz);
  } catch (e) {
    console.error("executeRun buildNowScope", e);
    scope.now = buildNowScope(Date.now(), null);
  }
  const approval = asRecord(run.context.approval);
  // route_to_team state: tried[], the currently-offered agent, and last_event
  // (claim/reject/timeout) stamped by the inbound webhook / escalation sweep.
  const routing = asRecord(run.context.routing);

  // Branch arms are stored nested but the run state machine is a flat integer
  // cursor, so execute over the deterministic flattened order (see
  // _shared/ai_flows/branching.ts). For flows without branch steps this is
  // exactly def.steps, index for index.
  const flat = flattenSteps(def.steps);

  let index = run.current_step;
  while (index < flat.length) {
    const { step, branchPath } = flat[index];
    // Cooperative owner cancel: the dashboard "Stop this run" flips the row to
    // `canceled` while we hold the claim. Re-read the live status at the TOP
    // of every iteration (before branch-skip bookkeeping too, so a long skip
    // chain can't march to `done`) so a stopped run quits at the next step
    // boundary — the step already in flight completes, nothing after it runs.
    // Every updateRun below is additionally status-guarded, so even a cancel
    // that lands mid-step can never be overwritten — this check is what stops
    // the remaining SIDE EFFECTS, the guard is what protects the STATE. A
    // read failure proceeds (cancel stays best-effort; the write guard holds).
    try {
      const { data: liveRow } = await supabase
        .from("ai_flow_runs")
        .select("status")
        .eq("id", run.id)
        .maybeSingle();
      if ((liveRow as { status?: string } | null)?.status === "canceled") {
        await stoppedMidExecutionLog(supabase, run, index);
        return;
      }
    } catch (e) {
      console.error("executeRun cancel check", e);
    }
    // A step under an untaken (or not-yet-evaluated) branch arm never runs —
    // recorded "skipped" like a when_unmet skip, so run history shows every
    // path with the untaken ones greyed.
    if (branchPath.length > 0 && !isOnActivePath(branchPath, scope.vars)) {
      await recordStep(supabase, run, index, step, "skipped", { skipped: "branch_not_taken" });
      index += 1;
      await updateRun(supabase, run.id, {
        current_step: index,
        context: buildContext(scope, approval, routing)
      });
      continue;
    }
    let outcome: StepOutcome;
    try {
      outcome = await runStep(supabase, run, step, index, scope, approval, routing);
    } catch (e) {
      // A THROWN (transient) error otherwise leaves the step row stuck at
      // "running" — so a dead-lettered run shows a phantom in-progress step.
      // Finalize the row as "failed" (carrying any diagnostics the step
      // attached, e.g. a screenshot of the page extraction failed on) before
      // re-throwing into the retry/dead-letter handler. On a re-queue the next
      // attempt flips it back to "running" via recordStep at the step's start.
      const diag = e instanceof StepDiagnosticError ? e.result : undefined;
      await recordStep(
        supabase,
        run,
        index,
        step,
        "failed",
        diag,
        e instanceof Error ? e.message : String(e)
      );
      throw e;
    }
    if (outcome.kind === "fail") {
      await recordStep(supabase, run, index, step, "failed", outcome.result, outcome.error);
      await failRun(supabase, run, outcome.error, scope, approval, routing);
      return;
    }
    if (outcome.kind === "pause") {
      await recordStep(supabase, run, index, step, "pending");
      // Dynamic reply options for THIS gate, persisted on the run so the
      // inbound webhook and dashboard render/parse exactly what was offered:
      // approve/skip always lead, "bypass quiet hours" appears only when a
      // later send_sms step has quiet hours configured AND it is currently
      // inside that window (no point offering to skip a window we're not in),
      // and cancel is always the LAST digit.
      const nowMs = Date.now();
      const gateOptions = buildApprovalGateOptions({
        offerQuietBypass: flat
          .slice(index + 1)
          .map((e) => e.step)
          .some(
            (s) =>
              s.type === "send_sms" &&
              s.quietHours != null &&
              !smsQuietDecision(nowMs, {
                timezone: s.quietHours.timezone,
                noSendAfter: s.quietHours.noSendAfter,
                resumeAt: s.quietHours.resumeAt
              }).allowed
          )
      });
      approval.options = gateOptions;
      const parked = await updateRun(supabase, run.id, {
        status: "awaiting_approval",
        current_step: index,
        context: buildContext(scope, approval, routing),
        claimed_at: null
      });
      if (!parked) {
        // The owner stopped the run while this step executed — the park write
        // matched nothing, so the approval prompt must not go out either.
        await stoppedMidExecutionLog(supabase, run, index);
        return;
      }
      // Offer the owner an SMS approval path alongside the dashboard buttons.
      // Best-effort + idempotent: a send failure must not unwind the parked
      // state (that would re-run the gate on retry), and the idempotency key
      // dedupes resends if the run is ever re-queued and re-pauses at this
      // same gate.
      const approvalPrompt =
        typeof approval.prompt === "string" && approval.prompt.trim()
          ? approval.prompt
          : "This automation step is waiting for your approval.";
      try {
        await sendOwnerSms(
          supabase,
          run,
          `${approvalPrompt}\n\n${approvalSmsInstruction(gateOptions)}`,
          `aiflow-approval:${run.id}:${index}`
        );
      } catch (e) {
        console.error("approval prompt SMS failed after park", e);
        await systemLog(supabase, {
          businessId: run.business_id,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_approval_sms_failed",
          message: `Approval prompt SMS failed after park: ${e instanceof Error ? e.message : String(e)}`,
          payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
        });
      }
      await telemetryRecord(supabase, "ai_flow_run_awaiting_approval", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index
      });
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "info",
        event: "ai_flow_run_awaiting_approval",
        message: "Run parked: waiting for owner approval",
        payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
      });
      return;
    }
    if (outcome.kind === "pause_agent") {
      await recordStep(supabase, run, index, step, "pending");
      // Stamp which step this offer parked on so a later late-claim can rewind
      // the run precisely to THIS route_to_team step (a flow may have several,
      // only one of which ran). Survives the owner fallback so the run stays
      // late-claimable after it's handed back.
      routing.step_index = index;
      // Durable copy of the route step index that is NOT cleared when a claim
      // finalizes (unlike step_index). A retroactive UNCLAIM ("86") re-opens a
      // claimed-and-completed run and rewinds it to this step, so it needs the
      // index to survive past the claim.
      routing.route_step_index = index;
      // Persist the parked state BEFORE sending the offer so an inbound 1/2
      // reply can always be matched to this run (state before side effect).
      const parked = await updateRun(supabase, run.id, {
        status: "awaiting_agent",
        current_step: index,
        context: buildContext(scope, approval, routing),
        awaiting_agent_e164: outcome.e164,
        respond_by_at: new Date(Date.now() + outcome.respondByMs).toISOString(),
        claimed_at: null
      });
      if (!parked) {
        // The owner stopped the run while this step executed — the park write
        // matched nothing, so the agent offer must not go out either.
        await stoppedMidExecutionLog(supabase, run, index);
        return;
      }
      // A send failure here leaves the run parked; the escalation sweep moves on
      // to the next agent at the deadline rather than stranding the lead — so we
      // log and stop instead of unwinding the durable parked state.
      try {
        await sendOfferSms(
          supabase,
          run,
          outcome.e164,
          outcome.offerText,
          outcome.idempotencyKey,
          outcome.mediaUrls
        );
      } catch (e) {
        console.error("route_to_team offer send failed after park", e);
        await systemLog(supabase, {
          businessId: run.business_id,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_offer_sms_failed",
          message: `route_to_team offer send failed after park: ${e instanceof Error ? e.message : String(e)}`,
          payload: { run_id: run.id, flow_id: run.flow_id, step_index: index, agent: outcome.e164 }
        });
      }
      await telemetryRecord(supabase, "ai_flow_run_awaiting_agent", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index,
        agent: outcome.e164
      });
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "info",
        event: "ai_flow_run_awaiting_agent",
        message: `Run parked: lead offered to team agent ${outcome.e164}`,
        payload: { run_id: run.id, flow_id: run.flow_id, step_index: index, agent: outcome.e164 }
      });
      return;
    }
    if (outcome.kind === "pause_reply") {
      const respondByIso = new Date(Date.now() + outcome.respondByMs).toISOString();
      await recordStep(supabase, run, index, step, "pending", {
        waiting_for: outcome.e164,
        save_as: outcome.saveAs,
        respond_by: respondByIso
      });
      // Persist the parked state; the inbound webhook matches the lead's next
      // text to this run via context.waiting_reply.from and re-queues it with
      // the reply in context.vars[saveAs]. The timeout sweep
      // (resume_overdue_reply_waits) re-queues with the no_reply sentinel at
      // respond_by_at. Attempt giveback like defer — waiting is not a failure.
      const parked = await updateRun(supabase, run.id, {
        status: "awaiting_reply",
        current_step: index,
        context: {
          ...buildContext(scope, approval, routing),
          waiting_reply: {
            from: outcome.e164,
            save_as: outcome.saveAs,
            marker: outcome.marker,
            step_index: index
          }
        },
        respond_by_at: respondByIso,
        claimed_at: null,
        attempt_count: Math.max(0, run.attempt_count - 1)
      });
      if (!parked) {
        // Owner stopped the run while this step executed; don't log/telemeter
        // a park that never landed.
        await stoppedMidExecutionLog(supabase, run, index);
        return;
      }
      await telemetryRecord(supabase, "ai_flow_run_awaiting_reply", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index
      });
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "info",
        event: "ai_flow_run_awaiting_reply",
        message: `Run parked: waiting for a reply from ${outcome.e164} (until ${respondByIso})`,
        payload: {
          run_id: run.id,
          flow_id: run.flow_id,
          step_index: index,
          from: outcome.e164,
          respond_by: respondByIso
        }
      });
      return;
    }
    if (outcome.kind === "pause_call") {
      const respondByIso = new Date(Date.now() + outcome.respondByMs).toISOString();
      await recordStep(supabase, run, index, step, "pending", {
        calling: outcome.e164,
        call_control_id: outcome.callControlId || null,
        save_as: outcome.saveAs,
        respond_by: respondByIso
      });
      // Persist the parked state; the voice path (bridge transfer tool /
      // telnyx-voice-call-end hangup handler) resumes the run with the call
      // outcome in context.vars[saveAs] via the session's flow_run link. The
      // timeout sweep (resume_overdue_call_waits) re-queues with the
      // no_answer sentinel at respond_by_at. Attempt giveback like defer —
      // waiting on a live call is not a failure.
      const parked = await updateRun(supabase, run.id, {
        status: "awaiting_call",
        current_step: index,
        context: {
          ...buildContext(scope, approval, routing),
          waiting_call: {
            to: outcome.e164,
            call_control_id: outcome.callControlId || null,
            save_as: outcome.saveAs,
            marker: outcome.marker,
            step_index: index
          }
        },
        respond_by_at: respondByIso,
        claimed_at: null,
        attempt_count: Math.max(0, run.attempt_count - 1)
      });
      if (!parked) {
        // Owner stopped the run while the call was being placed; the call
        // itself proceeds (hanging up a live callee mid-greeting would be
        // worse), but nothing resumes — the outcome write no-ops on a
        // canceled run.
        await stoppedMidExecutionLog(supabase, run, index);
        return;
      }
      await telemetryRecord(supabase, "ai_flow_run_awaiting_call", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index
      });
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "info",
        event: "ai_flow_run_awaiting_call",
        message: `Run parked: AI call to ${outcome.e164} in progress (outcome by ${respondByIso})`,
        payload: {
          run_id: run.id,
          flow_id: run.flow_id,
          step_index: index,
          to: outcome.e164,
          call_control_id: outcome.callControlId || null,
          respond_by: respondByIso
        }
      });
      return;
    }
    if (outcome.kind === "defer") {
      const resumeIso = new Date(outcome.resumeAtMs).toISOString();
      await recordStep(supabase, run, index, step, "pending", {
        deferred_until: resumeIso,
        reason: outcome.reason
      });
      // Park the whole run until the resume time: the claim RPC skips queued
      // runs whose earliest_claim_at is in the future. Give back the attempt
      // the claim charged (same as the paused-business defer) — waiting out
      // quiet hours is not a failure and must not drain any budget.
      const deferred = await updateRun(supabase, run.id, {
        status: "queued",
        current_step: index,
        context: buildContext(scope, approval, routing),
        earliest_claim_at: resumeIso,
        claimed_at: null,
        attempt_count: Math.max(0, run.attempt_count - 1)
      });
      if (!deferred) {
        // Owner stopped the run while this step executed; the re-queue lost
        // to the cancel, so don't log/telemeter a deferral that never landed.
        await stoppedMidExecutionLog(supabase, run, index);
        return;
      }
      await telemetryRecord(supabase, "ai_flow_run_deferred_quiet_hours", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index,
        resume_at: resumeIso
      });
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "info",
        event: "ai_flow_run_deferred_quiet_hours",
        message: `Run deferred until ${resumeIso} (${outcome.reason})`,
        payload: { run_id: run.id, flow_id: run.flow_id, step_index: index, resume_at: resumeIso }
      });
      return;
    }
    await recordStep(supabase, run, index, step, outcome.skipped ? "skipped" : "done", outcome.result);
    index += 1;
    if (outcome.endRun) {
      // Late claim: jump to the end so the run completes as done without
      // replaying the steps after route_to_team.
      index = flat.length;
    } else if (outcome.skipNextStep && index < flat.length) {
      // Approval gate decided "skip": the step the gate guards (the one
      // directly after it) is recorded as skipped without running.
      await recordStep(supabase, run, index, flat[index].step, "skipped", {
        skipped: "approval_skipped"
      });
      index += 1;
    }
    await updateRun(supabase, run.id, {
      current_step: index,
      context: buildContext(scope, approval, routing)
    });
  }

  const finished = await updateRun(supabase, run.id, {
    status: "done",
    current_step: index,
    context: buildContext(scope, approval, routing),
    claimed_at: null
  });
  if (!finished) {
    // Owner stopped the run as its last step executed; it stays `canceled`
    // rather than flipping to done, and the logs say so.
    await stoppedMidExecutionLog(supabase, run, index);
    return;
  }
  await telemetryRecord(supabase, "ai_flow_run_done", {
    run_id: run.id,
    business_id: run.business_id,
    steps: index
  });
  await systemLog(supabase, {
    businessId: run.business_id,
    source: "aiflow",
    level: "info",
    event: "ai_flow_run_done",
    message: `Run completed (${index} steps)`,
    payload: { run_id: run.id, flow_id: run.flow_id, steps: index }
  });
}

/**
 * scope.vars flag set when an approval gate is answered with "bypass quiet
 * hours": every later send_sms step in the run sends immediately instead of
 * deferring/emailing inside the quiet window. Underscore-prefixed like the
 * other engine-internal vars (e.g. the after-hours email markers).
 */
const BYPASS_QUIET_HOURS_VAR = "_bypass_quiet_hours";

/**
 * Trace an owner "Stop this run" observed mid-execution (at a step boundary,
 * or via a park write that matched nothing). The run row already says
 * `canceled`; this is the audit line explaining where execution quit.
 */
async function stoppedMidExecutionLog(
  supabase: Supabase,
  run: RunRow,
  index: number
): Promise<void> {
  await systemLog(supabase, {
    businessId: run.business_id,
    source: "aiflow",
    level: "info",
    event: "ai_flow_run_stopped_mid_execution",
    message: `Run stopped by the owner; execution quit at step ${index + 1}`,
    payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
  });
}

/**
 * Step types gated by the flow-level time window (definition.timeWindow):
 * everything that CONTACTS someone. Reads/waits/branches run any time — only
 * the outward touch waits for business hours.
 */
const COMM_STEP_TYPES = new Set<string>([
  "send_sms",
  "send_whatsapp",
  "send_email",
  "notify_owner",
  "route_to_team",
  "share_document",
  // An outbound AI phone call is the most intrusive contact of all — it must
  // never place outside the flow's business-hours window.
  "place_ai_call"
]);

type StepOutcome =
  // skipNextStep: set by an approval gate decided "skip" — the step directly
  // after the gate (the action it guards) is recorded as skipped and never
  // runs, while the rest of the flow continues.
  // endRun: finalize the run immediately after this step WITHOUT running any
  // remaining steps. Used by a route_to_team LATE claim (a "1" on a lapsed
  // offer) and the "86" unclaim, so those paths notify the owner but later
  // steps (email/browse/notify) don't replay.
  | { kind: "ok"; result?: Record<string, unknown>; skipped?: boolean; skipNextStep?: boolean; endRun?: boolean }
  // `result` lets a failing step attach diagnostics (e.g. a screenshot_path of
  // the stuck page) onto the recorded failed step so the dashboard can show it.
  | { kind: "fail"; error: string; result?: Record<string, unknown> }
  | { kind: "pause" }
  | {
      kind: "pause_agent";
      e164: string;
      respondByMs: number;
      // The offer SMS is sent by executeRun AFTER the awaiting_agent state is
      // durably persisted, so an inbound 1/2 reply can always match the run.
      offerText: string;
      idempotencyKey: string;
      // Signed screenshot URL(s) to ride along as MMS media, when configured.
      mediaUrls?: string[];
    }
  // Quiet hours: this step (and the rest of the run) must wait until
  // resumeAtMs. executeRun re-queues the run with earliest_claim_at so the
  // claim RPC skips it until then — no attempt burned, nothing sent.
  | { kind: "defer"; resumeAtMs: number; reason: string }
  // wait_for_reply: park until `e164` texts back (the inbound webhook writes
  // the reply into context.vars[saveAs] and re-queues) or respond_by_at lapses
  // (resume_overdue_reply_waits writes the no_reply sentinel and re-queues).
  // Both paths also stamp vars[marker] so the step completes on re-entry —
  // per step, so a later wait sharing the same saveAs still parks.
  | { kind: "pause_reply"; e164: string; respondByMs: number; saveAs: string; marker: string }
  // place_ai_call: the call was dialed — park until the voice path resumes the
  // run with the outcome (bridge transfer tool / call-end hangup handler) or
  // respond_by_at lapses (resume_overdue_call_waits writes the no_answer
  // sentinel). Same marker semantics as pause_reply.
  | {
      kind: "pause_call";
      e164: string;
      respondByMs: number;
      saveAs: string;
      marker: string;
      /** The dialed leg, when known ("" when re-parking after a crash). */
      callControlId: string;
    };

/** Execute one step's side effect. Throws on transient IO errors (→ retry). */
async function runStep(
  supabase: Supabase,
  run: RunRow,
  step: FlowStep,
  index: number,
  scope: Scope,
  approval: Record<string, unknown>,
  routing: Record<string, unknown>
): Promise<StepOutcome> {
  // Per-step `when` guard: skip (don't run) when the condition is unmet. This is
  // how a flow branches — e.g. a buyer vs. seller send_sms, only one of which
  // fires. Evaluated before recording "running" so a skipped step is never shown
  // as having started. EXCEPTION: a goal step the run JUMPED to (its
  // `__goal_<id>` var is stamped) ignores its guard — the milestone already
  // fired, and letting a stale condition skip the checkpoint would resume the
  // very follow-ups the jump exists to stop.
  const jumpedToGoal =
    step.type === "goal" && typeof scope.vars[goalReachedVar(step.id)] === "string" &&
    scope.vars[goalReachedVar(step.id)] !== "";
  if (step.when && !jumpedToGoal && !evaluateStepCondition(step.when, scope)) {
    return { kind: "ok", skipped: true, result: { skipped: "when_unmet", when: step.when } };
  }
  // Flow-level time window (definition.timeWindow): a communication step
  // outside the window defers the whole run to the next open slot — the same
  // earliest_claim_at mechanics as send_sms quiet hours, which still apply on
  // top per step. Checked AFTER the `when` guard so a step that would skip
  // anyway never parks the run, and before recording "running".
  if (scope.timeWindow && COMM_STEP_TYPES.has(step.type)) {
    const decision = timeWindowDecision(Date.now(), scope.timeWindow);
    if (!decision.allowed) {
      return { kind: "defer", resumeAtMs: decision.resumeAtMs, reason: "flow_time_window" };
    }
  }
  await recordStep(supabase, run, index, step, "running");
  // planStep's switch is compile-time exhaustive, but at RUNTIME a stored
  // definition can carry a step type this deploy predates (two agents
  // deploying in parallel raced exactly this way once — the old worker died
  // with a bare TypeError). Fail readably instead so the run history says
  // what to do.
  const plan = planStep(step, scope) as ReturnType<typeof planStep> | undefined;
  if (!plan) {
    return {
      kind: "fail",
      error:
        `unknown step type "${step.type}" — this ai-flow-worker deploy is older than the flow definition; redeploy the worker from main`
    };
  }
  // Test run: side-effecting actions are simulated (their rendered output IS
  // the step result) and waits resolve instantly; read-only/pure actions run
  // for real so extraction, branching, and goals behave exactly like a live
  // run. Checked before the plan-error path so a test run surfaces the same
  // "missing input" failures a live run would.
  if (scope.testMode && plan.ok) {
    const simulated = simulateTestAction(plan.action, scope);
    if (simulated) {
      // A simulated SKIP (planner skipReason — e.g. no usable recipient) is
      // recorded as skipped, exactly like the live path, so a test run never
      // claims it sent something the live run would not.
      if (typeof simulated.skipped === "string") {
        appendActionTaken(
          scope,
          `TEST run: skipped ${plan.action.kind} (${simulated.skipped})`
        );
        return { kind: "ok", skipped: true, result: simulated };
      }
      appendActionTaken(scope, `TEST run: simulated ${plan.action.kind}`);
      return { kind: "ok", result: simulated };
    }
  }
  if (!plan.ok) {
    // When the self-number scrub emptied THIS step's phone var earlier in the
    // run, an unusable-phone failure here is the scrub's doing — text the
    // owner a plain-words explanation alongside the failed run (which
    // otherwise reads as a technical error; the exact confusion from Truly's
    // office-line test). Gated on the failing step's own phoneVar being among
    // the scrubbed vars (a different scrubbed field with an already-empty
    // phoneVar is a plain no-phone lead, not the business's number). Sent at
    // failure time, not scrub time, because a later extraction step can still
    // backfill a real phone. Best-effort + idempotent per run.
    if (step.type === "upsert_customer" && selfScrubbedVars(scope).includes(step.phoneVar)) {
      try {
        await sendOwnerSms(
          supabase,
          run,
          "A lead just came in, but their phone number matched your own business number, so I can't text them (this happens when a test form uses the office line, or a lead source page shows your number). Check the lead's real number and reach out directly.",
          `aiflow-selfphone:${run.id}`
        );
      } catch (e) {
        console.error("self-phone scrub owner notice failed", e);
      }
    }
    return { kind: "fail", error: plan.error };
  }
  const action = plan.action;

  switch (action.kind) {
    case "set_vars":
      Object.assign(scope.vars, action.vars);
      return { kind: "ok", result: { vars: action.vars } };
    case "browse":
      return browseStep(supabase, run, index, scope, action);
    case "extract_text":
      return extractTextStep(supabase, run, scope, action);
    case "email_extract":
      return emailExtractStep(supabase, run, scope, action);
    case "doc_extract":
      return docExtractStep(supabase, run, scope, action);
    case "send_sms":
      return sendSmsStep(supabase, run, index, scope, action);
    case "send_whatsapp":
      return sendWhatsAppStep(supabase, run, scope, action);
    case "send_email":
      return sendEmailStep(supabase, run, index, scope, action);
    case "share_document":
      return shareDocumentStep(supabase, run, index, scope, action);
    case "run_agent":
      return runAgentStep(scope, run, action);
    case "notify_owner":
      return notifyOwnerStep(supabase, run, action);
    case "http_call":
      return httpCallStep(run, scope, action);
    case "await_approval":
      return approvalStep(approval, scope, index, action);
    case "route_to_team":
      // The routing grab-bag is owned by this worker; the typed contract
      // (OfferRouting) makes every field read/write key-checked while the
      // in-place mutation semantics (persisted via context) are preserved.
      // `index` is the rewind target auto-assignment stamps as
      // route_step_index (offer mode stamps it later, at park time).
      return routeToTeamStep(supabase, run, scope, action, routing as OfferRouting, index);
    case "browse_action":
      return browseActionStep(supabase, run, index, scope, action);
    case "recall_url":
      return recallUrlStep(supabase, run, scope, action);
    case "upsert_customer":
      return upsertCustomerStep(supabase, run, scope, action);
    case "update_contact":
      return updateContactStep(supabase, run, scope, action);
    case "classify":
      return classifyStep(supabase, run, scope, action);
    case "generate_image":
      return generateImageStep(supabase, run, scope, action);
    case "goal":
      // Checkpoint marker: the interesting work (the jump) happened in
      // applyGoalEvent when the external milestone landed; executing the
      // step just records how the run arrived here.
      appendActionTaken(
        scope,
        action.reachedVia === "passed_inline"
          ? `passed goal "${action.label}"`
          : `jumped to goal "${action.label}" (${action.reachedVia})`
      );
      return { kind: "ok", result: { goal: action.label, reached_via: action.reachedVia } };
    case "sleep":
      return sleepStep(scope, action);
    case "wait_for_reply":
      return {
        kind: "pause_reply",
        e164: action.from,
        respondByMs: action.timeoutMinutes * 60_000,
        saveAs: action.saveAs,
        marker: action.marker
      };
    case "place_ai_call":
      return placeAiCallStep(supabase, run, index, scope, action);
  }
}

/**
 * Pause-then-continue: compute the resume instant, stamp the re-entry marker
 * (persisted with the deferred context so the step is a no-op after the
 * wait), and defer the run via earliest_claim_at. Fails OPEN on a bad
 * timezone (skip the wait, note why) — a config typo must not brick the run.
 */
function sleepStep(
  scope: Scope,
  action: Extract<StepAction, { kind: "sleep" }>
): StepOutcome {
  const nowMs = Date.now();
  let resumeAtMs: number | null = null;
  if (action.minutes !== undefined) {
    resumeAtMs = nowMs + action.minutes * 60_000;
  } else if (action.untilTime && action.timezone) {
    const target = parseHHMM(action.untilTime);
    resumeAtMs = target === null ? null : nextTimeOfDayMs(nowMs, action.timezone, target);
  } else if (action.untilIso !== undefined) {
    // Date-anchored wait (untilDateTemplate / relativeToTemplate): the
    // planner already rendered + offset the instant. null = unparseable
    // render → fail open below. A PAST instant means there is nothing to
    // wait for — continue immediately rather than deferring a whole tick.
    const targetMs = action.untilIso === null ? NaN : Date.parse(action.untilIso);
    if (Number.isFinite(targetMs) && targetMs <= nowMs) {
      scope.vars[action.marker] = "1";
      return {
        kind: "ok",
        result: { slept: "target_in_past", until: action.untilIso }
      };
    }
    resumeAtMs = Number.isFinite(targetMs) ? targetMs : null;
  }
  if (resumeAtMs === null) {
    return {
      kind: "ok",
      skipped: true,
      result: {
        skipped: "sleep_invalid_config",
        untilTime: action.untilTime,
        timezone: action.timezone,
        ...(action.untilIso !== undefined ? { untilIso: action.untilIso } : {})
      }
    };
  }
  // Bound the wait (the planner caps minutes; untilTime is < 24h by nature).
  resumeAtMs = Math.min(resumeAtMs, nowMs + MAX_WAIT_MINUTES * 60_000);
  scope.vars[action.marker] = "1";
  return { kind: "defer", resumeAtMs, reason: "sleep" };
}

/**
 * Durably log a worker-sent SMS so it shows up in the dashboard Text history
 * (which otherwise only sees inbound conversations). Best-effort: a logging
 * failure must never fail a send that already happened.
 */
async function logOutboundSms(
  supabase: Supabase,
  run: RunRow,
  args: {
    to: string;
    from: string | null;
    body: string;
    source: "ai_flow" | "agent_offer" | "owner_notify";
    telnyxMessageId?: string | null;
    /** Delivery channel ('sms' default keeps owner/offer sends untagged-as-sms). */
    channel?: "sms" | "rcs";
  }
): Promise<string | null> {
  const { data, error } = await supabase
    .from("sms_outbound_log")
    .insert({
      business_id: run.business_id,
      to_e164: args.to,
      from_e164: args.from,
      body: args.body,
      source: args.source,
      run_id: run.id,
      flow_id: run.flow_id,
      telnyx_message_id: args.telnyxMessageId ?? null,
      channel: args.channel ?? "sms"
    })
    .select("id")
    .single();
  if (error) {
    console.error("sms_outbound_log insert", error);
    return null;
  }
  return (data as { id: string }).id;
}

/**
 * Durably log a flow-sent email for the dashboard Emails page. Best-effort:
 * a logging failure must never fail a send that already happened.
 */
async function logFlowEmail(
  supabase: Supabase,
  run: RunRow,
  args: {
    to: string;
    cc?: string[];
    bcc?: string[];
    from: string | null;
    subject: string;
    body: string;
    source: "ai_flow" | "owner_mailbox" | "tenant_mailbox_outbound";
    providerMessageId?: string | null;
    attachments?: {
      filename: string;
      mime_type: string;
      size_bytes: number;
      storage_path: string;
      bucket: string;
    }[];
  }
): Promise<void> {
  const { error } = await supabase.from("email_log").insert({
    business_id: run.business_id,
    direction: "outbound",
    to_email: args.to,
    cc_email: args.cc && args.cc.length > 0 ? args.cc.join(", ") : null,
    bcc_email: args.bcc && args.bcc.length > 0 ? args.bcc.join(", ") : null,
    from_email: args.from,
    subject: args.subject,
    body_preview: args.body.slice(0, 500),
    body_full: args.body,
    source: args.source,
    run_id: run.id,
    flow_id: run.flow_id,
    provider_message_id: args.providerMessageId ?? null,
    attachments: args.attachments ?? []
  });
  if (error) console.error("email_log insert", error);
}

/** Conservative email shape check for lead-supplied addresses (no whitespace, one @). */
const LEAD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * True when this number is saved as a manual (non-customer) contact on the
 * unified `contacts` table — i.e. a known vendor/integration sender (Clever's
 * numbers, a title company), the owner, or a tester, not a lead. Used to keep
 * such numbers off the Customers page. A row with type='customer' is a real
 * customer profile, so it does NOT count as a business contact. Best-effort: on
 * a query error we return false so a transient DB blip never silently drops a
 * real lead profile.
 */
async function isKnownBusinessContact(
  supabase: Supabase,
  businessId: string,
  e164: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("contacts")
    .select("type")
    .eq("business_id", businessId)
    .eq("customer_e164", e164)
    .maybeSingle();
  if (error) {
    console.error("isKnownBusinessContact (aiflow lead)", error);
    return false;
  }
  return data != null && (data as { type?: string }).type !== "customer";
}

/**
 * Create/enrich a customer profile keyed by an E.164 number, filling display
 * name + email best-effort. Shared by the lead-contact side effect
 * (recordLeadCustomerProfile) and the explicit `upsert_customer` step. Known
 * business contacts (Clever's own numbers, the owner, vendors saved as "other
 * contacts") are never filed — this keeps the Customers page clean and prevents
 * stamping a lead's name onto a co-recipient business number. Fill-only on
 * email so a later run / owner edit is never clobbered. Best-effort: a profile
 * failure only logs (the contact/extraction already succeeded).
 */
async function enrichCustomerProfile(
  supabase: Supabase,
  businessId: string,
  customerE164: string,
  name: string,
  email: string
): Promise<void> {
  if (await isKnownBusinessContact(supabase, businessId, customerE164)) return;

  const { data: interaction, error } = await supabase.rpc("record_customer_interaction", {
    p_business_id: businessId,
    p_customer_e164: customerE164,
    p_channel: "sms",
    p_display_name: name ? name : null
  });
  if (error) {
    console.error("record_customer_interaction (aiflow lead)", error);
    return;
  }

  // The RPC returns the row it actually bumped — which is the SURVIVING profile
  // when customerE164 was a merged-away alias. Target the email update at that
  // row's primary key so the link lands even after a merge (the merged-away
  // number no longer exists as a customer_e164).
  const profile = Array.isArray(interaction) ? interaction[0] : interaction;
  const targetE164 =
    profile && typeof profile.customer_e164 === "string" ? profile.customer_e164 : null;
  if (email && LEAD_EMAIL_RE.test(email) && targetE164) {
    const { error: emailErr } = await supabase
      .from("contacts")
      .update({ email, updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("customer_e164", targetE164)
      .is("email", null);
    if (emailErr) console.error("record lead email (aiflow lead)", emailErr);
  }
}

/**
 * Upsert a customer profile for a lead the flow just contacted, so every
 * AiFlow lead shows up on the dashboard Customers page like SMS/voice
 * customers do. Best-effort: the contact already succeeded, so a profile
 * failure only logs.
 */
async function recordLeadCustomerProfile(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  customerE164: string
): Promise<void> {
  // Enrich from whatever the flow captured: scan conventional name/email keys
  // (lead_name, seller_first_name, full_name, …) so any extracting flow fills
  // the customer in, not just ones using the exact `lead_name` key.
  const identity = extractLeadIdentity(scope.vars);
  // This helper also runs for every group-reply recipient (a teammate, the
  // owner) — only the LEAD should get the extracted name/email, never a
  // co-recipient. The lead is the recipient matching vars.lead_phone when the
  // flow captured it; when it didn't (e.g. the Clever group reply, which only
  // has seller_first_name), known business contacts are skipped inside
  // enrichCustomerProfile, so the remaining recipient is the lead. Compare
  // normalized E.164 so a format mismatch between vars.lead_phone and the send
  // target doesn't skip it.
  const leadPhone = leadPhoneE164(scope);
  const isLeadNumber = !leadPhone || leadPhone === customerE164;
  await enrichCustomerProfile(
    supabase,
    run.business_id,
    customerE164,
    isLeadNumber ? (identity.name ?? "") : "",
    isLeadNumber ? (identity.email ?? "") : ""
  );
}

/**
 * `upsert_customer` step: file/fill the customer keyed by the resolved phone,
 * using the name/email the planner read from earlier-step vars. Unlike
 * recordLeadCustomerProfile (a side effect of a send), this is an explicit
 * step, so the phone IS the lead — no co-recipient gating needed.
 */
/**
 * How long a prior run of the same flow for the same lead phone suppresses a
 * new introduction. Mirrors the 72h conversation-context lookback
 * (FLOW_CONTEXT_LOOKBACK_HOURS): while the earlier thread still counts as
 * live context for the reply path, a re-submission is a repeat, not a new
 * lead.
 */
const DUPLICATE_LEAD_WINDOW_HOURS = 72;

/**
 * Prior non-test, non-failed run of the SAME flow that already handled this
 * lead phone within the window → its id; null otherwise. Only lead-intake
 * triggers (tenant_email / webhook) are guarded. Strictly-earlier created_at
 * ordering (vs this run) keeps two same-batch duplicates from suppressing
 * each other into silence — exactly one of them wins.
 *
 * Lead identity uses the SAME keys as the reply path's flow-context lookup
 * (run_context.ts / goal_events): the triggering sender, the extracted
 * lead_phone var, or the number a wait is parked on — trigger.from and
 * waiting_reply.from are always E.164, so a prior run whose extraction
 * stored a formatted lead_phone still matches on those (Bugbot Mediums on
 * PR #575). A flow filing leads under a fully custom var name degrades to
 * pre-guard behavior (a duplicate intro), never a lost lead.
 *
 * A CANCELED prior run counts only when it actually texted the lead before
 * being stopped — an owner canceling a run pre-outreach must not make the
 * lead's next submission fall silent (Bugbot Medium on PR #575).
 *
 * Best-effort throughout: any read failure returns null (fail open).
 */
async function findDuplicateLeadRun(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  leadE164: string
): Promise<string | null> {
  const channel = typeof scope.trigger?.channel === "string" ? scope.trigger.channel : "";
  if (channel !== "tenant_email" && channel !== "webhook") return null;
  try {
    const { data: selfRow, error: selfErr } = await supabase
      .from("ai_flow_runs")
      .select("created_at")
      .eq("id", run.id)
      .maybeSingle();
    const myCreatedAt = (selfRow as { created_at?: string } | null)?.created_at;
    if (selfErr || !myCreatedAt) return null;
    const sinceIso = new Date(
      Date.now() - DUPLICATE_LEAD_WINDOW_HOURS * 3_600_000
    ).toISOString();
    // Shared filter shape for both passes below. updated_at (not created_at):
    // a long-running/parked run enqueued more than 72h ago is still a live
    // conversation for the reply path (which looks back on updated_at too) —
    // a repeat submission during it must still be suppressed. The second
    // .or() excludes simulated test runs (they never texted the lead).
    // (Bugbot Mediums on PR #575.)
    const priorRunsQuery = () =>
      supabase
        .from("ai_flow_runs")
        .select("id, status")
        .eq("business_id", run.business_id)
        .eq("flow_id", run.flow_id)
        .neq("id", run.id)
        .or(
          `context->trigger->>from.eq.${leadE164},context->vars->>lead_phone.eq.${leadE164},context->waiting_reply->>from.eq.${leadE164}`
        )
        .gte("updated_at", sinceIso)
        .lt("created_at", myCreatedAt)
        .or("context->trigger->>test_mode.is.null,context->trigger->>test_mode.neq.true")
        .order("created_at", { ascending: false });

    // Pass 1: any live/finished prior run qualifies outright. Queried
    // separately from the canceled pass so a stack of silent cancels can
    // never push a real qualifying run past a row limit (Bugbot Medium on
    // PR #575, second round).
    const { data: activePrior, error: activeErr } = await priorRunsQuery()
      .not("status", "in", "(failed,canceled)")
      .limit(1)
      .maybeSingle();
    if (activeErr) {
      console.error("duplicate-lead guard lookup", activeErr);
      return null;
    }
    const activeId = (activePrior as { id?: string } | null)?.id;
    if (activeId) return activeId;

    // Pass 2: canceled runs qualify only if they reached the lead before
    // being stopped (an owner cancel pre-outreach must not silence the
    // lead's next submission).
    const { data: canceledRows, error: canceledErr } = await priorRunsQuery()
      .eq("status", "canceled")
      .limit(5);
    if (canceledErr) {
      console.error("duplicate-lead guard canceled lookup", canceledErr);
      return null;
    }
    for (const prior of (canceledRows ?? []) as Array<{ id: string }>) {
      const { data: sent, error: sentErr } = await supabase
        .from("sms_outbound_log")
        .select("id")
        .eq("business_id", run.business_id)
        .eq("run_id", prior.id)
        .eq("to_e164", leadE164)
        .limit(1)
        .maybeSingle();
      if (sentErr) {
        console.error("duplicate-lead guard outbound check", sentErr);
        continue;
      }
      if (sent) return prior.id;
    }
    return null;
  } catch (e) {
    console.error("duplicate-lead guard", e);
    return null;
  }
}

async function upsertCustomerStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "upsert_customer" }>
): Promise<StepOutcome> {
  // Existence pre-check (alias-aware) so the contact_created trigger below
  // fires only for genuinely NEW contacts, never enrichments. Best-effort: a
  // read failure just means no trigger fires this pass — except on backfill
  // runs, where it fails SAFE (treated as existing, run ends) below.
  let existedBefore = true;
  let precheckFailed = false;
  try {
    const { data: existing, error: existErr } = await supabase
      .from("contacts")
      .select("id")
      .eq("business_id", run.business_id)
      .or(`customer_e164.eq.${action.e164},alias_e164s.cs.{${action.e164}}`)
      .maybeSingle();
    if (existErr) precheckFailed = true;
    else existedBefore = existing != null;
  } catch (e) {
    console.error("upsert_customer existence pre-check", e);
    precheckFailed = true;
  }
  // Email-replay backfill: the lead already has a contact row, so the
  // original run (or the owner) already reached out — finalize as done here
  // rather than continuing to send_sms/wait_for_reply and double-texting.
  // A failed pre-check counts as existing (fail safe: skipping one lead
  // beats spamming one). New leads fall through and run the full flow.
  if (isBackfillSkipExistingTrigger(scope.trigger) && (existedBefore || precheckFailed)) {
    appendActionTaken(
      scope,
      `backfill: ${action.e164} already exists as a contact — no outreach sent`
    );
    return {
      kind: "ok",
      skipped: true,
      endRun: true,
      result: {
        skipped: "backfill_contact_exists",
        customer_e164: action.e164,
        ...(precheckFailed
          ? { note: "existence check failed; treated as existing (fail safe)" }
          : {})
      }
    };
  }
  // Duplicate lead submission guard (Truly Insurance, 2026-07-13): the same
  // lead source re-submitting the same phone number within the window must
  // UPDATE the contact and flag the owner — never re-run the introduction.
  // Production showed five intro texts to one number in four minutes (one
  // per Privyr submission) and a second intro to an in-progress lead 1.75h
  // into their conversation. Scoped to lead-intake triggers (tenant_email /
  // webhook): contact-event and manual runs legitimately re-run for the
  // same phone. Detection is best-effort and FAILS OPEN — a duplicate intro
  // beats a lost lead.
  const duplicateOfRunId = isTestModeTrigger(scope.trigger)
    ? null
    : await findDuplicateLeadRun(supabase, run, scope, action.e164);
  await enrichCustomerProfile(supabase, run.business_id, action.e164, action.name, action.email);
  if (duplicateOfRunId) {
    const label = action.name ? `${action.name} (${action.e164})` : action.e164;
    appendActionTaken(
      scope,
      `duplicate lead submission for ${action.e164} — contact updated, no new outreach (prior run ${duplicateOfRunId})`
    );
    // Tell the owner once so the repeat isn't silent — someone may have
    // re-submitted the form on purpose and expects a human to look.
    await sendOwnerSms(
      supabase,
      run,
      `Heads up: ${label} submitted the lead form again. I updated their contact details but did NOT send another intro — their existing conversation continues. Review them on your dashboard if follow-up is needed.`,
      `aiflow-duplicate-lead:${run.id}`
    );
    await telemetryRecord(supabase, "ai_flow_duplicate_lead_suppressed", {
      run_id: run.id,
      flow_id: run.flow_id,
      business_id: run.business_id,
      duplicate_of: duplicateOfRunId
    });
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "info",
      event: "ai_flow_duplicate_lead_suppressed",
      message: `Repeat lead submission for ${action.e164}: contact updated, intro suppressed, owner notified`,
      payload: { run_id: run.id, flow_id: run.flow_id, duplicate_of: duplicateOfRunId }
    });
    return {
      kind: "ok",
      skipped: true,
      endRun: true,
      result: {
        skipped: "duplicate_lead_submission",
        duplicate_of: duplicateOfRunId,
        customer_e164: action.e164,
        display_name: action.name || null,
        email: action.email || null
      }
    };
  }
  if (!existedBefore) {
    // contact_created triggers: a flow that files a brand-new lead may start
    // OTHER flows (loop-guarded against this one). Fired only when the row
    // verifiably EXISTS now — enrichCustomerProfile is best-effort and can
    // exit without creating anything (staff-contact guard, RPC failure), and
    // a "new contact" event for a lead that was never filed would start
    // automations on a phantom. A verify-read failure just skips the event.
    try {
      const { data: createdRow, error: verifyErr } = await supabase
        .from("contacts")
        .select("id")
        .eq("business_id", run.business_id)
        .or(`customer_e164.eq.${action.e164},alias_e164s.cs.{${action.e164}}`)
        .maybeSingle();
      if (!verifyErr && createdRow != null) {
        await enqueueContactEventRuns(supabase, run.business_id, {
          kind: "contact_created",
          contact: {
            e164: action.e164,
            ...(action.name ? { name: action.name } : {}),
            ...(action.email ? { email: action.email } : {})
          },
          sourceFlowId: run.flow_id,
          // Keyed to THIS run (idempotent across step retries) rather than
          // the phone forever — a deleted-then-refiled contact is a new
          // creation.
          dedupeKey: `ce:created:${action.e164}:${run.id}`
        });
      }
    } catch (e) {
      console.error("upsert_customer contact_created verify", e);
    }
  }
  return {
    kind: "ok",
    result: {
      customer_e164: action.e164,
      display_name: action.name || null,
      email: action.email || null
    }
  };
}

/**
 * Is this contact protected staff for update_contact purposes? True when the
 * stored row is typed owner/employee, or any of its numbers sits on the
 * ai_flow_team_members roster (active or not — a deactivated broker is still
 * staff), or matches the business's own derived numbers (owner cell, forward
 * number, the coworker's DID — owner rows are often typed "customer"), AND
 * the business hasn't switched the protection off in Settings
 * (businesses.aiflow_protect_staff_contacts, default true). Read errors fail
 * SAFE (protected).
 */
async function isProtectedStaffContact(
  supabase: Supabase,
  businessId: string,
  contactNumbers: string[],
  storedType: string | null | undefined
): Promise<boolean> {
  let staff = storedType === "owner" || storedType === "employee";
  if (!staff) {
    // Roster check spans EVERY number attached to the contact row (primary +
    // merged aliases + the targeted number): the contact lookup is
    // alias-aware, so protection must be too — a flow targeting an alias of
    // a broker's row is still targeting the broker.
    const { data: member, error } = await supabase
      .from("ai_flow_team_members")
      .select("id")
      .eq("business_id", businessId)
      .in("phone_e164", contactNumbers)
      .limit(1)
      .maybeSingle();
    if (error) {
      // Fail SAFE: if we can't check the roster, treat the contact as staff
      // rather than risk tagging a broker's row.
      console.error("update_contact roster check", error);
      return true;
    }
    staff = member != null;
  }
  if (!staff) {
    // Owner numbers are usually DERIVED (businesses.phone, the forward cell,
    // the coworker's own DID) rather than stored as an owner-typed contact —
    // an owner testing with their cell must be protected too. isSelfPhone is
    // the SHARED both-sides-normalized comparator (same one the extraction
    // scrub and send_sms self-send guard use), so the guards can never
    // disagree on what counts as "ourselves".
    const selfNumbers = await businessSelfNumbers(supabase, businessId);
    staff = contactNumbers.some((n) => isSelfPhone(n, selfNumbers));
  }
  if (!staff) return false;
  const { data: biz, error: bizErr } = await supabase
    .from("businesses")
    .select("aiflow_protect_staff_contacts")
    .eq("id", businessId)
    .maybeSingle();
  if (bizErr) {
    console.error("update_contact protection setting read", bizErr);
    return true; // fail safe: protect
  }
  return (biz as { aiflow_protect_staff_contacts?: boolean } | null)
    ?.aiflow_protect_staff_contacts !== false;
}

/**
 * `update_contact` step: maintain the contact's lead-state tags. Removals
 * apply before additions (one step = one status transition), matching is
 * alias-aware like getCustomerMemory, and tags are normalized the way the
 * dashboard write path does (trim, case-insensitive de-dup, 25-tag cap).
 * A missing phone (planner skipReason) or missing contact row SKIPS with a
 * note — tag bookkeeping must never fail an otherwise-healthy run.
 */
async function updateContactStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "update_contact" }>
): Promise<StepOutcome> {
  if (action.skipReason) {
    // Mirror the send_sms skip path: the note keeps {{vars.actions_taken}}
    // honest for downstream steps ("tagging never ran, and here's why").
    appendActionTaken(scope, "skipped a contact-tag update (no usable phone)");
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }
  const { data, error } = await supabase
    .from("contacts")
    .select("id, tags, type, customer_e164, alias_e164s")
    .eq("business_id", run.business_id)
    .or(`customer_e164.eq.${action.e164},alias_e164s.cs.{${action.e164}}`)
    .maybeSingle();
  if (error) throw new Error(`update_contact lookup: ${error.message}`);
  const contact = data as {
    id: string;
    tags?: string[] | null;
    type?: string | null;
    customer_e164?: string | null;
    alias_e164s?: string[] | null;
  } | null;
  if (!contact) {
    appendActionTaken(
      scope,
      `skipped a contact-tag update (no contact on file for ${action.e164})`
    );
    return {
      kind: "ok",
      skipped: true,
      result: { skipped: "contact_not_found", customer_e164: action.e164 }
    };
  }
  // Staff-contact protection (default ON, toggled from Settings): lead-state
  // tags never land on the owner or a roster member — the classic trap is an
  // employee testing a flow with their own number (upsert_customer has the
  // same philosophy via its known-business-contact guard). Staff = a stored
  // owner/employee type, OR any of the row's numbers (primary, merged
  // aliases, the targeted number) on the ai_flow_team_members roster — the
  // roster is authoritative even when the stored row is typed "customer".
  const contactNumbers = [
    ...new Set(
      [action.e164, contact.customer_e164 ?? "", ...(contact.alias_e164s ?? [])].filter(Boolean)
    )
  ];
  if (
    await isProtectedStaffContact(supabase, run.business_id, contactNumbers, contact.type)
  ) {
    appendActionTaken(
      scope,
      `skipped a contact-tag update (${action.e164} is a staff contact; protection is on in Settings)`
    );
    return {
      kind: "ok",
      skipped: true,
      result: { skipped: "staff_contact_protected", customer_e164: action.e164 }
    };
  }
  const removeSet = new Set(action.removeTags.map((t) => t.trim().toLowerCase()));
  const seen = new Set<string>();
  const next: string[] = [];
  // Tags actually stripped from the row (vs. merely CONFIGURED removals that
  // were never present) — the actions_taken note must not over-claim.
  const removed: string[] = [];
  // Existing tags (minus removals) survive unconditionally — the DB cap
  // guarantees there are at most 25 of them, so no truncation is possible.
  for (const t of Array.isArray(contact.tags) ? contact.tags : []) {
    const tag = t.trim().slice(0, 40);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    if (removeSet.has(key)) {
      removed.push(tag);
      continue;
    }
    seen.add(key);
    next.push(tag);
  }
  // Additions are tracked individually so the actions_taken note (and the
  // recorded result) only claim tags that actually landed — a full contact
  // drops the overflow explicitly instead of silently.
  const added: string[] = [];
  const droppedAtCap: string[] = [];
  for (const t of action.addTags) {
    const tag = t.trim().slice(0, 40);
    const key = tag.toLowerCase();
    if (!tag || removeSet.has(key)) continue;
    if (seen.has(key)) continue; // already on the contact — nothing to write
    if (next.length >= 25) {
      droppedAtCap.push(tag);
      continue;
    }
    seen.add(key);
    next.push(tag);
    added.push(tag);
  }
  const { error: updErr } = await supabase
    .from("contacts")
    .update({ tags: next, updated_at: new Date().toISOString() })
    .eq("id", contact.id);
  if (updErr) throw new Error(`update_contact write: ${updErr.message}`);
  // Goal Events: each tag that actually landed may jump OTHER parked/queued
  // runs for this lead to a matching tag_added goal (this running run is
  // untouched — its own goals are passed inline). Runs match by the EXACT
  // number they were triggered with, which after a profile merge may be any
  // of the row's numbers — fan out over all of them (contactNumbers already
  // unions the targeted number, the primary, and the merge aliases).
  // Best-effort by design.
  for (const tag of added) {
    for (const number of contactNumbers) {
      await applyGoalEvent(supabase, run.business_id, number, { kind: "tag_added", tag });
    }
  }
  // tag_changed triggers: added AND removed tags may start OTHER flows (the
  // state-machine chain the channel exists for). sourceFlowId loop-guards
  // this flow from retriggering itself; the dedupe key is idempotent across
  // step retries. Skipped entirely on test runs (this path is unreachable
  // then — update_contact is simulated), so no extra guard needed.
  for (const [changed, change] of [
    ...added.map((t) => [t, "added"] as const),
    ...removed.map((t) => [t, "removed"] as const)
  ]) {
    await enqueueContactEventRuns(supabase, run.business_id, {
      kind: "tag_changed",
      contact: { e164: action.e164, tags: next },
      tag: changed,
      change,
      sourceFlowId: run.flow_id,
      dedupeKey: `ce:tag:${run.id}:${changed.toLowerCase()}:${change}`
    });
  }
  appendActionTaken(
    scope,
    `updated contact tags for ${action.e164}` +
      (added.length > 0 ? ` (+${added.join(", +")})` : "") +
      (removed.length > 0 ? ` (-${removed.join(", -")})` : "") +
      (droppedAtCap.length > 0
        ? ` — ${droppedAtCap.length} tag(s) not added (25-tag limit): ${droppedAtCap.join(", ")}`
        : "")
  );
  return {
    kind: "ok",
    result: {
      customer_e164: action.e164,
      tags: next,
      ...(droppedAtCap.length > 0 ? { dropped_at_cap: droppedAtCap } : {})
    }
  };
}

/**
 * Append a human description of an outbound contact to the engine-maintained
 * `vars.actions_taken`, so a later step (the ReferralExchange timeline note)
 * can template "what did this flow actually do" via {{vars.actions_taken}}.
 */
function appendActionTaken(scope: Scope, description: string): void {
  const prev = typeof scope.vars.actions_taken === "string" ? scope.vars.actions_taken : "";
  scope.vars.actions_taken = prev ? `${prev}; ${description}` : description;
}

/**
 * The business's OWN phone numbers (tenant DID, owner forward cell, owner
 * profile phone) — the numbers an extracted "lead phone" can never
 * legitimately be. Used to scrub extraction output (see
 * _shared/ai_flows/extracted_contact.ts). Best-effort: a lookup error returns
 * what was found so extraction never fails on this.
 */
async function businessSelfNumbers(supabase: Supabase, businessId: string): Promise<string[]> {
  const out: string[] = [];
  const { data: settings } = await supabase
    .from("business_telnyx_settings")
    .select("telnyx_sms_from_e164, forward_to_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const s = settings as
    | { telnyx_sms_from_e164?: string | null; forward_to_e164?: string | null }
    | null;
  if (s?.telnyx_sms_from_e164) out.push(s.telnyx_sms_from_e164);
  if (s?.forward_to_e164) out.push(s.forward_to_e164);
  const { data: biz } = await supabase
    .from("businesses")
    .select("phone")
    .eq("id", businessId)
    .maybeSingle();
  const phone = (biz as { phone?: string | null } | null)?.phone;
  if (phone) out.push(phone);
  return out;
}

/**
 * Run extraction output through the self-number scrub and record what was
 * discarded. A cleared field goes back to "" so email_extract's
 * fillOnlyEmpty backfill gets its chance, and the owner's outcome line says
 * why a lead step may have been skipped.
 */
async function scrubExtractedSelfPhones(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  out: Record<string, string>,
  stepLabel: string
): Promise<Record<string, string>> {
  const scrub = scrubSelfPhones(out, await businessSelfNumbers(supabase, run.business_id));
  if (scrub.cleared.length > 0) {
    appendActionTaken(
      scope,
      `discarded extracted ${scrub.cleared.join(", ")} from ${stepLabel} — it matched the business's own number, not the lead's`
    );
    await telemetryRecord(supabase, "ai_flow_extraction_scrubbed", {
      business_id: run.business_id,
      run_id: run.id,
      step: stepLabel,
      cleared: scrub.cleared
    });
    // Record WHICH vars were scrubbed (in persisted vars, like the
    // wait_for_reply `__waited_*` markers) so a DOWNSTREAM unusable-phone
    // failure can tell the owner why in plain words — but only when the var
    // that failed is one the scrub actually cleared. Deliberately not
    // notifying here: a later extraction step (e.g. email_extract with
    // fillOnlyEmpty) may still backfill a real lead phone, in which case
    // nothing is wrong. Merged across scrub calls (browse + email extracts).
    scope.vars[SELF_PHONE_SCRUBBED_VAR] = [
      ...new Set([...selfScrubbedVars(scope), ...scrub.cleared])
    ].join(",");
  }
  return scrub.values;
}

/** Persisted-vars marker: comma-joined var names the self-scrub cleared. */
const SELF_PHONE_SCRUBBED_VAR = "__self_phone_scrubbed";

/** Var names this run's self-number scrub cleared so far (possibly empty). */
function selfScrubbedVars(scope: Scope): string[] {
  const raw = scope.vars[SELF_PHONE_SCRUBBED_VAR];
  return typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
}

async function browseStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "browse" }>
): Promise<StepOutcome> {
  const safe = normalizeBrowseUrl(action.url);
  if (!safe) return { kind: "fail", error: `browse: unsafe or invalid URL ${action.url}` };

  // The render service is resolved per-tenant from the run's business_id
  // (this tenant's own VPS sidecar). A login-gated browse can only be
  // performed by that headless service — a static fetch can't drive a login
  // form — so missing config is a permanent setup error, not a transient one;
  // fail without burning retries.
  const renderUrl = resolveRenderUrl(run.business_id);
  if (action.auth && !renderUrl) {
    return {
      kind: "fail",
      error: "browse: authenticated browse requires the AIFLOW_RENDER_URL_TEMPLATE render service"
    };
  }

  let page: { finalUrl: string; text: string; html: string; screenshotBase64?: string };
  try {
    page = await fetchPage(
      safe,
      renderUrl,
      action.auth ? { businessId: run.business_id, auth: action.auth } : undefined,
      // Capture when the step attaches a screenshot downstream OR the flow opted
      // into run-timeline visibility. The attach var below stays gated on the
      // step's own `screenshot` flag.
      action.screenshot === true || scope.captureScreenshots === true
    );
  } catch (e) {
    // A render login failure is permanent (bad creds / MFA), not transient IO —
    // fail the run instead of letting it throw into the retry path.
    if (e instanceof BrowseLoginError) {
      const which = action.auth ? ` for integration "${action.auth.integrationLabel}"` : "";
      return { kind: "fail", error: `browse: ${e.message}${which}` };
    }
    // A render_failed (timeout/interstitial) is transient and normally retries.
    // But when the flow opted into step screenshots and the render captured the
    // stuck page, store it and fail the step so the investigate view shows the
    // failure instead of dropping the image into the silent retry path.
    if (e instanceof RenderFailedError && scope.captureScreenshots && e.screenshotBase64) {
      const shotPath = await storeScreenshotBestEffort(supabase, run, index, e.screenshotBase64);
      const srcPath = await storeSourceBestEffort(supabase, run, index, e.pageSource);
      const diag: Record<string, unknown> = {};
      if (shotPath) diag.screenshot_path = shotPath;
      if (srcPath) diag.source_path = srcPath;
      return {
        kind: "fail",
        error: `browse: ${e.message}`,
        ...(Object.keys(diag).length > 0 ? { result: diag } : {})
      };
    }
    throw e;
  }
  const pageText = page.text || htmlToText(page.html);

  // Terminal-state guard (mirrors browse_action.skipWhenText): when the fetched
  // page carries the configured marker (e.g. Clever's "already been claimed"
  // banner) there is nothing to read — the contact card isn't on the page — so
  // end the run gracefully BEFORE spending Gemini extraction on a page that can
  // only yield empty fields (which would fail a downstream upsert_customer).
  // Checked against both the visible text and the raw HTML.
  if (action.skipWhenText) {
    const marker = action.skipWhenText.toLowerCase();
    if (pageText.toLowerCase().includes(marker) || page.html.toLowerCase().includes(marker)) {
      // Persist the page we already fetched so the investigate view shows WHY
      // the run ended (best-effort; a storage failure must not fail the skip).
      const shotPath = await storeScreenshotBestEffort(supabase, run, index, page.screenshotBase64);
      const srcPath = await storeSourceBestEffort(supabase, run, index, page.html);
      const diag: Record<string, unknown> = {};
      if (shotPath) diag.screenshot_path = shotPath;
      if (srcPath) diag.source_path = srcPath;
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "info",
        event: "ai_flow_browse_skipped_terminal",
        message: `browse skipped: page already in terminal state ("${action.skipWhenText}")`,
        payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
      });
      return {
        kind: "ok",
        skipped: true,
        endRun: true,
        result: { skipped: "already_done", marker: action.skipWhenText, ...diag }
      };
    }
  }

  let extracted: Record<string, string> = {};
  // Only run the (AI-budgeted) field extraction when the step actually asks for
  // fields — a links-only browse_extract skips Gemini entirely.
  if (action.fields && action.fields.length > 0) {
    try {
      extracted = await extractFields(supabase, run, action.fields, pageText);
    } catch (e) {
      // Persist the page we ALREADY fetched (screenshot when captured + source,
      // which is always available) onto the failed step for ANY extraction
      // failure — not just the budget cap. Previously a transient Gemini error
      // (e.g. 503) re-threw and discarded the in-hand page, leaving the
      // dead-lettered step with no screenshot/source for the investigate view.
      const shotPath = await storeScreenshotBestEffort(supabase, run, index, page.screenshotBase64);
      const srcPath = await storeSourceBestEffort(supabase, run, index, page.html);
      const diag: Record<string, unknown> = {};
      if (shotPath) diag.screenshot_path = shotPath;
      if (srcPath) diag.source_path = srcPath;
      // The shared AI budget being exhausted is a permanent, owner-actionable
      // state for this period — fail the run now instead of retrying into the cap.
      if (e instanceof SpendCapError) {
        return {
          kind: "fail",
          error: `browse: ${e.message}`,
          ...(Object.keys(diag).length > 0 ? { result: diag } : {})
        };
      }
      // Other errors are transient (retry). Carry the diagnostics on the thrown
      // error so the eventual dead-lettered step row still shows the page state
      // (the run loop records them when finalizing the failed step).
      throw new StepDiagnosticError(e instanceof Error ? e.message : String(e), diag);
    }
  }

  const raw: Record<string, string> = {};
  for (const f of action.fields ?? []) {
    let val = extracted[f.name] ?? "";
    if (!val && isPhoneFieldName(f.name)) {
      val = extractLabeledPhones(pageText)[0] ?? "";
    }
    raw[f.name] = val;
  }
  // Scrub BEFORE the link/screenshot passthroughs join the map, so the
  // actions_taken note only ever names real extraction fields.
  const out = await scrubExtractedSelfPhones(supabase, run, scope, raw, "browse_extract");
  // Capture link hrefs by their visible button text from the page HTML (parsed
  // here in the worker; the render service already returns html). Empty string
  // when no anchor's visible text contains the matchText.
  for (const link of action.extractLinks ?? []) {
    out[link.name] = extractLinkByText(page.html, link.matchText, page.finalUrl);
  }

  // Screenshot is captured on every browse for run-timeline visibility.
  // Best-effort: a storage failure must not fail a browse that already extracted
  // its fields. The downstream attach var (`screenshot_path` in scope) is only
  // set when the flow asked to attach one — cleared FIRST so a failed
  // capture/upload can never leave a stale path from an earlier browse.
  const shotPath = await storeScreenshotBestEffort(supabase, run, index, page.screenshotBase64);
  if (action.screenshot) out.screenshot_path = shotPath;
  // Store the page source alongside the screenshot (diagnostic only — never an
  // attach var) so the run timeline can link "View page source" for the shot.
  const srcPath = shotPath ? await storeSourceBestEffort(supabase, run, index, page.html) : "";

  Object.assign(scope.vars, out);
  return {
    kind: "ok",
    result: {
      vars: out,
      finalUrl: page.finalUrl,
      ...(shotPath ? { screenshot_path: shotPath } : {}),
      ...(srcPath ? { source_path: srcPath } : {})
    }
  };
}

/**
 * extract_text: the browser-free sibling of browse_extract. Runs the SAME
 * Gemini structured extraction over the inbound message text (resolved by the
 * planner from {{trigger.windowText}}) instead of a fetched page, then applies
 * the same phone-regex fallback for phone-like fields. Used when the triggering
 * message already contains the lead details, so no link needs to be opened.
 */
async function extractTextStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "extract_text" }>
): Promise<StepOutcome> {
  let extracted: Record<string, string>;
  try {
    extracted = await extractFields(supabase, run, action.fields, action.text);
  } catch (e) {
    // An exhausted shared AI budget is a permanent, owner-actionable state for
    // this period — fail the run instead of retrying into the cap.
    if (e instanceof SpendCapError) return { kind: "fail", error: `extract_text: ${e.message}` };
    throw e;
  }

  const raw: Record<string, string> = {};
  for (const f of action.fields) {
    let val = extracted[f.name] ?? "";
    if (!val && isPhoneFieldName(f.name)) {
      val = extractLabeledPhones(action.text)[0] ?? "";
    }
    raw[f.name] = val;
  }
  const out = await scrubExtractedSelfPhones(supabase, run, scope, raw, "extract_text");

  Object.assign(scope.vars, out);
  return { kind: "ok", result: { vars: out } };
}

/**
 * Treat an absent/blank/"none"-class value as empty, so the email_extract
 * backfill (fillOnlyEmpty) only overwrites vars a prior step couldn't fill.
 * Mirrors how the lead-email branches read "none" from extraction as "no value".
 */
function isEmptyVarValue(v: unknown): boolean {
  if (typeof v !== "string") return true;
  const t = v.trim().toLowerCase();
  return t === "" || t === "none" || t === "n/a" || t === "na" || t === "null" || t === "unknown";
}

/**
 * email_extract: read the best-matching recent inbound message from a connected
 * mailbox (via the gateway-guarded /api/internal/aiflow-email-fetch — the worker
 * can't reach Nango) and run the SAME Gemini extraction over it as extract_text.
 * Used as a FALLBACK source for lead details (e.g. HomeLight's "Client Details"
 * email) when a portal browse_extract was delayed/empty: with `fillOnlyEmpty`,
 * it only writes a field whose var is still empty/"none", so the browse wins.
 * A clean miss (the alert hasn't arrived) backfills nothing and continues.
 */
async function emailExtractStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "email_extract" }>
): Promise<StepOutcome> {
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const token = Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
  if (!base || !token) {
    return { kind: "fail", error: "email_extract: platform proxy not configured for mailbox read" };
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/internal/aiflow-email-fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        businessId: run.business_id,
        connectionId: action.connectionId,
        ...(action.fromContains ? { fromContains: action.fromContains } : {}),
        ...(action.bodyContains.length ? { bodyContains: action.bodyContains } : {}),
        lookbackMinutes: action.lookbackMinutes
      })
    });
  } catch (e) {
    throw new Error(
      `email_extract: mailbox read request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  // 5xx = provider/transport fault → throw so the run retries.
  if (res.status >= 500) {
    const t = await res.text().catch(() => "");
    throw new Error(`email_extract: mailbox read ${res.status}: ${t.slice(0, 200)}`);
  }
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; detail?: string; data?: { found?: boolean; bodyText?: string } }
    | null;
  // ok:false on a 2xx is a permanent setup error (connection missing / wrong type
  // / bad args) → fail without retrying.
  if (!payload || payload.ok !== true) {
    return { kind: "fail", error: `email_extract: ${payload?.detail ?? "mailbox read rejected"}` };
  }
  const data = payload.data;
  // No matching email yet (the alert may still be in flight): this is a fallback,
  // not a hard dependency — backfill nothing and let the run continue.
  if (!data?.found || typeof data.bodyText !== "string" || !data.bodyText.trim()) {
    return { kind: "ok", result: { found: false } };
  }

  let extracted: Record<string, string>;
  try {
    extracted = await extractFields(supabase, run, action.fields, data.bodyText);
  } catch (e) {
    if (e instanceof SpendCapError) return { kind: "fail", error: `email_extract: ${e.message}` };
    throw e;
  }

  const raw: Record<string, string> = {};
  for (const f of action.fields) {
    // Backfill: keep a meaningful existing value (an earlier browse already
    // filled it); only fall through to the email value when it's empty/"none".
    if (action.fillOnlyEmpty && !isEmptyVarValue(scope.vars[f.name])) {
      raw[f.name] = scope.vars[f.name] as string;
      continue;
    }
    let val = extracted[f.name] ?? "";
    if (!val && isPhoneFieldName(f.name)) {
      val = extractLabeledPhones(data.bodyText)[0] ?? "";
    }
    raw[f.name] = val;
  }
  const out = await scrubExtractedSelfPhones(supabase, run, scope, raw, "email_extract");
  Object.assign(scope.vars, out);
  return { kind: "ok", result: { found: true, vars: out } };
}

/**
 * doc_extract: read typed fields out of a document (the triggering email's
 * PDF/text attachment) and optionally file it into Business Documents. The
 * worker can't run Gemini's document pipeline or touch the documents store,
 * so the whole read+extract+file round-trips through the gateway-guarded
 * platform adapter (/api/internal/aiflow-doc-extract) — same proxy pattern
 * as email_extract's mailbox read. A planner skip (no document on the
 * trigger) records a skipped step; ok:false on 2xx is a permanent input
 * error (unsupported type, oversized, unreadable) → fail without retrying;
 * 5xx / transport throws so the run retries.
 */
async function docExtractStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "doc_extract" }>
): Promise<StepOutcome> {
  if (action.skipReason) {
    // Stamp every field empty so later when-guards/templates read cleanly.
    for (const f of action.fields) scope.vars[f.name] = "";
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const token = Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
  if (!base || !token) {
    return { kind: "fail", error: "doc_extract: platform proxy not configured" };
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/internal/aiflow-doc-extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        businessId: run.business_id,
        sourceRef: action.sourceRef,
        fields: action.fields,
        ...(action.fileTitle
          ? {
              fileAs: {
                title: action.fileTitle,
                audience: action.fileAudience ?? "staff",
                // Record sinks: contact link (resolved phone or this-step
                // field name), extracted-field stamping, renewal date.
                ...(action.fileContactPhone !== undefined
                  ? { contactPhone: action.fileContactPhone }
                  : {}),
                ...(action.fileContactField
                  ? { contactPhoneField: action.fileContactField }
                  : {}),
                ...(action.fileRecordFields ? { recordFieldsFromExtraction: true } : {}),
                ...(action.fileRenewalField ? { renewalDateField: action.fileRenewalField } : {})
              }
            }
          : {})
      })
    });
  } catch (e) {
    throw new Error(
      `doc_extract: platform request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (res.status >= 500) {
    const t = await res.text().catch(() => "");
    throw new Error(`doc_extract: platform ${res.status}: ${t.slice(0, 200)}`);
  }
  const payload = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        detail?: string;
        data?: {
          vars?: Record<string, string>;
          filed?: { documentId: string; title: string } | null;
          fileError?: string;
          fileNotes?: string[];
        };
      }
    | null;
  if (!payload || payload.ok !== true) {
    return { kind: "fail", error: `doc_extract: ${payload?.detail ?? "document read rejected"}` };
  }
  const raw: Record<string, string> = {};
  for (const f of action.fields) raw[f.name] = payload.data?.vars?.[f.name] ?? "";
  const out = await scrubExtractedSelfPhones(supabase, run, scope, raw, "doc_extract");
  Object.assign(scope.vars, out);
  return {
    kind: "ok",
    result: {
      vars: out,
      ...(payload.data?.filed ? { filed: payload.data.filed } : {}),
      ...(payload.data?.fileError ? { file_error: payload.data.fileError } : {}),
      ...(payload.data?.fileNotes && payload.data.fileNotes.length > 0
        ? { file_notes: payload.data.fileNotes }
        : {})
    }
  };
}

/**
 * browse_action: drive an ordered click/fill sequence on a page via the
 * per-tenant render service (e.g. posting a "still trying to contact" update
 * on the ReferralExchange lead timeline). Unlike browse_extract there is no
 * static-fetch fallback — actions need a real browser — so missing render
 * config is a permanent setup error. The render service reports how many
 * actions completed; a selector that no longer matches fails the run (the
 * page changed; retrying won't fix it) with the failing action in the error.
 */
async function browseActionStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "browse_action" }>
): Promise<StepOutcome> {
  const safe = normalizeBrowseUrl(action.url);
  if (!safe) return { kind: "fail", error: `browse_action: unsafe or invalid URL ${action.url}` };
  const renderUrl = resolveRenderUrl(run.business_id);
  if (!renderUrl) {
    return {
      kind: "fail",
      error: "browse_action: requires the AIFLOW_RENDER_URL_TEMPLATE render service"
    };
  }

  const ctrl = new AbortController();
  const fetchTimeoutMs = action.forEachLink
    ? RENDER_FOREACH_FETCH_TIMEOUT_MS
    : RENDER_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs);
  let body: unknown;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const renderToken = Deno.env.get("AIFLOW_RENDER_TOKEN");
    if (renderToken) headers.Authorization = `Bearer ${renderToken}`;
    const res = await fetch(renderUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: safe,
        businessId: run.business_id,
        ...(action.auth ? { auth: action.auth } : {}),
        actions: action.actions,
        // `screenshot` = capture the after-page shot for downstream attach
        // (email/MMS). `debugScreenshots` = the per-flow visibility opt-in that
        // also captures a before-actions shot and an at-failure shot for the
        // dashboard "investigate" view. Default off so other flows pay nothing.
        ...(action.screenshot ? { screenshot: true } : {}),
        ...(scope.captureScreenshots ? { debugScreenshots: true } : {}),
        ...(action.forEachLink ? { forEachLink: action.forEachLink } : {}),
        // Forward the name filter even when it's an EMPTY array: a requested
        // filter that resolved to no names must update NOTHING, not every row.
        ...(Array.isArray(action.forEachMatch) ? { forEachMatch: action.forEachMatch } : {})
      }),
      signal: ctrl.signal
    });
    // The render service reports application outcomes in a 200 JSON body (NOT a
    // 5xx) so the Cloudflare Tunnel can't strip the structured error off a
    // gateway-error status. Read the body once and classify on its `error` code;
    // a real non-2xx here means a transport/edge failure (origin down, body
    // replaced by Cloudflare's "error code: 502" page) → retry.
    const raw = await res.text();
    let parsedBody: unknown = null;
    try {
      parsedBody = raw ? JSON.parse(raw) : null;
    } catch {
      parsedBody = null;
    }
    const { error: errCode, detail } = renderErrorFields(parsedBody);
    if (errCode) {
      const kind = renderErrorKind(errCode);
      // Permanent setup/page errors: bad creds, missing platform config, or a
      // selector that no longer matches. Retrying cannot fix any of these.
      if (kind === "login") {
        const which = action.auth ? ` for integration "${action.auth.integrationLabel}"` : "";
        return { kind: "fail", error: `browse_action: ${errCode}${which}` };
      }
      if (kind === "action") {
        // On an action failure the render service returns BOTH a "before" shot
        // (the page as it loaded, going into the step) and a "failure" shot (the
        // stuck page). Persist both onto the failed step so the owner can see the
        // page state before AND where it broke (e.g. a wizard "Next" loop).
        const failShot = await storeScreenshotBestEffort(
          supabase,
          run,
          index,
          readScreenshotBase64(parsedBody)
        );
        const beforeShot = await storeScreenshotBestEffort(
          supabase,
          run,
          index,
          readScreenshotBeforeBase64(parsedBody),
          "before"
        );
        // Page source paired with each shot so the investigate view can link the
        // exact markup before the actions AND at the point it broke.
        const failSrc = await storeSourceBestEffort(supabase, run, index, readPageSource(parsedBody));
        const beforeSrc = await storeSourceBestEffort(
          supabase,
          run,
          index,
          readPageSourceBefore(parsedBody),
          "before"
        );
        const diag: Record<string, unknown> = {};
        if (failShot) diag.screenshot_path = failShot;
        if (beforeShot) diag.screenshot_before_path = beforeShot;
        if (failSrc) diag.source_path = failSrc;
        if (beforeSrc) diag.source_before_path = beforeSrc;
        // Terminal-state guard: if the action failed only because the page is
        // already in the desired end-state (e.g. a lead another agent claimed,
        // so there's no "Accept" button), end the run gracefully — recorded as a
        // "skipped" step on a done run — instead of dead-lettering it as a
        // failure. Match the configured marker against the page source captured
        // at the failure (and the before-source as a fallback).
        if (action.skipWhenText) {
          const marker = action.skipWhenText.toLowerCase();
          // Match ONLY the FAILURE-page source (the stuck page captured after the
          // action failed) — never the debug-only "before actions" page. A marker
          // present only on the pre-action page must not skip a run that then
          // failed for an unrelated reason without reaching the terminal state.
          const pageText = (readPageSource(parsedBody) ?? "").toLowerCase();
          if (pageText.includes(marker)) {
            await systemLog(supabase, {
              businessId: run.business_id,
              source: "aiflow",
              level: "info",
              event: "ai_flow_browse_action_skipped_terminal",
              message: `browse_action skipped: page already in terminal state ("${action.skipWhenText}")`,
              payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
            });
            return {
              kind: "ok",
              skipped: true,
              endRun: true,
              result: { skipped: "already_done", marker: action.skipWhenText, ...diag }
            };
          }
        }
        return {
          kind: "fail",
          error: `browse_action: ${detail || "a page action failed"}`,
          ...(Object.keys(diag).length > 0 ? { result: diag } : {})
        };
      }
      // render_failed / unknown → transient; carry the detail so the run log
      // shows WHY (e.g. a Playwright navigation timeout). When the flow opted into
      // step screenshots and the render captured the stuck page, store it and fail
      // the step so the investigate view shows the failure instead of dropping the
      // image into the silent retry path.
      const why = [errCode, detail].filter(Boolean).join(": ");
      const failBase64 = readScreenshotBase64(parsedBody);
      if (scope.captureScreenshots && failBase64) {
        const failShot = await storeScreenshotBestEffort(supabase, run, index, failBase64);
        const failSrc = await storeSourceBestEffort(supabase, run, index, readPageSource(parsedBody));
        const diag: Record<string, unknown> = {};
        if (failShot) diag.screenshot_path = failShot;
        if (failSrc) diag.source_path = failSrc;
        return {
          kind: "fail",
          error: `browse_action: render service error${why ? ` (${why})` : ""}`,
          ...(Object.keys(diag).length > 0 ? { result: diag } : {})
        };
      }
      throw new Error(`browse_action: render service error${why ? ` (${why})` : ""}`);
    }
    if (!res.ok) {
      // No app error code on a non-2xx → the body was stripped/replaced by the
      // tunnel edge (origin unreachable). Surface a snippet and retry.
      const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(`browse_action: render service ${res.status}${snippet ? ` (${snippet})` : ""}`);
    }
    body = parsedBody;
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseActionResponse(body, safe);
  if (!parsed) throw new Error("browse_action: render service returned an invalid body");

  // Loop-over-list: the response summarizes per-item outcomes instead of a
  // single page's action count. Handle it on its own terms and return early.
  if (action.forEachLink) {
    if (!parsed.forEach) {
      // A render service that doesn't loop would silently run the actions once
      // on the LIST page. Fail loudly rather than half-apply the update.
      return {
        kind: "fail",
        error: "browse_action: render service did not loop (forEachLink unsupported)"
      };
    }
    const fe = parsed.forEach;
    if (fe.items === 0) {
      // Zero items WITH errors means link collection itself failed (e.g. a bad
      // CSS selector throws in querySelectorAll) — fail loudly instead of
      // treating a broken weekly-update selector as a clean "nothing to do".
      if (fe.errors.length > 0) {
        return {
          kind: "fail",
          error: `browse_action: forEachLink matched no items (${fe.errors[0]})`
        };
      }
      appendActionTaken(scope, "found no matching list items to update");
      return { kind: "ok", result: { forEach: fe } };
    }
    // Every item failed → the selectors are wrong (or every page changed). Fail
    // so we notice; nothing was applied, so a retry won't double-update.
    if (fe.succeeded === 0) {
      return {
        kind: "fail",
        error: `browse_action: all ${fe.items} list item(s) failed${fe.errors[0] ? `: ${fe.errors[0]}` : ""}`
      };
    }
    // Partial success: don't fail the run (a retry would re-update the ones that
    // already succeeded), but log the misses so they can be checked.
    if (fe.failed > 0) {
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_for_each_partial",
        message: `forEachLink updated ${fe.succeeded}/${fe.items}; ${fe.failed} failed`,
        payload: { run_id: run.id, flow_id: run.flow_id, step_index: index, errors: fe.errors }
      });
    }
    appendActionTaken(scope, `updated ${fe.succeeded} of ${fe.items} list item(s)`);
    return { kind: "ok", result: { forEach: fe } };
  }

  // The render service fails fast on the first broken action, so a 200 with a
  // short count means the contract was violated somewhere — never mark the
  // step done unless every planned action actually ran.
  if (parsed.actionsCompleted < action.actions.length) {
    return {
      kind: "fail",
      error: `browse_action: only ${parsed.actionsCompleted} of ${action.actions.length} actions completed`
    };
  }

  // Audit screenshot of the page AFTER the actions, captured on every browse so
  // the dashboard run timeline can show it. Best-effort: a storage failure must
  // not fail an update that already posted.
  const screenshotPath = await storeScreenshotBestEffort(
    supabase,
    run,
    index,
    parsed.screenshotBase64
  );
  // Page source paired with the after-action screenshot (diagnostic only) so the
  // run timeline can link "View page source" for the shot.
  const sourcePath = screenshotPath
    ? await storeSourceBestEffort(supabase, run, index, parsed.html)
    : "";
  // Only PUBLISH the screenshot as the downstream attach var when the flow asked
  // to attach one (email/MMS). Writing it unconditionally would change which
  // screenshot a later attachScreenshot step picks up; visibility-only captures
  // ride along in the step result instead.
  if (action.screenshot && screenshotPath) scope.vars.screenshot_path = screenshotPath;

  // Same-pass extraction: when the step asked for `fields`, read them out of the
  // page text the render service returned AFTER the actions (e.g. the accepted
  // lead's name/phone/email), reusing the browse_extract extraction + phone
  // fallback so no second navigation is needed.
  let extractedVars: Record<string, string> | undefined;
  if (action.fields && action.fields.length > 0) {
    const pageText = parsed.text || htmlToText(parsed.html);
    let extracted: Record<string, string>;
    try {
      extracted = await extractFields(supabase, run, action.fields, pageText);
    } catch (e) {
      // Carry the after-action screenshot captured above onto the failed step so
      // a cap hit mid-extraction still shows the page in the investigate view.
      if (e instanceof SpendCapError) {
        const diag: Record<string, unknown> = {};
        if (screenshotPath) diag.screenshot_path = screenshotPath;
        if (sourcePath) diag.source_path = sourcePath;
        return {
          kind: "fail",
          error: `browse_action: ${e.message}`,
          ...(Object.keys(diag).length > 0 ? { result: diag } : {})
        };
      }
      throw e;
    }
    const raw: Record<string, string> = {};
    for (const f of action.fields) {
      let val = extracted[f.name] ?? "";
      if (!val && isPhoneFieldName(f.name)) {
        val = extractLabeledPhones(pageText)[0] ?? "";
      }
      raw[f.name] = val;
    }
    const out = await scrubExtractedSelfPhones(supabase, run, scope, raw, "browse_action");
    Object.assign(scope.vars, out);
    extractedVars = out;
  }

  // Persist the final URL keyed by a phone so a LATER run for the same person
  // can recall it (recall_url). Resolved from scope.vars AFTER same-pass
  // extraction above, so a phone THIS step just extracted can be the key.
  // Best-effort: a memory write must never fail a browse that already posted.
  const rememberRaw = action.rememberKeyVar ? scope.vars[action.rememberKeyVar] : undefined;
  const rememberKey =
    typeof rememberRaw === "string" ? normalizeNanpToE164(rememberRaw) : null;
  if (rememberKey && parsed.finalUrl) {
    const { error: memErr } = await supabase.from("aiflow_url_memory").upsert(
      {
        business_id: run.business_id,
        memory_key: rememberKey,
        url: parsed.finalUrl,
        flow_id: run.flow_id,
        run_id: run.id
      },
      { onConflict: "business_id,memory_key" }
    );
    if (memErr) {
      console.error("aiflow_url_memory upsert", memErr);
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_url_memory_write_failed",
        message: `URL memory write failed: ${memErr.message}`,
        payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
      });
    }
  }

  return {
    kind: "ok",
    result: {
      finalUrl: parsed.finalUrl,
      actionsCompleted: parsed.actionsCompleted,
      ...(extractedVars ? { vars: extractedVars } : {}),
      ...(screenshotPath ? { screenshot_path: screenshotPath } : {}),
      ...(sourcePath ? { source_path: sourcePath } : {})
    }
  };
}

/**
 * recall_url: look up a URL a prior browse_action persisted for the same person
 * (by normalized phone) and save it into {{vars.<saveAs>}}. Saves "" on a miss,
 * so a consuming step guarded by a `when` skips cleanly instead of failing.
 */
async function recallUrlStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "recall_url" }>
): Promise<StepOutcome> {
  let url = "";
  if (action.keys.length > 0) {
    const { data, error } = await supabase
      .from("aiflow_url_memory")
      .select("memory_key, url, updated_at")
      .eq("business_id", run.business_id)
      .in("memory_key", action.keys)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("aiflow_url_memory read", error);
    } else if (data && typeof (data as { url?: unknown }).url === "string") {
      url = (data as { url: string }).url;
    }
  }
  scope.vars[action.saveAs] = url;
  return { kind: "ok", result: { vars: { [action.saveAs]: url }, matched: url.length > 0 } };
}

/**
 * Upload a captured screenshot to the private screenshots bucket and return its
 * storage path. Later steps consume it by path: send_email downloads it to
 * attach, route_to_team signs a short-lived URL for Telnyx MMS media.
 */
async function storeScreenshot(
  supabase: Supabase,
  run: RunRow,
  index: number,
  base64: string,
  // Optional filename variant (e.g. "before") so a single step can store more
  // than one screenshot — the default (no variant) stays `step-N.jpg`, which is
  // the path attachScreenshot steps consume, so their behavior is unchanged.
  variant?: string
): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const suffix = variant ? `-${variant}` : "";
  const path = `${run.business_id}/${run.id}/step-${index}${suffix}.jpg`;
  const { error: upErr } = await supabase.storage
    .from(SCREENSHOT_BUCKET)
    .upload(path, new Blob([bytes], { type: "image/jpeg" }), {
      contentType: "image/jpeg",
      upsert: true
    });
  if (upErr) throw new Error(`screenshot upload: ${upErr.message}`);
  return path;
}

/**
 * Store a screenshot for the run timeline without ever failing the step: a
 * storage hiccup must not turn a browse that otherwise succeeded (or already
 * failed for a real reason) into a different outcome. Returns the stored path,
 * or "" when there was nothing to store or the upload failed.
 */
async function storeScreenshotBestEffort(
  supabase: Supabase,
  run: RunRow,
  index: number,
  base64: string | null | undefined,
  variant?: string
): Promise<string> {
  if (!base64) return "";
  try {
    return await storeScreenshot(supabase, run, index, base64, variant);
  } catch (e) {
    console.error("browse screenshot store failed", e);
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "warn",
      event: "ai_flow_screenshot_store_failed",
      message: `browse screenshot store failed: ${e instanceof Error ? e.message : String(e)}`,
      payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
    });
    return "";
  }
}

/**
 * Upload captured page source (HTML) next to its screenshot in the same private
 * bucket, returning its storage path. Stored as text/plain so the owner sees the
 * raw markup (and the browser never executes it) when opening the signed URL.
 * The filename mirrors the paired screenshot (`step-N[-variant].html`) so the
 * run-detail reader can sign both together.
 */
async function storeSource(
  supabase: Supabase,
  run: RunRow,
  index: number,
  html: string,
  variant?: string
): Promise<string> {
  const suffix = variant ? `-${variant}` : "";
  const path = `${run.business_id}/${run.id}/step-${index}${suffix}.html`;
  const { error: upErr } = await supabase.storage
    .from(SCREENSHOT_BUCKET)
    .upload(path, new Blob([html], { type: "text/plain" }), {
      contentType: "text/plain; charset=utf-8",
      upsert: true
    });
  if (upErr) throw new Error(`source upload: ${upErr.message}`);
  return path;
}

/**
 * Store captured page source for the run timeline without ever failing the step
 * (a storage hiccup must not change a browse's outcome). Returns the stored path,
 * or "" when there was nothing to store or the upload failed.
 */
async function storeSourceBestEffort(
  supabase: Supabase,
  run: RunRow,
  index: number,
  html: string | null | undefined,
  variant?: string
): Promise<string> {
  if (!html) return "";
  try {
    return await storeSource(supabase, run, index, html, variant);
  } catch (e) {
    console.error("browse source store failed", e);
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "warn",
      event: "ai_flow_source_store_failed",
      message: `browse source store failed: ${e instanceof Error ? e.message : String(e)}`,
      payload: { run_id: run.id, flow_id: run.flow_id, step_index: index }
    });
    return "";
  }
}

/** Read a base64 screenshot off a render-service body, or null when absent. */
function readScreenshotBase64(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>).screenshotBase64;
  return typeof v === "string" && v ? v : null;
}

/** Read the pre-action ("before") base64 screenshot off a render body, or null. */
function readScreenshotBeforeBase64(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>).screenshotBeforeBase64;
  return typeof v === "string" && v ? v : null;
}

/** Read the captured page source (HTML) paired with the failure shot, or null. */
function readPageSource(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>).pageSource;
  return typeof v === "string" && v ? v : null;
}

/** Read the page source paired with the "before" shot off a render body, or null. */
function readPageSourceBefore(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>).pageSourceBefore;
  return typeof v === "string" && v ? v : null;
}

/**
 * Best-effort: sign a short-lived URL for the run's stored screenshot so it can
 * ride along as MMS media. Returns null (and logs) when there is no stored
 * screenshot or signing fails — an offer without the image still routes the lead.
 */
async function screenshotMmsUrl(
  supabase: Supabase,
  run: RunRow,
  scope: Scope
): Promise<string | null> {
  // Tenant guard: only a path under THIS run's business prefix is signable —
  // the var shares the scope.vars namespace with extraction outputs, whose
  // values inbound text controls (see screenshot_guard.ts).
  const path = tenantScreenshotPath(run.business_id, scope.vars.screenshot_path);
  if (!path) return null;
  const { data: signed, error } = await supabase.storage
    .from(SCREENSHOT_BUCKET)
    .createSignedUrl(path, SCREENSHOT_MMS_URL_TTL_S);
  if (error || !signed?.signedUrl) {
    console.error("screenshot MMS sign failed", error?.message ?? "no signed url");
    return null;
  }
  return signed.signedUrl;
}

/**
 * Fetch a page via the render service.
 *
 * When `authCtx` is supplied the render service logs in with the named custom
 * integration's stored credentials before reading the page (credentialed
 * browse). The render service is network-reachable, so calls carry a bearer
 * token (AIFLOW_RENDER_TOKEN) when configured.
 */
async function fetchViaRender(
  url: string,
  renderUrl: string,
  authCtx?: { businessId: string; auth: BrowseAuth },
  screenshot = false
): Promise<{ finalUrl: string; text: string; html: string; screenshotBase64?: string }> {
  const ctrl = new AbortController();
  // Render calls (multi-nav + login) get a much larger budget than a static GET.
  const timer = setTimeout(() => ctrl.abort(), RENDER_FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const renderToken = Deno.env.get("AIFLOW_RENDER_TOKEN");
    if (renderToken) headers.Authorization = `Bearer ${renderToken}`;
    const res = await fetch(renderUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        ...(authCtx ? { businessId: authCtx.businessId, auth: authCtx.auth } : {}),
        ...(screenshot ? { screenshot: true } : {})
      }),
      signal: ctrl.signal
    });
    // Render outcomes arrive in a 200 JSON body (see browse_action above for
    // why a 5xx would be body-stripped by the Cloudflare Tunnel). Classify on
    // the `error` code; a true non-2xx is a transport failure to retry.
    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const { error: errCode, detail } = renderErrorFields(body);
    if (errCode) {
      // login_failed (bad creds/MFA) and auth_config_error (missing platform
      // config, integration not found, wrong selectors) are permanent setup
      // failures — fail the run rather than retrying transiently.
      if (renderErrorKind(errCode) === "login") {
        throw new BrowseLoginError(errCode);
      }
      // render_failed / unknown → transient; surface the root cause. Carry any
      // failure screenshot so a debug-enabled caller can store it before the run
      // retries (otherwise the stuck page is lost on a timeout/interstitial).
      const why = [errCode, detail].filter(Boolean).join(": ");
      throw new RenderFailedError(
        `render service error${why ? ` (${why})` : ""}`,
        readScreenshotBase64(body) ?? undefined,
        readPageSource(body) ?? undefined
      );
    }
    if (!res.ok) {
      const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(`render service ${res.status}${snippet ? ` (${snippet})` : ""}`);
    }
    const parsed = parseRenderResponse(body, url);
    if (!parsed) throw new Error("render service returned an invalid body");
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Static GET with manual, SSRF-revalidated redirect following. */
async function fetchStatic(
  url: string
): Promise<{ finalUrl: string; text: string; html: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects manually so each hop's host is re-validated against the
    // SSRF guard — a public URL must not be able to redirect to a private /
    // loopback / cloud-metadata host (CodeQL/Bugbot: unsafe redirect).
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": "NewCoworker-AiFlow/1.0" },
        signal: ctrl.signal
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`fetch ${res.status} without location`);
        const next = normalizeBrowseUrl(new URL(location, current).toString());
        if (!next) throw new Error("fetch: redirect to unsafe or invalid URL");
        current = next;
        continue;
      }
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const html = await res.text();
      return { finalUrl: current, text: "", html };
    }
    throw new Error("fetch: too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a page via the per-tenant render service, falling back to a static GET.
 *
 * Credentialed browse (`authCtx`) MUST use the render service — a static fetch
 * can't drive a login form — so its errors propagate. A NON-credentialed browse
 * falls back to a static fetch when the render service is unreachable: per-tenant
 * render only exists on render-capable tiers, so a starter/KVM2 tenant has no
 * `render-*` hostname/sidecar and must still read public/SPA pages statically
 * rather than failing against a non-existent backend.
 */
async function fetchPage(
  url: string,
  renderUrl: string | null,
  authCtx?: { businessId: string; auth: BrowseAuth },
  screenshot = false
): Promise<{ finalUrl: string; text: string; html: string; screenshotBase64?: string }> {
  if (renderUrl) {
    try {
      return await fetchViaRender(url, renderUrl, authCtx, screenshot);
    } catch (e) {
      // Credentialed browse can't fall back to a static fetch (no login),
      // so surface the error (incl. BrowseLoginError) to the caller.
      if (authCtx) throw e;
      // Non-credentialed: fall through to the static fetch below.
    }
  }
  return await fetchStatic(url);
}

/**
 * True when this tenant's shared AI spend (owner chat + SMS + AiFlows) has
 * crossed the period cap. Fails OPEN on any read error — a metering blip must
 * never block a lead flow.
 */
async function aiFlowSpendOverCap(supabase: Supabase, businessId: string): Promise<boolean> {
  if (!AIFLOW_SPEND_METERING_ENABLED) return false;
  const spend = supabase as unknown as SpendSupabase;
  try {
    const periodStart = await resolveChatPeriodStart(spend, businessId);
    const spent = await readChatSpendMicros(spend, businessId, periodStart);
    return spent >= CHAT_SPEND_CAP_MICROS;
  } catch {
    return false;
  }
}

/**
 * Meter one AiFlow model call (Gemini extraction or the legacy Rowboat
 * agent-pick) into the shared owner_chat_model_spend pool. Best-effort and
 * never throws — the reply/extraction already happened, so a metering failure
 * only under-counts the fuse. A retried run can re-meter the same call (there
 * is no per-step claim like the SMS worker's metered_at); the cap is a safety
 * fuse, not an invoice, so a rare over-count errs on the safe side.
 */
async function meterAiFlowSpend(
  supabase: Supabase,
  run: RunRow,
  surface: string,
  inputChars: number,
  outputChars: number,
  /** Exact billed cost from usageMetadata when available; overrides the estimate. */
  exactCostMicros: number | null = null
): Promise<void> {
  if (!AIFLOW_SPEND_METERING_ENABLED) return;
  try {
    const spend = supabase as unknown as SpendSupabase;
    const periodStart = await resolveChatPeriodStart(spend, run.business_id);
    // No exact usageMetadata tokens — estimate from text length (~4 chars/token)
    // and price with the same per-model table as the exact path above. Pass the
    // fractional chars/4 (no per-side rounding) so geminiCostMicrosFromTokens'
    // single trailing Math.ceil rounds once, avoiding an overcount on short text.
    const costMicros =
      exactCostMicros !== null && exactCostMicros > 0
        ? exactCostMicros
        : geminiCostMicrosFromTokens(
            GEMINI_MODEL,
            Math.max(0, inputChars) / 4,
            Math.max(0, outputChars) / 4
          );
    const { data, error } = await supabase.rpc("owner_chat_record_spend", {
      p_business_id: run.business_id,
      p_period_start: periodStart,
      p_cost_micros: costMicros,
      p_cap_micros: CHAT_SPEND_CAP_MICROS
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { fuse_newly_tripped?: boolean }
      | null
      | undefined;
    if (row?.fuse_newly_tripped) {
      await telemetryRecord(supabase, "ai_flow_spend_cap_tripped", {
        run_id: run.id,
        business_id: run.business_id,
        surface
      });
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_spend_cap_tripped",
        message: `Shared AI spend cap reached (${surface}); further extractions will fail until the period resets`,
        payload: { run_id: run.id, flow_id: run.flow_id, surface, cost_micros: costMicros }
      });
    }
  } catch (e) {
    console.error("meterAiFlowSpend", e);
  }
}

/**
 * Max attempts (1 initial + retries) for a transient Gemini response. Clamped to
 * a finite 1..5: a bad/non-finite env var (e.g. "Infinity" or unparseable) must
 * never become an unbounded loop bound that spins on a persistently-failing call
 * and blocks the worker on that run.
 */
const GEMINI_MAX_ATTEMPTS = (() => {
  const raw = Number(Deno.env.get("AIFLOW_GEMINI_MAX_ATTEMPTS") ?? 3);
  return Number.isFinite(raw) ? Math.min(5, Math.max(1, Math.round(raw))) : 3;
})();

/**
 * POST with bounded retry on TRANSIENT upstream failures (HTTP 429 / 5xx, and a
 * fetch that throws — a network blip). Exponential backoff with jitter
 * (~0.5s, ~1s, …). Returns the last response (even if not ok) so the caller's
 * existing `!res.ok` handling still applies; a permanent 4xx (≠429) returns
 * immediately without retrying. Best-effort: never throws on its own beyond a
 * final rethrow of the underlying fetch error.
 */
async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  const attempts = GEMINI_MAX_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      const transient = res.status === 429 || res.status >= 500;
      if (res.ok || !transient || attempt === attempts) return res;
      // Drain the body so the connection can be reused before we back off.
      await res.text().catch(() => {});
    } catch (e) {
      lastErr = e;
      if (attempt === attempts) throw e;
    }
    // Exponential backoff with jitter: ~500ms, ~1000ms, ~2000ms, …
    const backoffMs = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  // Unreachable in practice (the loop returns/throws), but satisfies the type.
  if (lastErr) throw lastErr;
  return await fetch(url, init);
}

/**
 * One spend-gated Gemini JSON call — the shared engine room for extract_text /
 * browse extraction AND classify. Returns the response text, or null when no
 * API key is configured (callers fail open with their own fallback). Throws
 * SpendCapError when the shared AI budget is exhausted.
 */
async function geminiJsonForPrompt(
  supabase: Supabase,
  run: RunRow,
  prompt: string,
  surface: string
): Promise<string | null> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY") ?? "";
  if (!apiKey) return null;
  // Spend gate: AiFlow model calls bill per token into the shared pool, so an
  // exhausted budget blocks the Gemini call (throws SpendCapError → run fails).
  if (await aiFlowSpendOverCap(supabase, run.business_id)) {
    throw new SpendCapError(
      "the shared AI budget for this billing period is used up; extraction is paused until it resets"
    );
  }
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=` +
    encodeURIComponent(apiKey);
  // Inner retry/backoff for TRANSIENT upstream errors (429 / 5xx — Gemini
  // "model overloaded" returns 503). A single 503 used to bubble straight out
  // and burn a whole run-level retry, and an overloaded window could dead-letter
  // a run AFTER an irreversible earlier step (e.g. a lead already accepted on
  // Clever) — orphaning it. Riding out a brief overload here avoids that. A 4xx
  // (other than 429) is permanent, so it fails fast without retrying.
  const res = await fetchWithTransientRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" }
    })
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  // Prefer the EXACT billed tokens from usageMetadata: thinking tokens are
  // billed as output but invisible in the candidate text, and the configured
  // model may not be flash-lite — both made the chars/4 estimate undercount.
  const um = body.usageMetadata;
  const promptTokens = Number(um?.promptTokenCount ?? 0);
  const outputTokens =
    Number(um?.candidatesTokenCount ?? 0) + Number(um?.thoughtsTokenCount ?? 0);
  const exactCostMicros =
    Number.isFinite(promptTokens) && Number.isFinite(outputTokens) &&
    promptTokens + outputTokens > 0
      ? geminiCostMicrosFromTokens(GEMINI_MODEL, promptTokens, outputTokens)
      : null;
  await meterAiFlowSpend(supabase, run, surface, prompt.length, text.length, exactCostMicros);
  return text;
}

/** Gemini structured extraction; empty map when no API key (regex fallback covers it). */
async function extractFields(
  supabase: Supabase,
  run: RunRow,
  fields: ExtractField[],
  pageText: string
): Promise<Record<string, string>> {
  const text = await geminiJsonForPrompt(
    supabase,
    run,
    buildExtractionPrompt(fields, pageText),
    "extract"
  );
  if (text === null) return {};
  return parseExtractionJson(text, fields);
}

/**
 * classify step: decide which of the author's categories the message means,
 * writing the winner into vars[saveAs] so a branch can fork on it. Sentinel
 * inputs were pre-resolved by the planner (no model call); a missing API key
 * or an unusable model response resolves to the reserved "unclear" fallback —
 * the flow's unclear arm handles it, never a crash.
 */
async function classifyStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "classify" }>
): Promise<StepOutcome> {
  if (action.resolved !== undefined) {
    scope.vars[action.saveAs] = action.resolved;
    return {
      kind: "ok",
      result: { [action.saveAs]: action.resolved, pre_resolved: true }
    };
  }
  let text: string | null;
  try {
    text = await geminiJsonForPrompt(
      supabase,
      run,
      buildClassifyPrompt(action.categories, action.text, action.question),
      "classify"
    );
  } catch (e) {
    // An exhausted shared AI budget is a permanent, owner-actionable state
    // for this period — fail the run instead of retrying into the cap.
    if (e instanceof SpendCapError) return { kind: "fail", error: `classify: ${e.message}` };
    throw e;
  }
  const choice = text === null ? CLASSIFY_UNCLEAR : parseClassifyChoice(text, action.categories);
  scope.vars[action.saveAs] = choice;
  return { kind: "ok", result: { [action.saveAs]: choice } };
}

/** Max bytes for a generate_image edit source (matches the coworker tools). */
const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;

const INPUT_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const INPUT_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

/**
 * Resolve a generate_image edit source to raw bytes. Accepted forms — ALL
 * platform-controlled (never an arbitrary URL, so no SSRF surface):
 *   - `email-attachments:<inbound/...>` — an inbound tenant-mailbox
 *     attachment (path written by the platform into the trigger context);
 *   - a generated-images path `<businessId>/<uuid>.<ext>` for THIS business
 *     (a prior generation or a stored inbound MMS photo);
 *   - an https URL on our own Supabase host (a signed URL an earlier
 *     generate_image step saved) or on Telnyx's media CDN ({{trigger.image}}
 *     from an inbound MMS).
 * Returns null (with a reason) on anything else, oversize, or a fetch miss.
 */
async function resolveFlowInputImage(
  supabase: Supabase,
  businessId: string,
  ref: string,
  /**
   * The run's own platform-written {{trigger.image}} value. An
   * `email-attachments:` ref is accepted ONLY when it matches this exactly —
   * the platform wrote it into the run context for THIS tenant's inbound
   * mail, so no DB lookup (and no enqueue-vs-log race) is needed, and a
   * crafted literal path to another tenant's attachment reads nothing.
   */
  trustedTriggerImage: string
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const finish = (bytes: Uint8Array, mimeType: string) => {
    if (bytes.length === 0 || bytes.length > MAX_INPUT_IMAGE_BYTES) return null;
    return INPUT_IMAGE_TYPES.has(mimeType) ? { bytes, mimeType } : null;
  };

  // Inbound tenant-mailbox attachment. The path carries no business prefix,
  // so tenancy comes from the run context itself: the ref must be the exact
  // value the platform wrote into THIS run's {{trigger.image}} when the
  // tenant's own mailbox received the mail. A crafted literal ref to another
  // tenant's (message-id-derived, guessable) path reads nothing, and there
  // is no dependency on the email_log write landing before the run starts.
  if (ref.startsWith("email-attachments:")) {
    if (ref !== trustedTriggerImage) return null;
    const path = ref.slice("email-attachments:".length);
    if (!path.startsWith("inbound/")) return null;
    const { data, error } = await supabase.storage.from("email-attachments").download(path);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return finish(bytes, data.type || INPUT_MIME_BY_EXT[ext] || "");
  }

  // Bare generated-images path for THIS business.
  const pathMatch = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.(png|jpg|jpeg|webp)$/i.exec(ref);
  if (pathMatch) {
    if (pathMatch[1].toLowerCase() !== businessId.toLowerCase()) return null;
    const { data, error } = await supabase.storage.from(GENERATED_IMAGES_BUCKET).download(ref);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return finish(bytes, data.type || INPUT_MIME_BY_EXT[pathMatch[3].toLowerCase()]);
  }

  // https URL: only our own Supabase host (signed URLs we minted) or the
  // Telnyx media CDN (inbound MMS attachments from the verified webhook).
  let parsed: URL;
  try {
    parsed = new URL(ref);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const ownHost = (() => {
    try {
      return new URL(Deno.env.get("SUPABASE_URL") ?? "").hostname;
    } catch {
      return "";
    }
  })();
  const telnyxHost =
    parsed.hostname === "telnyx.com" || parsed.hostname.endsWith(".telnyx.com");
  if (!(telnyxHost || (ownHost && parsed.hostname === ownHost))) return null;
  // An own-host signed URL must additionally point at an object THIS run may
  // read: this business's generated-images prefix. (Email attachments are
  // deliberately NOT accepted in URL form — they go through the
  // `email-attachments:` ref above, which verifies tenancy via email_log.)
  // Without this, a signed URL for another tenant's object on the same
  // project host would pass the host check.
  if (!telnyxHost) {
    const objMatch = /^\/storage\/v1\/object\/(?:sign|authenticated|public)\/([^/]+)\/(.+)$/.exec(
      parsed.pathname
    );
    if (!objMatch) return null;
    const bucket = objMatch[1];
    const objectPath = decodeURIComponent(objMatch[2]);
    const allowed =
      bucket === GENERATED_IMAGES_BUCKET &&
      objectPath.toLowerCase().startsWith(`${businessId.toLowerCase()}/`);
    if (!allowed) return null;
  }
  try {
    // NEVER follow redirects: a permitted first hop must not be able to
    // bounce the fetch to an internal/metadata endpoint (SSRF). Telnyx media
    // and our own signed URLs serve bytes directly; any 3xx is a refusal.
    const res = await fetch(ref, { redirect: "manual" });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = parsed.pathname.slice(parsed.pathname.lastIndexOf(".") + 1).toLowerCase();
    return finish(bytes, contentType || INPUT_MIME_BY_EXT[ext] || "");
  } catch {
    return null;
  }
}

/** Chunked base64 for input images (btoa on a giant string blows the stack). */
function inputImageBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * generate_image step: spend-gated Gemini image generation (or editing, when
 * inputImage is set). Uploads the image to the private generated-images
 * bucket, signs a 32-day URL into vars[saveAs] (consumed by send_sms
 * mediaUrlVar / send_email bodies; the TTL outlives the 30-day max deferral),
 * and meters the flat per-image price into the shared AI budget. A missing
 * API key or an empty model response FAILS the step (unlike extraction there
 * is no fallback that can stand in for an image). AiFlow runs are exempt from
 * the conversational per-session image limit — flows are owner-authored and
 * explicitly enabled.
 */
async function generateImageStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "generate_image" }>
): Promise<StepOutcome> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY") ?? Deno.env.get("GEMINI_API_KEY") ?? "";
  if (!apiKey) {
    return { kind: "fail", error: "generate_image: no AI key is configured on this deployment" };
  }
  // Hard budget gate WITH headroom for this image's flat price (parity with
  // the coworker image tools): images are the priciest single model call,
  // there is no local fallback to degrade to, and the charge must never push
  // the business past the cap. The cap is tier-aware ($5 starter / $10
  // otherwise) plus active purchased credits — the same effective cap
  // getChatSpendSnapshotForBusiness gives the dashboard/SMS tools, so the
  // surfaces can never disagree on whether a tenant may generate. Fails OPEN
  // on a read error like aiFlowSpendOverCap — a metering blip must never
  // block a lead flow.
  const flatCostMicros = IMAGE_COST_MICROS[GEMINI_IMAGE_MODEL] ?? DEFAULT_IMAGE_COST_MICROS;
  if (AIFLOW_SPEND_METERING_ENABLED) {
    let overCap = false;
    try {
      const spend = supabase as unknown as SpendSupabase;
      const periodStart = await resolveChatPeriodStart(spend, run.business_id);
      const spent = await readChatSpendMicros(spend, run.business_id, periodStart);
      const credits = await readActiveChatCreditMicros(spend, run.business_id);
      const { data: bizRow } = await supabase
        .from("businesses")
        .select("tier")
        .eq("id", run.business_id)
        .maybeSingle();
      const tier = (bizRow as { tier?: string | null } | null)?.tier ?? null;
      const capMicros = capMicrosForTier(tier, CHAT_SPEND_CAP_MICROS) + credits;
      overCap = spent + flatCostMicros > capMicros;
    } catch {
      overCap = false;
    }
    if (overCap) {
      // A permanent, owner-actionable state for this period — fail the run
      // now (like classify/extraction) instead of retrying into the cap.
      return {
        kind: "fail",
        error:
          "generate_image: the shared AI budget for this billing period is used up; " +
          "image generation is paused until it resets"
      };
    }
  }

  // Editing mode: resolve the source image BEFORE the (billed) model call.
  // An unresolvable reference FAILS the step — silently generating from
  // scratch instead of editing the owner's chosen photo would be worse.
  let inputImage: { bytes: Uint8Array; mimeType: string } | null = null;
  if (action.inputImage) {
    const trustedTriggerImage =
      typeof scope.trigger?.image === "string" ? scope.trigger.image : "";
    inputImage = await resolveFlowInputImage(
      supabase,
      run.business_id,
      action.inputImage,
      trustedTriggerImage
    );
    if (!inputImage) {
      return {
        kind: "fail",
        error:
          "generate_image: the source image could not be loaded (missing, expired, " +
          "oversized, or not an accepted image type/source)"
      };
    }
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  // fetchWithTransientRetry already rides out 429/5xx blips INSIDE this call.
  // Anything still failing after that is treated as permanent for the run:
  // images are the priciest single model call, and a run-loop retry would
  // call (and bill) Gemini again per attempt — fail the step instead.
  let res: Response;
  try {
    res = await fetchWithTransientRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: action.prompt },
              ...(inputImage
                ? [
                    {
                      inlineData: {
                        mimeType: inputImage.mimeType,
                        data: inputImageBase64(inputImage.bytes)
                      }
                    }
                  ]
                : [])
            ]
          }
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      })
    });
  } catch (e) {
    return {
      kind: "fail",
      error: `generate_image: the image service could not be reached (${
        e instanceof Error ? e.message : String(e)
      })`
    };
  }
  if (!res.ok) return { kind: "fail", error: `generate_image: gemini ${res.status}` };
  type ImageResponse = {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  let body: ImageResponse;
  try {
    body = (await res.json()) as ImageResponse;
  } catch {
    // A 200 with an unreadable body was still billed by Google — fail the
    // step rather than let a retry bill again.
    return { kind: "fail", error: "generate_image: unreadable model response" };
  }
  const inline = (body.candidates?.[0]?.content?.parts ?? []).find(
    (p) => typeof p?.inlineData?.data === "string" && p.inlineData.data.length > 0
  )?.inlineData;
  if (!inline?.data) {
    // Google still bills an image-less response (thinking/text-only) by its
    // token usage — meter that before failing, mirroring the coworker tools.
    const um = body.usageMetadata;
    const promptTokens = Number(um?.promptTokenCount ?? 0);
    const outputTokens =
      Number(um?.candidatesTokenCount ?? 0) + Number(um?.thoughtsTokenCount ?? 0);
    if (
      Number.isFinite(promptTokens) &&
      Number.isFinite(outputTokens) &&
      promptTokens + outputTokens > 0
    ) {
      await meterAiFlowSpend(
        supabase,
        run,
        "generate_image",
        0,
        0,
        geminiCostMicrosFromTokens(GEMINI_MODEL, promptTokens, outputTokens)
      );
    }
    return { kind: "fail", error: "generate_image: the model returned no image" };
  }

  const mimeType = inline.mimeType && inline.mimeType.length > 0 ? inline.mimeType : "image/png";
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  const bytes = Uint8Array.from(atob(inline.data), (c) => c.charCodeAt(0));
  // Store/sign failures also FAIL the step (not throw): a run-loop retry
  // would regenerate — and rebill — the image, and each failed attempt would
  // strand another object in the bucket.
  const path = `${run.business_id}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(GENERATED_IMAGES_BUCKET)
    .upload(path, new Blob([bytes], { type: mimeType }), { contentType: mimeType });
  if (upErr) {
    return { kind: "fail", error: `generate_image: upload failed: ${upErr.message}` };
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from(GENERATED_IMAGES_BUCKET)
    .createSignedUrl(path, GENERATED_IMAGE_URL_TTL_S);
  if (signErr || !signed?.signedUrl) {
    return {
      kind: "fail",
      error: `generate_image: sign failed: ${signErr?.message ?? "no url"}`
    };
  }

  // Meter LAST, once the step can no longer fail (store + sign both done):
  // any earlier failure yields no usable image, and a thrown error here would
  // be retried — metering before the last failure point could bill twice for
  // one intended image. Google bills per generated image — the flat list
  // price, not token math.
  await meterAiFlowSpend(supabase, run, "generate_image", 0, 0, flatCostMicros);

  scope.vars[action.saveAs] = signed.signedUrl;
  appendActionTaken(scope, "generated an image");
  return { kind: "ok", result: { vars: { [action.saveAs]: signed.signedUrl }, path } };
}

/** base64url-encode raw bytes (share tokens; no padding). */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Share links minted by flows live this long (mirrors the app-side default). */
const SHARE_DOCUMENT_TTL_DAYS = 30;

/**
 * share_document: validate the referenced business document, mint a
 * tokenized share link, then deliver it through the SAME machinery as
 * send_sms / send_email (opt-outs, monthly SMS reservation, logging all
 * apply). The eligibility re-check here is the AiFlow-side half of the
 * document-expiration guarantee: a document that expired (or was switched
 * to staff-only, or deleted) AFTER the flow was authored fails the step
 * loudly — with an owner notice — instead of silently sending a stale link.
 */
async function shareDocumentStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "share_document" }>
): Promise<StepOutcome> {
  if (action.skipReason) {
    appendActionTaken(
      scope,
      "skipped sharing the document — no valid recipient was extracted"
    );
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }

  const { data: doc, error: docError } = await supabase
    .from("business_documents")
    .select("id, title, audience, status, expires_at, mime_type")
    .eq("business_id", run.business_id)
    .eq("id", action.documentId)
    .maybeSingle();
  if (docError) throw new Error(`share_document: document read failed: ${docError.message}`);

  // Eligibility gate. Flow recipients are customers, so only ready,
  // client-audience, non-expired documents may go out.
  const expired =
    Boolean(doc?.expires_at) && Date.parse(doc!.expires_at as string) <= Date.now();
  const failReason = !doc
    ? "document_deleted"
    : doc.status !== "ready"
      ? "document_not_ready"
      : doc.audience === "staff"
        ? "document_staff_only"
        : expired
          ? "document_expired"
          : null;
  if (failReason) {
    const title = doc?.title ?? action.documentTitle ?? "a document";
    // Owner notice (best-effort, idempotent per run): a flow quietly
    // skipping its document share is exactly the silent-staleness failure
    // the expiration feature exists to prevent.
    try {
      await sendOwnerSms(
        supabase,
        run,
        failReason === "document_expired"
          ? `Your automation tried to share "${title}", but that document has expired, so nothing was sent. Update or replace it under Dashboard → Memory → Documents.`
          : `Your automation tried to share "${title}", but that document is ${
              failReason === "document_deleted"
                ? "no longer on file"
                : failReason === "document_staff_only"
                  ? "marked internal-only"
                  : "not ready"
            }, so nothing was sent. Review the flow under Dashboard → AiFlows.`,
        `aiflow-sharedoc:${run.id}:${index}`
      );
    } catch (e) {
      console.error("share_document owner notice failed", e);
    }
    return { kind: "fail", error: `share_document: ${failReason}` };
  }

  const appBase = (Deno.env.get("AIFLOW_PLATFORM_URL") ?? "").replace(/\/+$/, "");
  if (!appBase) {
    return { kind: "fail", error: "share_document: AIFLOW_PLATFORM_URL is not configured" };
  }

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = base64UrlEncode(tokenBytes);
  const expiresAt = new Date(
    Date.now() + SHARE_DOCUMENT_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data: shareRow, error: insertError } = await supabase
    .from("business_document_shares")
    .insert({
      business_id: run.business_id,
      document_id: action.documentId,
      token_sha256: await sha256Hex(token),
      shared_with: action.to.slice(0, 200),
      channel: "flow",
      expires_at: expiresAt
    })
    .select("id")
    .single();
  if (insertError) {
    throw new Error(`share_document: share insert failed: ${insertError.message}`);
  }
  const shareId = (shareRow as { id: string }).id;
  const url = `${appBase}/api/public/docs/${token}`;
  if (action.saveAs) scope.vars[action.saveAs] = url;

  // A link the recipient never received must not stay live: on any
  // undelivered outcome the share is revoked (best-effort — it still dies
  // at its TTL if the revoke itself fails).
  const revokeUndelivered = async (): Promise<void> => {
    const { error: revokeError } = await supabase
      .from("business_document_shares")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", shareId);
    if (revokeError) {
      console.error("share_document: undelivered-share revoke failed", revokeError.message);
    }
  };

  // Place the link: explicit {{share_url}} token wins; otherwise append.
  const title = doc!.title as string;
  let body: string;
  if (action.message.includes(SHARE_URL_TOKEN)) {
    body = action.message.split(SHARE_URL_TOKEN).join(url);
  } else if (action.message) {
    body = `${action.message} ${url}`;
  } else {
    body = `Here is "${title}": ${url}`;
  }

  const delivered =
    action.via === "email"
      ? await deliverFlowEmail(supabase, run, index, scope, {
          to: action.to,
          subject: `Document: ${title}`,
          body,
          attachScreenshot: false
        })
      : await sendSmsStep(supabase, run, index, scope, {
          kind: "send_sms",
          to: action.to,
          body
        });
  if (delivered.kind !== "ok" || delivered.skipped) {
    await revokeUndelivered();
    return delivered;
  }
  appendActionTaken(scope, `shared the document "${title}" with ${action.to}`);
  return {
    kind: "ok",
    result: {
      document: title,
      url,
      via: action.via,
      to: action.to,
      link_expires_at: expiresAt,
      ...(delivered.result ?? {})
    }
  };
}

/**
 * send_whatsapp: resolve the recipient (same roster/contact-ref semantics
 * as send_sms), then delegate delivery to the platform's internal
 * whatsapp-send endpoint — the Cloud API client, tenant token decryption,
 * 24h-window check, and template fallback all live in the Next app.
 * Policy skips (no WhatsApp connected, template still in Meta review)
 * come back as structured ok:false results and are recorded as honest
 * step skips with an owner-facing note, never run failures.
 */
async function sendWhatsAppStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "send_whatsapp" }>
): Promise<StepOutcome> {
  if (action.skipReason) {
    appendActionTaken(
      scope,
      "skipped the WhatsApp message — no valid phone number was extracted"
    );
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }

  // Named-agent / contact-ref recipients: resolve the live number and render
  // the raw body, exactly like sendSmsStep.
  let toE164 = action.to;
  let bodyText = action.body;
  if (action.toAgentName) {
    const agent = await resolveAgentByName(supabase, run.business_id, action.toAgentName);
    if (!agent) {
      return {
        kind: "fail",
        error: `send_whatsapp: agent "${action.toAgentName}" is not on the active roster`
      };
    }
    toE164 = agent.phone;
    bodyText = renderTemplate(action.body, agentScope(scope, agent)).trim();
    if (!bodyText) {
      return { kind: "fail", error: "send_whatsapp: body is empty after templating" };
    }
  } else if (action.toRef) {
    const resolved = await resolveContactRef(supabase, run.business_id, action.toRef);
    if (!resolved) {
      return {
        kind: "fail",
        error: `send_whatsapp: ${action.toRef.source} reference could not be resolved (removed or no phone)`
      };
    }
    toE164 = resolved.phone;
    bodyText = renderTemplate(
      action.body,
      action.toRef.source === "employee" ? agentScope(scope, resolved) : scope
    ).trim();
    if (!bodyText) {
      return { kind: "fail", error: "send_whatsapp: body is empty after templating" };
    }
  }

  // Never message ourselves (same extraction-grabbed-our-own-number guard
  // as send_sms).
  if (isSelfPhone(toE164, await businessSelfNumbers(supabase, run.business_id))) {
    return {
      kind: "fail",
      error:
        "send_whatsapp: the recipient is the business's own number — an earlier step " +
        "extracted the business's contact info instead of the lead's"
    };
  }

  const appUrl = (Deno.env.get("NEXT_PUBLIC_APP_URL") ?? "").trim().replace(/\/$/, "");
  const bearer = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  if (!appUrl || !bearer) {
    return { kind: "fail", error: "send_whatsapp: platform delivery is not configured" };
  }

  const isTeammate = Boolean(action.toAgentName) || action.toRef?.source === "employee";
  let res: Response;
  try {
    res = await fetch(`${appUrl}/api/internal/whatsapp-send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        // CSRF gate: src/proxy.ts allows server-to-server bearer POSTs only
        // when Origin matches NEXT_PUBLIC_APP_URL.
        Origin: appUrl
      },
      body: JSON.stringify({
        businessId: run.business_id,
        to: toE164,
        text: bodyText,
        // Teammate sends use the owner-alert template out of window; lead
        // sends use the follow-up template.
        audience: isTeammate ? "owner" : "contact"
      })
    });
  } catch (err) {
    // Transport blip: retryable.
    return {
      kind: "fail",
      error: `send_whatsapp: delivery endpoint unreachable (${(err as Error).message})`
    };
  }
  const payload = (await res.json().catch(() => null)) as {
    data?: {
      ok?: boolean;
      via?: string;
      reason?: string;
      detail?: string;
    };
  } | null;
  if (!res.ok) {
    return { kind: "fail", error: `send_whatsapp: delivery endpoint answered ${res.status}` };
  }
  const result = payload?.data;
  if (!result?.ok) {
    const reason = result?.reason ?? "send_failed";
    if (reason === "not_connected") {
      appendActionTaken(
        scope,
        "skipped the WhatsApp message — WhatsApp is not connected under Integrations"
      );
      return { kind: "ok", skipped: true, result: { skipped: reason } };
    }
    if (reason === "template_not_approved") {
      appendActionTaken(
        scope,
        `skipped the WhatsApp message to ${toE164} — the recipient hasn't messaged recently ` +
          "and the message template is still in Meta review"
      );
      return { kind: "ok", skipped: true, result: { skipped: reason } };
    }
    if (reason === "invalid_recipient") {
      return {
        kind: "fail",
        error: `send_whatsapp: recipient "${toE164}" is not a usable phone number`
      };
    }
    // send_failed: could be transient (Cloud API 5xx) — retryable.
    return {
      kind: "fail",
      error: `send_whatsapp: delivery failed (${result?.detail ?? "unknown"})`
    };
  }

  appendActionTaken(
    scope,
    `sent a WhatsApp message to ${action.toAgentName || action.toRef?.label || toE164}` +
      (result.via === "template" ? " (via approved template — outside the 24h window)" : "")
  );
  return { kind: "ok", result: { to: toE164, via: result.via ?? "text" } };
}

async function sendSmsStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "send_sms" }>
): Promise<StepOutcome> {
  // A templated recipient that resolved to nothing usable (lead had no phone,
  // or the self-number scrub cleared a bogus extraction): skip the outreach
  // with a note in the owner's outcome line instead of failing the run.
  if (action.skipReason) {
    appendActionTaken(
      scope,
      "skipped texting the lead — no valid phone number was extracted"
    );
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }
  // Named-agent send: resolve the roster member's current phone and render the
  // body with {{agent.*}} in scope (the planner left both pending — only the
  // worker can read the roster). Everything below then treats it as a 1:1 send.
  let toE164 = action.to;
  let bodyText = action.body;
  if (action.toAgentName) {
    const agent = await resolveAgentByName(supabase, run.business_id, action.toAgentName);
    if (!agent) {
      return {
        kind: "fail",
        error: `send_sms: agent "${action.toAgentName}" is not on the active roster`
      };
    }
    toE164 = agent.phone;
    // The planner couldn't render this (agent scope is worker-only), so its
    // empty-body guard never ran. Re-check here so an all-template body that
    // resolves to nothing doesn't send a bare compliance-suffix text to a
    // teammate.
    bodyText = renderTemplate(action.body, agentScope(scope, agent)).trim();
    if (!bodyText) return { kind: "fail", error: "send_sms: body is empty after templating" };
  } else if (action.toRef) {
    // Dynamic recipient (saved employee/contact): resolve the LIVE number, then
    // render the (raw) body. An employee ref puts {{agent.*}} in scope like
    // toAgentName; a contact ref renders against plain run vars.
    const resolved = await resolveContactRef(supabase, run.business_id, action.toRef);
    if (!resolved) {
      return {
        kind: "fail",
        error: `send_sms: ${action.toRef.source} reference could not be resolved (removed or no phone)`
      };
    }
    toE164 = resolved.phone;
    bodyText = renderTemplate(
      action.body,
      action.toRef.source === "employee" ? agentScope(scope, resolved) : scope
    ).trim();
    if (!bodyText) return { kind: "fail", error: "send_sms: body is empty after templating" };
  }
  // An employee recipient (named or referenced) is an internal teammate text:
  // never quiet-hours-deferred and never filed as a lead. A contact ref is a
  // lead-side recipient, so it is treated like a plain `to`.
  const internalAgentSend = Boolean(action.toAgentName) || action.toRef?.source === "employee";
  const recipientLabel = action.toAgentName ?? action.toRef?.label ?? "the lead";
  // Lead-contact quiet hours: inside the configured overnight window the lead
  // is never texted. With an extracted lead email we email the same message
  // right away (email is not time-gated) AND still defer the run so the text
  // also goes out at the morning resume time; without an email the run just
  // parks until then via earliest_claim_at. The owner can lift this for the
  // rest of the run by answering an approval gate with "bypass quiet hours".
  // Quiet hours (defer overnight) and the email fallback are lead-contact
  // protections; an agent-directed text (toAgentName) is an internal
  // notification that must not be parked until morning or copied to the lead's
  // email with content meant for a roster member.
  if (action.quiet && !internalAgentSend && scope.vars[BYPASS_QUIET_HOURS_VAR] !== true) {
    const decision = smsQuietDecision(Date.now(), {
      timezone: action.quiet.timezone,
      noSendAfter: action.quiet.noSendAfter,
      resumeAt: action.quiet.resumeAt
    });
    if (!decision.allowed) {
      // Defer re-runs this same step in the morning, so the email send must be
      // once-only across re-claims. The marker rides in scope.vars, which the
      // defer path persists into ai_flow_runs.context.
      const emailedMarker = `_after_hours_emailed_${index}`;
      if (action.quiet.emailTo && !scope.vars[emailedMarker]) {
        const sent = await deliverFlowEmail(supabase, run, index, scope, {
          to: action.quiet.emailTo,
          subject: action.quiet.emailSubject || "Following up on your inquiry",
          body: bodyText,
          attachScreenshot: false,
          fromConnectionId: action.quiet.emailFromConnectionId
        });
        if (sent.kind !== "ok") return sent;
        scope.vars[emailedMarker] = true;
        appendActionTaken(
          scope,
          `emailed the lead at ${action.quiet.emailTo} (after-hours; text scheduled for ` +
            `${formatInTimeZone(decision.resumeAtMs, action.quiet.timezone)})`
        );
      }
      return {
        kind: "defer",
        resumeAtMs: decision.resumeAtMs,
        reason: scope.vars[emailedMarker] ? "sms_quiet_hours_emailed" : "sms_quiet_hours"
      };
    }
  }
  // Group reply: one group MMS to every other participant in the inbound thread
  // (the planner already excluded our own DID). Diverges enough from the 1:1
  // path — recipient list, per-recipient opt-out, array `to` — to live on its
  // own.
  if (action.recipients && action.recipients.length > 0) {
    return await sendGroupSmsStep(supabase, run, index, scope, action);
  }
  if (await isRecipientOptedOut(supabase, run.business_id, toE164)) {
    return { kind: "ok", skipped: true, result: { skipped: "recipient_opted_out", to: toE164 } };
  }
  const cfg = await messagingConfig(supabase, run.business_id);
  if (!cfg) return { kind: "fail", error: "send_sms: Telnyx messaging is not configured" };

  // Never text ourselves: a destination equal to our own sending DID (or any
  // of the business's own numbers) means an upstream extraction grabbed the
  // business's contact info instead of the lead's. Telnyx would reject it
  // anyway (40310, source == destination) — fail the step IMMEDIATELY with a
  // clear message instead of burning MAX_ATTEMPTS on a permanent 400.
  // isSelfPhone normalizes BOTH sides (businesses.phone is free-form), so the
  // guard and the extraction scrub can never disagree.
  if (
    toE164 === cfg.from ||
    isSelfPhone(toE164, await businessSelfNumbers(supabase, run.business_id))
  ) {
    return {
      kind: "fail",
      error:
        `send_sms: destination ${toE164} is this business's own number — refusing to ` +
        "text ourselves. The extracted lead phone is wrong (the extraction likely " +
        "picked up the business's contact info instead of the lead's)."
    };
  }

  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "try_reserve_sms_outbound_slot",
    { p_business_id: run.business_id }
  );
  if (reserveErr) throw new Error(`reserve slot: ${reserveErr.message}`);
  const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
  if (!reserve?.ok) {
    if (reserve?.reason === "monthly_sms_limit") {
      await alertSmsCapOnce(supabase, run.business_id, "ai_flow_send_sms");
    }
    return { kind: "ok", skipped: true, result: { skipped: reserve?.reason ?? "quota" } };
  }

  const release = async () => {
    const { error } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: run.business_id,
      p_refund_bonus: reserve.source === "bonus"
    });
    if (error) console.error("release_sms_outbound_slot", error);
  };

  // Tracked short links: rewrite long URLs in lead-facing texts to /s/<code>
  // redirects so link clicks are measurable per flow (sms_links table).
  // Teammate notifications keep raw URLs — tracking is for lead engagement,
  // and dashboard links read clearer unshortened. Runs AFTER the quota
  // reserve so a quota-skipped step never mints link rows, and every failed
  // send below cleans its rows up — no live redirects for texts nobody got.
  // Strictly fail-safe: any error leaves the original URL and the send
  // proceeds.
  let outboundBody = bodyText;
  let shortenedLinks: Awaited<ReturnType<typeof shortenSmsBodyUrls>>["links"] = [];
  if (!internalAgentSend) {
    const shortened = await shortenSmsBodyUrls(supabase, {
      businessId: run.business_id,
      text: bodyText,
      source: "ai_flow",
      baseUrl: Deno.env.get("NEXT_PUBLIC_APP_URL"),
      toE164,
      flowId: run.flow_id,
      runId: run.id
    });
    outboundBody = shortened.text;
    shortenedLinks = shortened.links;
  }

  // No auto-appended opt-out footer on AiFlow sends. The "Reply STOP to opt out."
  // suffix corrupts control replies (e.g. the literal "Y" a partner system expects)
  // and was never part of these message bodies. We still normalize to GSM-safe text
  // and cap length via prepareSmsBody; STOP/HELP handling lives in the inbound path.
  const text = prepareSmsBody(outboundBody);

  try {
    const send = await telnyxSendSms({
      apiKey: cfg.apiKey,
      messagingProfileId: cfg.profile,
      fromE164: cfg.from,
      toE164,
      text,
      // generate_image attachment → MMS. telnyxSendSms itself keeps media
      // sends off the RCS-first branch (an RCS payload here is text-only).
      ...(action.mediaUrl ? { mediaUrls: [action.mediaUrl] } : {}),
      idempotencyKey: `aiflow:${run.id}:${index}`,
      // Lead-facing texts go RCS-first for eligible tenants (Standard+,
      // approved agent) with Telnyx-side SMS fallback. Internal teammate
      // texts stay plain SMS — the branded business agent shouldn't be the
      // sender identity for roster notifications.
      rcsAgentId: internalAgentSend
        ? null
        : await resolveRcsAgentId(supabase, run.business_id)
    });
    if (!send.ok) {
      await release();
      // The text never went out — remove its tracked links so no live
      // /s/<code> redirect survives for a message nobody received.
      await deleteShortLinks(supabase, shortenedLinks);
      const detail = `telnyx ${send.status}: ${send.body.slice(0, 200)}`;
      // A Telnyx 4xx is PERMANENT for this exact payload (invalid 'to'
      // number, blocked destination, rejected content) — retrying resends
      // the same rejected request. Fail the step readably instead of
      // burning the whole retry budget: a Privyr digest email once yielded
      // lead_phone "+11459337300" (not a dialable NANP number) and the run
      // spent five retries on guaranteed 40310s before dying with a raw
      // error blob. 408 (timeout) and 429 (rate limit) are transient and
      // keep the retry path, as do 5xx/network errors.
      if (send.status >= 400 && send.status < 500 && send.status !== 408 && send.status !== 429) {
        return {
          kind: "fail",
          error:
            `send_sms: the carrier rejected the text to ${toE164} and a retry can't fix it — ` +
            `usually the number isn't a real dialable line. (${detail})`
        };
      }
      throw new Error(detail);
    }
    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(send.body) as { data?: { id?: string } })?.data?.id ?? null;
    } catch {
      messageId = null;
    }
    appendActionTaken(scope, `texted ${recipientLabel} at ${toE164}`);
    const outboundLogId = await logOutboundSms(supabase, run, {
      to: toE164,
      from: cfg.from || null,
      body: text,
      source: "ai_flow",
      telnyxMessageId: messageId,
      channel: send.channel
    });
    await linkSmsLinksToOutboundLog(
      supabase,
      shortenedLinks.map((l) => l.shortCode),
      outboundLogId
    );
    // An agent recipient is a teammate, not a lead — don't file them as a lead
    // customer profile. A contact ref is still a lead-side recipient.
    if (!internalAgentSend) {
      await recordLeadCustomerProfile(supabase, run, scope, toE164);
    }
    return { kind: "ok", result: { to: toE164, messageId } };
  } catch (e) {
    await release();
    await deleteShortLinks(supabase, shortenedLinks);
    throw e;
  }
}

/**
 * send_sms with replyToGroup: post one reply into the inbound thread. The
 * planner supplied every participant except our own DID; here we additionally
 * drop our own number (defensive) and any opted-out recipient, then reserve a
 * SINGLE outbound slot. With 2+ recipients we send a Telnyx group MMS (its
 * dedicated /messages/group_mms endpoint — the standard endpoint rejects a
 * multi-destination SMS `to`); with exactly one we fall back to a normal 1:1
 * SMS so a degenerate "group" of one still delivers.
 */
async function sendGroupSmsStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "send_sms" }>
): Promise<StepOutcome> {
  const cfg = await messagingConfig(supabase, run.business_id);
  if (!cfg) return { kind: "fail", error: "send_sms: Telnyx messaging is not configured" };

  const own = (cfg.from ?? "").trim();
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const r of action.recipients ?? []) {
    const n = r.trim();
    if (!n || n === own || seen.has(n)) continue;
    seen.add(n);
    if (await isRecipientOptedOut(supabase, run.business_id, n)) continue;
    recipients.push(n);
  }
  if (recipients.length === 0) {
    return { kind: "ok", skipped: true, result: { skipped: "group_no_recipients" } };
  }

  // 2+ recipients must go out as a Telnyx group MMS (the standard /messages
  // endpoint rejects a multi-destination `to`). Group MMS requires an explicit
  // MMS-enabled sender, so a missing from-number is a permanent config error.
  // Group MMS requires an explicit MMS-enabled sender (`own`), so a missing
  // from-number is a permanent config error. The 1:1 path below may omit `from`
  // and fall back to the messaging-profile number pool, so it is NOT guarded.
  const isGroup = recipients.length >= 2;
  if (isGroup && !own) {
    return {
      kind: "fail",
      error: "send_sms: group reply needs a configured from-number (MMS-enabled)"
    };
  }

  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "try_reserve_sms_outbound_slot",
    { p_business_id: run.business_id }
  );
  if (reserveErr) throw new Error(`reserve slot: ${reserveErr.message}`);
  const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
  if (!reserve?.ok) {
    if (reserve?.reason === "monthly_sms_limit") {
      await alertSmsCapOnce(supabase, run.business_id, "ai_flow_send_sms");
    }
    return { kind: "ok", skipped: true, result: { skipped: reserve?.reason ?? "quota" } };
  }

  // Group replies are lead-facing too: same tracked-short-link rewrite as the
  // 1:1 path (to_e164 stays null — one body, many recipients). Runs after the
  // reserve, with failed-send cleanup below, so no link row outlives a text
  // that never went out. Fail-safe.
  const groupShortened = await shortenSmsBodyUrls(supabase, {
    businessId: run.business_id,
    text: action.body,
    source: "ai_flow",
    baseUrl: Deno.env.get("NEXT_PUBLIC_APP_URL"),
    flowId: run.flow_id,
    runId: run.id
  });

  const text = prepareSmsBody(groupShortened.text);

  const release = async () => {
    const { error } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: run.business_id,
      p_refund_bonus: reserve.source === "bonus"
    });
    if (error) console.error("release_sms_outbound_slot", error);
  };

  try {
    // Group MMS never goes over RCS; only the degenerate 1:1 send can, so the
    // channel is captured on the non-group branch where the type carries it.
    let send: { ok: boolean; status: number; body: string };
    let sendChannel: "sms" | "rcs" = "sms";
    if (isGroup) {
      send = await telnyxSendGroupMms({
        apiKey: cfg.apiKey,
        fromE164: own,
        toE164: recipients,
        text,
        ...(action.mediaUrl ? { mediaUrls: [action.mediaUrl] } : {}),
        idempotencyKey: `aiflow:${run.id}:${index}`
      });
    } else {
      const single = await telnyxSendSms({
        apiKey: cfg.apiKey,
        messagingProfileId: cfg.profile,
        fromE164: cfg.from,
        toE164: recipients[0],
        text,
        ...(action.mediaUrl ? { mediaUrls: [action.mediaUrl] } : {}),
        idempotencyKey: `aiflow:${run.id}:${index}`,
        // Degenerate group-of-one is a customer-facing text: RCS-eligible.
        rcsAgentId: await resolveRcsAgentId(supabase, run.business_id)
      });
      send = single;
      sendChannel = single.channel;
    }
    if (!send.ok) {
      await release();
      // The group text never went out — remove its tracked links.
      await deleteShortLinks(supabase, groupShortened.links);
      const detail = `telnyx ${send.status}: ${send.body.slice(0, 200)}`;
      // Same permanent-4xx rule as the 1:1 send above (408/429 stay
      // transient): retrying an invalid recipient or rejected payload can
      // only fail again.
      if (send.status >= 400 && send.status < 500 && send.status !== 408 && send.status !== 429) {
        return {
          kind: "fail",
          error:
            `send_sms: the carrier rejected the group text and a retry can't fix it — ` +
            `check the recipient numbers. (${detail})`
        };
      }
      throw new Error(detail);
    }
    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(send.body) as { data?: { id?: string } })?.data?.id ?? null;
    } catch {
      messageId = null;
    }
    appendActionTaken(scope, `replied in the group text to ${recipients.length} recipient(s)`);
    // Log one outbound row per recipient AND record a customer interaction for
    // each, mirroring the 1:1 path so every texted number shows up in Text
    // history and on the Customers page.
    // sms_outbound_log_id is a single FK, so the shared group links pair with
    // the FIRST recipient's log row — enough for thread stats/deep links.
    let groupOutboundLogId: string | null = null;
    for (const to of recipients) {
      const outboundLogId = await logOutboundSms(supabase, run, {
        to,
        from: cfg.from || null,
        body: text,
        source: "ai_flow",
        telnyxMessageId: messageId,
        channel: sendChannel
      });
      groupOutboundLogId ??= outboundLogId;
      await recordLeadCustomerProfile(supabase, run, scope, to);
    }
    await linkSmsLinksToOutboundLog(
      supabase,
      groupShortened.links.map((l) => l.shortCode),
      groupOutboundLogId
    );
    return { kind: "ok", result: { to: recipients, group: true, messageId } };
  } catch (e) {
    await release();
    await deleteShortLinks(supabase, groupShortened.links);
    throw e;
  }
}

/** Chunked base64 encode (btoa on a giant string blows the call stack). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * send_email: deliver a templated email and note it in vars.actions_taken.
 * Delivery itself lives in deliverFlowEmail (shared with the send_sms
 * quiet-hours email fallback).
 */
async function sendEmailStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "send_email" }>
): Promise<StepOutcome> {
  // Extraction-derived recipients (e.g. a lead-marketing email to
  // {{vars.lead_email}}) commonly resolve to the literal "none" when the lead
  // has no address. A non-deliverable `to` 4xxs at Resend and would fail the
  // whole run after a successful claim, so skip the send instead — the owner
  // still learns the outcome via actions_taken / notify_owner. The planner only
  // rejects an EMPTY `to`, and cc/bcc are already EMAIL_RE-validated there, so
  // this just adds the address-shape check the send_sms email fallback also
  // applies (it requires an "@").
  if (!LEAD_EMAIL_RE.test(action.to)) {
    appendActionTaken(scope, `skipped email to "${action.to}" (no valid address)`);
    return { kind: "ok", skipped: true, result: { skipped: "invalid_recipient", to: action.to } };
  }
  const sent = await deliverFlowEmail(supabase, run, index, scope, action);
  if (sent.kind === "ok") appendActionTaken(scope, `emailed ${action.to}`);
  return sent;
}

type FlowEmailArgs = {
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachScreenshot: boolean;
  fromConnectionId?: string;
};

/** The platform email domain tenant mailboxes live under. */
function tenantEmailDomain(): string {
  const raw = (Deno.env.get("TENANT_EMAIL_DOMAIN") ?? "").trim();
  return raw.length > 0 ? raw.toLowerCase() : "newcoworker.com";
}

/**
 * Resolve the dedicated AI-mailbox identity for a business so flow emails send
 * AS the coworker's own address (and replies route back to it, re-triggering
 * tenant_email flows).
 *
 * NEVER returns the platform sender: an account's outbound mail must always go
 * out as that account's coworker. Provisioning normally reserves the row, but we
 * self-heal here by creating the default (business UUID) mailbox if it's missing,
 * so a flow can never fall back to "New Coworker <contact@…>". A hard DB error
 * throws → the run retries rather than silently sending from the platform.
 */
async function ensureMailboxIdentity(
  supabase: Supabase,
  businessId: string
): Promise<{ from: string; address: string }> {
  const { data, error } = await supabase
    .from("tenant_mailboxes")
    .select("local_part")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`ensureMailboxIdentity: ${error.message}`);
  let localPart = (data as { local_part?: string } | null)?.local_part ?? null;

  if (!localPart) {
    // Default local-part is the business UUID (mirrors ensureTenantMailbox in
    // the app).
    const fallback = businessId.toLowerCase();
    const { error: insertError } = await supabase
      .from("tenant_mailboxes")
      .insert({ business_id: businessId, local_part: fallback, personalized: false });
    if (insertError) {
      // 23505 = unique violation. The benign case is a concurrent insert for
      // THIS business (business_id PK) — re-read and use the reserved row. But a
      // 23505 can also mean the local_part is already claimed by ANOTHER tenant;
      // in that case there's no row for this business and we must NOT fall back
      // to the default address (it would resolve to the wrong mailbox). Throw so
      // the run surfaces the conflict instead of sending as someone else.
      if ((insertError as { code?: string }).code !== "23505") {
        throw new Error(`ensureMailboxIdentity insert: ${insertError.message}`);
      }
      const { data: row } = await supabase
        .from("tenant_mailboxes")
        .select("local_part")
        .eq("business_id", businessId)
        .maybeSingle();
      localPart = (row as { local_part?: string } | null)?.local_part ?? null;
      if (!localPart) {
        throw new Error(
          `ensureMailboxIdentity: default mailbox local-part conflict for ${businessId}`
        );
      }
    } else {
      localPart = fallback;
    }
  }

  const address = `${String(localPart).toLowerCase()}@${tenantEmailDomain()}`;
  const { data: biz } = await supabase
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .maybeSingle();
  const name = (biz as { name?: string } | null)?.name?.trim();
  return { from: name ? `${name} <${address}>` : address, address };
}

/**
 * Deliver one flow email.
 *
 * Default path: platform Resend transport, but always sending FROM the tenant's
 * own AI mailbox (created on the fly if missing) — never the platform identity.
 * Optionally attaches the screenshot a prior browse_extract stored (downloaded
 * from the private bucket by path — never by fetching a templatable URL). Missing
 * RESEND_API_KEY is a permanent setup error; a Resend/storage IO failure throws
 * so the run retries.
 *
 * `fromConnectionId` path: the owner chose "send as me" — the worker calls the
 * app's gateway-guarded /api/aiflows/send-owner-email, which sends through the
 * owner's connected Gmail/Outlook via Nango (plain text only). A 200 ok:false
 * means the connection is missing/wrong — a permanent setup error; transport /
 * 5xx failures throw so the run retries.
 */
async function deliverFlowEmail(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: FlowEmailArgs
): Promise<StepOutcome> {
  if (action.fromConnectionId) {
    return deliverOwnerMailboxEmail(supabase, run, action);
  }
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!apiKey) return { kind: "fail", error: "send_email: RESEND_API_KEY is not configured" };

  const SCREENSHOT_FILENAME = "lead-screenshot.jpg";
  let attachment: { filename: string; content: string } | null = null;
  // Metadata logged onto email_log.attachments so the dashboard reading pane can
  // show + sign the screenshot. References the bytes in the screenshots bucket in
  // place (no copy) — see StoredAttachment.bucket.
  let attachmentMeta:
    | { filename: string; mime_type: string; size_bytes: number; storage_path: string; bucket: string }
    | null = null;
  if (action.attachScreenshot) {
    // Tenant guard: only a path under THIS run's business prefix is
    // downloadable (see screenshot_guard.ts) — the var shares scope.vars
    // with extraction outputs, whose values inbound text controls.
    const path = tenantScreenshotPath(run.business_id, scope.vars.screenshot_path);
    if (path) {
      const { data, error } = await supabase.storage.from(SCREENSHOT_BUCKET).download(path);
      if (error || !data) {
        throw new Error(`send_email: screenshot download failed: ${error?.message ?? "no data"}`);
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      attachment = {
        filename: SCREENSHOT_FILENAME,
        content: bytesToBase64(bytes)
      };
      attachmentMeta = {
        filename: SCREENSHOT_FILENAME,
        mime_type: "image/jpeg",
        size_bytes: bytes.byteLength,
        storage_path: path,
        bucket: SCREENSHOT_BUCKET
      };
    }
    // No screenshot in scope (static-fetch fallback or capture failure): send
    // without the attachment rather than stranding the lead email.
  }

  // Always send AS the tenant's own AI mailbox (creating it if missing) so the
  // platform identity is NEVER used on a business's behalf, and replies come
  // back to the coworker (re-triggering tenant_email flows).
  const mailbox = await ensureMailboxIdentity(supabase, run.business_id);
  const fromHeader = mailbox.from;
  const replyTo = mailbox.address;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Resend de-duplicates on retry, mirroring the Telnyx idempotency keys.
      "Idempotency-Key": `aiflow-email/${run.id}/${index}`
    },
    body: JSON.stringify({
      from: fromHeader,
      to: action.to,
      ...(action.cc && action.cc.length > 0 ? { cc: action.cc } : {}),
      ...(action.bcc && action.bcc.length > 0 ? { bcc: action.bcc } : {}),
      reply_to: replyTo,
      subject: action.subject,
      text: action.body,
      ...(attachment ? { attachments: [attachment] } : {})
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`send_email: resend ${res.status}: ${body.slice(0, 200)}`);
  }
  let emailId: string | null = null;
  try {
    emailId = ((await res.json()) as { id?: string })?.id ?? null;
  } catch {
    emailId = null;
  }
  await logFlowEmail(supabase, run, {
    to: action.to,
    cc: action.cc,
    bcc: action.bcc,
    from: fromHeader,
    subject: action.subject,
    body: action.body,
    source: "tenant_mailbox_outbound",
    providerMessageId: emailId,
    attachments: attachmentMeta ? [attachmentMeta] : []
  });
  return {
    kind: "ok",
    result: { to: action.to, emailId, attached: attachment !== null }
  };
}

/**
 * run_agent: hand the rendered input (text or a document ref) to the
 * platform's gateway-guarded run-agent endpoint, which re-checks the agent
 * exists + is enabled, resolves the document when a ref rode along,
 * executes the transformation on central Gemini, meters the spend into the
 * shared AI budget, records the agent_runs history row (source='flow'),
 * optionally files the artifact into Business Documents, and returns the
 * artifact — stamped here into {{vars.<saveAs>}} (plus
 * {{vars.<saveAs>_document_id}} / _document_title when filed).
 */
async function runAgentStep(
  scope: Scope,
  run: RunRow,
  action: Extract<StepAction, { kind: "run_agent" }>
): Promise<StepOutcome> {
  const label = action.agentName ? `agent "${action.agentName}"` : "agent";
  // Templated input rendered to nothing: the lead/run simply has no content
  // to transform — skip (var lands ""), don't fail the flow.
  if (action.skipReason) {
    scope.vars[action.saveAs] = "";
    scope.vars[`${action.saveAs}_document_id`] = "";
    scope.vars[`${action.saveAs}_document_title`] = "";
    appendActionTaken(scope, `skipped ${label} run (${action.skipReason})`);
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const token = Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
  if (!base || !token) {
    return { kind: "fail", error: "run_agent: platform proxy not configured" };
  }
  const res = await fetch(`${base}/api/aiflows/run-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      businessId: run.business_id,
      agentId: action.agentId,
      ...(action.documentRef
        ? { documentRef: action.documentRef }
        : { input: action.input }),
      ...(action.saveTitle ? { saveDocument: { title: action.saveTitle } } : {}),
      flowRunId: run.id
    })
  });
  // 5xx = transport/platform fault → throw so the run retries. 2xx/4xx carry
  // a { ok, detail } body: ok:false there is a permanent setup/budget error
  // (agent missing/disabled, budget exhausted, model refused) → fail without
  // burning retries on a deterministic outcome.
  if (res.status >= 500) {
    const body = await res.text().catch(() => "");
    throw new Error(`run_agent: platform call ${res.status}: ${body.slice(0, 200)}`);
  }
  let parsed: {
    ok?: boolean;
    detail?: string;
    data?: {
      output?: string;
      runId?: string;
      filed?: { documentId: string; title: string } | null;
      fileError?: string;
    };
  };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    throw new Error("run_agent: platform call returned an invalid body");
  }
  if (!parsed.ok || typeof parsed.data?.output !== "string") {
    return {
      kind: "fail",
      error: `run_agent: ${label} run failed (${parsed.detail ?? `http ${res.status}`})`
    };
  }
  scope.vars[action.saveAs] = parsed.data.output;
  // Filed-artifact linkage for later steps (share_document pickers can't
  // reference these, but notify_owner/send_email templates can).
  scope.vars[`${action.saveAs}_document_id`] = parsed.data.filed?.documentId ?? "";
  scope.vars[`${action.saveAs}_document_title`] = parsed.data.filed?.title ?? "";
  appendActionTaken(scope, `ran ${label} (${parsed.data.output.length} chars → {{vars.${action.saveAs}}})`);
  if (parsed.data.filed) {
    appendActionTaken(scope, `filed ${label} output as "${parsed.data.filed.title}"`);
  }
  return {
    kind: "ok",
    result: {
      agentId: action.agentId,
      ...(action.agentName ? { agentName: action.agentName } : {}),
      agent_run_id: parsed.data.runId ?? null,
      output_chars: parsed.data.output.length,
      saved_as: action.saveAs,
      ...(action.documentRef ? { document: action.documentRef } : {}),
      ...(parsed.data.filed ? { filed: parsed.data.filed } : {}),
      ...(parsed.data.fileError ? { file_error: parsed.data.fileError } : {})
    }
  };
}

/** Send via the owner's connected mailbox through the platform adapter. */
async function deliverOwnerMailboxEmail(
  supabase: Supabase,
  run: RunRow,
  action: FlowEmailArgs
): Promise<StepOutcome> {
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const token = Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
  if (!base || !token) {
    return { kind: "fail", error: "send_email: platform proxy not configured for owner-mailbox send" };
  }
  const res = await fetch(`${base}/api/aiflows/send-owner-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      businessId: run.business_id,
      connectionId: action.fromConnectionId,
      toEmail: action.to,
      ...(action.cc && action.cc.length > 0 ? { cc: action.cc } : {}),
      ...(action.bcc && action.bcc.length > 0 ? { bcc: action.bcc } : {}),
      subject: action.subject,
      bodyText: action.body
    })
  });
  // 5xx = provider/transport fault → throw so the run retries. 2xx/4xx carry a
  // { ok, detail } body: ok:false there is a permanent setup error (connection
  // missing / not an email connection / bad args) → fail without retries.
  if (res.status >= 500) {
    const body = await res.text().catch(() => "");
    throw new Error(`send_email: owner-mailbox send ${res.status}: ${body.slice(0, 200)}`);
  }
  let parsed: { ok?: boolean; detail?: string; data?: { messageId?: string | null; provider?: string } };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    throw new Error("send_email: owner-mailbox send returned an invalid body");
  }
  if (!parsed.ok) {
    return {
      kind: "fail",
      error: `send_email: owner-mailbox send failed (${parsed.detail ?? `http ${res.status}`})`
    };
  }
  await logFlowEmail(supabase, run, {
    to: action.to,
    cc: action.cc,
    bcc: action.bcc,
    from: parsed.data?.provider ?? "owner mailbox",
    subject: action.subject,
    body: action.body,
    source: "owner_mailbox",
    providerMessageId: parsed.data?.messageId ?? null
  });
  return {
    kind: "ok",
    result: {
      to: action.to,
      emailId: parsed.data?.messageId ?? null,
      provider: parsed.data?.provider ?? null,
      sent_from: "owner_mailbox"
    }
  };
}

async function notifyOwnerStep(
  supabase: Supabase,
  run: RunRow,
  action: Extract<StepAction, { kind: "notify_owner" }>
): Promise<StepOutcome> {
  await telemetryRecord(supabase, "ai_flow_notify_owner", {
    run_id: run.id,
    business_id: run.business_id,
    message: action.message.slice(0, 300)
  });
  // Best-effort owner SMS to the configured forward number.
  const { data: settingsRow } = await supabase
    .from("business_telnyx_settings")
    .select("forward_to_e164")
    .eq("business_id", run.business_id)
    .maybeSingle();
  const forward = (settingsRow as { forward_to_e164?: string | null } | null)?.forward_to_e164 ?? "";
  const cfg = await messagingConfig(supabase, run.business_id);
  if (forward && cfg) {
    const text = prepareSmsBody(`[AiFlow] ${action.message}`);
    // Metered (never refused) owner traffic — Jul 14 2026 policy.
    const send = await sendOperationalSms(supabase, run.business_id, {
      apiKey: cfg.apiKey,
      messagingProfileId: cfg.profile,
      fromE164: cfg.from,
      toE164: forward,
      text,
      idempotencyKey: `aiflow-notify:${run.id}`
    });
    if (!send.ok) throw new Error(`notify_owner telnyx ${send.status}`);
    await logOutboundSms(supabase, run, {
      to: forward,
      from: cfg.from || null,
      body: text,
      source: "owner_notify"
    });
    return { kind: "ok", result: { notified: forward } };
  }
  return { kind: "ok", result: { notified: null } };
}

async function httpCallStep(
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "http_call" }>
): Promise<StepOutcome> {
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const token = Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
  // The run row is the authoritative tenant id; the trigger context does not
  // carry business_id, so reading it from scope.trigger would send an empty id.
  const businessId = run.business_id;
  if (!base || !token) return { kind: "fail", error: "http_call: platform proxy not configured" };
  const res = await fetch(`${base}/api/integrations/custom/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      businessId,
      label: action.label,
      method: action.method,
      path: action.path,
      body: action.body
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`http_call ${res.status}: ${text.slice(0, 200)}`);
  if (action.saveAs) scope.vars[action.saveAs] = text.slice(0, 4000);
  return { kind: "ok", result: { status: res.status } };
}

/**
 * Wait ceiling for a parked place_ai_call run: long enough for the longest
 * non-transferred AI call (session caps end those in minutes), short enough
 * that a lost hangup webhook only stalls the run briefly. A TRANSFERRED call
 * can outlive this (a human conversation has no cap) — that's fine, because
 * the bridge resumes the run with "transferred" the moment the transfer
 * starts, long before the ceiling.
 */
const PLACE_CALL_WAIT_CEILING_MINUTES = 45;
/** How long a budget-blocked place_ai_call defers before re-probing. */
const PLACE_CALL_BUDGET_RETRY_MINUTES = 240;

/**
 * Place an outbound AI call for a batch flow (the `place_ai_call` step) and
 * park the run until the call's outcome lands.
 *
 * Exactly-once dialing: the run state machine alone can't prevent a re-dial
 * when the worker crashes between the dial and the park write, so the same
 * voice_outbound_dial_log ledger the schedule sweep uses locks the (run,
 * step) occurrence FIRST — a 23505 means an earlier attempt already dialed,
 * so we re-park and let the webhook/timeout resolve the outcome instead of
 * ringing the callee again.
 *
 * Refusal semantics:
 *   - pre-dial budget block → release the ledger lock and DEFER the run
 *     (re-probe later; a temporary budget block must not burn the attempt);
 *   - other pre-dial refusals (config/validation) → not_placed outcome,
 *     continue (the flow's outcome gating decides what happens next);
 *   - post-dial failures → "failed" outcome, continue (the leg was hung up
 *     before the AI attached; no resume will arrive, and the callee was
 *     already rung so this occurrence never re-dials);
 *   - ambiguous no-response from originate → park (a dial and the session
 *     write may have landed; the webhook resumes, the sweep backstops).
 */
async function placeAiCallStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "place_ai_call" }>
): Promise<StepOutcome> {
  // Lead-data gap (no usable callee phone): resolve to the not_placed
  // sentinel and continue — mirrors send_sms's skip semantics.
  if (action.skipReason) {
    scope.vars[action.saveAs] = CALL_NOT_PLACED_SENTINEL;
    scope.vars[action.marker] = "1";
    appendActionTaken(scope, `AI call skipped (${action.skipReason})`);
    return { kind: "ok", skipped: true, result: { skipped: action.skipReason } };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const bearer = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  if (!supabaseUrl || !bearer) {
    return { kind: "fail", error: "place_ai_call: voice origination is not configured" };
  }

  // Resolve dynamic refs to live numbers (resolve-before-dial). Failures are
  // config errors — fail loudly rather than calling with a wrong target.
  let notifyE164 = action.notifyE164 ?? "";
  if (action.notifyRef) {
    const resolved = await resolveContactRef(supabase, run.business_id, action.notifyRef);
    if (!resolved) {
      return {
        kind: "fail",
        error: `place_ai_call: notify ${action.notifyRef.source} reference could not be resolved (removed or no phone)`
      };
    }
    notifyE164 = resolved.phone;
  }
  if (!notifyE164) {
    return { kind: "fail", error: "place_ai_call: no notify number configured" };
  }
  let transfer: { toE164: string; preSmsBody?: string; agentName?: string } | undefined;
  if (action.transferToE164 || action.transferToRef) {
    let transferTo = action.transferToE164 ?? "";
    let agentName = action.transferToRef?.label ?? "";
    if (action.transferToRef) {
      const resolved = await resolveContactRef(supabase, run.business_id, action.transferToRef);
      if (!resolved) {
        return {
          kind: "fail",
          error: `place_ai_call: transfer ${action.transferToRef.source} reference could not be resolved (removed or no phone)`
        };
      }
      transferTo = resolved.phone;
      agentName = resolved.name || agentName;
    }
    transfer = {
      toE164: transferTo,
      ...(action.preSmsBody ? { preSmsBody: action.preSmsBody } : {}),
      ...(agentName ? { agentName } : {})
    };
  }

  const pause = (callControlId: string): StepOutcome => ({
    kind: "pause_call",
    e164: action.to,
    respondByMs: PLACE_CALL_WAIT_CEILING_MINUTES * 60_000,
    saveAs: action.saveAs,
    marker: action.marker,
    callControlId
  });

  const dedupeKey = `pac:${run.id}:${index}`;
  const { error: insErr } = await supabase.from("voice_outbound_dial_log").insert({
    flow_id: run.flow_id,
    business_id: run.business_id,
    dedupe_key: dedupeKey,
    status: "placed"
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      // A previous attempt already dialed this step (crash between dial and
      // park). Never ring the callee again — park and let the webhook (or
      // the timeout sweep's no_answer sentinel) resolve it.
      return pause("");
    }
    throw new Error(`place_ai_call dial ledger insert: ${insErr.message}`);
  }

  const result = await placeOutboundCall(supabaseUrl, bearer, {
    businessId: run.business_id,
    flowId: run.flow_id,
    call: {
      toE164: action.to,
      ...(action.persona ? { persona: action.persona } : {}),
      ...(action.contextNote ? { contextNote: action.contextNote } : {}),
      ...(action.captureFields ? { captureFields: action.captureFields } : {}),
      notifyE164,
      ...(transfer ? { transfer } : {}),
      flowRun: { runId: run.id, saveAs: action.saveAs, marker: action.marker, stepIndex: index }
    }
  });

  if (result.ok) {
    // Stamp the placed leg on the ledger row (audit trail), then park.
    const { error: updErr } = await supabase
      .from("voice_outbound_dial_log")
      .update({ call_control_id: result.callControlId ?? null })
      .eq("flow_id", run.flow_id)
      .eq("dedupe_key", dedupeKey);
    if (updErr) console.error("place_ai_call ledger update", updErr);
    appendActionTaken(scope, `placed an AI call to ${action.to}`);
    return pause(result.callControlId ?? "");
  }

  // Ambiguous no-response: the dial (and even the session write) may have
  // landed. Keep the ledger lock and park — the webhook resumes a placed
  // call, and the timeout sweep backstops a phantom one with no_answer.
  if (result.errorCode === "originate_unreachable") {
    return pause("");
  }

  if (result.retryable) {
    // Refused BEFORE any dial — release the ledger lock so a later attempt
    // (deferral retry, or a future flow occurrence) may dial.
    const { error: delErr } = await supabase
      .from("voice_outbound_dial_log")
      .delete()
      .eq("flow_id", run.flow_id)
      .eq("dedupe_key", dedupeKey);
    if (delErr) console.error("place_ai_call ledger release", delErr);
    if (result.errorCode === "budget") {
      // Over the voice budget: defer the whole run and re-probe later — a
      // temporary budget block must not burn this follow-up attempt.
      return {
        kind: "defer",
        resumeAtMs: Date.now() + PLACE_CALL_BUDGET_RETRY_MINUTES * 60_000,
        reason: `voice budget (${result.reason ?? "blocked"})`
      };
    }
    // Config/validation refusal (no Telnyx connection, invalid callee, ...):
    // record the not_placed outcome and continue so notify/branch steps
    // still run and the owner can see why in the run history.
    scope.vars[action.saveAs] = CALL_NOT_PLACED_SENTINEL;
    scope.vars[action.marker] = "1";
    appendActionTaken(scope, `AI call not placed (${result.reason ?? "refused"})`);
    return {
      kind: "ok",
      result: { outcome: CALL_NOT_PLACED_SENTINEL, reason: result.reason ?? null }
    };
  }

  // Failed AFTER the dial (post-dial budget refusal, session persist failure,
  // lost call id): originate hung the leg up before the AI attached and no
  // session run-link was written, so no resume will ever arrive. Record the
  // failed outcome and continue; the ledger row stays terminal (the callee
  // was rung — this occurrence never re-dials).
  const { error: failUpdErr } = await supabase
    .from("voice_outbound_dial_log")
    .update({ status: "failed", reason: result.reason ?? null })
    .eq("flow_id", run.flow_id)
    .eq("dedupe_key", dedupeKey);
  if (failUpdErr) console.error("place_ai_call ledger fail-update", failUpdErr);
  scope.vars[action.saveAs] = "failed";
  scope.vars[action.marker] = "1";
  appendActionTaken(scope, `AI call failed (${result.reason ?? "error"})`);
  return { kind: "ok", result: { outcome: "failed", reason: result.reason ?? null } };
}

function approvalStep(
  approval: Record<string, unknown>,
  scope: Scope,
  index: number,
  action: Extract<StepAction, { kind: "await_approval" }>
): StepOutcome {
  if (approval.decision === "approve" && approval.consumed !== true) {
    approval.consumed = true;
    return { kind: "ok", result: { approved: true } };
  }
  // "Bypass quiet hours": approve AND drop the quiet-hours gate on every
  // remaining send_sms step in this run. The flag rides in scope.vars (which
  // buildContext persists), so it survives re-claims and later gates.
  if (approval.decision === "bypass_quiet_hours" && approval.consumed !== true) {
    approval.consumed = true;
    scope.vars[BYPASS_QUIET_HOURS_VAR] = true;
    return { kind: "ok", result: { approved: true, quiet_hours_bypassed: true } };
  }
  // "Skip": don't run the action this gate guards — the step immediately
  // following the gate — but keep the rest of the workflow going (later
  // emails, team routing, timeline updates). A full stop is "cancel" (always
  // the LAST reply digit / dashboard Cancel), which never reaches the worker:
  // the decide paths set the run to canceled directly.
  if (approval.decision === "skip" && approval.consumed !== true) {
    approval.consumed = true;
    return { kind: "ok", result: { approved: false, skipped_gated_step: true }, skipNextStep: true };
  }
  // Stash the prompt for the dashboard approvals inbox.
  approval.prompt = action.prompt;
  return { kind: "pause" };
}

/**
 * route_to_team: offer the lead to one team agent at a time over SMS, escalating
 * on reject/timeout, and falling back to the owner when the roster is exhausted.
 *
 * Re-entrant via `routing` (persisted in context.routing): the inbound webhook
 * stamps last_event='claim'|'reject' on an agent's 1/2 reply and the escalation
 * sweep stamps 'timeout'; this handler resumes accordingly. Rowboat owns agent
 * SELECTION (its vault memory holds the roster + rotation); the engine owns the
 * ORCHESTRATION (offer SMS, deadline, escalation, owner fallback).
 */
// Sentinel pinned-name used when an agentRef can't be resolved: it matches no
// real roster row (names are compared trimmed/lower-cased), so the offer falls
// through to the owner fallback — the same "pinned agent missing" path as a
// stale agentName — instead of round-robin to an unintended teammate.
const UNRESOLVED_AGENT_REF = "\u0000__unresolved_agent_ref__";

/**
 * Is lead auto-assignment on for this business? (Truly Issue 7 — Employees
 * page toggle.) Fails CLOSED to offer-and-claim on any read error: wrongly
 * hard-assigning a lead is worse than wrongly asking for a claim.
 */
async function leadAutoAssignEnabled(supabase: Supabase, businessId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("lead_auto_assign")
      .eq("id", businessId)
      .maybeSingle();
    if (error) {
      console.error("leadAutoAssignEnabled", error);
      return false;
    }
    return (data as { lead_auto_assign?: boolean } | null)?.lead_auto_assign === true;
  } catch (e) {
    console.error("leadAutoAssignEnabled", e);
    return false;
  }
}

async function routeToTeamStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "route_to_team" }>,
  // Typed contract shared with the inbound webhook — see
  // _shared/ai_flows/routing.ts for each field's full lifecycle.
  routing: OfferRouting,
  // This step's index: auto-assignment stamps it as route_step_index so a
  // teammate's "86" can re-open the finished run (offer mode stamps it at
  // park time in executeRun instead).
  stepIndex: number
): Promise<StepOutcome> {
  const tried: string[] = Array.isArray(routing.tried)
    ? (routing.tried as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  routing.tried = tried;

  // Dynamic pin (agentRef): resolve the referenced roster member's CURRENT name
  // and pin to it (stable across renames). agentRef is always an employee
  // (enforced at author time); an unresolved ref pins to a sentinel so the offer
  // falls through to the owner fallback rather than to an unintended teammate.
  let pinnedAgentName = action.agentName;
  if (action.agentRef) {
    const referenced = await resolveContactRef(supabase, run.business_id, action.agentRef);
    pinnedAgentName = referenced?.name ?? UNRESOLVED_AGENT_REF;
  }

  // A teammate retroactively UNCLAIMED a lead they'd taken (inbound "86"): clear
  // the claim, hand it back to the owner, and finalize WITHOUT replaying the
  // steps after route_to_team. The inbound webhook re-opened the run at this
  // step and stamped last_event='unclaim' + reply_from. Handled before the
  // claim block so an unclaim is never mistaken for a claim.
  if (routing.last_event === "unclaim") {
    const releasedBy =
      typeof routing.reply_from === "string" && routing.reply_from
        ? routing.reply_from
        : typeof routing.claimed_by === "string"
          ? routing.claimed_by
          : "";
    const releasedName =
      typeof routing.claimed_name === "string" && routing.claimed_name
        ? routing.claimed_name
        : typeof routing.offered_name === "string"
          ? routing.offered_name
          : "";
    const who = releasedName || releasedBy || "A teammate";
    // The lead is no longer claimed by anyone: clear claim state and reset the
    // gating var so claim-gated steps would NOT run (we end the run anyway).
    delete routing.last_event;
    delete routing.reply_from;
    delete routing.offered;
    delete routing.offered_name;
    delete routing.claimed_by;
    delete routing.claimed_name;
    delete routing.late_claimed;
    delete routing.claim_timeframe;
    scope.vars.claimed_agent = "none";
    scope.vars.claimed_agent_phone = "none";
    scope.vars.claimed_agent_eta_minutes = "0";
    // Notify the owner the lead bounced back. Reuse the tenant's owner-fallback
    // copy (their "back to you" wording) with a leading line naming who let it
    // go, so the owner knows it was claimed-then-released (not never claimed).
    const fallbackBody = renderTemplate(action.ownerFallbackTemplate, scope);
    const body = `${who} released this lead — it's back with you.\n${fallbackBody}`;
    await sendOwnerSms(supabase, run, body, `aiflow-unclaimed:${run.id}`);
    appendActionTaken(scope, `lead unclaimed by ${who}; returned to the owner`);
    return {
      kind: "ok",
      result: { routed: "unclaimed", unclaimed_by: releasedBy },
      endRun: true
    };
  }

  // An agent claimed (inbound '1' — live, late, or first-to-claim yank):
  // finalize and optionally tell the owner.
  if (routing.last_event === "claim") {
    // Late claim: the offer had already lapsed (and likely fallen back to the
    // owner) when the agent texted "1". Notify the owner the same way, then
    // finalize WITHOUT replaying the steps after route_to_team. ("86" is the
    // OPPOSITE — a retroactive unclaim — handled above.)
    const lateClaim = routing.late_claim === true;
    const claimedBy =
      typeof routing.reply_from === "string" && routing.reply_from
        ? routing.reply_from
        : typeof routing.offered === "string"
          ? routing.offered
          : "";
    const claimedName = typeof routing.offered_name === "string" ? routing.offered_name : "";
    // Optional ETA the teammate stated when claiming ("4, 20 min" → "20 min"),
    // stamped on routing by the inbound webhook. Surfaced to the owner (claim
    // notice + actions_taken/notify_owner) so they know WHEN the lead is contacted.
    const claimTimeframe =
      typeof routing.claim_timeframe === "string" ? routing.claim_timeframe.trim() : "";
    routing.claimed_by = claimedBy;
    routing.claimed_name = claimedName;
    // Engine-provided var so LATER steps can gate on "a teammate accepted" via
    // `when: { var: "claimed_agent", notEquals: "none" }`. Mirrors routing into
    // scope.vars (which `when` guards read). Name preferred, phone as fallback.
    scope.vars.claimed_agent = claimedName || claimedBy || "none";
    // The claimer's E.164 (so a later wait_for_reply can park on THEIR next
    // text) and their stated ETA as whole minutes ("0" when absent/vague) —
    // parsed here, while the timeframe is still in hand before it's cleared.
    scope.vars.claimed_agent_phone = claimedBy || "none";
    scope.vars.claimed_agent_eta_minutes = String(parseEtaMinutes(claimTimeframe));
    delete routing.last_event;
    delete routing.reply_from;
    delete routing.offered;
    delete routing.offered_name;
    delete routing.late_claim;
    delete routing.step_index;
    delete routing.claim_timeframe;
    // Legacy per-flow reply digits (tf_digit / late_digit) are gone: "1"
    // claims and "2" passes universally. Scrub any stamp left by an old
    // deploy so no stored run keeps a digit the webhook no longer honors.
    delete routing.tf_digit;
    delete routing.late_digit;
    if (lateClaim) routing.late_claimed = true;
    if (action.claimedNotifyTemplate) {
      let body = renderTemplate(
        action.claimedNotifyTemplate,
        agentScope(scope, { name: claimedName, phone: claimedBy })
      );
      // Appended (not templated) so EVERY Dave-routed flow's claim notice carries
      // the ETA without editing each template, and an empty ETA adds nothing.
      if (claimTimeframe) body += `\nETA to contact lead: ${claimTimeframe}`;
      // Distinct idempotency key for a late claim so it isn't deduped against an
      // earlier owner-fallback/claim notice on the same run.
      const notifyKey = lateClaim ? `aiflow-late-claimed:${run.id}` : `aiflow-claimed:${run.id}`;
      await sendOwnerSms(supabase, run, body, notifyKey);
    }
    appendActionTaken(
      scope,
      // No "(86)" here: "86" is the retroactive UNCLAIM digit — a late claim
      // arrives as a "1" on a lapsed offer. The old label taught owners the
      // wrong digit.
      `lead ${lateClaim ? "claimed late by" : "claimed by"} ${claimedName || claimedBy}` +
        (claimTimeframe ? ` (ETA: ${claimTimeframe})` : "")
    );
    // Claim-driven ownership: the claimer becomes the contact's owner if the
    // contact is currently unowned (never steals). Best-effort by design.
    if (claimedBy) await assignContactOwnerOnClaim(supabase, run, scope, claimedBy);
    // Goal Events: a claim may jump the lead's OTHER parked/queued runs (e.g.
    // a nurture flow) to a "claimed" goal. This run continues normally.
    {
      const leadPhone = leadContactPhone(scope);
      if (leadPhone) {
        await applyGoalEvent(supabase, run.business_id, leadPhone, { kind: "claimed" });
      }
    }
    return {
      kind: "ok",
      result: { routed: lateClaim ? "late_claimed" : "claimed", claimed_by: claimedBy },
      ...(lateClaim ? { endRun: true } : {})
    };
  }

  // A pass with a stated reason ("2, out of town"): the inbound webhook stamps
  // routing.pass_reason on the reject. Record it — accumulated on
  // routing.pass_reasons (one entry per passing teammate) and in actions_taken —
  // so the owner-fallback notice and the run summary say WHY the lead bounced.
  // Cleared afterwards so a later offer never inherits a stale reason.
  const passReason =
    typeof routing.pass_reason === "string" ? routing.pass_reason.trim() : "";
  if (routing.last_event === "reject" && passReason) {
    const passerName =
      (typeof routing.offered_name === "string" && routing.offered_name) ||
      (typeof routing.reply_from === "string" && routing.reply_from) ||
      "a teammate";
    const reasons = Array.isArray(routing.pass_reasons)
      ? (routing.pass_reasons as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    reasons.push(`${passerName}: ${passReason}`);
    routing.pass_reasons = reasons;
    appendActionTaken(scope, `${passerName} passed (${passReason})`);
  }
  delete routing.pass_reason;

  // First entry, reject ('2'), or timeout: retire the agent we last offered, then
  // ask Rowboat for the next one.
  const prevOffered = typeof routing.offered === "string" ? routing.offered : "";
  if (prevOffered && !tried.includes(prevOffered)) tried.push(prevOffered);
  // routing.offered is only ever set when an offer SMS actually went out, so
  // the retiring agent belongs in offered_log too. This is what backfills
  // yank rights for runs already in flight when offered_log first shipped
  // (their earlier offers predate the field).
  if (prevOffered) {
    const offeredLog = Array.isArray(routing.offered_log)
      ? (routing.offered_log as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!offeredLog.includes(prevOffered)) offeredLog.push(prevOffered);
    routing.offered_log = offeredLog;
  }
  delete routing.offered;
  delete routing.offered_name;
  delete routing.last_event;
  delete routing.reply_from;

  // Keep-for-owner rule (e.g. the $1M+ price band): when the configured
  // condition matches on FIRST entry — before anyone was ever offered — the
  // lead is never offered to the team. The owner gets the ownerDirect SMS
  // with the details, and claimed_agent="none" makes every claim-gated later
  // step skip (the flow's unclaimed/outcome notify still fires and its
  // actions_taken line says why). Checked only when offered_log is empty so
  // a resumed run mid-escalation can never re-branch here.
  const everOffered = Array.isArray(routing.offered_log) && routing.offered_log.length > 0;
  if (
    action.ownerDirectWhen &&
    action.ownerDirectTemplate &&
    !everOffered &&
    tried.length === 0 &&
    evaluateStepCondition(action.ownerDirectWhen, scope)
  ) {
    scope.vars.claimed_agent = "none";
    scope.vars.claimed_agent_phone = "none";
    scope.vars.claimed_agent_eta_minutes = "0";
    const body = renderTemplate(action.ownerDirectTemplate, scope);
    await sendOwnerSms(supabase, run, body, `aiflow-owner-direct:${run.id}`);
    appendActionTaken(
      scope,
      `kept for the owner (${action.ownerDirectWhen.var} matched the keep-for-owner rule) — not offered to the team`
    );
    await telemetryRecord(supabase, "ai_flow_route_owner_direct", {
      run_id: run.id,
      business_id: run.business_id,
      var: action.ownerDirectWhen.var,
      value: String(scope.vars[action.ownerDirectWhen.var] ?? "")
    });
    return { kind: "ok", result: { routed: "owner_direct" } };
  }

  const leadPhone = leadPhoneE164(scope);
  // Auto-assign mode (businesses.lead_auto_assign, Truly Issue 7): the
  // rotation pick IS the assignment — no offer/claim handshake. Resolved
  // per entry (not cached) so a Settings flip applies to the next lead.
  // A read failure falls back to offer-and-claim, never the other way:
  // wrongly hard-assigning a lead is worse than wrongly asking for a claim.
  const autoAssign = await leadAutoAssignEnabled(supabase, run.business_id);
  // Owner-first routing (preferContactOwner): a repeat lead whose contact
  // already has an owning employee gets offered to "their" person first; the
  // normal cascade follows if they pass or time out (they land in `tried`).
  // A pinned agent (agentName/agentRef) wins over the preference, and a
  // preferred owner already tried is a no-op — so this only shapes the FIRST
  // offer and never loops.
  let preferredAgent: RoutedAgent | null = null;
  if (action.preferContactOwner && !pinnedAgentName) {
    const owner = await contactOwnerAgent(supabase, run.business_id, scope);
    if (owner && !tried.includes(owner.phone)) preferredAgent = owner;
  }
  for (let i = 0; i < ROUTE_MAX_LOOKUPS; i++) {
    const preferredThisPass = preferredAgent;
    const agent =
      preferredAgent ?? (await pickNextAgent(supabase, run, scope, tried, pinnedAgentName));
    preferredAgent = null;
    // No agent at all (none / parse fail / unconfigured / pinned agent missing):
    // roster is exhausted.
    if (!agent) break;
    // Rowboat repeated an agent we already tried: don't end routing on one bad
    // pick — consume another lookup and ask again (bounded by ROUTE_MAX_LOOKUPS).
    if (tried.includes(agent.phone)) continue;
    // Never offer the lead their own number: a hallucinated Rowboat pick (or a
    // corrupt roster row) must not text the lead an agent "offer".
    if (leadPhone && agent.phone === leadPhone) {
      tried.push(agent.phone);
      continue;
    }
    // A teammate who texted STOP is opted out: skip them and ask for the next.
    if (await isRecipientOptedOut(supabase, run.business_id, agent.phone)) {
      tried.push(agent.phone);
      continue;
    }
    if (autoAssign) {
      // Hard assignment: record the claim NOW (same state shape a "1" reply
      // produces — claimed_by/claimed_name on routing, claimed_agent var for
      // claim-gated later steps, contact ownership, claimed goal) and send
      // the teammate an FYI instead of an offer. routing.offered is NOT set:
      // there is no live offer for the webhook's claim/yank machinery to act
      // on. The rotation cursor was already stamped by pickNextAgent, so
      // fairness holds exactly as in offer mode.
      routing.claimed_by = agent.phone;
      routing.claimed_name = agent.name;
      routing.auto_assigned = true;
      // Rewind target for a retroactive "86" unclaim: the webhook re-opens a
      // claimed-and-finished run at route_step_index, which offer mode stamps
      // at park time — auto-assign never parks, so stamp it here or an
      // auto-assigned lead could never be handed back (Bugbot on PR #580).
      routing.route_step_index = stepIndex;
      scope.vars.claimed_agent = agent.name || agent.phone;
      // Auto-assign has no claim handshake, so there is never a stated ETA.
      scope.vars.claimed_agent_phone = agent.phone;
      scope.vars.claimed_agent_eta_minutes = "0";
      const fyiMms = action.attachScreenshot ? await screenshotMmsUrl(supabase, run, scope) : null;
      const fyiBody =
        "New lead assigned to you (auto-assign is on — it's yours, no reply " +
        'needed; reply "86" to hand it back):\n' +
        renderTemplate(action.offerTemplate, agentScope(scope, agent));
      // FYI delivery is best-effort: the assignment is the durable fact; a
      // Telnyx hiccup must not bounce the lead back into rotation. The
      // owner notice below still lands (its own channel), and the lead
      // shows as assigned on Tasks either way.
      try {
        await sendOfferSms(
          supabase,
          run,
          agent.phone,
          fyiBody,
          `aiflow-assign:${run.id}:${tried.length}`,
          fyiMms ? [fyiMms] : undefined
        );
      } catch (e) {
        console.error("route_to_team auto-assign FYI send failed", e);
        await systemLog(supabase, {
          businessId: run.business_id,
          source: "aiflow",
          level: "warn",
          event: "ai_flow_assign_sms_failed",
          message: `auto-assign FYI send failed: ${e instanceof Error ? e.message : String(e)}`,
          payload: { run_id: run.id, flow_id: run.flow_id, agent: agent.phone }
        });
      }
      if (action.claimedNotifyTemplate) {
        const ownerBody = renderTemplate(action.claimedNotifyTemplate, agentScope(scope, agent));
        await sendOwnerSms(supabase, run, ownerBody, `aiflow-claimed:${run.id}`);
      }
      appendActionTaken(scope, `lead auto-assigned to ${agent.name || agent.phone} (round robin)`);
      await assignContactOwnerOnClaim(supabase, run, scope, agent.phone);
      {
        const assignedLeadPhone = leadContactPhone(scope);
        if (assignedLeadPhone) {
          await applyGoalEvent(supabase, run.business_id, assignedLeadPhone, { kind: "claimed" });
        }
      }
      await telemetryRecord(supabase, "ai_flow_route_auto_assigned", {
        run_id: run.id,
        business_id: run.business_id,
        agent: agent.phone
      });
      return {
        kind: "ok",
        result: { routed: "auto_assigned", claimed_by: agent.phone }
      };
    }
    routing.offered = agent.phone;
    routing.offered_name = agent.name;
    // Log of teammates ACTUALLY texted an offer (unlike `tried`, which also
    // collects opt-out/lead-phone skips that never saw one). The webhook's
    // first-to-claim yank grants takeover rights from this log only.
    const offeredLog = Array.isArray(routing.offered_log)
      ? (routing.offered_log as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!offeredLog.includes(agent.phone)) offeredLog.push(agent.phone);
    routing.offered_log = offeredLog;
    // Reply digits are universal ("1" claim, "2" pass, "86" unclaim), so no
    // per-flow digit is stamped anymore. Clear stamps a pre-migration deploy
    // may have left so re-offered runs shed them.
    delete routing.tf_digit;
    delete routing.late_digit;
    // First to claim is ON by default; only an explicit opt-out is stamped so
    // the inbound webhook can refuse the bare-"1" yank for this flow.
    if (action.firstToClaim === false) routing.first_to_claim = false;
    else delete routing.first_to_claim;
    // After-hours offer window: the offer SMS still goes out now, but inside
    // the quiet window the claim deadline extends to quietEnd + grace so the
    // countdown effectively starts in the morning. The resolved deadline is
    // exposed to the template as {{offer.deadline}} in the owner's zone.
    const nowMs = Date.now();
    const deadlineMs = offerRespondByMs(nowMs, action.responseMinutes, action.offerWindow);
    // The offer SMS itself is sent by executeRun AFTER the awaiting_agent state
    // is persisted (state before side effect); we only carry the rendered body
    // and a per-agent idempotency key here. The MMS URL is signed fresh per
    // offer so an escalation hours later never carries an expired link.
    const mmsUrl = action.attachScreenshot ? await screenshotMmsUrl(supabase, run, scope) : null;
    let offerText = renderTemplate(
      action.offerTemplate,
      agentScope(scope, agent, formatInTimeZone(deadlineMs, action.offerWindow?.timezone ?? "UTC"))
    );
    // If this teammate ALREADY holds a live offer from another run, lead with
    // a heads-up: a single "1" only answers the newest offer, so without it
    // they'd reasonably assume one reply took both leads (the Jul 2026 Dave
    // two-leads confusion). Best-effort — a count failure never blocks the offer.
    const alreadyPending = await countOtherLiveOffers(supabase, run, agent.phone);
    if (alreadyPending > 0) {
      offerText = `${multiOfferHeadsUpLine(alreadyPending + 1)}\n${offerText}`;
    }
    if (preferredThisPass && agent.phone === preferredThisPass.phone) {
      appendActionTaken(
        scope,
        `offered ${agent.name || agent.phone} first — they own this contact`
      );
    }
    return {
      kind: "pause_agent",
      e164: agent.phone,
      respondByMs: Math.max(60_000, deadlineMs - nowMs),
      offerText,
      idempotencyKey: `aiflow-offer:${run.id}:${tried.length}`,
      ...(mmsUrl ? { mediaUrls: [mmsUrl] } : {})
    };
  }

  // Roster exhausted: hand the lead to the owner so it is never dropped. Mark
  // claimed_agent="none" so claim-gated LATER steps (e.g. the lead marketing
  // text/email) are skipped — only ungated steps like notify_owner still run.
  scope.vars.claimed_agent = "none";
  scope.vars.claimed_agent_phone = "none";
  scope.vars.claimed_agent_eta_minutes = "0";
  let body = renderTemplate(action.ownerFallbackTemplate, scope);
  // Appended (not templated) so EVERY flow's fallback notice carries the pass
  // reasons teammates stated ("2, <reason>") without editing each template.
  const passReasons = Array.isArray(routing.pass_reasons)
    ? (routing.pass_reasons as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (passReasons.length > 0) body += `\nPassed: ${passReasons.join("; ")}`;
  await sendOwnerSms(supabase, run, body, `aiflow-owner-fallback:${run.id}`);
  appendActionTaken(scope, "no agent claimed the lead; handed back to the owner");
  return { kind: "ok", result: { routed: "owner_fallback", tried: tried.length } };
}

/**
 * How many OTHER runs of this business currently have a live offer out to
 * `agentPhone` (status awaiting_agent/queued with routing.offered stamped —
 * the same bucket the inbound webhook matches replies against). Used for the
 * multi-offer heads-up line. Best-effort: returns 0 on a query error so a
 * counting hiccup never blocks the offer itself.
 */
async function countOtherLiveOffers(
  supabase: Supabase,
  run: RunRow,
  agentPhone: string
): Promise<number> {
  const { count, error } = await supabase
    .from("ai_flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", run.business_id)
    .in("status", ["awaiting_agent", "queued"])
    .eq("context->routing->>offered", agentPhone)
    .neq("id", run.id);
  if (error) {
    console.error("countOtherLiveOffers", error);
    return 0;
  }
  return count ?? 0;
}

/**
 * Scope for templating an agent-facing SMS: run vars/trigger plus {{agent.*}}
 * and (when resolved) the {{offer.deadline}} claim deadline. Carries
 * {{coworker.email}} through too so it stays resolvable in route_to_team
 * offer/claimed templates (it's documented as always available).
 */
function agentScope(scope: Scope, agent: RoutedAgent, deadline?: string): Record<string, unknown> {
  return {
    vars: scope.vars,
    trigger: scope.trigger,
    ...(scope.now ? { now: scope.now } : {}),
    ...(scope.coworker ? { coworker: scope.coworker } : {}),
    agent: { name: agent.name, phone: agent.phone },
    ...(deadline ? { offer: { deadline } } : {})
  };
}

/**
 * Resolve a single named roster member to {name, phone} for a send_sms
 * { toAgentName } step. Active members only; first match by created_at when a
 * name is duplicated. Returns null when no active member matches; THROWS on a
 * query error so the run retries rather than silently mis-sending.
 */
async function resolveAgentByName(
  supabase: Supabase,
  businessId: string,
  name: string
): Promise<RoutedAgent | null> {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const { data, error } = await supabase
    .from("ai_flow_team_members")
    .select("name, phone_e164")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`send_sms: roster query failed: ${error.message}`);
  const rows = (data ?? []) as { name: string; phone_e164: string }[];
  const match = rows.find((r) => r.name.trim().toLowerCase() === want);
  const phone = match?.phone_e164?.trim();
  if (!match || !phone) return null;
  return { name: match.name, phone };
}

/** The lead's own phone (from vars.lead_phone) normalized to E.164, or null. */
function leadPhoneE164(scope: Scope): string | null {
  const raw = typeof scope.vars.lead_phone === "string" ? scope.vars.lead_phone.trim() : "";
  if (!raw) return null;
  return isE164(raw) ? raw : normalizeNanpToE164(raw);
}

/**
 * The phone that identifies this lead's CONTACT row: vars.lead_phone when an
 * extraction produced one, else the triggering sender (SMS-triggered flows).
 * Used by contact-ownership routing (preferContactOwner + claim auto-assign).
 */
function leadContactPhone(scope: Scope): string | null {
  const fromVars = leadPhoneE164(scope);
  if (fromVars) return fromVars;
  const from = typeof scope.trigger?.from === "string" ? scope.trigger.from.trim() : "";
  return from && isE164(from) ? from : null;
}

/**
 * The roster member who OWNS this lead's contact (contacts.owner_employee_id),
 * resolved to {name, phone}, or null (no phone / no contact / unowned /
 * owner inactive / owner unavailable). Alias-aware like getCustomerMemory.
 * Applies the SAME working-info rules as pickNextAgent — time off covering
 * today and out-of-schedule members are hard skips — so ownership preference
 * never routes around an owner's time off; the normal cascade takes over.
 * Best-effort: a lookup error logs and returns null — ownership preference
 * must never stall routing.
 */
async function contactOwnerAgent(
  supabase: Supabase,
  businessId: string,
  scope: Scope
): Promise<RoutedAgent | null> {
  const phone = leadContactPhone(scope);
  if (!phone) return null;
  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("owner_employee_id")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`)
      .maybeSingle();
    const ownerId = (contact as { owner_employee_id?: string | null } | null)?.owner_employee_id;
    if (!ownerId) return null;
    const { data: member } = await supabase
      .from("ai_flow_team_members")
      .select("id, name, phone_e164, active, weekly_schedule, preferred_windows")
      .eq("business_id", businessId)
      .eq("id", ownerId)
      .maybeSingle();
    const m = member as {
      id?: string;
      name?: string;
      phone_e164?: string;
      active?: boolean;
      weekly_schedule?: unknown;
      preferred_windows?: unknown;
    } | null;
    if (!m?.id || !m.active || !m.phone_e164?.trim()) return null;
    // Availability (business-local): the owner on time off today or outside
    // their weekly schedule is skipped, same as in pickNextAgent.
    const [tzRes, offRes] = await Promise.all([
      supabase.from("businesses").select("timezone").eq("id", businessId).maybeSingle(),
      supabase
        .from("employee_time_off")
        .select("member_id, starts_on, ends_on")
        .eq("business_id", businessId)
        .eq("member_id", m.id)
    ]);
    const tz = (tzRes.data as { timezone?: string | null } | null)?.timezone ?? null;
    const clock = localClock(new Date(), tz);
    const offIds = new Set(
      ((offRes.data ?? []) as { member_id: string; starts_on: string; ends_on: string }[])
        .filter((t) => t.starts_on <= clock.isoDate && t.ends_on >= clock.isoDate)
        .map((t) => t.member_id)
    );
    const available = filterRosterByAvailability(
      [
        {
          id: m.id,
          name: m.name ?? "",
          phone_e164: m.phone_e164.trim(),
          weekly_schedule: m.weekly_schedule,
          preferred_windows: m.preferred_windows
        }
      ],
      offIds,
      clock
    );
    if (available.length === 0) return null;
    return { name: m.name ?? "", phone: m.phone_e164.trim() };
  } catch (e) {
    console.error("contactOwnerAgent", e);
    return null;
  }
}

/**
 * Claim-driven ownership: the teammate who claimed this lead becomes the
 * contact's owner — but ONLY when the contact is currently unowned (ownership
 * is never stolen by a later claim). Best-effort: a failure logs and moves on;
 * the claim itself already succeeded.
 */
async function assignContactOwnerOnClaim(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  claimedByPhone: string
): Promise<void> {
  const leadPhone = leadContactPhone(scope);
  if (!leadPhone || !claimedByPhone) return;
  try {
    const { data: member } = await supabase
      .from("ai_flow_team_members")
      .select("id")
      .eq("business_id", run.business_id)
      .eq("phone_e164", claimedByPhone)
      .maybeSingle();
    const memberId = (member as { id?: string } | null)?.id;
    if (!memberId) return;
    const { data: updated, error } = await supabase
      .from("contacts")
      .update({ owner_employee_id: memberId, updated_at: new Date().toISOString() })
      .eq("business_id", run.business_id)
      .or(`customer_e164.eq.${leadPhone},alias_e164s.cs.{${leadPhone}}`)
      .is("owner_employee_id", null)
      .select("id");
    if (error) {
      console.error("assignContactOwnerOnClaim", error);
      return;
    }
    if ((updated ?? []).length > 0) {
      await telemetryRecord(supabase, "ai_flow_contact_owner_assigned", {
        run_id: run.id,
        business_id: run.business_id,
        member_id: memberId
      });
      // owner_assigned triggers: the claim just gave this lead an owner —
      // that may start other flows (e.g. an intro text from the new owner).
      // Loop-guarded against the claiming flow; idempotent per run.
      const claimedName =
        typeof (scope.vars.claimed_agent as unknown) === "string" &&
        scope.vars.claimed_agent !== "none"
          ? String(scope.vars.claimed_agent)
          : "";
      await enqueueContactEventRuns(supabase, run.business_id, {
        kind: "owner_assigned",
        contact: { e164: leadPhone },
        ...(claimedName ? { ownerName: claimedName } : {}),
        sourceFlowId: run.flow_id,
        dedupeKey: `ce:owner:${run.id}`
      });
    }
  } catch (e) {
    console.error("assignContactOwnerOnClaim", e);
  }
}

/**
 * Pick the next team member to offer the lead to, excluding `tried`.
 *
 * Selection is deterministic when the business has an `ai_flow_team_members`
 * roster: active members in `last_offered_at` order (nulls first), and the
 * picked row's cursor is stamped so rotation stays fair ACROSS runs — the
 * "least recently received a lead" rule computed instead of remembered.
 *
 * Only when no roster rows exist does the legacy path ask the tenant's
 * Rowboat agent (memory-grounded LLM pick). Returns null when the roster is
 * exhausted, the reply is unparseable, or Rowboat isn't configured (→ owner
 * fallback). THROWS on a roster query / Rowboat transport error so the run
 * retries rather than prematurely escalating.
 */
async function pickNextAgent(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  tried: string[],
  pinnedAgentName?: string
): Promise<RoutedAgent | null> {
  // --- Deterministic roster path -------------------------------------------
  const { data: rosterRows, error: rosterErr } = await supabase
    .from("ai_flow_team_members")
    .select("id, name, phone_e164, weekly_schedule, preferred_windows")
    .eq("business_id", run.business_id)
    .eq("active", true)
    .order("last_offered_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true });
  if (rosterErr) {
    throw new Error(`route_to_team: roster query failed: ${rosterErr.message}`);
  }
  let roster = (rosterRows ?? []) as {
    id: string;
    name: string;
    phone_e164: string;
    weekly_schedule?: unknown;
    preferred_windows?: unknown;
  }[];
  // Pinned routing (step.agentName): this lead type goes to ONE named member
  // (e.g. every seller lead straight to the broker). Restrict the roster to
  // that member; if they're missing/renamed — or there is no roster at all —
  // the offer falls through to the owner fallback, never to the legacy
  // Rowboat picker, which could offer the lead to a different teammate.
  if (pinnedAgentName) {
    const want = pinnedAgentName.trim().toLowerCase();
    roster = roster.filter((r) => r.name.trim().toLowerCase() === want);
    if (roster.length === 0) {
      console.error(`route_to_team: pinned agent "${pinnedAgentName}" not on the active roster`);
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_pinned_agent_missing",
        message: `route_to_team: pinned agent "${pinnedAgentName}" is not on the active roster; falling back to the owner`,
        payload: { run_id: run.id, flow_id: run.flow_id, agent_name: pinnedAgentName }
      });
      return null;
    }
  }
  if (roster.length > 0) {
    // Working-info rules (evaluated business-local): time off covering today
    // and out-of-schedule members are hard skips — applied AFTER the pin
    // filter so time off supersedes pinned routing too. Preferred windows
    // only reorder. When every roster member is unavailable the offer falls
    // through to the owner fallback (null), never to the legacy Rowboat
    // picker — the owner curated this roster; don't let the model improvise.
    const [tzRes, offRes] = await Promise.all([
      supabase.from("businesses").select("timezone").eq("id", run.business_id).maybeSingle(),
      supabase
        .from("employee_time_off")
        .select("member_id, starts_on, ends_on")
        .eq("business_id", run.business_id)
    ]);
    if (offRes.error) {
      throw new Error(`route_to_team: time-off query failed: ${offRes.error.message}`);
    }
    const tz = (tzRes.data as { timezone?: string | null } | null)?.timezone ?? null;
    const clock = localClock(new Date(), tz);
    const offIds = new Set(
      ((offRes.data ?? []) as { member_id: string; starts_on: string; ends_on: string }[])
        .filter((t) => t.starts_on <= clock.isoDate && t.ends_on >= clock.isoDate)
        .map((t) => t.member_id)
    );
    const availableRoster = filterRosterByAvailability(roster, offIds, clock);
    if (availableRoster.length === 0) {
      await systemLog(supabase, {
        businessId: run.business_id,
        source: "aiflow",
        level: "warn",
        event: "ai_flow_no_agent_available",
        message:
          "route_to_team: every roster member is on time off or outside their schedule; falling back to the owner",
        payload: { run_id: run.id, flow_id: run.flow_id, roster_size: roster.length }
      });
      return null;
    }
    const pick = pickRosterAgent(
      availableRoster.map((r) => ({ name: r.name, phone: r.phone_e164 })),
      tried,
      leadPhoneE164(scope)
    );
    if (!pick) return null;
    // Stamp the rotation cursor at pick time (not claim time) so concurrent
    // runs don't all offer to the same member. A failed offer simply rotates
    // that member to the back, which is acceptable.
    const { error: stampErr } = await supabase
      .from("ai_flow_team_members")
      .update({ last_offered_at: new Date().toISOString() })
      .eq("id", availableRoster[pick.index].id);
    if (stampErr) {
      console.error(`route_to_team: rotation stamp failed: ${stampErr.message}`);
    }
    return pick.agent;
  }

  // --- Legacy Rowboat memory path ------------------------------------------
  const template =
    Deno.env.get("ROWBOAT_CHAT_URL_TEMPLATE") ??
    "https://{businessId}.newcoworker.com/api/v1/{projectId}/chat";
  // Rowboat-facing bearer: a re-keyed VPS rejects the shared env token, so
  // resolve the tenant's confirmed per-tenant token (env fallback inside).
  const bearer = await resolveRowboatBearerForBusiness(supabase, run.business_id);
  const defaultProjectId = Deno.env.get("ROWBOAT_DEFAULT_PROJECT_ID") ?? "";
  const { data: cfgRow } = await supabase
    .from("business_configs")
    .select("rowboat_project_id")
    .eq("business_id", run.business_id)
    .maybeSingle();
  const cfg = cfgRow as { rowboat_project_id?: string | null } | null;
  const projectId =
    cfg?.rowboat_project_id && String(cfg.rowboat_project_id).length > 0
      ? String(cfg.rowboat_project_id)
      : defaultProjectId;
  if (!projectId || !bearer) {
    console.error("route_to_team: Rowboat not configured; falling back to owner");
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "warn",
      event: "ai_flow_rowboat_not_configured",
      message: "route_to_team: Rowboat not configured; falling back to owner",
      payload: { run_id: run.id, flow_id: run.flow_id }
    });
    return null;
  }
  const chatUrl = template
    .replace(/\{businessId\}/g, run.business_id)
    .replace(/\{projectId\}/g, projectId);

  const lead = {
    name: typeof scope.vars.lead_name === "string" ? scope.vars.lead_name : "",
    phone: typeof scope.vars.lead_phone === "string" ? scope.vars.lead_phone : "",
    location: typeof scope.vars.location === "string" ? scope.vars.location : "",
    price: typeof scope.vars.price === "string" ? scope.vars.price : "",
    type: typeof scope.vars.lead_type === "string" ? scope.vars.lead_type : ""
  };
  // NOTE: a pinned step never reaches this legacy path — the pin guard above
  // either restricted the roster or already returned the owner fallback, so
  // the model can never be asked to (mis)pick a pinned lead's agent.
  // Real-estate / mortgage tenants keep the original "real-estate lead" wording
  // (no behavior change for existing prod businesses); every other industry
  // gets the neutral phrasing.
  const { data: bizTypeRow } = await supabase
    .from("businesses")
    .select("business_type")
    .eq("id", run.business_id)
    .maybeSingle();
  const businessType = (bizTypeRow as { business_type?: string | null } | null)?.business_type ?? null;
  const isHousingBusiness =
    businessType === "real_estate" || businessType === "mortgage_brokerage";
  const leadDescriptor = isHousingBusiness ? "new real-estate lead" : "new lead";
  const preamble = [
    `You are routing a ${leadDescriptor} to your team.`,
    "Pick the single NEXT team agent to offer this lead to, using the team",
    "roster and rotation rules in your memory.",
    "Do NOT pick any agent whose phone is in the alreadyTried list.",
    "Reply with ONLY a compact JSON object and nothing else: either",
    '{"name":"<agent name>","phone":"<E.164 phone>"} for the next agent, or',
    '{"none":true} if every eligible agent has already been tried.'
  ].join(" ");
  const userText = JSON.stringify({ lead, alreadyTried: tried });

  try {
    const res = await callRowboatChatOnce({
      chatUrl,
      bearer,
      userText,
      conversationId: null,
      state: null,
      timeoutMs: ROWBOAT_ROUTE_TIMEOUT_MS,
      customerPreamble: preamble
    });
    // The legacy agent-pick is a billed Gemini turn on the tenant's Rowboat —
    // meter it into the shared pool (not gated: routing a live lead must not
    // be blocked by the fuse; it just counts toward it).
    await meterAiFlowSpend(
      supabase,
      run,
      "route_pick",
      preamble.length + userText.length,
      res.reply.length
    );
    return parseRoutedAgent(res.reply);
  } catch (e) {
    throw new Error(
      `route_to_team: Rowboat next-agent call failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}

/**
 * Send an agent-offer SMS. Unlike send_sms this never silently skips: the caller
 * has already screened opt-out, and a quota/Telnyx failure THROWS so the run
 * retries instead of stranding the lead. Reserves a quota slot and releases it
 * on failure.
 */
async function sendOfferSms(
  supabase: Supabase,
  run: RunRow,
  to: string,
  text: string,
  idempotencyKey: string,
  mediaUrls?: string[]
): Promise<void> {
  const cfg = await messagingConfig(supabase, run.business_id);
  if (!cfg) throw new Error("route_to_team: Telnyx messaging is not configured");
  const body = prepareSmsBody(text);
  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "try_reserve_sms_outbound_slot",
    { p_business_id: run.business_id }
  );
  if (reserveErr) throw new Error(`reserve slot: ${reserveErr.message}`);
  const reserve = reserveRaw as { ok?: boolean; reason?: string; source?: string } | null;
  if (!reserve?.ok) {
    if (reserve?.reason === "monthly_sms_limit") {
      await alertSmsCapOnce(supabase, run.business_id, "ai_flow_route_to_team");
    }
    throw new Error(`route_to_team: outbound quota unavailable (${reserve?.reason ?? "quota"})`);
  }
  try {
    const send = await telnyxSendSms({
      apiKey: cfg.apiKey,
      messagingProfileId: cfg.profile,
      fromE164: cfg.from,
      toE164: to,
      text: body,
      mediaUrls,
      idempotencyKey
    });
    if (!send.ok) throw new Error(`telnyx ${send.status}: ${send.body.slice(0, 200)}`);
    await logOutboundSms(supabase, run, {
      to,
      from: cfg.from || null,
      body,
      source: "agent_offer"
    });
  } catch (e) {
    const { error } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: run.business_id,
      p_refund_bonus: reserve.source === "bonus"
    });
    if (error) console.error("release_sms_outbound_slot", error);
    throw e;
  }
}

/** One-shot (per business per month) urgent owner alert when the SMS cap blocks a send. */
async function alertSmsCapOnce(
  supabase: Supabase,
  businessId: string,
  surface: string
): Promise<void> {
  await sendCapAlertOnce(supabase, {
    businessId,
    kind: "sms_monthly",
    periodKey: smsCapPeriodKey(),
    notifyUrl: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/notifications`,
    bearer: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    payload: { surface }
  });
}

/**
 * Send an owner-facing SMS (claim notice / roster-exhausted fallback) to the
 * configured forward number. No-op when the owner has no forward number set —
 * there is nowhere to route, so we log rather than throw and stall the run.
 */
async function sendOwnerSms(
  supabase: Supabase,
  run: RunRow,
  text: string,
  idempotencyKey: string
): Promise<void> {
  const { data: settingsRow } = await supabase
    .from("business_telnyx_settings")
    .select("forward_to_e164")
    .eq("business_id", run.business_id)
    .maybeSingle();
  const forward = (settingsRow as { forward_to_e164?: string | null } | null)?.forward_to_e164 ?? "";
  const cfg = await messagingConfig(supabase, run.business_id);
  if (!forward || !cfg) {
    console.error("route_to_team: owner forward not configured; cannot notify owner");
    await systemLog(supabase, {
      businessId: run.business_id,
      source: "aiflow",
      level: "warn",
      event: "ai_flow_owner_forward_missing",
      message: "Owner SMS skipped: no forward number / Telnyx messaging configured",
      payload: { run_id: run.id, flow_id: run.flow_id }
    });
    return;
  }
  const body = prepareSmsBody(`[AiFlow] ${text}`);
  // Metered (never refused) owner traffic — Jul 14 2026 policy.
  const send = await sendOperationalSms(supabase, run.business_id, {
    apiKey: cfg.apiKey,
    messagingProfileId: cfg.profile,
    fromE164: cfg.from,
    toE164: forward,
    text: body,
    idempotencyKey
  });
  if (!send.ok) throw new Error(`route_to_team owner sms telnyx ${send.status}`);
  await logOutboundSms(supabase, run, {
    to: forward,
    from: cfg.from || null,
    body,
    source: "owner_notify"
  });
}

// --- persistence helpers -----------------------------------------------------

async function recordStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  step: FlowStep,
  status: string,
  result?: Record<string, unknown>,
  error?: string
): Promise<void> {
  const { error: upErr } = await supabase.from("ai_flow_run_steps").upsert(
    {
      run_id: run.id,
      business_id: run.business_id,
      step_index: index,
      step_type: step.type,
      status,
      result: result ?? null,
      error: error ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "run_id,step_index" }
  );
  if (upErr) console.error("ai_flow_run_steps upsert", upErr);
  // Every step transition lands in system_logs so the admin view can replay a
  // run without joining tables: failed steps are errors, parked steps info,
  // everything else debug-level trace. If the durable ai_flow_run_steps upsert
  // failed, escalate to error and carry the upsert failure in the payload so
  // the trace can't silently diverge from what the run table actually shows.
  await systemLog(supabase, {
    businessId: run.business_id,
    source: "aiflow",
    level: upErr
      ? "error"
      : status === "failed"
        ? "error"
        : status === "pending"
          ? "info"
          : "debug",
    event: `ai_flow_step_${status}`,
    message: error ?? `${step.type} step ${status}`,
    payload: {
      run_id: run.id,
      flow_id: run.flow_id,
      step_index: index,
      step_type: step.type,
      attempt: run.attempt_count,
      ...(result ? { result } : {}),
      ...(upErr ? { step_row_persist_error: upErr.message } : {})
    }
  });
}

/**
 * Persist a run-state patch. THROWS on failure so the caller (executeRun) does
 * not march on assuming a current_step/context/status write landed — a swallowed
 * error here desyncs the run from its real progress and fights stale-run reclaim.
 * A thrown error propagates to handleRunThrow, which re-queues for retry. The
 * terminal/recovery callers (failRun, handleRunThrow) wrap this best-effort so a
 * persistence failure there can never crash the worker loop.
 */
async function updateRun(
  supabase: Supabase,
  id: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  // `.neq(status, canceled)`: an owner "Stop this run" is terminal the moment
  // it lands. A worker mid-execution (or a late park/retry/terminal persist)
  // must never resurrect or overwrite a canceled run. Returns whether a row
  // actually matched — FALSE means the run was canceled underneath us, and a
  // caller about to perform post-persist side effects (the approval-prompt /
  // agent-offer sends) must bail instead of messaging on a stopped run.
  const { data, error } = await supabase
    .from("ai_flow_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "canceled")
    .select("id");
  if (error) throw new Error(`ai_flow_runs update: ${error.message}`);
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

async function failRun(
  supabase: Supabase,
  run: RunRow,
  error: string,
  scope?: Scope,
  approval?: Record<string, unknown>,
  routing?: Record<string, unknown>
): Promise<void> {
  // Best-effort terminal write; if it fails, stale-run reclaim recovers the run.
  try {
    await updateRun(supabase, run.id, {
      status: "failed",
      last_error: error.slice(0, 2000),
      claimed_at: null,
      ...(scope && approval ? { context: buildContext(scope, approval, routing) } : {})
    });
  } catch (e) {
    console.error("failRun updateRun", e);
  }
  await telemetryRecord(supabase, "ai_flow_run_failed", {
    run_id: run.id,
    business_id: run.business_id,
    error: error.slice(0, 300)
  });
  await systemLog(supabase, {
    businessId: run.business_id,
    source: "aiflow",
    level: "error",
    event: "ai_flow_run_failed",
    message: error,
    payload: {
      run_id: run.id,
      flow_id: run.flow_id,
      step_index: run.current_step,
      attempt: run.attempt_count
    }
  });
  // Opt-in owner alert (aiflow_failure_alerts, default OFF): a dead-lettered
  // lead-intake run is a lead that arrived and got silence — tell the owner
  // when they've asked to hear about it. Best-effort; scope (when the caller
  // had one) carries fresher vars than the persisted context.
  const ctx = run.context ?? {};
  await sendAiflowFailureAlert(supabase, {
    businessId: run.business_id,
    runId: run.id,
    flowId: run.flow_id,
    trigger: (scope?.trigger ?? (ctx as { trigger?: Record<string, unknown> }).trigger) ?? null,
    vars: (scope?.vars ?? (ctx as { vars?: Record<string, unknown> }).vars) ?? null,
    error,
    notifyUrl: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/notifications`,
    bearer: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  });
}

/**
 * Transient throw → re-queue until the ERROR retry budget is exhausted, then
 * dead-letter. Keyed off error_retry_count, NOT attempt_count: attempt_count
 * is bumped on every claim, including benign re-claims (route_to_team offer
 * escalations, approval resumes, quiet-hour deferrals), so using it here let a
 * healthy multi-agent routing run eat the whole retry budget without a single
 * error.
 */
async function handleRunThrow(supabase: Supabase, run: RunRow, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  const retries = run.error_retry_count ?? 0;
  if (retries >= MAX_ATTEMPTS) {
    await failRun(supabase, run, `max retries: ${message}`);
    return;
  }
  // Best-effort re-queue; if it fails, stale-run reclaim recovers the run.
  try {
    await updateRun(supabase, run.id, {
      status: "queued",
      last_error: message.slice(0, 2000),
      error_retry_count: retries + 1,
      claimed_at: null
    });
  } catch (e) {
    console.error("handleRunThrow updateRun", e);
  }
  await telemetryRecord(supabase, "ai_flow_run_retry", {
    run_id: run.id,
    business_id: run.business_id,
    retry: retries + 1,
    error: message.slice(0, 300)
  });
  await systemLog(supabase, {
    businessId: run.business_id,
    source: "aiflow",
    level: "warn",
    event: "ai_flow_run_retry",
    message,
    payload: {
      run_id: run.id,
      flow_id: run.flow_id,
      step_index: run.current_step,
      retry: retries + 1,
      max_retries: MAX_ATTEMPTS
    }
  });
}

// --- non-SMS trigger sources ---------------------------------------------------

/**
 * Schedule sweep: enqueue a run for every enabled schedule-triggered flow that
 * is due this tick. Exactly-once per occurrence via dedupe_key (the unique
 * (flow_id, dedupe_key) index turns repeat ticks inside the due window into
 * benign 23505s). Never throws — a bad flow just logs and is skipped.
 */
async function enqueueDueScheduledRuns(supabase: Supabase): Promise<void> {
  try {
    // Paged listing so a fleet with many scheduled flows never silently
    // skips the ones past an arbitrary limit.
    const PAGE = 200;
    const rows: { id: string; business_id: string; definition: unknown }[] = [];
    for (let offset = 0; ; offset += PAGE) {
      // Primary schedule trigger OR any flow carrying an additional-triggers
      // array (rare; the code below picks out its schedule members).
      const { data, error } = await supabase
        .from("ai_flows")
        .select("id, business_id, definition")
        .eq("enabled", true)
        .or("definition->trigger->>channel.eq.schedule,definition->triggers.not.is.null")
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error("schedule sweep list", error);
        // A later page failing must not discard the flows already listed —
        // sweep those now; the next tick retries the full listing (dedupe
        // keys make any overlap benign).
        if (rows.length === 0) return;
        break;
      }
      const batch = (data ?? []) as typeof rows;
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    const nowMs = Date.now();
    for (const row of rows) {
      if (!isExecutableDefinition(row.definition)) continue;
      const triggers = flowTriggers(row.definition);
      for (let ti = 0; ti < triggers.length; ti++) {
        const trig = triggers[ti];
        if (trig.channel !== "schedule") continue;
        const due = scheduleDue(nowMs, trig);
        if (!due) continue;
        // Extra triggers suffix their index into the dedupe key so two
        // schedules in one flow due the same minute both enqueue; the primary
        // keeps the legacy key so pre-multi-trigger occurrences stay deduped.
        const dedupeKey = ti === 0 ? `sched:${due.key}` : `sched:${due.key}:t${ti}`;
        const { error: insErr } = await supabase.from("ai_flow_runs").insert({
          flow_id: row.id,
          business_id: row.business_id,
          status: "queued",
          context: {
            trigger: {
              channel: "schedule",
              scheduled_for: due.scheduledForIso,
              url: null,
              windowText: "",
              from: ""
            }
          },
          current_step: 0,
          dedupe_key: dedupeKey
        });
        // 23505 = this occurrence is already enqueued (earlier tick) — expected.
        if (insErr && (insErr as { code?: string }).code !== "23505") {
          console.error("schedule enqueue", insErr);
          continue;
        }
        if (!insErr) {
          await telemetryRecord(supabase, "ai_flow_run_enqueued_schedule", {
            business_id: row.business_id,
            flow_id: row.id,
            scheduled_for: due.scheduledForIso
          });
          await systemLog(supabase, {
            businessId: row.business_id,
            source: "aiflow",
            level: "info",
            event: "ai_flow_run_enqueued_schedule",
            message: `Scheduled run enqueued (${due.scheduledForIso})`,
            payload: { flow_id: row.id, dedupe_key: dedupeKey }
          });
        }
      }
    }
  } catch (e) {
    console.error("enqueueDueScheduledRuns", e);
  }
}

/**
 * Birthday-trigger sweep: for every enabled flow with a `birthday` trigger,
 * fire once per contact per year when the local date (trigger timezone,
 * default business timezone) matches the contact's stored birthday and the
 * local time has reached the trigger's send time. Exactly-once via the
 * `bday:<contactId>:<year>` dedupe key. Failure-isolated like the schedule
 * sweep — never throws.
 */
async function enqueueDueBirthdayRuns(supabase: Supabase): Promise<void> {
  try {
    const PAGE = 200;
    const rows: Array<{ id: string; business_id: string; definition: unknown }> = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("ai_flows")
        .select("id, business_id, definition")
        .eq("enabled", true)
        .or("definition->trigger->>channel.eq.birthday,definition->triggers.not.is.null")
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error("birthday sweep flow listing", error);
        if (rows.length === 0) return;
        break;
      }
      const batch = (data ?? []) as typeof rows;
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    type BirthdayFlow = {
      id: string;
      business_id: string;
      ti: number;
      time?: string;
      timezone?: string;
      conditions: import("../_shared/ai_flows/types.ts").TriggerCondition[];
      /** definition.drip stagger, when configured. */
      dripIntervalMinutes?: number;
    };
    const flows: BirthdayFlow[] = [];
    for (const row of rows) {
      if (!isExecutableDefinition(row.definition)) continue;
      const triggers = flowTriggers(row.definition);
      for (let ti = 0; ti < triggers.length; ti++) {
        const trig = triggers[ti];
        if (trig.channel !== "birthday") continue;
        flows.push({
          id: row.id,
          business_id: row.business_id,
          ti,
          time: trig.time,
          timezone: trig.timezone,
          conditions: Array.isArray(trig.conditions) ? trig.conditions : [],
          ...(typeof row.definition.drip?.intervalMinutes === "number" &&
          row.definition.drip.intervalMinutes >= 1
            ? { dripIntervalMinutes: row.definition.drip.intervalMinutes }
            : {})
        });
      }
    }
    if (flows.length === 0) return;

    const byBusiness = new Map<string, BirthdayFlow[]>();
    for (const f of flows) {
      byBusiness.set(f.business_id, [...(byBusiness.get(f.business_id) ?? []), f]);
    }
    const nowMs = Date.now();
    for (const [businessId, group] of byBusiness) {
      try {
        const { data: bizRow } = await supabase
          .from("businesses")
          .select("timezone")
          .eq("id", businessId)
          .maybeSingle();
        const businessTz =
          (bizRow as { timezone?: string | null } | null)?.timezone || "UTC";
        // Paged so a directory with many birthdays never silently stops at
        // one page; a later page failing keeps the contacts already listed.
        type BirthdayContact = {
          id: string;
          customer_e164: string;
          display_name: string | null;
          email: string | null;
          tags: string[] | null;
          birthday: string | null;
        };
        const CONTACT_PAGE = 500;
        const contacts: BirthdayContact[] = [];
        let contactListingFailed = false;
        for (let offset = 0; ; offset += CONTACT_PAGE) {
          const { data: contactData, error: contactErr } = await supabase
            .from("contacts")
            .select("id, customer_e164, display_name, email, tags, birthday")
            .eq("business_id", businessId)
            .not("birthday", "is", null)
            .order("id", { ascending: true })
            .range(offset, offset + CONTACT_PAGE - 1);
          if (contactErr) {
            console.error("birthday sweep contacts", contactErr);
            contactListingFailed = contacts.length === 0;
            break;
          }
          const batch = (contactData ?? []) as BirthdayContact[];
          contacts.push(...batch);
          if (batch.length < CONTACT_PAGE) break;
        }
        if (contactListingFailed || contacts.length === 0) continue;

        for (const flow of group) {
          const tz = flow.timezone || businessTz;
          // from_matches saved-person refs resolve ONCE per flow (not per
          // contact) to live identity values; a resolution failure fails
          // CLOSED for this flow only — mirrors the calendar poller.
          let refValues: ReadonlyMap<string, string[]> | undefined;
          if (flow.conditions.some((c) => c.type === "from_matches" && c.ref)) {
            try {
              refValues = await resolveFromMatchesRefValues(
                supabase,
                businessId,
                flow.conditions
              );
            } catch (e) {
              console.error("birthday sweep ref resolution", e);
              continue;
            }
          }
          // Drip pacing (definition.drip): read the flow's latest scheduled
          // slot ONCE, then step forward locally for each contact enqueued
          // this pass — many contacts sharing a birthday is exactly the
          // burst drip exists for. Best-effort: a read failure paces from
          // now.
          let nextDripMs: number | null = null;
          if (flow.dripIntervalMinutes !== undefined) {
            nextDripMs = nowMs;
            try {
              const { data: lastRow } = await supabase
                .from("ai_flow_runs")
                .select("earliest_claim_at")
                .eq("flow_id", flow.id)
                .eq("status", "queued")
                .not("earliest_claim_at", "is", null)
                .order("earliest_claim_at", { ascending: false })
                .limit(1)
                .maybeSingle();
              const lastIso = (lastRow as { earliest_claim_at?: string | null } | null)
                ?.earliest_claim_at;
              const lastMs = lastIso ? Date.parse(lastIso) : NaN;
              if (Number.isFinite(lastMs)) {
                nextDripMs = Math.max(nowMs, lastMs + flow.dripIntervalMinutes * 60_000);
              }
            } catch (e) {
              console.error("birthday sweep drip", e);
            }
          }
          for (const contact of contacts) {
            if (!birthdayDue(contact.birthday, nowMs, tz, flow.time)) continue;
            const localYear = localYearIn(nowMs, tz);
            const age = contactAge(contact.birthday, localYear);
            const dedupeKey =
              flow.ti === 0
                ? birthdayDedupeKey(contact.id, localYear)
                : `${birthdayDedupeKey(contact.id, localYear)}:t${flow.ti}`;
            const windowText = [
              `event: birthday`,
              contact.display_name ? `name: ${contact.display_name}` : "",
              `phone: ${contact.customer_e164}`,
              contact.email ? `email: ${contact.email}` : "",
              (contact.tags ?? []).length > 0 ? `tags: ${(contact.tags ?? []).join(", ")}` : "",
              age !== null ? `age: ${age}` : ""
            ]
              .filter((l) => l.length > 0)
              .join("\n");
            // Trigger conditions run over the contact text (from = the
            // contact's phone); an empty list matches every birthday.
            if (flow.conditions.length > 0) {
              const res = evaluateSmsTrigger(
                { channel: "sms", conditions: flow.conditions },
                { messages: [{ text: windowText, from: contact.customer_e164, atMs: nowMs }] },
                refValues
              );
              if (!res.matched) continue;
            }
            const { error: insErr } = await supabase.from("ai_flow_runs").insert({
              flow_id: flow.id,
              business_id: businessId,
              status: "queued",
              context: {
                trigger: {
                  channel: "birthday",
                  windowText,
                  url: null,
                  from: contact.customer_e164,
                  contact_name: contact.display_name ?? "",
                  ...(age !== null ? { age: String(age) } : {})
                }
              },
              current_step: 0,
              dedupe_key: dedupeKey,
              ...(nextDripMs !== null
                ? { earliest_claim_at: new Date(nextDripMs).toISOString() }
                : {})
            });
            // 23505 = this year's firing already enqueued — expected.
            if (insErr && (insErr as { code?: string }).code !== "23505") {
              console.error("birthday enqueue", insErr);
              continue;
            }
            if (!insErr) {
              if (nextDripMs !== null && flow.dripIntervalMinutes !== undefined) {
                nextDripMs += flow.dripIntervalMinutes * 60_000;
              }
              await systemLog(supabase, {
                businessId,
                source: "aiflow",
                level: "info",
                event: "ai_flow_run_enqueued_birthday",
                message: `Birthday run enqueued for ${contact.display_name || contact.customer_e164}`,
                payload: { flow_id: flow.id, contact_id: contact.id, dedupe_key: dedupeKey }
              });
            }
          }
        }
      } catch (e) {
        console.error("birthday sweep business", e);
      }
    }
  } catch (e) {
    console.error("enqueueDueBirthdayRuns", e);
  }
}

/**
 * Place one outbound call via the telnyx-voice-originate Edge fn (same metering
 * as the manual "Place call"). Returns a normalized result. Never throws.
 * `blocked` distinguishes a budget refusal (200 { ok:false, error:"budget" })
 * from a hard failure so the ledger can record the right status.
 */
async function placeOutboundCall(
  supabaseUrl: string,
  bearer: string,
  body: {
    businessId: string;
    flowId: string;
    /** place_ai_call: fully-resolved per-call payload (see parsePlaceCallPayload). */
    call?: {
      toE164: string;
      persona?: string;
      contextNote?: string;
      captureFields?: string[];
      notifyE164: string;
      transfer?: { toE164: string; preSmsBody?: string; agentName?: string };
      flowRun?: { runId: string; saveAs: string; marker: string; stepIndex: number };
    };
  }
): Promise<{
  ok: boolean;
  callControlId?: string;
  reason?: string;
  // Whether this occurrence is safe to dial again. True ONLY when originate
  // explicitly reports it never rang the callee (`dialed === false`: any
  // auth/validation/config refusal, the pre-dial budget block, or Telnyx
  // rejecting POST /v2/calls so no leg was created). Anything that already rang
  // the callee (post-dial budget refusal, session_persist_failed, lost call id)
  // or a no-response timeout is NOT retryable, or the same occurrence would
  // dial the callee again.
  retryable: boolean;
  /** originate's machine error code (e.g. "budget"), for caller branching. */
  errorCode?: string;
}> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OUTBOUND_ORIGINATE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/functions/v1/telnyx-voice-originate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal
      }
    );
    const out = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; reason?: string; callControlId?: string; dialed?: boolean }
      | null;
    if (res.ok && out?.ok) return { ok: true, callControlId: out.callControlId, retryable: false };
    // Retry ONLY when originate explicitly reports it never dialed the callee.
    return {
      ok: false,
      reason: out?.reason ?? out?.error ?? `http_${res.status}`,
      errorCode: out?.error,
      retryable: out?.dialed === false
    };
  } catch (e) {
    // No response: a dial MAY have gone through — never retry (could double-dial).
    console.error("placeOutboundCall", e);
    return { ok: false, reason: "originate_unreachable", errorCode: "originate_unreachable", retryable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Outbound-voice schedule sweep: place a call for every enabled OUTBOUND voice
 * flow whose trigger carries a schedule and is due this tick. Outbound voice
 * flows never enqueue an ai_flow_run (the batch engine has no outbound_call
 * processor), so exactly-once is enforced by the voice_outbound_dial_log ledger
 * (unique flow_id, dedupe_key): insert the occurrence row FIRST (a 23505 means
 * "already dialed this occurrence" → skip), then call telnyx-voice-originate,
 * which runs the same pre-dial probe + post-dial reserve metering as the manual
 * "Place call". Never throws — a bad flow logs and is skipped.
 */
async function enqueueDueOutboundCalls(
  supabase: Supabase,
  supabaseUrl: string,
  bearer: string
): Promise<void> {
  try {
    const PAGE = 200;
    const rows: { id: string; business_id: string; definition: unknown }[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("ai_flows")
        .select("id, business_id, definition")
        .eq("enabled", true)
        .eq("definition->trigger->>channel", "voice")
        .eq("definition->trigger->>direction", "outbound")
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error("outbound sweep list", error);
        if (rows.length === 0) return;
        break;
      }
      const batch = (data ?? []) as typeof rows;
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    const nowMs = Date.now();
    for (const row of rows) {
      const def = row.definition as { trigger?: Record<string, unknown> } | null;
      const trig = def?.trigger;
      if (!trig || trig.channel !== "voice" || trig.direction !== "outbound") continue;
      // Only SCHEDULED outbound flows participate; manual-only flows carry no
      // schedule fields and are placed via the "Place call" button.
      const hasSchedule =
        typeof trig.everyMinutes === "number" ||
        (typeof trig.time === "string" && typeof trig.timezone === "string");
      if (!hasSchedule) continue;
      const due = scheduleDue(nowMs, trig as ScheduleConfig);
      if (!due) continue;

      const dedupeKey = `osched:${due.key}`;
      const { error: insErr } = await supabase.from("voice_outbound_dial_log").insert({
        flow_id: row.id,
        business_id: row.business_id,
        dedupe_key: dedupeKey,
        status: "placed"
      });
      if (insErr) {
        // 23505 = this occurrence was already dialed on an earlier tick — expected.
        if ((insErr as { code?: string }).code !== "23505") {
          console.error("outbound sweep ledger insert", insErr);
        }
        continue;
      }

      const result = await placeOutboundCall(supabaseUrl, bearer, {
        businessId: row.business_id,
        flowId: row.id
      });

      // The pre-inserted row is a dedupe LOCK that prevents overlapping ticks
      // from double-dialing. Resolve it by outcome:
      //   - placed (ok): keep the row terminal (at-most-once for a real call).
      //   - failed AFTER a dial / ambiguous no-response: keep it terminal — the
      //     callee was (or may have been) rung, so retrying would dial again.
      //   - failed BEFORE any dial (originate reports dialed:false — a config/
      //     validation refusal, the pre-dial budget block, or Telnyx rejecting
      //     the dial so no leg exists): RELEASE the lock (delete the row) so a
      //     later tick retries this occurrence within its window. Budget blocks
      //     re-probe cheaply (the pre-dial check refuses without dialing), so
      //     this never rings the callee until budget frees; post-dial failures
      //     keep the lock and are not retried.
      const retryable = !result.ok && result.retryable;
      if (retryable) {
        const { error: delErr } = await supabase
          .from("voice_outbound_dial_log")
          .delete()
          .eq("flow_id", row.id)
          .eq("dedupe_key", dedupeKey);
        if (delErr) console.error("outbound sweep ledger release", delErr);
      } else {
        const finalStatus = result.ok ? "placed" : "failed";
        const { error: updErr } = await supabase
          .from("voice_outbound_dial_log")
          .update({
            status: finalStatus,
            call_control_id: result.callControlId ?? null,
            reason: result.ok ? null : result.reason ?? null
          })
          .eq("flow_id", row.id)
          .eq("dedupe_key", dedupeKey);
        if (updErr) console.error("outbound sweep ledger update", updErr);
      }

      await telemetryRecord(supabase, "ai_flow_outbound_call_swept", {
        business_id: row.business_id,
        flow_id: row.id,
        scheduled_for: due.scheduledForIso,
        status: result.ok ? "placed" : retryable ? "retryable" : "failed",
        reason: result.ok ? null : result.reason ?? null
      });
      await systemLog(supabase, {
        businessId: row.business_id,
        source: "voice",
        level: result.ok ? "info" : "warn",
        event: "ai_flow_outbound_call_swept",
        message: result.ok
          ? `Scheduled outbound call placed (${due.scheduledForIso})`
          : retryable
            ? `Scheduled outbound call not placed (will retry): ${result.reason ?? "error"}`
            : `Scheduled outbound call not placed: ${result.reason ?? "error"}`,
        payload: { flow_id: row.id, dedupe_key: dedupeKey }
      });
    }
  } catch (e) {
    console.error("enqueueDueOutboundCalls", e);
  }
}

/**
 * Email + calendar triggers: the mailbox/calendar polling needs the app's
 * Nango credentials, so the actual work lives in the Next.js
 * /api/internal/aiflow-email-poll and /api/internal/aiflow-calendar-poll
 * routes (cron-secret authed, same contract as this worker's own auth); this
 * just kicks one of them once per tick. The routes are cheap no-ops when no
 * enabled flow uses their channel. Failures only log — mailbox/calendar
 * trouble must never stall SMS or scheduled runs.
 */
async function kickTriggerPoll(routePath: string): Promise<void> {
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  if (!base || !secret) return;
  const ctl = new AbortController();
  // The poll routes legitimately run up to their 60s maxDuration on a busy
  // mailbox/calendar; aborting sooner can cut the work short on some hosts
  // and logs spurious failures, so wait past that ceiling (the caller
  // overlaps this wait with run processing rather than blocking on it).
  const timer = setTimeout(() => ctl.abort(), EMAIL_POLL_KICK_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${routePath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: "{}",
      signal: ctl.signal
    });
    if (!res.ok) {
      console.error(routePath, res.status, (await res.text()).slice(0, 200));
    } else {
      await res.body?.cancel();
    }
  } catch (e) {
    console.error(`kickTriggerPoll ${routePath}`, e);
  } finally {
    clearTimeout(timer);
  }
}

// --- misc helpers ------------------------------------------------------------

type Messaging = { apiKey: string; profile: string; from?: string };

async function messagingConfig(supabase: Supabase, businessId: string): Promise<Messaging | null> {
  const apiKey = Deno.env.get("TELNYX_API_KEY") ?? "";
  let profile = Deno.env.get("TELNYX_MESSAGING_PROFILE_ID") ?? "";
  let from = Deno.env.get("TELNYX_SMS_FROM_E164") ?? "";
  const { data } = await supabase
    .from("business_telnyx_settings")
    .select("telnyx_messaging_profile_id, telnyx_sms_from_e164")
    .eq("business_id", businessId)
    .maybeSingle();
  const row = data as
    | { telnyx_messaging_profile_id?: string | null; telnyx_sms_from_e164?: string | null }
    | null;
  if (row?.telnyx_messaging_profile_id) profile = row.telnyx_messaging_profile_id;
  if (row?.telnyx_sms_from_e164) from = row.telnyx_sms_from_e164;
  if (!apiKey || !profile) return null;
  return { apiKey, profile, from };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : {};
}

function buildContext(
  scope: Scope,
  approval: Record<string, unknown>,
  routing?: Record<string, unknown>
): Record<string, unknown> {
  const ctx: Record<string, unknown> = { vars: scope.vars, trigger: scope.trigger };
  if (Object.keys(approval).length > 0) ctx.approval = approval;
  if (routing && Object.keys(routing).length > 0) ctx.routing = routing;
  return ctx;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
