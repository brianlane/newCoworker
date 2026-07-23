// Per-tenant VPS-side dashboard-chat worker (Option B).
//
// Pulls 'queued' jobs from dashboard_chat_jobs, calls the local Rowboat in
// non-streaming mode (~5–30s typical), inserts the assistant message into
// dashboard_chat_messages, and marks the job 'done'. The browser sees the
// reply by subscribing to dashboard_chat_messages Realtime — the Vercel
// function returned 200 the moment it enqueued the job (in <2s) and is
// long gone by the time the worker finishes.
//
// Two-attempt protocol per job:
//   1. First attempt sends `input_messages` with `rowboat_conversation_id`
//      (Rowboat's server-side state path). If it succeeds, done.
//   2. On a STATELESS_RETRY_ERRORS-class failure (Rowboat 4xx/5xx
//      indicating its conversation state is wedged), retry with
//      `stateless_input_messages` and WITHOUT a conversationId. The
//      stateless variant carries the tail-as-system message so Rowboat
//      can answer entirely off our prompt. After a successful stateless
//      retry, the worker NULLs out dashboard_chat_threads.rowboat_conversation_id
//      so the next turn doesn't pay 2x latency on the same dead id.
//   3. If both attempts fail (or stateless_input_messages is null and
//      the first attempt failed) on a RETRYABLE code with claim budget
//      left, the job is RE-QUEUED (status 'queued', claim cleared) after a
//      REQUEUE_BACKOFF_MS * attempts pause, so a transient Rowboat outage
//      wider than the in-turn retry window (observed: a ~30s 500 window)
//      doesn't dead-end the turn. Non-retryable codes, or the last
//      allowed attempt failing, end the job as 'error'.
//
// Reliability contract ("messages do not drop"):
//   1. claim_chat_job() is FOR UPDATE SKIP LOCKED — concurrent workers
//      claim disjoint jobs.
//   2. If the worker crashes between claim and write, the row stays
//      'processing' with a stale claimed_at; reclaim_stale_chat_jobs()
//      flips it back to 'queued' on the next sweep so a restarted worker
//      re-picks it up. Bound on recovery time = WORKER_SWEEP_INTERVAL_MS.
//   3. The assistant-message INSERT happens BEFORE the job UPDATE to
//      'done', so a crash between them just leaves the job 'processing'
//      (caught by #2) — never loses the message.
//   4. Realtime is best-effort. The periodic sweep + drain loop also
//      covers any queued jobs the websocket missed.
//   5. claim_chat_job() increments `attempts` on every claim; the worker
//      refuses to process jobs with attempts > MAX_ATTEMPTS to avoid a
//      hot-loop on persistently failing upstreams. The job ends as
//      `error` instead.
//
// Verified end-to-end on srv1632631.hstgr.cloud (business
// 621a5b0d-c2ad-449f-9d74-9d50e7b27fa3) before this code shipped:
//   * 1 happy-path job   → done in 4.4s end-to-end
//   * 5 simultaneous     → 5/5 done in 25s wall-clock, 0 drops
//   * Simulated stuck    → reclaimed 291ms after restart, attempts=2,
//     claim                done in 6s
//
// Env (required unless noted):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY     (service role; bypasses RLS, see migration)
//   ROWBOAT_BASE_URL              (default: http://rowboat:3000)
//   ROWBOAT_PROJECT_ID            (per-tenant Rowboat project id; this is
//                                  the same UUID as BUSINESS_ID in our
//                                  deploys, but kept as a separate env var
//                                  to keep Rowboat's identifier model
//                                  decoupled from Supabase's.)
//   ROWBOAT_GATEWAY_TOKEN         (Rowboat API key for this project)
//   BUSINESS_ID                   (this worker only handles its tenant's
//                                  jobs; multi-tenant deploys would run
//                                  one worker container per business)
//   WORKER_STALE_CLAIM_MS         (default 300000 = 5min)
//   WORKER_SWEEP_INTERVAL_MS      (default 30000 = 30s)
//   WORKER_ROWBOAT_TIMEOUT_MS     (default 240000 = 4min — must be < the
//                                  cron sweep + claim age, otherwise we'd
//                                  reclaim our own in-flight job)
//   WORKER_MAX_ATTEMPTS           (default 3 — hard cap on retries before
//                                  marking a job permanently errored)
//   WORKER_REQUEUE_BACKOFF_MS     (default 10000 — pause before a retryable
//                                  failure is re-queued, × the claim number)
//   WORKER_VERCEL_BASE_URL        (e.g. https://newcoworker.com — when set
//                                  AND WORKER_VERCEL_BEARER is set, the
//                                  worker fires a fire-and-forget POST to
//                                  /api/internal/dashboard-chat-summarize
//                                  after each successful job so the rolling
//                                  thread summary picks up the just-written
//                                  assistant turn. Optional: skipping this
//                                  env pair is equivalent to "summaries
//                                  never refresh from this worker"; the
//                                  next turn re-evaluates shouldSummarize
//                                  on whichever side runs the trigger.)
//   WORKER_VERCEL_BEARER          (matches Vercel's INTERNAL_CRON_SECRET;
//                                  see assertCronAuth in src/lib/cron-auth.ts)

import { createClient } from "@supabase/supabase-js";
import {
  extractExistingBullets,
  extractLatestOwnerMessage,
  extractOwnerRule,
  fitBulletsToPayload
} from "./memory-capture.mjs";
import { extractEmailSendRequests, fulfillEmailSends } from "./email-tool.mjs";
import { maybeBuildGraphDb } from "./graph-db-build.mjs";

