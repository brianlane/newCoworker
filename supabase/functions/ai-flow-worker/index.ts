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
  extractPhones,
  htmlToText,
  isExecutableDefinition,
  parseExtractionJson
} from "../_shared/ai_flows/engine.ts";
import { planStep, type StepAction } from "../_shared/ai_flows/steps.ts";
import { normalizeBrowseUrl, parseRenderResponse } from "../_shared/ai_flows/browse.ts";
import { ensureStopLanguage, isRecipientOptedOut } from "../_shared/ai_flows/compliance.ts";
import type { AiFlowDefinition, BrowseAuth, ExtractField, FlowStep } from "../_shared/ai_flows/types.ts";

type Supabase = ReturnType<typeof createClient>;

const MAX_ATTEMPTS = 4;
const CLAIM_LIMIT = 3;
const FETCH_TIMEOUT_MS = 20_000;
// Render-service calls can run several navigations plus a login, so they need a
// far larger budget than a static fetch. Must exceed the render service's
// per-navigation timeout (AIFLOW_RENDER_TIMEOUT_MS, default 30s) times the
// worst-case nav count (initial + login + re-nav) or the worker aborts a render
// that would have succeeded.
const RENDER_FETCH_TIMEOUT_MS = Number(
  Deno.env.get("AIFLOW_RENDER_FETCH_TIMEOUT_MS") ?? "120000"
);
const MAX_REDIRECTS = 5;

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

  let index = run.current_step;
  while (index < def.steps.length) {
    const step = def.steps[index];
    const outcome = await runStep(supabase, run, step, index, scope, approval);
    if (outcome.kind === "fail") {
      await recordStep(supabase, run, index, step, "failed", undefined, outcome.error);
      await failRun(supabase, run, outcome.error, scope, approval);
      return;
    }
    if (outcome.kind === "pause") {
      await recordStep(supabase, run, index, step, "pending");
      await updateRun(supabase, run.id, {
        status: "awaiting_approval",
        current_step: index,
        context: buildContext(scope, approval),
        claimed_at: null
      });
      await telemetryRecord(supabase, "ai_flow_run_awaiting_approval", {
        run_id: run.id,
        business_id: run.business_id,
        step_index: index
      });
      return;
    }
    await recordStep(supabase, run, index, step, outcome.skipped ? "skipped" : "done", outcome.result);
    index += 1;
    await updateRun(supabase, run.id, {
      current_step: index,
      context: buildContext(scope, approval)
    });
  }

  await updateRun(supabase, run.id, {
    status: "done",
    current_step: index,
    context: buildContext(scope, approval),
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
  | { kind: "pause" };

/** Execute one step's side effect. Throws on transient IO errors (→ retry). */
async function runStep(
  supabase: Supabase,
  run: RunRow,
  step: FlowStep,
  index: number,
  scope: Scope,
  approval: Record<string, unknown>
): Promise<StepOutcome> {
  await recordStep(supabase, run, index, step, "running");
  const plan = planStep(step, scope);
  if (!plan.ok) return { kind: "fail", error: plan.error };
  const action = plan.action;

  switch (action.kind) {
    case "set_vars":
      Object.assign(scope.vars, action.vars);
      return { kind: "ok", result: { vars: action.vars } };
    case "browse":
      return browseStep(run, scope, action);
    case "send_sms":
      return sendSmsStep(supabase, run, index, action);
    case "notify_owner":
      return notifyOwnerStep(supabase, run, action);
    case "http_call":
      return httpCallStep(run, scope, action);
    case "await_approval":
      return approvalStep(approval, index, action);
  }
}

async function browseStep(
  run: RunRow,
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

  let page: { finalUrl: string; text: string; html: string };
  try {
    page = await fetchPage(
      safe,
      renderUrl,
      action.auth ? { businessId: run.business_id, auth: action.auth } : undefined
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
  Object.assign(scope.vars, out);
  return { kind: "ok", result: { vars: out, finalUrl: page.finalUrl } };
}

/**
 * Fetch a page via the optional render service, else a static GET.
 *
 * When `authCtx` is supplied the render service logs in with the named custom
 * integration's stored credentials before reading the page (credentialed
 * browse). The render service is network-reachable, so calls carry a bearer
 * token (AIFLOW_RENDER_TOKEN) when configured.
 */
async function fetchPage(
  url: string,
  renderUrl: string | null,
  authCtx?: { businessId: string; auth: BrowseAuth }
): Promise<{ finalUrl: string; text: string; html: string }> {
  const ctrl = new AbortController();
  // Render calls (multi-nav + login) get a much larger budget than a static GET.
  const timer = setTimeout(
    () => ctrl.abort(),
    renderUrl ? RENDER_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS
  );
  try {
    if (renderUrl) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const renderToken = Deno.env.get("AIFLOW_RENDER_TOKEN");
      if (renderToken) headers.Authorization = `Bearer ${renderToken}`;
      const res = await fetch(renderUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(
          authCtx ? { url, businessId: authCtx.businessId, auth: authCtx.auth } : { url }
        ),
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
    }
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
  approval?: Record<string, unknown>
): Promise<void> {
  // Best-effort terminal write; if it fails, stale-run reclaim recovers the run.
  try {
    await updateRun(supabase, run.id, {
      status: "failed",
      last_error: error.slice(0, 2000),
      claimed_at: null,
      ...(scope && approval ? { context: buildContext(scope, approval) } : {})
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

function buildContext(scope: Scope, approval: Record<string, unknown>): Record<string, unknown> {
  const ctx: Record<string, unknown> = { vars: scope.vars, trigger: scope.trigger };
  if (Object.keys(approval).length > 0) ctx.approval = approval;
  return ctx;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
