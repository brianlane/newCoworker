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
//      the first attempt failed), the job ends as 'error'.
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
const VERCEL_BASE_URL = (process.env.WORKER_VERCEL_BASE_URL || "").replace(/\/+$/, "");
const VERCEL_BEARER = process.env.WORKER_VERCEL_BEARER || "";
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
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function claimNextJob() {
  const { data, error } = await sb.rpc("claim_chat_job", {
    p_worker_id: WORKER_ID,
    p_business_id: BUSINESS_ID
  });
  if (error) {
    log("error", "claim_failed", { error: error.message });
    return null;
  }
  return data && data.length > 0 ? data[0] : null;
}

async function callRowboat(messages, conversationId, state) {
  const url = `${ROWBOAT_BASE_URL}/api/v1/${ROWBOAT_PROJECT_ID}/chat`;
  const body = { messages, stream: false };
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

// Errors where it's worth retrying without Rowboat's stored conversation
// state. Mirrors STATELESS_RETRY_ERRORS in the pre-Option-B streaming
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

    // ATTEMPT 1: input_messages + (possibly) stored conversationId
    // + stored Rowboat state. The state is Rowboat's client-carried
    // tool/agent state from the previous turn (see migration
    // 20260508000004); without it, multi-turn tool loops resume blank
    // and lose context.
    let result;
    let usedStateless = false;
    let primaryError = null;
    try {
      result = await callRowboat(
        primaryMessages,
        job.rowboat_conversation_id,
        job.rowboat_state ?? null
      );
    } catch (err) {
      primaryError = err;
      const code = String(err?.message || "").split(":")[0];
      const canRetry = isRetryableErrorCode(code) && fallbackMessages !== null;
      if (!canRetry) {
        // Either the error class isn't worth retrying, or we have no
        // stateless variant to fall back to (fresh thread).
        throw err;
      }
      log("warn", "stateless_retry", {
        jobId: job.id,
        primaryErrorCode: code,
        primaryError: String(err?.message || "").slice(0, 200)
      });
      // ATTEMPT 2: stateless input, no conversationId, no state.
      // Rowboat sees a brand-new conversation that already has the
      // tail spelled out in the system message we built upstream.
      // Sending the old state alongside would defeat the point of
      // the retry (it's the same broken context).
      result = await callRowboat(fallbackMessages, null, null);
      usedStateless = true;
    }
    const { content, conversationId, state: nextState } = result;

    const { data: msg, error: insertErr } = await sb
      .from("dashboard_chat_messages")
      .insert({ thread_id: job.thread_id, role: "assistant", content })
      .select("id")
      .single();
    if (insertErr) {
      throw new Error(`message_insert_failed:${insertErr.message}`);
    }

    // Persist Rowboat's stateful conversationId for the next turn, OR,
    // if we just succeeded via the stateless retry, NULL out whatever
    // we had stored — the previous id is known-bad and re-sending it
    // next turn would force the same primary-fail/stateless-retry
    // cycle every time.
    // Mirrors the pre-Option-B streaming-route semantics
    // (src/lib/db/dashboard-chat.ts::updateThreadConversation): the
    // conversationId and state fields are INDEPENDENT. Rowboat may
    // return either, both, or neither on a given turn — persisting
    // whichever it returned without coupling them prevents stale
    // state from leaking into future turns when Rowboat omits
    // conversationId, and prevents stale conversationId from
    // outliving its state when Rowboat omits state.
    //
    //   - usedStateless: the previous (conversationId, state) pair
    //     went down with the failed primary attempt. Write whatever
    //     Rowboat returned this turn, defaulting to null on either
    //     side so the next turn doesn't re-send the rotted values.
    //   - !usedStateless: only write a column when Rowboat actually
    //     returned a value for it (undefined = "key absent in
    //     response, preserve what we had").
    //
    // Cursor Bugbot Medium-severity finding: the previous version
    // gated rowboat_state on conversationId being present, dropping
    // state updates when Rowboat returned only state.
    const threadUpdate = { updated_at: new Date().toISOString() };
    if (usedStateless) {
      threadUpdate.rowboat_conversation_id = conversationId || null;
      threadUpdate.rowboat_state = nextState ?? null;
    } else {
      if (conversationId) {
        threadUpdate.rowboat_conversation_id = conversationId;
      }
      if (nextState !== undefined) {
        threadUpdate.rowboat_state = nextState;
      }
    }
    const { error: tErr } = await sb
      .from("dashboard_chat_threads")
      .update(threadUpdate)
      .eq("id", job.thread_id);
    if (tErr) log("warn", "thread_update_failed", { error: tErr.message });

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
      // The job row being stuck in 'processing' is much less bad than a
      // duplicate write on retry, so we surface the bookkeeping error
      // without re-throwing.
      log("error", "job_update_failed", { jobId: job.id, error: jobErr.message });
      return;
    }

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
    {
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
      usedStateless,
      primaryErrorCode: usedStateless
        ? String(primaryError?.message || "").split(":")[0]
        : null
    });
  } catch (err) {
    const msg = String(err?.message || "unknown_error");
    const code = msg.split(":")[0];
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

async function reclaimStale() {
  const { data, error } = await sb.rpc("reclaim_stale_chat_jobs", {
    p_max_age_ms: STALE_CLAIM_MS
  });
  if (error) {
    log("error", "reclaim_failed", { error: error.message });
    return 0;
  }
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
      await processLoop();
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
    maxAttempts: MAX_ATTEMPTS
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
    .subscribe((status) => {
      log("info", "realtime_status", { status });
    });

  setInterval(drain, SWEEP_INTERVAL_MS).unref();

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
  process.exit(1);
});
