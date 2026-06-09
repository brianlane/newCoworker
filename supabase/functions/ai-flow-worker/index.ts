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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { assertCronAuth } from "../_shared/cron_auth.ts";
import { telemetryRecord } from "../_shared/telemetry.ts";
import { telnyxSendSms } from "../_shared/telnyx_sms_compliance.ts";
import {
  buildExtractionPrompt,
  evaluateStepCondition,
  extractPhones,
  htmlToText,
  isExecutableDefinition,
  parseExtractionJson,
  parseRoutedAgent,
  renderTemplate,
  type RoutedAgent
} from "../_shared/ai_flows/engine.ts";
import { callRowboatChatOnce } from "../_shared/sms_rowboat.ts";
import { planStep, type StepAction } from "../_shared/ai_flows/steps.ts";
import { normalizeBrowseUrl, parseRenderResponse } from "../_shared/ai_flows/browse.ts";
import { ensureStopLanguage, isRecipientOptedOut } from "../_shared/ai_flows/compliance.ts";
import type { AiFlowDefinition, BrowseAuth, ExtractField, FlowStep } from "../_shared/ai_flows/types.ts";

type Supabase = ReturnType<typeof createClient>;

const MAX_ATTEMPTS = 4;
const CLAIM_LIMIT = 3;
const FETCH_TIMEOUT_MS = 20_000;
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
const GEMINI_MODEL = Deno.env.get("AIFLOW_EXTRACT_MODEL") ?? "gemini-2.5-flash-lite";

type RunRow = {
  id: string;
  flow_id: string;
  business_id: string;
  status: string;
  context: Record<string, unknown>;
  current_step: number;
  attempt_count: number;
};

type Scope = { vars: Record<string, unknown>; trigger: Record<string, unknown> };

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

  const { data: claimed, error: claimErr } = await supabase.rpc("claim_ai_flow_runs", {
    p_limit: CLAIM_LIMIT
  });
  if (claimErr) {
    console.error("claim_ai_flow_runs", claimErr);
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
      await updateRun(supabase, run.id, {
        status: "canceled",
        last_error: "flow disabled",
        claimed_at: null
      });
    } catch (e) {
      console.error("executeRun cancel-disabled updateRun", e);
    }
    await telemetryRecord(supabase, "ai_flow_run_canceled_disabled", {
      run_id: run.id,
      business_id: run.business_id
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
    trigger: asRecord(run.context.trigger)
  };
  const approval = asRecord(run.context.approval);
  // route_to_team state: tried[], the currently-offered agent, and last_event
  // (claim/reject/timeout) stamped by the inbound webhook / escalation sweep.
  const routing = asRecord(run.context.routing);

  let index = run.current_step;
  while (index < def.steps.length) {
    const step = def.steps[index];
    const outcome = await runStep(supabase, run, step, index, scope, approval, routing);
    if (outcome.kind === "fail") {
      await recordStep(supabase, run, index, step, "failed", undefined, outcome.error);
      await failRun(supabase, run, outcome.error, scope, approval, routing);
      return;
    }
    if (outcome.kind === "pause") {
      await recordStep(supabase, run, index, step, "pending");
      await updateRun(supabase, run.id, {
        status: "awaiting_approval",
        current_step: index,
        context: buildContext(scope, approval, routing),
        claimed_at: null
      });
      // Offer the owner an SMS approval path (reply 1 = approve, 2 = decline)
      // alongside the dashboard buttons. Best-effort + idempotent: a send failure
      // must not unwind the parked state (that would re-run the gate on retry),
      // and the idempotency key dedupes resends if the run is ever re-queued and
      // re-pauses at this same gate.
      const approvalPrompt =
        typeof approval.prompt === "string" && approval.prompt.trim()
          ? approval.prompt
          : "This automation step is waiting for your approval.";
      try {
        await sendOwnerSms(
          supabase,
          run,
          `${approvalPrompt}\n\nReply 1 to approve or 2 to decline.`,
          `aiflow-approval:${run.id}:${index}`
        );
      } catch (e) {
        console.error("approval prompt SMS failed after park", e);
      }
      await telemetryRecord(supabase, "ai_flow_run_awaiting_approval", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index
      });
      return;
    }
    if (outcome.kind === "pause_agent") {
      await recordStep(supabase, run, index, step, "pending");
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
      }
      await telemetryRecord(supabase, "ai_flow_run_awaiting_agent", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index,
        agent: outcome.e164
      });
      return;
    }
    await recordStep(supabase, run, index, step, outcome.skipped ? "skipped" : "done", outcome.result);
    index += 1;
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
}

