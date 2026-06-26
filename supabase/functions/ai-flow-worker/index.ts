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
import { systemLog } from "../_shared/system_log.ts";
import { telnyxSendSms, telnyxSendGroupMms } from "../_shared/telnyx_sms_compliance.ts";
import {
  buildExtractionPrompt,
  buildNowScope,
  evaluateStepCondition,
  extractLeadIdentity,
  extractLinkByText,
  extractPhones,
  filterRosterByAvailability,
  htmlToText,
  isE164,
  isExecutableDefinition,
  localClock,
  normalizeNanpToE164,
  parseExtractionJson,
  parseRoutedAgent,
  pickRosterAgent,
  renderTemplate,
  type NowScope,
  type RoutedAgent
} from "../_shared/ai_flows/engine.ts";
import { callRowboatChatOnce } from "../_shared/sms_rowboat.ts";
import { planStep, type StepAction } from "../_shared/ai_flows/steps.ts";
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
import {
  formatInTimeZone,
  offerRespondByMs,
  smsQuietDecision
} from "../_shared/ai_flows/quiet_hours.ts";
import { scheduleDue } from "../_shared/ai_flows/schedule.ts";
import {
  geminiCostMicrosFromTokens,
  readChatSpendMicros,
  resolveChatPeriodStart,
  type SpendSupabase
} from "../_shared/chat_spend_cap.ts";
import type { AiFlowDefinition, BrowseAuth, ExtractField, FlowStep } from "../_shared/ai_flows/types.ts";

// The actual createClient(url, key) call infers SupabaseClient<any, "public", any>,
// but `ReturnType<typeof createClient>` resolves to <unknown, never, GenericSchema>
// (TS instantiates the generic at its constraints, not its defaults), which is NOT
// assignable. Use a permissive client type so helpers accept the real client.
type Supabase = SupabaseClient<any, any, any>;