const SUPABASE_URL = required("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const ROWBOAT_BASE_URL = process.env.ROWBOAT_BASE_URL || "http://rowboat:3000";
const ROWBOAT_PROJECT_ID = required("ROWBOAT_PROJECT_ID");
const ROWBOAT_GATEWAY_TOKEN = required("ROWBOAT_GATEWAY_TOKEN");
const BUSINESS_ID = required("BUSINESS_ID");
const STALE_CLAIM_MS = intEnv("WORKER_STALE_CLAIM_MS", 5 * 60 * 1000);
const SWEEP_INTERVAL_MS = intEnv("WORKER_SWEEP_INTERVAL_MS", 30 * 1000);
const ROWBOAT_TIMEOUT_MS = intEnv("WORKER_ROWBOAT_TIMEOUT_MS", 4 * 60 * 1000);
const MAX_ATTEMPTS = intEnv("WORKER_MAX_ATTEMPTS", 3);
// Backoff before a failed-but-retryable job is re-queued, multiplied by the
// claim number. Observed live (July 2026, business 690f85c0): Rowboat 500'd
// for a ~30s window — the in-turn retry (a few seconds apart) failed too, but
// the owner's manual resend ~45s later succeeded. Spacing re-claims out gives
// a blipping Rowboat room to recover instead of burning the whole attempts
// budget inside the same bad window.
const REQUEUE_BACKOFF_MS = intEnv("WORKER_REQUEUE_BACKOFF_MS", 10 * 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Rowboat agent to enter on owner-dashboard turns. MUST match an agent in
// this tenant's seeded workflow. deploy-client.sh seeds "OwnerCoworker"
// (= Coworker's tool surface plus owner_append_business_memory), so that's
// the default. Set CHAT_WORKER_OWNER_START_AGENT="" to omit startAgent
// entirely — Rowboat then enters its workflow-default startAgent
// ("Coworker"). That escape hatch matters for tenants still on an older
// seed that predates OwnerCoworker: sending a non-existent agent name made
// Rowboat silently fall back with no signal (observed on business
// 621a5b0d, June 2026, whose Mongo workflow only had ["Coworker"]). Re-run
// deploy-client.sh to seed OwnerCoworker, OR set this to "Coworker"/"".
const OWNER_START_AGENT = (process.env.CHAT_WORKER_OWNER_START_AGENT ?? "OwnerCoworker").trim();
const OWNER_START_AGENT_OPTS = OWNER_START_AGENT
  ? { startAgent: OWNER_START_AGENT }
  : {};

// Website chat widget agents (webchat_jobs queue). WebchatCoworker is the
// capability-restricted anonymous-visitor agent seeded by deploy-client.sh
// (info + lead gen tools ONLY — no SMS/email/call/image); its Local twin is
// the spend-cap fallback. Same empty-string escape hatch as the owner pair:
// deploy-client.sh writes CHAT_WORKER_WEBCHAT_LOCAL_AGENT="" on kvm1 (no
// local model), which makes the worker REFUSE over-cap webchat turns with an
// honest visitor-facing reply instead of routing to an agent that can't run.
const WEBCHAT_START_AGENT = (process.env.CHAT_WORKER_WEBCHAT_START_AGENT ?? "WebchatCoworker").trim();
const WEBCHAT_LOCAL_AGENT = (process.env.CHAT_WORKER_WEBCHAT_LOCAL_AGENT ?? "WebchatCoworkerLocal").trim();

// --- Owner-chat spend cap ("runaway fuse") --------------------------------
// The Gemini-backed OwnerCoworker agent bills per token. We meter estimated
// per-turn cost into owner_chat_model_spend (period-keyed) and the enqueue
// route flips jobs to the local Qwen agent once the period cap is hit. This
// is the ROUTING half — it READS live period spend to decide Gemini vs local.
// It no longer WRITES spend: exact billed tokens are now metered by the
// llm-router sidecar (the only component that sees Gemini's real `usage`),
// which POSTs them to /api/internal/meter-gemini-spend. Metering a chars/4
// estimate here on top of that would double-count the same turn.
// The local-agent name MUST match the agent deploy-client.sh seeds for the
// Qwen fallback; turns on it are $0.
const OWNER_CHAT_LOCAL_AGENT = (process.env.CHAT_WORKER_OWNER_LOCAL_AGENT ?? "OwnerCoworkerLocal").trim();
const OWNER_CHAT_SPEND_CAP_MICROS = intEnv("OWNER_CHAT_SPEND_CAP_MICROS", 10_000_000); // $10 (standard/enterprise)
// Starter tenants get a lower included AI budget ($5). The cap is derived from
// the business tier (read from `businesses.tier`, cached) so it stays in lockstep
// with the platform (src/lib/db/chat-usage.ts) and Edge (_shared/chat_spend_cap.ts)
// mappings without depending on a per-tenant .env redeploy. Env-tunable base.
const OWNER_CHAT_SPEND_CAP_MICROS_STARTER = intEnv("OWNER_CHAT_SPEND_CAP_MICROS_STARTER", 5_000_000); // $5
// Gates the spend-cap ROUTING read (Gemini→local fallback once the period cap
// is hit). The cap WRITE moved to the llm-router → app meter; this flag stays
// the on/off switch for the routing behavior. Off ⇒ never downgrade to local.
const OWNER_CHAT_SPEND_METERING_ENABLED =
  (process.env.OWNER_CHAT_SPEND_METERING_ENABLED ?? "true").trim().toLowerCase() !== "false";
const VERCEL_BASE_URL = (process.env.WORKER_VERCEL_BASE_URL || "").replace(/\/+$/, "");
const VERCEL_BEARER = process.env.WORKER_VERCEL_BEARER || "";
// Server-side owner-rule capture (see memory-capture.mjs for the why). On
// every owner turn we run a small local-Ollama extraction over the owner's
// message; if it's a durable business rule we POST it to the platform
// owner-append adapter (which writes memory_md + triggers a vault sync) and
// append an HONEST confirmation to the reply. Disabled by setting
// MEMORY_CAPTURE_ENABLED=false, or implicitly when WORKER_VERCEL_BASE_URL is
// unset (no adapter to POST to).
const MEMORY_CAPTURE_ENABLED =
  (process.env.MEMORY_CAPTURE_ENABLED ?? "true").trim().toLowerCase() !== "false";
// Ollama is bound to 0.0.0.0:11434 on the host (see bootstrap.sh); the worker
// container reaches it the same way the llm-router does — via the
// host.docker.internal=host-gateway extra_host wired in docker-compose.yml.
// Only used when MEMORY_CAPTURE_MODEL is a LOCAL (non-gemini) tag.
const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434"
).replace(/\/+$/, "");
// Google's OpenAI-compatible endpoint + key for a gemini-* MEMORY_CAPTURE_MODEL.
// Extraction calls Google DIRECTLY (not via the per-tenant llm-router sidecar):
// the worker reaches Google in <1s, but POSTing to the llm-router from the
// worker container hangs (different docker network — small GETs like /health
// pass, POST bodies black-hole). The owner-chat path is unaffected (it goes
// worker → Rowboat → router, and Rowboat is co-located with the router).
const MEMORY_CAPTURE_GEMINI_BASE_URL = (
  process.env.MEMORY_CAPTURE_GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai"
).replace(/\/+$/, "");
const GOOGLE_API_KEY = (process.env.GOOGLE_API_KEY || "").trim();
// Extraction model. Defaults to Gemini (gemini-3.5-flash-lite, GA
// 2026-07-21 — captured rules become durable memory, so the quality tier
// matters) called directly: a functional, fast classification that uses ZERO
// local CPU, so it can't starve the latency-sensitive Gemini chat turns. The
// CPU-bound local qwen path it replaces always timed out (~30s) AND inflated
// concurrent owner turns from ~7s to ~50s. Override to a local Ollama tag
// (e.g. qwen3:4b-instruct) to run capture fully locally on a keyless host.
const MEMORY_CAPTURE_MODEL = (process.env.MEMORY_CAPTURE_MODEL || "gemini-3.5-flash-lite").trim();
const MEMORY_CAPTURE_TIMEOUT_MS = intEnv("MEMORY_CAPTURE_TIMEOUT_MS", 30 * 1000);
// Platform adapter that persists owner rules. Authenticated with the same
// ROWBOAT_GATEWAY_TOKEN the voice/SMS tool adapters use (verifyRowboatGatewayToken).
const OWNER_APPEND_URL = VERCEL_BASE_URL
  ? `${VERCEL_BASE_URL}/api/voice/tools/owner-append-business-memory`
  : "";
// Platform adapter that sends dashboard-chat emails from the owner's
// connected mailbox. Same auth as OWNER_APPEND_URL (gateway token). The
// adapter authoritatively re-checks the owner's Settings → Coworker tools
// toggle before any mail leaves, so this worker never needs its own
// settings read. Empty when the worker is deployed without Vercel plumbing
// — EMAIL_SEND blocks then resolve to an honest "not configured" line.
const EMAIL_TOOL_URL = VERCEL_BASE_URL
  ? `${VERCEL_BASE_URL}/api/voice/tools/dashboard-email`
  : "";
const EMAIL_TOOL_TIMEOUT_MS = intEnv("EMAIL_TOOL_TIMEOUT_MS", 15_000);
const MEMORY_CAPTURE_CALLBACK_TIMEOUT_MS = 10_000;
// Cap how long we'll let the summarizer callback hold an open
// connection. We don't await the response, but we DO want bounded
// resource usage if Vercel hangs — node's default fetch keeps the
// socket open until the server closes it. 10s is well above the
// route's typical 200-500ms shouldSummarize miss case and the 3-15s
// summarizer hit case.
const SUMMARIZE_CALLBACK_TIMEOUT_MS = 10_000;

// Sanity check: if a worker takes longer to call Rowboat than the stale-claim
// window allows, two workers (or this one twice) could reclaim the same job
// and produce duplicate assistant messages. Refuse to start in that mode —
// far better to fail fast than to corrupt chat history.
if (ROWBOAT_TIMEOUT_MS >= STALE_CLAIM_MS) {
  console.error(
    JSON.stringify({
      level: "fatal",
      event: "config_invalid",
      reason: "ROWBOAT_TIMEOUT_MS must be less than WORKER_STALE_CLAIM_MS",
      ROWBOAT_TIMEOUT_MS,
      STALE_CLAIM_MS
    })
  );
  process.exit(2);
}

const WORKER_ID = `${process.env.HOSTNAME || "worker"}#${process.pid}`;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function intEnv(name, def) {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function log(level, event, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      worker: WORKER_ID,
      ...data
    })
  );
  shipSystemLog(level, event, data);
}

// undici buries the actionable failure reason (ETIMEDOUT, ENOTFOUND,
// ECONNRESET, ...) inside error.cause and reports only "TypeError: fetch
// failed" — and supabase-js then flattens the thrown error into a message
// STRING, dropping the cause entirely. Wrap fetch so the cause codes are
// appended to the message before supabase-js flattens it; every supabase
// error downstream becomes diagnosable ("fetch failed (ETIMEDOUT)").
function describeCauseChain(err) {
  const parts = [];
  let cur = err?.cause;
  for (let depth = 0; cur && depth < 5; depth++) {
    // AggregateError (e.g. happy-eyeballs multi-address ECONNREFUSED) carries
    // its members in .errors rather than .cause.
    for (const e of Array.isArray(cur.errors) ? cur.errors : [cur]) {
      const part = e?.code || e?.message;
      if (part && !parts.includes(String(part))) parts.push(String(part));
    }
    cur = cur.cause;
  }
  return parts.join(", ");
}

async function fetchWithCauseInMessage(...args) {
  try {
    return await fetch(...args);
  } catch (err) {
    const cause = describeCauseChain(err);
    if (cause && err instanceof Error) {
      const wrapped = new TypeError(`${err.message} (${cause})`, {
        cause: err.cause
      });
      wrapped.stack = err.stack;
      throw wrapped;
    }
    throw err;
  }
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  global: { fetch: fetchWithCauseInMessage }
});