type StepOutcome =
  | { kind: "ok"; result?: Record<string, unknown>; skipped?: boolean }
  | { kind: "fail"; error: string }
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
    case "send_sms":
      return sendSmsStep(supabase, run, index, action);
    case "send_email":
      return sendEmailStep(supabase, run, index, scope, action);
    case "notify_owner":
      return notifyOwnerStep(supabase, run, action);
    case "http_call":
      return httpCallStep(run, scope, action);
    case "await_approval":
      return approvalStep(approval, index, action);
    case "route_to_team":
      return routeToTeamStep(supabase, run, scope, action, routing);
  }
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
      action.screenshot === true
    );
  } catch (e) {
    // A render login failure is permanent (bad creds / MFA), not transient IO —
    // fail the run instead of letting it throw into the retry path.
    if (e instanceof BrowseLoginError) {
      const which = action.auth ? ` for integration "${action.auth.integrationLabel}"` : "";
      return { kind: "fail", error: `browse: ${e.message}${which}` };
    }
    throw e;
  }
  const pageText = page.text || htmlToText(page.html);
  const extracted = await extractFields(action.fields, pageText);

  const out: Record<string, string> = {};
  for (const f of action.fields) {
    let val = extracted[f.name] ?? "";
    if (!val && /phone|mobile|cell|tel/i.test(f.name)) {
      val = extractPhones(pageText)[0] ?? "";
    }
    out[f.name] = val;
  }

  // Best-effort screenshot persistence: a storage failure must not fail a
  // browse that already extracted its fields — downstream attachScreenshot
  // steps just run without the attachment.
  if (action.screenshot && page.screenshotBase64) {
    try {
      out.screenshot_path = await storeScreenshot(supabase, run, index, page.screenshotBase64);
    } catch (e) {
      console.error("browse screenshot store failed", e);
    }
  }

  Object.assign(scope.vars, out);
  return { kind: "ok", result: { vars: out, finalUrl: page.finalUrl } };
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
  base64: string
): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const path = `${run.business_id}/${run.id}/step-${index}.jpg`;
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
    if (!res.ok) {
      // Distinguish a permanent login failure from transient render errors so
      // the caller can fail fast instead of retrying bad credentials.
      let errCode = "";
      try {
        errCode = ((await res.json()) as { error?: string })?.error ?? "";
      } catch {
        /* non-JSON error body — treat as transient below */
      }
      // login_failed (bad creds/MFA) and auth_config_error (missing platform
      // config, integration not found, wrong selectors) are permanent setup
      // failures — fail the run rather than retrying transiently.
      if (errCode === "login_failed" || errCode === "auth_config_error") {
        throw new BrowseLoginError(errCode);
      }
      throw new Error(`render service ${res.status}`);
    }
    const parsed = parseRenderResponse(await res.json(), url);
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

/** Gemini structured extraction; empty map when no API key (regex fallback covers it). */
async function extractFields(
  fields: ExtractField[],
  pageText: string
): Promise<Record<string, string>> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY") ?? "";
  if (!apiKey) return {};
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
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return parseExtractionJson(text, fields);
}