const MAX_ATTEMPTS = 4;
const CLAIM_LIMIT = 3;
const FETCH_TIMEOUT_MS = 20_000;
// /api/internal/aiflow-email-poll declares maxDuration = 60; give the kick
// headroom beyond that so the worker never aborts a still-running poll.
const EMAIL_POLL_KICK_TIMEOUT_MS = 75_000;
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

  // Non-SMS trigger sources, both failure-isolated so a bad schedule or a
  // mailbox outage never stalls run processing below. The email poll is
  // started here but awaited after the run loop: a busy mailbox can take the
  // route most of its 60s budget, and overlapping it with run execution keeps
  // the tick from stretching by that long (kickEmailTriggerPoll never throws).
  await enqueueDueScheduledRuns(supabase);
  const emailPoll = kickEmailTriggerPoll();

  const { data: claimed, error: claimErr } = await supabase.rpc("claim_ai_flow_runs", {
    p_limit: CLAIM_LIMIT
  });
  if (claimErr) {
    console.error("claim_ai_flow_runs", claimErr);
    await emailPoll;
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

  await emailPoll;
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
  if (!flow?.enabled) {
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

  const scope: Scope = {
    vars: asRecord(run.context.vars),
    trigger: asRecord(run.context.trigger),
    captureScreenshots: def.options?.captureStepScreenshots === true
  };
  // Default the claim sentinel to "none" so a claim-gated step
  // (when: { var: "claimed_agent", notEquals: "none" }) stays CLOSED until a
  // route_to_team actually records a claim — an absent var would otherwise trim
  // to "" and spuriously satisfy notEquals. Only seed when missing so a resume
  // (route_to_team waits across invocations) never clobbers a real claim that
  // was already persisted into run.context.vars.
  if (scope.vars.claimed_agent === undefined) {
    scope.vars.claimed_agent = "none";
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

  let index = run.current_step;
  while (index < def.steps.length) {
    const step = def.steps[index];
    const outcome = await runStep(supabase, run, step, index, scope, approval, routing);
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
        offerQuietBypass: def.steps
          .slice(index + 1)
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
      await updateRun(supabase, run.id, {
        status: "awaiting_approval",
        current_step: index,
        context: buildContext(scope, approval, routing),
        claimed_at: null
      });
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
      // Stamp which step this offer parked on so a later "86" late-claim can
      // rewind the run precisely to THIS route_to_team step (a flow may have
      // several, only one of which ran). Survives the owner fallback so the
      // run stays late-claimable after it's handed back.
      routing.step_index = index;
      // Persist the parked state BEFORE sending the offer so an inbound 1/2
      // reply can always be matched to this run (state before side effect).
      await updateRun(supabase, run.id, {
        status: "awaiting_agent",
        current_step: index,
        context: buildContext(scope, approval, routing),
        awaiting_agent_e164: outcome.e164,
        respond_by_at: new Date(Date.now() + outcome.respondByMs).toISOString(),
        claimed_at: null
      });
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
      await updateRun(supabase, run.id, {
        status: "queued",
        current_step: index,
        context: buildContext(scope, approval, routing),
        earliest_claim_at: resumeIso,
        claimed_at: null,
        attempt_count: Math.max(0, run.attempt_count - 1)
      });
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
      index = def.steps.length;
    } else if (outcome.skipNextStep && index < def.steps.length) {
      // Approval gate decided "skip": the step the gate guards (the one
      // directly after it) is recorded as skipped without running.
      await recordStep(supabase, run, index, def.steps[index], "skipped", {
        skipped: "approval_skipped"
      });
      index += 1;
    }
    await updateRun(supabase, run.id, {
      current_step: index,
      context: buildContext(scope, approval, routing)
    });
  }

  await updateRun(supabase, run.id, {
    status: "done",
    current_step: index,
    context: buildContext(scope, approval, routing),
    claimed_at: null
  });
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

type StepOutcome =
  // skipNextStep: set by an approval gate decided "skip" — the step directly
  // after the gate (the action it guards) is recorded as skipped and never
  // runs, while the rest of the flow continues.
  // endRun: finalize the run immediately after this step WITHOUT running any
  // remaining steps. Used by a route_to_team LATE claim ("86") so the claim
  // path notifies the owner but later steps (email/browse/notify) don't replay.
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
  | { kind: "defer"; resumeAtMs: number; reason: string };

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
  // as having started.
  if (step.when && !evaluateStepCondition(step.when, scope)) {
    return { kind: "ok", skipped: true, result: { skipped: "when_unmet", when: step.when } };
  }
  await recordStep(supabase, run, index, step, "running");
  const plan = planStep(step, scope);
  if (!plan.ok) return { kind: "fail", error: plan.error };
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
    case "send_sms":
      return sendSmsStep(supabase, run, index, scope, action);
    case "send_email":
      return sendEmailStep(supabase, run, index, scope, action);
    case "notify_owner":
      return notifyOwnerStep(supabase, run, action);
    case "http_call":
      return httpCallStep(run, scope, action);
    case "await_approval":
      return approvalStep(approval, scope, index, action);
    case "route_to_team":
      return routeToTeamStep(supabase, run, scope, action, routing);
    case "browse_action":
      return browseActionStep(supabase, run, index, scope, action);
    case "recall_url":
      return recallUrlStep(supabase, run, scope, action);
    case "upsert_customer":
      return upsertCustomerStep(supabase, run, action);
  }
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
  }
): Promise<void> {
  const { error } = await supabase.from("sms_outbound_log").insert({
    business_id: run.business_id,
    to_e164: args.to,
    from_e164: args.from,
    body: args.body,
    source: args.source,
    run_id: run.id,
    flow_id: run.flow_id,
    telnyx_message_id: args.telnyxMessageId ?? null
  });
  if (error) console.error("sms_outbound_log insert", error);
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
async function upsertCustomerStep(
  supabase: Supabase,
  run: RunRow,
  action: Extract<StepAction, { kind: "upsert_customer" }>
): Promise<StepOutcome> {
  await enrichCustomerProfile(supabase, run.business_id, action.e164, action.name, action.email);
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
 * Append a human description of an outbound contact to the engine-maintained
 * `vars.actions_taken`, so a later step (the ReferralExchange timeline note)
 * can template "what did this flow actually do" via {{vars.actions_taken}}.
 */
function appendActionTaken(scope: Scope, description: string): void {
  const prev = typeof scope.vars.actions_taken === "string" ? scope.vars.actions_taken : "";
  scope.vars.actions_taken = prev ? `${prev}; ${description}` : description;
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
  let extracted: Record<string, string> = {};
  // Only run the (AI-budgeted) field extraction when the step actually asks for
  // fields — a links-only browse_extract skips Gemini entirely.
  if (action.fields && action.fields.length > 0) {
    try {
      extracted = await extractFields(supabase, run, action.fields, pageText);
    } catch (e) {
      // The shared AI budget being exhausted is a permanent, owner-actionable
      // state for this period — fail the run instead of retrying into the cap.
      // Persist the page screenshot (when one was captured) onto the failed step
      // so the investigate view isn't empty for a cap-hit mid-extraction.
      if (e instanceof SpendCapError) {
        const shotPath = await storeScreenshotBestEffort(supabase, run, index, page.screenshotBase64);
        const srcPath = await storeSourceBestEffort(supabase, run, index, page.html);
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
  }

  const out: Record<string, string> = {};
  for (const f of action.fields ?? []) {
    let val = extracted[f.name] ?? "";
    if (!val && /phone|mobile|cell|tel/i.test(f.name)) {
      val = extractPhones(pageText)[0] ?? "";
    }
    out[f.name] = val;
  }
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

  const out: Record<string, string> = {};
  for (const f of action.fields) {
    let val = extracted[f.name] ?? "";
    if (!val && /phone|mobile|cell|tel/i.test(f.name)) {
      val = extractPhones(action.text)[0] ?? "";
    }
    out[f.name] = val;
  }

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

  const out: Record<string, string> = {};
  for (const f of action.fields) {
    // Backfill: keep a meaningful existing value (an earlier browse already
    // filled it); only fall through to the email value when it's empty/"none".
    if (action.fillOnlyEmpty && !isEmptyVarValue(scope.vars[f.name])) {
      out[f.name] = scope.vars[f.name] as string;
      continue;
    }
    let val = extracted[f.name] ?? "";
    if (!val && /phone|mobile|cell|tel/i.test(f.name)) {
      val = extractPhones(data.bodyText)[0] ?? "";
    }
    out[f.name] = val;
  }
  Object.assign(scope.vars, out);
  return { kind: "ok", result: { found: true, vars: out } };
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
    const out: Record<string, string> = {};
    for (const f of action.fields) {
      let val = extracted[f.name] ?? "";
      if (!val && /phone|mobile|cell|tel/i.test(f.name)) {
        val = extractPhones(pageText)[0] ?? "";
      }
      out[f.name] = val;
    }
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
async function screenshotMmsUrl(supabase: Supabase, scope: Scope): Promise<string | null> {
  const path = typeof scope.vars.screenshot_path === "string" ? scope.vars.screenshot_path : "";
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

/** Gemini structured extraction; empty map when no API key (regex fallback covers it). */
async function extractFields(
  supabase: Supabase,
  run: RunRow,
  fields: ExtractField[],
  pageText: string
): Promise<Record<string, string>> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY") ?? "";
  if (!apiKey) return {};
  // Spend gate: AiFlow extraction bills per token into the shared pool, so an
  // exhausted budget blocks the Gemini call (throws SpendCapError → run fails).
  if (await aiFlowSpendOverCap(supabase, run.business_id)) {
    throw new SpendCapError(
      "the shared AI budget for this billing period is used up; extraction is paused until it resets"
    );
  }
  const prompt = buildExtractionPrompt(fields, pageText);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=` +
    encodeURIComponent(apiKey);
  const res = await fetch(url, {
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
  await meterAiFlowSpend(supabase, run, "extract", prompt.length, text.length, exactCostMicros);
  return parseExtractionJson(text, fields);
}

async function sendSmsStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "send_sms" }>
): Promise<StepOutcome> {
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
  }
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
  if (action.quiet && !action.toAgentName && scope.vars[BYPASS_QUIET_HOURS_VAR] !== true) {
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

  // No auto-appended opt-out footer on AiFlow sends. The "Reply STOP to opt out."
  // suffix corrupts control replies (e.g. the literal "Y" a partner system expects)
  // and was never part of these message bodies. We still normalize to GSM-safe text
  // and cap length via prepareSmsBody; STOP/HELP handling lives in the inbound path.
  const text = prepareSmsBody(bodyText);
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

  try {
    const send = await telnyxSendSms({
      apiKey: cfg.apiKey,
      messagingProfileId: cfg.profile,
      fromE164: cfg.from,
      toE164,
      text,
      idempotencyKey: `aiflow:${run.id}:${index}`
    });
    if (!send.ok) {
      await release();
      throw new Error(`telnyx ${send.status}: ${send.body.slice(0, 200)}`);
    }
    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(send.body) as { data?: { id?: string } })?.data?.id ?? null;
    } catch {
      messageId = null;
    }
    appendActionTaken(scope, `texted ${action.toAgentName ?? "the lead"} at ${toE164}`);
    await logOutboundSms(supabase, run, {
      to: toE164,
      from: cfg.from || null,
      body: text,
      source: "ai_flow",
      telnyxMessageId: messageId
    });
    // An agent recipient is a teammate, not a lead — don't file them as a lead
    // customer profile.
    if (!action.toAgentName) {
      await recordLeadCustomerProfile(supabase, run, scope, toE164);
    }
    return { kind: "ok", result: { to: toE164, messageId } };
  } catch (e) {
    await release();
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

  const text = prepareSmsBody(action.body);
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

  try {
    const send = isGroup
      ? await telnyxSendGroupMms({
          apiKey: cfg.apiKey,
          fromE164: own,
          toE164: recipients,
          text,
          idempotencyKey: `aiflow:${run.id}:${index}`
        })
      : await telnyxSendSms({
          apiKey: cfg.apiKey,
          messagingProfileId: cfg.profile,
          fromE164: cfg.from,
          toE164: recipients[0],
          text,
          idempotencyKey: `aiflow:${run.id}:${index}`
        });
    if (!send.ok) {
      await release();
      throw new Error(`telnyx ${send.status}: ${send.body.slice(0, 200)}`);
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
    for (const to of recipients) {
      await logOutboundSms(supabase, run, {
        to,
        from: cfg.from || null,
        body: text,
        source: "ai_flow",
        telnyxMessageId: messageId
      });
      await recordLeadCustomerProfile(supabase, run, scope, to);
    }
    return { kind: "ok", result: { to: recipients, group: true, messageId } };
  } catch (e) {
    await release();
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
    const path = typeof scope.vars.screenshot_path === "string" ? scope.vars.screenshot_path : "";
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
    const send = await telnyxSendSms({
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
async function routeToTeamStep(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  action: Extract<StepAction, { kind: "route_to_team" }>,
  routing: Record<string, unknown>
): Promise<StepOutcome> {
  const tried: string[] = Array.isArray(routing.tried)
    ? (routing.tried as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  routing.tried = tried;

  // An agent claimed (inbound '1', or a late '86'): finalize and optionally
  // tell the owner.
  if (routing.last_event === "claim") {
    // Late claim: the offer had already lapsed (and likely fallen back to the
    // owner) when the agent texted "86". Notify the owner the same way, then
    // finalize WITHOUT replaying the steps after route_to_team.
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
    delete routing.last_event;
    delete routing.reply_from;
    delete routing.offered;
    delete routing.offered_name;
    delete routing.late_claim;
    delete routing.step_index;
    delete routing.claim_timeframe;
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
      `lead ${lateClaim ? "claimed late (86) by" : "claimed by"} ${claimedName || claimedBy}` +
        (claimTimeframe ? ` (ETA: ${claimTimeframe})` : "")
    );
    return {
      kind: "ok",
      result: { routed: lateClaim ? "late_claimed" : "claimed", claimed_by: claimedBy },
      ...(lateClaim ? { endRun: true } : {})
    };
  }

  // First entry, reject ('2'), or timeout: retire the agent we last offered, then
  // ask Rowboat for the next one.
  const prevOffered = typeof routing.offered === "string" ? routing.offered : "";
  if (prevOffered && !tried.includes(prevOffered)) tried.push(prevOffered);
  delete routing.offered;
  delete routing.offered_name;
  delete routing.last_event;
  delete routing.reply_from;

  const leadPhone = leadPhoneE164(scope);
  for (let i = 0; i < ROUTE_MAX_LOOKUPS; i++) {
    const agent = await pickNextAgent(supabase, run, scope, tried, action.agentName);
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
    routing.offered = agent.phone;
    routing.offered_name = agent.name;
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
    const mmsUrl = action.attachScreenshot ? await screenshotMmsUrl(supabase, scope) : null;
    return {
      kind: "pause_agent",
      e164: agent.phone,
      respondByMs: Math.max(60_000, deadlineMs - nowMs),
      offerText: renderTemplate(
        action.offerTemplate,
        agentScope(scope, agent, formatInTimeZone(deadlineMs, action.offerWindow?.timezone ?? "UTC"))
      ),
      idempotencyKey: `aiflow-offer:${run.id}:${tried.length}`,
      ...(mmsUrl ? { mediaUrls: [mmsUrl] } : {})
    };
  }

  // Roster exhausted: hand the lead to the owner so it is never dropped. Mark
  // claimed_agent="none" so claim-gated LATER steps (e.g. the lead marketing
  // text/email) are skipped — only ungated steps like notify_owner still run.
  scope.vars.claimed_agent = "none";
  const body = renderTemplate(action.ownerFallbackTemplate, scope);
  await sendOwnerSms(supabase, run, body, `aiflow-owner-fallback:${run.id}`);
  appendActionTaken(scope, "no agent claimed the lead; handed back to the owner");
  return { kind: "ok", result: { routed: "owner_fallback", tried: tried.length } };
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
  const bearer =
    Deno.env.get("ROWBOAT_VPS_CHAT_BEARER") ?? Deno.env.get("ROWBOAT_GATEWAY_TOKEN") ?? "";
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
  const send = await telnyxSendSms({
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
): Promise<void> {
  const { error } = await supabase
    .from("ai_flow_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`ai_flow_runs update: ${error.message}`);
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
      const { data, error } = await supabase
        .from("ai_flows")
        .select("id, business_id, definition")
        .eq("enabled", true)
        .eq("definition->trigger->>channel", "schedule")
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
      const trig = row.definition.trigger;
      if (trig.channel !== "schedule") continue;
      const due = scheduleDue(nowMs, trig);
      if (!due) continue;
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
        dedupe_key: `sched:${due.key}`
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
          payload: { flow_id: row.id, dedupe_key: `sched:${due.key}` }
        });
      }
    }
  } catch (e) {
    console.error("enqueueDueScheduledRuns", e);
  }
}

/**
 * Email triggers: the mailbox polling needs the app's Nango credentials, so
 * the actual work lives in the Next.js /api/internal/aiflow-email-poll route
 * (cron-secret authed, same contract as this worker's own auth); this just
 * kicks it once per tick. The route is a cheap no-op when no enabled flow has
 * an email trigger. Failures only log — mailbox trouble must never stall SMS
 * or scheduled runs.
 */
async function kickEmailTriggerPoll(): Promise<void> {
  const base = Deno.env.get("AIFLOW_PLATFORM_URL") ?? "";
  const secret = Deno.env.get("INTERNAL_CRON_SECRET") ?? "";
  if (!base || !secret) return;
  const ctl = new AbortController();
  // The poll route legitimately runs up to its 60s maxDuration on a busy
  // mailbox; aborting sooner can cut the work short on some hosts and logs
  // spurious failures, so wait past that ceiling (the caller overlaps this
  // wait with run processing rather than blocking on it).
  const timer = setTimeout(() => ctl.abort(), EMAIL_POLL_KICK_TIMEOUT_MS);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/internal/aiflow-email-poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: "{}",
      signal: ctl.signal
    });
    if (!res.ok) {
      console.error("aiflow-email-poll", res.status, (await res.text()).slice(0, 200));
    } else {
      await res.body?.cancel();
    }
  } catch (e) {
    console.error("kickEmailTriggerPoll", e);
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