// Mirror every structured log line into the platform's system_logs table so
// the admin business page (and debug/system-logs.ts) can show this tenant's
// Rowboat/Ollama/Gemini failures without SSH-ing into the VPS. Fire-and-forget:
// a logging insert must never block or fail the job path, and console output
// (docker logs) remains the complete source of truth if Supabase is down.
// "fatal" maps onto error — the table's level enum is debug|info|warn|error.
function shipSystemLog(level, event, data = {}) {
  const dbLevel =
    level === "fatal" ? "error" : ["debug", "info", "warn", "error"].includes(level) ? level : "info";
  const { error: errMsg, reason, ...rest } = data;
  const message = [errMsg, reason].filter(Boolean).join(", ");
  sb.from("system_logs")
    .insert({
      business_id: BUSINESS_ID,
      source: "chat_worker",
      level: dbLevel,
      event,
      message: (message || event).slice(0, 4000),
      payload: { worker: WORKER_ID, ...rest }
    })
    .then(({ error }) => {
      if (error) {
        // console only — recursing into log() would loop on persistent failure.
        console.error(
          JSON.stringify({ level: "warn", event: "system_log_ship_failed", error: error.message })
        );
      }
    })
    .catch((e) => {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "system_log_ship_failed",
          error: e?.message || String(e)
        })
      );
    });
}

// ---------------------------------------------------------------------------
// Transient-failure handling for the queue RPCs (claim + stale-reclaim).
//
// These RPCs run on every 30s sweep, so a one-off VPS→Supabase network blip
// (DNS hiccup, connection reset, socket timeout — undici's "fetch failed")
// is harmless by design: nothing is lost, the next sweep retries (reliability
// contract at the top of this file). But logging every blip at `error` put a
// red "reclaim_failed — TypeError: fetch failed" row in the admin System
// Errors feed each time any tenant box hiccupped. Treatment:
//   * a transient failure gets ONE inline retry after QUEUE_RPC_RETRY_MS
//     (sweep RPCs only — claims are re-driven by Realtime / the next sweep);
//   * a failure that survives the retry logs `warn` (`<event>_transient`)
//     until QUEUE_RPC_ERROR_AFTER consecutive failures of that RPC (~90s of
//     sustained connectivity loss at the 30s sweep) — then it escalates to
//     `error` under the original event name so existing alerting still fires;
//   * non-transient failures keep their original level immediately (a
//     missing RPC or auth failure is a real defect, not network weather).
// ---------------------------------------------------------------------------

const QUEUE_RPC_RETRY_MS = 2000;
const QUEUE_RPC_ERROR_AFTER = 3;

const TRANSIENT_RPC_ERROR_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR|socket hang up|network|abort/i;

function isTransientRpcError(message) {
  return TRANSIENT_RPC_ERROR_RE.test(String(message || ""));
}

const consecutiveTransientRpcFailures = new Map();

function logQueueRpcFailure(event, errorMessage, { nonTransientLevel = "error" } = {}) {
  if (!isTransientRpcError(errorMessage)) {
    consecutiveTransientRpcFailures.delete(event);
    log(nonTransientLevel, event, { error: errorMessage });
    return;
  }
  const n = (consecutiveTransientRpcFailures.get(event) || 0) + 1;
  consecutiveTransientRpcFailures.set(event, n);
  if (n >= QUEUE_RPC_ERROR_AFTER) {
    log("error", event, { error: errorMessage, consecutiveFailures: n });
  } else {
    log("warn", `${event}_transient`, { error: errorMessage, consecutiveFailures: n });
  }
}

function clearQueueRpcFailure(event) {
  consecutiveTransientRpcFailures.delete(event);
}

// Sweep RPCs get one inline retry on a transient failure: most blips are
// sub-second, so a single spaced retry inside the same sweep absorbs them
// without waiting a full SWEEP_INTERVAL_MS.
async function rpcWithTransientRetry(fn, params) {
  let res = await sb.rpc(fn, params);
  if (res.error && isTransientRpcError(res.error.message)) {
    await sleep(QUEUE_RPC_RETRY_MS);
    res = await sb.rpc(fn, params);
  }
  return res;
}

async function claimNextJob() {
  const { data, error } = await sb.rpc("claim_chat_job", {
    p_worker_id: WORKER_ID,
    p_business_id: BUSINESS_ID
  });
  if (error) {
    logQueueRpcFailure("claim_failed", error.message);
    return null;
  }
  clearQueueRpcFailure("claim_failed");
  return data && data.length > 0 ? data[0] : null;
}