async function sendSmsStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  action: Extract<StepAction, { kind: "send_sms" }>
): Promise<StepOutcome> {
  if (await isRecipientOptedOut(supabase, run.business_id, action.to)) {
    return { kind: "ok", skipped: true, result: { skipped: "recipient_opted_out", to: action.to } };
  }
  const cfg = await messagingConfig(supabase, run.business_id);
  if (!cfg) return { kind: "fail", error: "send_sms: Telnyx messaging is not configured" };

  const text = ensureStopLanguage(action.body).slice(0, 1600);
  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "try_reserve_sms_outbound_slot",
    { p_business_id: run.business_id }
  );
  if (reserveErr) throw new Error(`reserve slot: ${reserveErr.message}`);
  const reserve = reserveRaw as { ok?: boolean; reason?: string } | null;
  if (!reserve?.ok) {
    return { kind: "ok", skipped: true, result: { skipped: reserve?.reason ?? "quota" } };
  }

  const release = async () => {
    const { error } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: run.business_id
    });
    if (error) console.error("release_sms_outbound_slot", error);
  };

  try {
    const send = await telnyxSendSms({
      apiKey: cfg.apiKey,
      messagingProfileId: cfg.profile,
      fromE164: cfg.from,
      toE164: action.to,
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
    return { kind: "ok", result: { to: action.to, messageId } };
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
 * send_email: deliver a templated email via Resend, optionally attaching the
 * screenshot a prior browse_extract stored (downloaded from the private bucket
 * by path — never by fetching a templatable URL). Missing RESEND_API_KEY is a
 * permanent setup error; a Resend/storage IO failure throws so the run retries.
 */
async function sendEmailStep(
  supabase: Supabase,
  run: RunRow,
  index: number,
  scope: Scope,
  action: Extract<StepAction, { kind: "send_email" }>
): Promise<StepOutcome> {
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!apiKey) return { kind: "fail", error: "send_email: RESEND_API_KEY is not configured" };

  let attachment: { filename: string; content: string } | null = null;
  if (action.attachScreenshot) {
    const path = typeof scope.vars.screenshot_path === "string" ? scope.vars.screenshot_path : "";
    if (path) {
      const { data, error } = await supabase.storage.from(SCREENSHOT_BUCKET).download(path);
      if (error || !data) {
        throw new Error(`send_email: screenshot download failed: ${error?.message ?? "no data"}`);
      }
      attachment = {
        filename: "lead-screenshot.jpg",
        content: bytesToBase64(new Uint8Array(await data.arrayBuffer()))
      };
    }
    // No screenshot in scope (static-fetch fallback or capture failure): send
    // without the attachment rather than stranding the lead email.
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Resend de-duplicates on retry, mirroring the Telnyx idempotency keys.
      "Idempotency-Key": `aiflow-email/${run.id}/${index}`
    },
    body: JSON.stringify({
      from: Deno.env.get("MAILER_EMAIL") ?? "New Coworker <contact@newcoworker.com>",
      to: action.to,
      reply_to: Deno.env.get("CONTACT_EMAIL") ?? undefined,
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
  return {
    kind: "ok",
    result: { to: action.to, emailId, attached: attachment !== null }
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
    const send = await telnyxSendSms({
      apiKey: cfg.apiKey,
      messagingProfileId: cfg.profile,
      fromE164: cfg.from,
      toE164: forward,
      text: `[AiFlow] ${action.message}`.slice(0, 1600),
      idempotencyKey: `aiflow-notify:${run.id}`
    });
    if (!send.ok) throw new Error(`notify_owner telnyx ${send.status}`);
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
  index: number,
  action: Extract<StepAction, { kind: "await_approval" }>
): StepOutcome {
  if (approval.decision === "approve" && approval.consumed !== true) {
    approval.consumed = true;
    return { kind: "ok", result: { approved: true } };
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

  // An agent claimed (inbound '1'): finalize and optionally tell the owner.
  if (routing.last_event === "claim") {
    const claimedBy =
      typeof routing.reply_from === "string" && routing.reply_from
        ? routing.reply_from
        : typeof routing.offered === "string"
          ? routing.offered
          : "";
    const claimedName = typeof routing.offered_name === "string" ? routing.offered_name : "";
    routing.claimed_by = claimedBy;
    routing.claimed_name = claimedName;
    delete routing.last_event;
    delete routing.reply_from;
    delete routing.offered;
    delete routing.offered_name;
    if (action.claimedNotifyTemplate) {
      const body = renderTemplate(
        action.claimedNotifyTemplate,
        agentScope(scope, { name: claimedName, phone: claimedBy })
      );
      await sendOwnerSms(supabase, run, body, `aiflow-claimed:${run.id}`);
    }
    return { kind: "ok", result: { routed: "claimed", claimed_by: claimedBy } };
  }

  // First entry, reject ('2'), or timeout: retire the agent we last offered, then
  // ask Rowboat for the next one.
  const prevOffered = typeof routing.offered === "string" ? routing.offered : "";
  if (prevOffered && !tried.includes(prevOffered)) tried.push(prevOffered);
  delete routing.offered;
  delete routing.offered_name;
  delete routing.last_event;
  delete routing.reply_from;

  for (let i = 0; i < ROUTE_MAX_LOOKUPS; i++) {
    const agent = await pickNextAgent(supabase, run, scope, tried);
    // No agent at all (none / parse fail / unconfigured): roster is exhausted.
    if (!agent) break;
    // Rowboat repeated an agent we already tried: don't end routing on one bad
    // pick — consume another lookup and ask again (bounded by ROUTE_MAX_LOOKUPS).
    if (tried.includes(agent.phone)) continue;
    // A teammate who texted STOP is opted out: skip them and ask for the next.
    if (await isRecipientOptedOut(supabase, run.business_id, agent.phone)) {
      tried.push(agent.phone);
      continue;
    }
    routing.offered = agent.phone;
    routing.offered_name = agent.name;
    // The offer SMS itself is sent by executeRun AFTER the awaiting_agent state
    // is persisted (state before side effect); we only carry the rendered body
    // and a per-agent idempotency key here. The MMS URL is signed fresh per
    // offer so an escalation hours later never carries an expired link.
    const mmsUrl = action.attachScreenshot ? await screenshotMmsUrl(supabase, scope) : null;
    return {
      kind: "pause_agent",
      e164: agent.phone,
      respondByMs: action.responseMinutes * 60_000,
      offerText: renderTemplate(action.offerTemplate, agentScope(scope, agent)),
      idempotencyKey: `aiflow-offer:${run.id}:${tried.length}`,
      ...(mmsUrl ? { mediaUrls: [mmsUrl] } : {})
    };
  }

  // Roster exhausted: hand the lead to the owner so it is never dropped.
  const body = renderTemplate(action.ownerFallbackTemplate, scope);
  await sendOwnerSms(supabase, run, body, `aiflow-owner-fallback:${run.id}`);
  return { kind: "ok", result: { routed: "owner_fallback", tried: tried.length } };
}

/** Scope for templating an agent-facing SMS: run vars/trigger plus {{agent.*}}. */
function agentScope(scope: Scope, agent: RoutedAgent): Record<string, unknown> {
  return {
    vars: scope.vars,
    trigger: scope.trigger,
    agent: { name: agent.name, phone: agent.phone }
  };
}

/**
 * Ask the tenant's Rowboat agent for the next team member to offer the lead to,
 * excluding `tried`. Returns null when the roster is exhausted, the reply is
 * unparseable, or Rowboat isn't configured (→ owner fallback). THROWS on a
 * Rowboat transport error so the run retries rather than prematurely escalating.
 */
async function pickNextAgent(
  supabase: Supabase,
  run: RunRow,
  scope: Scope,
  tried: string[]
): Promise<RoutedAgent | null> {
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
  const preamble = [
    "You are routing a new real-estate lead to your team.",
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
  const body = ensureStopLanguage(text).slice(0, 1600);
  const { data: reserveRaw, error: reserveErr } = await supabase.rpc(
    "try_reserve_sms_outbound_slot",
    { p_business_id: run.business_id }
  );
  if (reserveErr) throw new Error(`reserve slot: ${reserveErr.message}`);
  const reserve = reserveRaw as { ok?: boolean; reason?: string } | null;
  if (!reserve?.ok) {
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
  } catch (e) {
    const { error } = await supabase.rpc("release_sms_outbound_slot", {
      p_business_id: run.business_id
    });
    if (error) console.error("release_sms_outbound_slot", error);
    throw e;
  }
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
    return;
  }
  const send = await telnyxSendSms({
    apiKey: cfg.apiKey,
    messagingProfileId: cfg.profile,
    fromE164: cfg.from,
    toE164: forward,
    text: `[AiFlow] ${text}`.slice(0, 1600),
    idempotencyKey
  });
  if (!send.ok) throw new Error(`route_to_team owner sms telnyx ${send.status}`);
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
}

/** Transient throw → re-queue until attempts exhausted, then dead-letter. */
async function handleRunThrow(supabase: Supabase, run: RunRow, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  if (run.attempt_count >= MAX_ATTEMPTS) {
    await failRun(supabase, run, `max attempts: ${message}`);
    return;
  }
  // Best-effort re-queue; if it fails, stale-run reclaim recovers the run.
  try {
    await updateRun(supabase, run.id, {
      status: "queued",
      last_error: message.slice(0, 2000),
      claimed_at: null
    });
  } catch (e) {
    console.error("handleRunThrow updateRun", e);
  }
  await telemetryRecord(supabase, "ai_flow_run_retry", {
    run_id: run.id,
    business_id: run.business_id,
    attempt: run.attempt_count,
    error: message.slice(0, 300)
  });
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