// Optional opts.startAgent: dashboard jobs pass OwnerCoworker on fresh
// threads and stateless retries (owner memory tool). SMS uses default
// workflow startAgent Coworker only.
async function callRowboat(messages, conversationId, state, opts = {}) {
  const url = `${ROWBOAT_BASE_URL}/api/v1/${ROWBOAT_PROJECT_ID}/chat`;
  const body = { messages, stream: false };
  if (opts.startAgent) body.startAgent = opts.startAgent;
  if (conversationId) body.conversationId = conversationId;
  // `state` is Rowboat's client-carried per-conversation tool/agent
  // state from the previous turn. Forwarding it lets Rowboat resume
  // multi-turn tool loops without re-asking. Null on fresh threads
  // and on stateless retries (those go without conversationId AND
  // without state by design).
  if (state !== null && state !== undefined) body.state = state;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ROWBOAT_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ROWBOAT_GATEWAY_TOKEN}`
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
    } catch (e) {
      // AbortError (timeout) and connection-reset/refused all get the same
      // 'rowboat_network' classification — same retry treatment.
      const reason = ctl.signal.aborted ? "timeout" : (e?.message || "fetch failed");
      throw new Error(`rowboat_network:${reason}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`rowboat_http_${res.status}:${text.slice(0, 200)}`);
    }
    let parsed;
    try {
      parsed = await res.json();
    } catch (e) {
      throw new Error("rowboat_invalid_json:" + (e?.message || "parse failed"));
    }
    const turn = parsed?.turn;
    const out = Array.isArray(turn?.output) ? turn.output : [];
    const assistant = out.find(
      (m) => m && m.role === "assistant" && typeof m.content === "string" && m.content.length > 0
    );
    if (!assistant) {
      throw new Error("rowboat_empty_assistant:no assistant content in turn.output");
    }
    // Rowboat may omit `state` entirely on turns that didn't run a
    // tool / change agent state. We distinguish "key absent"
    // (preserve whatever we had) from "key present and null"
    // (clear it) the same way src/lib/rowboat/chat.ts does — by
    // checking own-property presence on the parsed object.
    const stateKey =
      parsed !== null &&
      typeof parsed === "object" &&
      Object.prototype.hasOwnProperty.call(parsed, "state");
    return {
      content: assistant.content,
      conversationId:
        typeof parsed?.conversationId === "string" ? parsed.conversationId : null,
      state: stateKey ? parsed.state : undefined
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Monthly quota windows within a (possibly multi-month) Stripe billing period.
// 12/24-month plans are charged in full at checkout, so the Stripe period can
// span the whole prepaid term while included usage still resets MONTHLY.
// INLINE COPY of supabase/functions/_shared/billing_period_window.ts — keep in
// lockstep (this worker builds/deploys from its own directory).
// ---------------------------------------------------------------------------
function addUtcMonthsClamped(base, months) {
  const totalMonths = base.getUTCMonth() + months;
  const year = base.getUTCFullYear() + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(base.getUTCDate(), daysInTarget);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
}

// Window 0 echoes the input string verbatim so existing monthly tenants'
// spend keys are bit-for-bit unchanged (period_start is an equality key).
function deriveMonthlyQuotaWindowStart(periodStartIso, nowMs) {
  const start = new Date(periodStartIso);
  if (!Number.isFinite(start.getTime())) return periodStartIso;

  let n = 0;
  if (nowMs > start.getTime()) {
    const now = new Date(nowMs);
    // The month-diff estimate can only overshoot around clamped month ends;
    // settle downward onto the invariant window[n] <= now < window[n+1].
    n =
      (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - start.getUTCMonth());
    while (n > 0 && addUtcMonthsClamped(start, n).getTime() > nowMs) n--;
  }
  return n === 0 ? periodStartIso : addUtcMonthsClamped(start, n).toISOString();
}

// Billing-period key for owner-chat spend: the current month-window within the
// subscription's Stripe period (multi-month prepaid terms still reset the fuse
// monthly). Falls back to the start of the current UTC month when there's no
// subscription row. Never throws.
async function resolveOwnerChatPeriodStart() {
  try {
    const { data } = await sb
      .from("subscriptions")
      .select("stripe_current_period_start")
      .eq("business_id", BUSINESS_ID)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.stripe_current_period_start) {
      return deriveMonthlyQuotaWindowStart(data.stripe_current_period_start, Date.now());
    }
  } catch {
    // fall through to month-start
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Tier-derived shared spend cap base ($5 starter / $10 otherwise). Tier rarely
// changes for a tenant (only on a plan change, which re-provisions), so we read
// `businesses.tier` once and cache it. A read blip falls back to the standard
// base, never minting extra headroom for a starter tenant beyond one process
// lifetime.
let cachedTierCapMicros = null;
async function resolveTierCapMicros() {
  if (cachedTierCapMicros !== null) return cachedTierCapMicros;
  try {
    const { data } = await sb
      .from("businesses")
      .select("tier")
      .eq("id", BUSINESS_ID)
      .maybeSingle();
    const tier = typeof data?.tier === "string" ? data.tier : null;
    cachedTierCapMicros =
      tier === "starter" ? OWNER_CHAT_SPEND_CAP_MICROS_STARTER : OWNER_CHAT_SPEND_CAP_MICROS;
  } catch {
    // Don't cache a fallback: a transient read failure shouldn't pin the cap
    // for the process lifetime; retry on the next turn.
    return OWNER_CHAT_SPEND_CAP_MICROS;
  }
  return cachedTierCapMicros;
}

// Current period spend (micro-USD) for this tenant. Throws on a hard read
// error so the caller can fail open. 0 when no row exists yet.
async function readOwnerChatSpendMicros(periodStart) {
  const { data, error } = await sb
    .from("owner_chat_model_spend")
    .select("spend_micros")
    .eq("business_id", BUSINESS_ID)
    .eq("period_start", periodStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Number(data?.spend_micros ?? 0);
}

// Purchased Gemini spend credit currently active for this tenant (micro-USD,
// chat_spend_credit_grants). Credit RAISES the period cap: effective cap =
// base + credits. Returns 0 on any failure so a read blip can never mint
// free headroom beyond the base cap.
async function readActiveChatCreditMicros() {
  try {
    const { data, error } = await sb.rpc("chat_active_credit_micros", {
      p_business_id: BUSINESS_ID
    });
    if (error) return 0;
    const n = Number(data ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// Resolve the spend-cap decision for the turn about to run: the billing-period
// key + whether the tenant is already at/over the cap. Never throws — on any
// read failure it returns overCap=false (fail open to the Gemini agent), and
// returns the period it resolved so the post-turn metering can reuse it.
// The cap compared against is `base + active purchased credit`, so a Gemini
// pack purchase immediately restores cloud-model replies mid-period.
async function resolveOwnerChatCap() {
  if (!OWNER_CHAT_SPEND_METERING_ENABLED) return { periodStart: null, overCap: false };
  try {
    const periodStart = await resolveOwnerChatPeriodStart();
    const spent = await readOwnerChatSpendMicros(periodStart);
    const baseCap = await resolveTierCapMicros();
    const effectiveCap = baseCap + (await readActiveChatCreditMicros());
    return { periodStart, overCap: spent >= effectiveCap };
  } catch (err) {
    log("warn", "owner_chat_cap_read_failed", { error: err?.message || String(err) });
    return { periodStart: null, overCap: false };
  }
}

// NOTE: owner-chat spend is no longer metered here. Exact billed tokens are
// recorded by the llm-router sidecar (the only component that sees Gemini's
// real `usage`), which POSTs them to /api/internal/meter-gemini-spend →
// owner_chat_model_spend. The fuse-tripped owner alert moved there too
// (src/lib/billing/ai-spend-meter.ts via _shared/cap_alerts.ts). This worker
// only READS that spend (resolveOwnerChatCap, above) to route Gemini→local.

// Fire-and-forget callback to Vercel after a job successfully
// persists an assistant message. The endpoint runs shouldSummarize +
// summarizeThread internally; we don't care about its return value.
// Bounded by SUMMARIZE_CALLBACK_TIMEOUT_MS so a hung Vercel can't
// keep a socket open. Errors are logged at warn (not failure) — the
// next turn's callback re-evaluates shouldSummarize, so a missed
// callback self-heals.
async function notifyVercelSummarize(businessId, threadId) {
  if (!VERCEL_BASE_URL || !VERCEL_BEARER) {
    // Worker is deployed without summarizer plumbing — nothing to do.
    return;
  }
  const url = `${VERCEL_BASE_URL}/api/internal/dashboard-chat-summarize`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SUMMARIZE_CALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VERCEL_BEARER}`
      },
      body: JSON.stringify({ businessId, threadId }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log("warn", "summarize_callback_non_2xx", {
        threadId,
        status: res.status,
        detail: detail.slice(0, 200)
      });
    }
  } catch (err) {
    const reason = ctl.signal.aborted ? "timeout" : err?.message || "fetch failed";
    log("warn", "summarize_callback_failed", { threadId, reason });
  } finally {
    clearTimeout(timer);
  }
}

// Extraction is READ-ONLY (just a local Ollama classification of the owner's
// latest message) so it's safe to kick off concurrently with the Rowboat
// reply. The actual PERSISTENCE (persistOwnerRule) is deliberately split out
// and only invoked on the SUCCESS path — see processJob — so a turn that
// later errors (Rowboat failure, empty assistant, message-insert failure)
// never writes to memory_md without a corresponding reply + confirmation, and
// a reclaimed/retried job doesn't double-write the same rule. NEVER throws.
async function startOwnerRuleExtraction(job, assistantReply, existingBullets) {
  const noop = { save: false, bullets: [] };
  if (!MEMORY_CAPTURE_ENABLED || !OWNER_APPEND_URL) return noop;

  const ownerMessage = extractLatestOwnerMessage(job.input_messages);
  if (!ownerMessage) return noop;

  return extractOwnerRule({
    ownerMessage,
    // The dashboard reply both signals intent ("…applied to your memory") and
    // restates values cleanly — feed it in so the extractor catches durable
    // facts the owner stated and recovers exact numbers/names.
    assistantReply,
    // Already-saved bullets so the model only emits NEW items (the adapter
    // dedupes authoritatively too, but this keeps the model from proposing
    // re-phrased duplicates in the first place).
    existingBullets,
    // Upstream is picked from the model name inside extractOwnerRule: gemini-*
    // ⇒ Google direct (geminiBaseUrl + geminiApiKey), else ⇒ ollamaBaseUrl.
    model: MEMORY_CAPTURE_MODEL,
    ollamaBaseUrl: OLLAMA_BASE_URL,
    geminiBaseUrl: MEMORY_CAPTURE_GEMINI_BASE_URL,
    geminiApiKey: GOOGLE_API_KEY,
    fetchImpl: fetch,
    timeoutMs: MEMORY_CAPTURE_TIMEOUT_MS,
    logger: log
  });
}

// Read the tenant's current saved memory bullets so the extractor can avoid
// re-proposing them. Best-effort: a failed read just means the model isn't
// told about existing items (the adapter still dedupes on write). NEVER throws.
async function loadExistingBullets(businessId) {
  try {
    const { data, error } = await sb
      .from("business_configs")
      .select("memory_md")
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      log("warn", "memory_read_failed", { businessId, error: error.message });
      return [];
    }
    return extractExistingBullets(data?.memory_md || "");
  } catch (err) {
    log("warn", "memory_read_failed", { businessId, error: err?.message || String(err) });
    return [];
  }
}

// Persist extracted rule bullets via the platform owner-append adapter.
// Returns the bullets actually saved (so the caller renders an honest
// confirmation), or null when nothing was saved / the save failed. NEVER
// throws. Only called once a turn has produced a real assistant reply.
async function persistOwnerRule(job, bullets) {
  // Bound the payload to the adapter's hard char limit so a large extraction
  // saves the rules that fit instead of failing the whole POST with a 400.
  const fitted = fitBulletsToPayload(bullets);
  if (fitted.length === 0) return null;

  // Adapter envelope mirrors voiceToolEnvelopeSchema: { businessId, args }
  // with NO callerE164 — the adapter rejects any envelope carrying a caller as
  // a non-owner attempt. bullets are joined one-per-line, which is what
  // owner-append-business-memory parses into memory_md.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MEMORY_CAPTURE_CALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(OWNER_APPEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ROWBOAT_GATEWAY_TOKEN}`
      },
      body: JSON.stringify({
        businessId: BUSINESS_ID,
        args: { bullets: fitted.join("\n") }
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log("warn", "memory_save_non_2xx", {
        jobId: job.id,
        status: res.status,
        detail: detail.slice(0, 200)
      });
      return null;
    }
    // The adapter dedupes against existing memory_md and returns the lines it
    // ACTUALLY appended (savedBullets). Confirm only those so we never tell the
    // owner we saved something that was already there. Fall back to `fitted`
    // for an older adapter that predates savedBullets but reported appended.
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (body && body.ok === false) {
      log("warn", "memory_save_rejected", { jobId: job.id, detail: body.detail || "" });
      return null;
    }
    const saved = Array.isArray(body?.data?.savedBullets)
      ? body.data.savedBullets
      : body?.data?.appended
        ? fitted
        : [];
    if (saved.length === 0) {
      log("info", "memory_no_new", { jobId: job.id });
      return null;
    }
    log("info", "memory_saved", { jobId: job.id, count: saved.length });
    return saved;
  } catch (err) {
    const reason = ctl.signal.aborted ? "timeout" : err?.message || "fetch failed";
    log("warn", "memory_save_failed", { jobId: job.id, reason });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// === Background owner-rule extraction queue ===
//
// Memory capture is a CPU-bound local-qwen classification (~tens of seconds,
// and it can hit its own timeout) that must be COMPLETELY DECOUPLED from job
// processing: processJob() enqueues a task and returns immediately, so
// processLoop() never waits on extraction before claiming the next job, and a
// back-to-back owner message is never stuck behind a prior turn's tail. The
// queue drains SEQUENTIALLY (concurrency 1) so overlapping extractions can't
// thrash the single local Ollama.
//
// Capture is silent and best-effort: it persists durable rules to business
// memory in the background and edits nothing the owner sees — no reply is
// updated, no confirmation is appended. A task that fails/throws is logged and
// dropped (the job is already 'done' and the spend already metered); tasks
// still queued when the worker is told to shut down are abandoned, which is an
// acceptable loss for capture (the owner can simply restate the rule).
const extractionQueue = [];
let extractionDraining = false;

function enqueueOwnerRuleExtraction(job, assistantReply) {
  // Mirror startOwnerRuleExtraction's own guard so we don't queue no-op work
  // (and don't grow the queue) when capture is disabled or unconfigured.
  if (!MEMORY_CAPTURE_ENABLED || !OWNER_APPEND_URL) return;
  extractionQueue.push({ job, assistantReply });
  // Fire-and-forget: kick the drainer if it isn't already running. drainer is
  // self-guarded against concurrent runs, so multiple enqueues collapse into
  // one sequential drain.
  void drainExtractionQueue();
}

async function drainExtractionQueue() {
  if (extractionDraining) return;
  extractionDraining = true;
  try {
    while (extractionQueue.length > 0) {
      const task = extractionQueue.shift();
      await runOwnerRuleExtraction(task);
    }
  } finally {
    extractionDraining = false;
  }
}

// Settings → Coworker tools: the owner can disable automatic business-memory
// capture (dashboard / memory_capture, default ON). The owner-append adapter
// enforces this authoritatively on every write; this pre-check just avoids
// burning a Gemini/Ollama extraction call on a turn whose save would be
// rejected anyway. Fail-open on any read error (capture defaults ON).
async function isMemoryCaptureToolEnabled() {
  try {
    const { data, error } = await sb
      .from("agent_tool_settings")
      .select("enabled")
      .eq("business_id", BUSINESS_ID)
      .eq("agent_key", "dashboard")
      .eq("tool_key", "memory_capture")
      .maybeSingle();
    if (error) {
      log("warn", "memory_capture_setting_read_failed", { error: error.message });
      return true;
    }
    return data && typeof data.enabled === "boolean" ? data.enabled : true;
  } catch (err) {
    log("warn", "memory_capture_setting_read_failed", { error: err?.message || String(err) });
    return true;
  }
}

async function runOwnerRuleExtraction({ job, assistantReply }) {
  try {
    if (!(await isMemoryCaptureToolEnabled())) {
      log("info", "memory_capture_tool_disabled", { jobId: job.id });
      return;
    }
    const existingBullets = await loadExistingBullets(job.business_id);
    const extraction = await startOwnerRuleExtraction(job, assistantReply, existingBullets);
    if (extraction.save && extraction.bullets.length > 0) {
      // persistOwnerRule logs its own memory_saved / memory_no_new outcome.
      await persistOwnerRule(job, extraction.bullets);
    }
  } catch (err) {
    log("warn", "memory_capture_unexpected", {
      jobId: job.id,
      error: err?.message || String(err)
    });
  }
}

// Transient error codes worth a single immediate retry of the (stateless)
// owner turn. Mirrors STATELESS_RETRY_ERRORS in the pre-Option-B streaming
// route (src/lib/rowboat/chat.ts pre-PR-#79):
//   * HTTP 4xx that suggest the conversationId was rejected (400 bad
//     request / 404 not found / 408 timeout / 409 conflict / 422
//     unprocessable). Retrying stateless without the bad id may work.
//   * HTTP 5xx where Rowboat itself was sad (500/502/503/504/522/524).
//     Often transient; a fresh stateless call dodges any in-memory
//     conversation state corruption on Rowboat's side.
//   * `rowboat_empty_assistant`: Rowboat returned a turn with no
//     assistant content. Sometimes this happens when the conversation
//     state is wedged and the agent gets stuck on a tool loop; the
//     retry without the conversationId starts fresh.
//   * `rowboat_invalid_json` and `rowboat_network`: I/O failures, where
//     "did the server even get our request" is unknowable. A retry is
//     idempotent from our side (we never persist anything until we
//     have a successful response).
function isRetryableErrorCode(code) {
  if (!code) return false;
  if (code === "rowboat_empty_assistant") return true;
  if (code === "rowboat_invalid_json") return true;
  if (code === "rowboat_network") return true;
  const m = /^rowboat_http_(\d{3})$/.exec(code);
  if (!m) return false;
  const status = Number(m[1]);
  // 401/403 (auth) deliberately excluded — those will fail identically
  // on retry; we'd just be doubling the 4xx rate against Rowboat.
  if (status === 400 || status === 404 || status === 408 || status === 409 || status === 422) {
    return true;
  }
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function processJob(job) {
  const t0 = Date.now();
  log("info", "process_start", {
    jobId: job.id,
    threadId: job.thread_id,
    attempts: job.attempts
  });

  // Hard retry cap: after MAX_ATTEMPTS claims we stop trying and mark the
  // job permanently errored. Without this, a job that always fails (bad
  // input, broken Rowboat) would burn CPU forever.
  if (job.attempts > MAX_ATTEMPTS) {
    log("error", "max_attempts_exceeded", { jobId: job.id, attempts: job.attempts });
    await sb
      .from("dashboard_chat_jobs")
      .update({
        status: "error",
        error_code: "max_attempts_exceeded",
        error_detail: `Job exceeded ${MAX_ATTEMPTS} attempts without success.`,
        completed_at: new Date().toISOString()
      })
      .eq("id", job.id);
    return;
  }

  try {
    // input_messages is non-null for every job inserted by the
    // post-PR-#79 route (which always pre-builds the full Rowboat
    // input). A null here means a regression in the route or a row
    // hand-injected for testing — fail fast rather than silently
    // dropping the user's prompt onto a blank thread, and avoid
    // the prior loadHistoryFallback() path that re-read raw rows
    // from dashboard_chat_messages and forwarded role:"assistant"
    // entries to Rowboat (which /chat rejects with a 400).
    if (!Array.isArray(job.input_messages) || job.input_messages.length === 0) {
      throw new Error("input_empty:no messages to send to rowboat");
    }
    const primaryMessages = job.input_messages;
    const fallbackMessages = Array.isArray(job.stateless_input_messages)
      ? job.stateless_input_messages
      : null;

    // === Owner-turn agent routing — ALWAYS forced, ALWAYS stateless ===
    //
    // Spend-cap routing is decided HERE, authoritatively, from LIVE period
    // spend at claim time (not at enqueue): a burst of jobs queued before the
    // fuse tripped still downgrade once it has, and the cap lives in exactly
    // one place (this worker + the RPC). Fails open to the Gemini agent on a
    // read error (quality over fuse on a transient DB blip).
    const { overCap } = await resolveOwnerChatCap();

    // No-local-model hosts (kvm1: deploy-client.sh writes
    // CHAT_WORKER_OWNER_LOCAL_AGENT="") have nothing to downgrade to when
    // the fuse trips. Silently staying on Gemini would defeat the fuse
    // (unbounded spend), so REFUSE the turn with an honest reply. The reply
    // is stored like any assistant message and the job completes normally;
    // the owner can buy a Gemini credit pack (billing page) or wait for the
    // period reset — both paths un-trip the fuse automatically.
    if (overCap && !OWNER_CHAT_LOCAL_AGENT) {
      log("warn", "owner_turn_refused_over_cap", { jobId: job.id });
      const refusal =
        "Your coworker's monthly AI budget is used up, so replies are paused. " +
        "They resume automatically when your billing period resets, or add a " +
        "Gemini credit pack from the Billing page to keep chatting now.";
      const { data: refusalMsg, error: refusalInsertErr } = await sb
        .from("dashboard_chat_messages")
        .insert({ thread_id: job.thread_id, role: "assistant", content: refusal })
        .select("id")
        .single();
      if (refusalInsertErr) {
        throw new Error(`message_insert_failed:${refusalInsertErr.message}`);
      }
      const { error: refusalThreadErr } = await sb
        .from("dashboard_chat_threads")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", job.thread_id);
      if (refusalThreadErr) {
        log("warn", "thread_update_failed", { error: refusalThreadErr.message });
      }
      const { error: refusalJobErr } = await sb
        .from("dashboard_chat_jobs")
        .update({
          status: "done",
          assistant_message_id: refusalMsg.id,
          completed_at: new Date().toISOString()
        })
        .eq("id", job.id);
      if (refusalJobErr) {
        log("error", "job_update_failed", { jobId: job.id, error: refusalJobErr.message });
      }
      log("info", "process_done", { jobId: job.id, ms: Date.now() - t0, refused: true });
      return;
    }

    const jobStartAgent =
      overCap && OWNER_CHAT_LOCAL_AGENT ? OWNER_CHAT_LOCAL_AGENT : OWNER_START_AGENT;
    const jobStartAgentOpts = jobStartAgent ? { startAgent: jobStartAgent } : {};

    // Why every owner turn runs stateless with an EXPLICIT startAgent and NEVER
    // resumes a stored conversationId:
    //
    //   Rowboat IGNORES startAgent whenever a conversationId is supplied — it
    //   resumes the agent the conversation was first BOUND to. Owner threads
    //   created via the SMS/workflow default (or before OwnerCoworker existed)
    //   are bound to the local-qwen `Coworker` agent. Resuming them ran EVERY
    //   owner turn on the CPU-only model (~100s+ prefill) and never reached
    //   Gemini, while the meter still billed the turn as Gemini. (Observed
    //   live, June 2026: a continued owner thread answered via agentName
    //   "Coworker" in ~103s — exactly the latency this Gemini migration was
    //   meant to eliminate.)
    //
    // So we never resume. Each owner turn is a fresh Rowboat call with an
    // explicit startAgent (OwnerCoworker = Gemini under cap; OwnerCoworkerLocal
    // over cap) and no conversationId/state. The enqueue route replays the
    // rolling summary + recent tail in input_messages every turn, so dropping
    // Rowboat's server-side state loses no conversational context. The fuller
    // stateless tail (stateless_input_messages) is preferred when present.
    const turnMessages = fallbackMessages ?? primaryMessages;
    let result;
    try {
      result = await callRowboat(turnMessages, null, null, jobStartAgentOpts);
    } catch (err) {
      const code = String(err?.message || "").split(":")[0];
      // Non-retryable (auth, malformed input, etc.) — surface it so the outer
      // catch marks the job 'error'.
      if (!isRetryableErrorCode(code)) throw err;
      // Transient Rowboat 5xx / I/O blip. Both attempts are identical stateless
      // calls (there is no conversationId to vary), so a single retry simply
      // re-issues the request — enough to ride out a transient failure without
      // failing the owner's turn.
      log("warn", "owner_turn_retry", {
        jobId: job.id,
        code,
        detail: String(err?.message || "").slice(0, 200)
      });
      result = await callRowboat(turnMessages, null, null, jobStartAgentOpts);
    }
    const { content, conversationId, state: nextState } = result;
    // We always ran the forced agent (no resume), so metering against
    // jobStartAgent is exact: Gemini turns meter, local (capped) turns are $0.
    const usedAgent = jobStartAgent;

    // === Dashboard email tool ===
    // The enqueue route teaches the model an EMAIL_SEND sentinel-block
    // protocol when the owner enabled Settings → Coworker tools → Send
    // email. Extract any blocks from the reply, send them via the platform
    // adapter (which re-checks the toggle authoritatively), strip the raw
    // blocks, and append HONEST per-email delivery results. Runs BEFORE the
    // reply insert so the stored message is the cleaned reply + outcomes —
    // the owner never sees raw protocol JSON or an unconfirmed "sent" claim.
    // fulfillEmailSends never throws; a reply without blocks passes through
    // untouched.
    const emailOutcome = await fulfillEmailSends({
      content,
      url: EMAIL_TOOL_URL,
      bearer: ROWBOAT_GATEWAY_TOKEN,
      businessId: BUSINESS_ID,
      timeoutMs: EMAIL_TOOL_TIMEOUT_MS,
      logger: (level, event, data) => log(level, event, { jobId: job.id, ...data })
    });
    const finalContent = emailOutcome.content;

    // Insert the assistant reply FIRST. Owner-rule persistence happens only
    // AFTER this succeeds (below), so a turn whose reply insert fails never
    // writes to memory_md, and a reclaimed/retried job can't persist a rule
    // against a reply that was never stored. Bugbot Medium-severity finding
    // on PR #94.
    const { data: msg, error: insertErr } = await sb
      .from("dashboard_chat_messages")
      .insert({ thread_id: job.thread_id, role: "assistant", content: finalContent })
      .select("id")
      .single();
    if (insertErr) {
      throw new Error(`message_insert_failed:${insertErr.message}`);
    }

    // Reply is durably stored. Model spend for this (Gemini) turn is metered
    // exactly by the llm-router sidecar → /api/internal/meter-gemini-spend, not
    // here (a chars/4 estimate on top of that would double-count the turn).

    // Persist whatever Rowboat returned this turn. We never RESUME this id —
    // every owner turn is stateless-forced above — so it is NOT used to
    // continue a Rowboat conversation. It functions only as the enqueue route's
    // "this thread has prior Rowboat history" marker, which makes the route
    // replay the FULL history tail (stateless_input_messages) on later turns
    // instead of the bounded short tail.
    //
    // The marker must be STICKY: only refresh it when Rowboat actually returned
    // a value, NEVER clear it on a successful turn. A stateless call usually
    // mints a fresh conversationId, but if Rowboat omits one, overwriting with
    // null would wipe the marker and make the route fall back to the short tail
    // next turn (Bugbot Medium-severity finding on PR #106). Since the id is
    // only a has-history flag now, keeping any prior non-null value is correct.
    const threadUpdate = { updated_at: new Date().toISOString() };
    if (conversationId) {
      threadUpdate.rowboat_conversation_id = conversationId;
    }
    if (nextState !== undefined) {
      threadUpdate.rowboat_state = nextState;
    }
    const { error: tErr } = await sb
      .from("dashboard_chat_threads")
      .update(threadUpdate)
      .eq("id", job.thread_id);
    if (tErr) log("warn", "thread_update_failed", { error: tErr.message });

    // Mark the job DONE now — as soon as the reply is durably stored, metered,
    // and the thread updated — and BEFORE owner-rule extraction below.
    // Extraction is a second, CPU-bound local-Ollama (qwen) classification that
    // can take tens of seconds (and hits its own timeout). It used to run
    // before this status flip, so the dashboard "thinking…" indicator (which
    // clears on status='done' / the reply INSERT) stayed up for the WHOLE
    // extraction even though the Gemini reply was ready in ~seconds. Flipping
    // to 'done' here lets the owner see the reply immediately; extraction is a
    // best-effort post-step that runs after (see below).
    const { error: jobErr } = await sb
      .from("dashboard_chat_jobs")
      .update({
        status: "done",
        assistant_message_id: msg.id,
        completed_at: new Date().toISOString()
      })
      .eq("id", job.id);
    if (jobErr) {
      // The assistant message is already persisted (the user will see it).
      // We DON'T return here: best-effort owner-rule extraction is still
      // enqueued below, and we deliberately fall through rather than skip it.
      // The job row stays 'processing', so the reclaimer re-runs the turn and
      // capture is retried (and deduped against existing bullets) even if this
      // pass is cut short — a failed status flip never silently drops rule
      // capture (Bugbot finding on PR #106). The success-only bookkeeping below
      // (keep-warm touch, summary trigger, done log) is skipped on this path.
      log("error", "job_update_failed", { jobId: job.id, error: jobErr.message });
    } else {
      // Refresh dashboard_chat_activity so the VPS keep-warm timer
      // resets at the END of the turn (not just at the start). The
      // pre-Option-B route had two touches per turn; only the pre-
      // enqueue one survives in the route, so without this the
      // keep-warm script would consider the tenant idle the moment
      // the route returned even though the worker was still
      // generating. Bugbot Medium-severity finding on PR #79 round-2.
      //
      // Upsert: if no row exists yet (first ever turn for this
      // tenant), insert it; otherwise overwrite the timestamps.
      // Errors here are non-fatal — keep-warm is an optimization,
      // not a correctness requirement.
      const nowIso = new Date().toISOString();
      const { error: aErr } = await sb
        .from("dashboard_chat_activity")
        .upsert(
          {
            business_id: job.business_id,
            last_user_chat_at: nowIso,
            updated_at: nowIso
          },
          { onConflict: "business_id" }
        );
      if (aErr) {
        log("warn", "activity_touch_failed", {
          jobId: job.id,
          error: aErr.message
        });
      }

      // Fire-and-forget rolling-summary trigger. The route used to do
      // this synchronously after streaming, but in the Option B
      // pipeline the route returns BEFORE the assistant turn is
      // persisted — firing from the worker is the only place that
      // sees both turns. We DON'T await: the job is already 'done'
      // from the user's perspective, and the next turn's callback
      // self-heals if this one is dropped.
      void notifyVercelSummarize(job.business_id, job.thread_id);

      log("info", "process_done", {
        jobId: job.id,
        msgId: msg.id,
        durationMs: Date.now() - t0,
        contentLen: content.length,
        conversationId,
        agent: usedAgent
      });
    }

    // === Owner-rule extraction — fully DECOUPLED background work ===
    //
    // Hand capture off to the background queue and return immediately. This is
    // intentionally NOT awaited: processLoop() claims the next job the moment
    // processJob() returns, so a back-to-back owner message is never stuck
    // behind the prior turn's CPU-bound (~tens of seconds) extraction. Capture
    // runs invisibly — no message is edited, the owner never waits for it and
    // never sees it — it just silently persists durable rules to business
    // memory in the background (see runOwnerRuleExtraction / the queue).
    // Uses the CLEANED reply so raw EMAIL_SEND protocol JSON never feeds the
    // rule extractor.
    enqueueOwnerRuleExtraction(job, finalContent);
  } catch (err) {
    const msg = String(err?.message || "unknown_error");
    const code = msg.split(":")[0];
    // Transient upstream failure with retry budget left → re-queue instead of
    // dead-ending the owner's turn. claim_chat_job bumps `attempts` on every
    // claim and the top of this function enforces MAX_ATTEMPTS, so this can't
    // loop forever. Strictly `<` so the LAST attempt's failure keeps its real
    // error code instead of burning one more claim to die as
    // max_attempts_exceeded. Idempotent from our side: nothing is persisted
    // until a successful Rowboat response, so re-running the same
    // input_messages is safe. The UI keeps showing the thinking indicator
    // ('queued' is in-flight), which beats a dead turn the owner must retype.
    if (isRetryableErrorCode(code) && job.attempts < MAX_ATTEMPTS) {
      log("warn", "owner_turn_requeued", {
        jobId: job.id,
        attempts: job.attempts,
        code,
        durationMs: Date.now() - t0
      });
      // The backoff deliberately blocks this worker's drain pass — one tenant
      // per box, and a Rowboat that just 500'd twice needs breathing room
      // more than the queue needs throughput.
      await sleep(REQUEUE_BACKOFF_MS * job.attempts);
      const { error: requeueErr } = await sb
        .from("dashboard_chat_jobs")
        .update({
          status: "queued",
          claimed_by: null,
          claimed_at: null,
          error_code: code,
          error_detail: msg.slice(0, 500)
        })
        .eq("id", job.id);
      if (!requeueErr) return;
      // Fall through to the terminal write — better an honest error than a
      // job stuck 'processing' until the stale-claim sweep.
      log("error", "requeue_failed", { jobId: job.id, error: requeueErr.message });
    }
    log("error", "process_failed", {
      jobId: job.id,
      error: msg,
      durationMs: Date.now() - t0
    });
    await sb
      .from("dashboard_chat_jobs")
      .update({
        status: "error",
        error_code: code,
        error_detail: msg.slice(0, 500),
        completed_at: new Date().toISOString()
      })
      .eq("id", job.id);
  }
}

async function processLoop() {
  for (;;) {
    const job = await claimNextJob();
    if (!job) return;
    await processJob(job);
  }
}

// ===========================================================================
// Website chat widget queue (webchat_jobs) — the ANONYMOUS-VISITOR surface.
//
// Mirrors the owner-dashboard pipeline above (same claim/reclaim RPCs
// pattern, same always-stateless forced-startAgent turn, same retry
// taxonomy) with the surface-specific differences kept deliberately small:
//
//   * startAgent is WebchatCoworker (restricted tool surface: knowledge
//     lookup, lead capture, calendar only) — over-cap turns downgrade to
//     WebchatCoworkerLocal, exactly like the owner pair.
//   * NO owner-side fulfilment runs here: no fulfillEmailSends (the email
//     adapter must never be reachable from an anonymous surface), and no
//     owner-rule memory capture (visitor messages are untrusted input —
//     capturing them as business rules would let any visitor write to the
//     tenant's memory). Any EMAIL_SEND-style sentinel block a confused or
//     prompt-injected model emits is STRIPPED before the reply persists.
//   * The over-cap refusal is visitor-facing copy — a website visitor has
//     no business seeing the tenant's billing details.
// ===========================================================================

const WEBCHAT_OVER_CAP_REFUSAL =
  "Sorry, our chat assistant is temporarily unavailable. Please try again a bit later, or contact us directly and we'll be happy to help.";

// Deterministic fallback when stripping sentinel blocks leaves an empty
// reply (the whole generation was a hallucinated tool block).
const WEBCHAT_EMPTY_AFTER_STRIP_REPLY =
  "Sorry, I can't do that from this chat, but I'm happy to answer questions or take your contact details so the team can follow up.";

async function claimNextWebchatJob() {
  const { data, error } = await sb.rpc("claim_webchat_job", {
    p_worker_id: WORKER_ID,
    p_business_id: BUSINESS_ID
  });
  if (error) {
    // A missing RPC (platform migration not applied yet) is expected during
    // rollout ordering — log once per sweep at warn, never crash the drain.
    // Transient network failures escalate to error only when persistent.
    logQueueRpcFailure("webchat_claim_failed", error.message, {
      nonTransientLevel: "warn"
    });
    return null;
  }
  clearQueueRpcFailure("webchat_claim_failed");
  return data && data.length > 0 ? data[0] : null;
}

async function reclaimStaleWebchat() {
  const { data, error } = await rpcWithTransientRetry("reclaim_stale_webchat_jobs", {
    p_max_age_ms: STALE_CLAIM_MS
  });
  if (error) {
    // Same rollout-ordering tolerance as claimNextWebchatJob above.
    logQueueRpcFailure("webchat_reclaim_failed", error.message, {
      nonTransientLevel: "warn"
    });
    return 0;
  }
  clearQueueRpcFailure("webchat_reclaim_failed");
  const n = Array.isArray(data) ? data.length : 0;
  if (n > 0) {
    log("warn", "webchat_reclaimed_stale", { count: n, ids: data.map((j) => j.id) });
  }
  return n;
}

async function failWebchatJob(jobId, code, detail) {
  await sb
    .from("webchat_jobs")
    .update({
      status: "error",
      error_code: code,
      error_detail: String(detail || "").slice(0, 500),
      completed_at: new Date().toISOString()
    })
    .eq("id", jobId);
}

// Insert the assistant reply, update the session's sticky has-history
// marker, and flip the job to done. Shared by the happy path and the
// over-cap refusal path.
async function finishWebchatJob(job, content, conversationId, nextState) {
  const { data: msg, error: insertErr } = await sb
    .from("webchat_messages")
    .insert({
      session_id: job.session_id,
      business_id: job.business_id,
      role: "assistant",
      content
    })
    .select("id")
    .single();
  if (insertErr) {
    throw new Error(`message_insert_failed:${insertErr.message}`);
  }

  // Sticky continuation marker (same semantics as the owner path): we never
  // RESUME this id — every webchat turn is stateless-forced — it only tells
  // the enqueue route "this session has prior Rowboat history", flipping it
  // to the full-tail input variant. Only refresh when Rowboat returned one.
  const sessionUpdate = { last_seen_at: new Date().toISOString() };
  if (conversationId) sessionUpdate.rowboat_conversation_id = conversationId;
  if (nextState !== undefined) sessionUpdate.rowboat_state = nextState;
  const { error: sErr } = await sb
    .from("webchat_sessions")
    .update(sessionUpdate)
    .eq("id", job.session_id);
  if (sErr) log("warn", "webchat_session_update_failed", { error: sErr.message });

  const { error: jobErr } = await sb
    .from("webchat_jobs")
    .update({
      status: "done",
      assistant_message_id: msg.id,
      completed_at: new Date().toISOString()
    })
    .eq("id", job.id);
  if (jobErr) {
    // Reply already persisted (the visitor's poll will render it); the job
    // row stays 'processing' and the reclaimer retries the status flip via
    // a re-run — same acceptance as the owner path's job_update_failed.
    log("error", "webchat_job_update_failed", { jobId: job.id, error: jobErr.message });
  }
  return msg.id;
}

async function processWebchatJob(job) {
  const t0 = Date.now();
  log("info", "webchat_process_start", {
    jobId: job.id,
    sessionId: job.session_id,
    attempts: job.attempts
  });

  if (job.attempts > MAX_ATTEMPTS) {
    log("error", "webchat_max_attempts_exceeded", { jobId: job.id, attempts: job.attempts });
    await failWebchatJob(
      job.id,
      "max_attempts_exceeded",
      `Job exceeded ${MAX_ATTEMPTS} attempts without success.`
    );
    return;
  }

  try {
    if (!Array.isArray(job.input_messages) || job.input_messages.length === 0) {
      throw new Error("input_empty:no messages to send to rowboat");
    }
    const fallbackMessages = Array.isArray(job.stateless_input_messages)
      ? job.stateless_input_messages
      : null;

    // Webchat shares the SAME period spend fuse as owner chat + SMS (all
    // Gemini turns meter into owner_chat_model_spend via the llm-router), so
    // the cap read is identical. Anonymous traffic degrading to the free
    // local model — not billing unbounded Gemini — is the entire point.
    const { overCap } = await resolveOwnerChatCap();

    if (overCap && !WEBCHAT_LOCAL_AGENT) {
      log("warn", "webchat_turn_refused_over_cap", { jobId: job.id });
      await finishWebchatJob(job, WEBCHAT_OVER_CAP_REFUSAL, null, undefined);
      log("info", "webchat_process_done", { jobId: job.id, ms: Date.now() - t0, refused: true });
      return;
    }

    const startAgent = overCap && WEBCHAT_LOCAL_AGENT ? WEBCHAT_LOCAL_AGENT : WEBCHAT_START_AGENT;
    const startAgentOpts = startAgent ? { startAgent } : {};

    // Always stateless with an explicit startAgent, never resuming a stored
    // conversationId — same reasoning as the owner path: Rowboat ignores
    // startAgent when a conversationId is supplied, so resuming would pin
    // the conversation to whatever agent the first turn bound (breaking the
    // over-cap downgrade mid-conversation). The enqueue route replays the
    // history tail in the input every turn, so no context is lost.
    const turnMessages = fallbackMessages ?? job.input_messages;
    let result;
    try {
      result = await callRowboat(turnMessages, null, null, startAgentOpts);
    } catch (err) {
      const code = String(err?.message || "").split(":")[0];
      if (!isRetryableErrorCode(code)) throw err;
      log("warn", "webchat_turn_retry", {
        jobId: job.id,
        code,
        detail: String(err?.message || "").slice(0, 200)
      });
      result = await callRowboat(turnMessages, null, null, startAgentOpts);
    }
    const { content, conversationId, state: nextState } = result;

    // The widget surface has NO sentinel tools. Strip any EMAIL_SEND-style
    // block a confused/prompt-injected model emits — nothing is sent, the
    // raw protocol JSON never reaches the visitor, and an all-block reply
    // degrades to an honest canned line.
    const { cleanedContent, requests, invalidCount } = extractEmailSendRequests(content);
    if (requests.length > 0 || invalidCount > 0) {
      log("warn", "webchat_sentinel_stripped", {
        jobId: job.id,
        blocks: requests.length + invalidCount
      });
    }
    const finalContent = cleanedContent.trim() || WEBCHAT_EMPTY_AFTER_STRIP_REPLY;

    const msgId = await finishWebchatJob(job, finalContent, conversationId, nextState);
    log("info", "webchat_process_done", {
      jobId: job.id,
      msgId,
      durationMs: Date.now() - t0,
      contentLen: finalContent.length,
      agent: startAgent
    });
  } catch (err) {
    const msg = String(err?.message || "unknown_error");
    const code = msg.split(":")[0];
    // Same re-queue-on-transient-failure semantics as processJob above —
    // claim_webchat_job bumps `attempts`, the top of this function enforces
    // MAX_ATTEMPTS, and nothing persists before a successful response.
    if (isRetryableErrorCode(code) && job.attempts < MAX_ATTEMPTS) {
      log("warn", "webchat_turn_requeued", {
        jobId: job.id,
        attempts: job.attempts,
        code,
        durationMs: Date.now() - t0
      });
      await sleep(REQUEUE_BACKOFF_MS * job.attempts);
      const { error: requeueErr } = await sb
        .from("webchat_jobs")
        .update({
          status: "queued",
          claimed_by: null,
          claimed_at: null,
          error_code: code,
          error_detail: msg.slice(0, 500)
        })
        .eq("id", job.id);
      if (!requeueErr) return;
      log("error", "webchat_requeue_failed", { jobId: job.id, error: requeueErr.message });
    }
    log("error", "webchat_process_failed", {
      jobId: job.id,
      error: msg,
      durationMs: Date.now() - t0
    });
    await failWebchatJob(job.id, code, msg);
  }
}

async function processWebchatLoop() {
  for (;;) {
    const job = await claimNextWebchatJob();
    if (!job) return;
    await processWebchatJob(job);
  }
}

async function reclaimStale() {
  const { data, error } = await rpcWithTransientRetry("reclaim_stale_chat_jobs", {
    p_max_age_ms: STALE_CLAIM_MS
  });
  if (error) {
    logQueueRpcFailure("reclaim_failed", error.message);
    return 0;
  }
  clearQueueRpcFailure("reclaim_failed");
  const n = Array.isArray(data) ? data.length : 0;
  if (n > 0) {
    log("warn", "reclaimed_stale", { count: n, ids: data.map((j) => j.id) });
  }
  return n;
}

let processing = false;
async function drain() {
  // Idempotent: a flood of Realtime INSERTs collapses into a single drain
  // pass that loops on claimNextJob() until empty. Without this, N
  // concurrent INSERTs would spawn N reentrant drains and serialize them
  // anyway via the FOR UPDATE lock.
  if (processing) return;
  processing = true;
  try {
    try {
      await reclaimStale();
      await reclaimStaleWebchat();
      await processLoop();
      await processWebchatLoop();
    } catch (err) {
      // Bugbot Low-severity finding on PR #79: drain() is invoked
      // from a Realtime subscription callback and from setInterval,
      // both of which surface unhandled rejections to the event
      // loop. Under Node's default --unhandled-rejections=throw,
      // an exception from processJob's catch-block DB UPDATE (e.g.
      // a transient Supabase connectivity loss) or from
      // reclaim_stale_chat_jobs would crash the worker.
      //
      // We log + swallow here. The next sweep tick (or next
      // Realtime event) re-enters drain() and retries; any job
      // that didn't get its terminal status update will be
      // reclaimed by reclaim_stale_chat_jobs() once
      // STALE_CLAIM_MS elapses.
      log("error", "drain_failed", {
        error: err?.message || String(err),
        stack: err?.stack ? String(err.stack).slice(0, 500) : undefined
      });
    }
  } finally {
    processing = false;
  }
}

async function main() {
  log("info", "worker_start", {
    businessId: BUSINESS_ID,
    rowboatBaseUrl: ROWBOAT_BASE_URL,
    staleClaimMs: STALE_CLAIM_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
    rowboatTimeoutMs: ROWBOAT_TIMEOUT_MS,
    maxAttempts: MAX_ATTEMPTS,
    ownerStartAgent: OWNER_START_AGENT || "(workflow default)",
    webchatStartAgent: WEBCHAT_START_AGENT || "(workflow default)",
    webchatLocalAgent: WEBCHAT_LOCAL_AGENT,
    ownerSpendMetering: OWNER_CHAT_SPEND_METERING_ENABLED ? "on" : "off",
    ownerSpendCapUsd: (OWNER_CHAT_SPEND_CAP_MICROS / 1_000_000).toFixed(2),
    ownerLocalAgent: OWNER_CHAT_LOCAL_AGENT,
    memoryCapture: MEMORY_CAPTURE_ENABLED && OWNER_APPEND_URL ? "on" : "off",
    memoryCaptureModel: MEMORY_CAPTURE_ENABLED ? MEMORY_CAPTURE_MODEL : undefined,
    memoryCaptureUpstream: MEMORY_CAPTURE_ENABLED
      ? /^gemini[-_.]/i.test(MEMORY_CAPTURE_MODEL)
        ? `gemini-direct@${MEMORY_CAPTURE_GEMINI_BASE_URL}${GOOGLE_API_KEY ? "" : " (NO KEY)"}`
        : `ollama@${OLLAMA_BASE_URL}`
      : undefined
  });

  // CRITICAL: drain any pending work BEFORE subscribing to Realtime. If
  // the order is reversed, a job inserted during the websocket handshake
  // would arrive at the subscription handler — but the handler is a no-op
  // until `processing` is unblocked, which won't happen until drain
  // returns. Net effect: same. We do it in this order anyway because it
  // makes the boot-up sequence easier to reason about: first heal,
  // then listen.
  await drain();

  const channel = sb
    .channel(`chat-jobs-worker-${BUSINESS_ID}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "dashboard_chat_jobs",
        filter: `business_id=eq.${BUSINESS_ID}`
      },
      () => {
        // Fire-and-forget; drain() is its own try/catch.
        drain();
      }
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "webchat_jobs",
        filter: `business_id=eq.${BUSINESS_ID}`
      },
      () => {
        // Same shared drain — it processes both queues.
        drain();
      }
    )
    .subscribe((status) => {
      log("info", "realtime_status", { status });
    });

  setInterval(drain, SWEEP_INTERVAL_MS).unref();

  // Knowledge-graph projection → local SQLite (graph.db). The vault sync
  // ships graph.jsonl for graph-mode tenants; this compiles it whenever it
  // changes. No-op (no_jsonl) on boxes whose tenant is not on the graph.
  // Never throws; never touches chat duties.
  const buildGraph = () => maybeBuildGraphDb({ log });
  buildGraph();
  setInterval(buildGraph, 5 * 60 * 1000).unref();

  const shutdown = (signal) => {
    log("info", "worker_stop", { signal });
    channel.unsubscribe();
    // Give in-flight processJob() a chance to finish writing.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log("error", "fatal", { error: err?.message || String(err), stack: err?.stack });
  // Brief grace so the fire-and-forget system_logs insert can flush before exit.
  setTimeout(() => process.exit(1), 1500).unref();
});
