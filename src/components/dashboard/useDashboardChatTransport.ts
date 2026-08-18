"use client";

/**
 * Owner-chat TRANSPORT state machine, extracted verbatim from
 * DashboardChat.tsx so a second shell (the Ask AI companion panel) can run
 * the same conversation without duplicating the subtle parts: the
 * optimistic send, the inline-vs-worker branch, and the Realtime+poll race
 * with its job-stamp verification (PR #79 rounds 2-8 hardening).
 *
 * What deliberately does NOT live here: composer state, attachment pickers,
 * draft-card rendering, confirms (window.confirm on the page,
 * i18n'd confirms in the companion), and scroll behavior — those are shell
 * concerns, and the two shells differ on every one of them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { parseEnvelope } from "@/lib/client/api-envelope";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  id: number | string;
  role: ChatRole;
  content: string;
  createdAt?: string;
};

type ChatGetResponse = {
  threadId: string | null;
  messages: ChatMessage[];
  isPaused: boolean;
  customerChannelsEnabled: boolean;
  // Present when the worker is still generating a reply for the active
  // thread (survives refresh / navigation so the "thinking…" indicator
  // can be re-attached instead of silently disappearing).
  pendingJob?: { id: string; threadId: string } | null;
};

// A creation draft returned by an inline turn: the owner reviews it in the
// matching editor (nothing is auto-saved).
export type ChatDraft =
  | { kind: "aiflow"; definition: unknown; warnings: string[] }
  | {
      kind: "agent";
      name: string;
      instructions: string;
      outputFormat: "markdown" | "same_as_input" | "pdf" | "docx" | "pdf_retypeset";
    };

type ChatPostResponse = {
  threadId: string;
  activeThreadId: string;
  userMessageId: number;
  messages: ChatMessage[];
  /**
   * "inline": the reply was generated on the platform and is already in
   * `messages` (plus any creation drafts). "worker"/absent: a job was
   * enqueued to the VPS worker — watch `jobId` for the reply.
   */
  mode?: "inline" | "worker";
  jobId?: string;
  assistantMessageId?: number;
  drafts?: ChatDraft[];
};

type ChatJobStatusResponse = {
  id: string;
  threadId: string;
  userMessageId: number;
  status: "queued" | "processing" | "done" | "error";
  assistantMessageId: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type ThreadSummary = {
  id: string;
  title: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

type ThreadsListResponse = {
  threads: ThreadSummary[];
};

type ThreadMessagesResponse = {
  threadId: string;
  title: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

// Reply delivery is a race between two parallel mechanisms:
//
//   (a) Supabase Realtime subscription on dashboard_chat_messages —
//       sub-second on the happy path. Authorized via the RLS SELECT
//       policy from migration 20260508000003 (matches owner_email
//       against the JWT email claim).
//
//   (b) Polling /api/dashboard/chat/jobs/[id] — fires every
//       JOB_POLL_INTERVAL_MS. Catches:
//         * websocket failures (corporate proxies, mobile network),
//         * the rare Realtime drop on the way to the client,
//         * worker errors (status='error' surfaces the friendly
//           message; Realtime never fires on the no-message path),
//         * any clock-skew where the INSERT lands a few ms before the
//           subscription handshake completes.
//
// First to settle wins; the loser is aborted. Both paths trigger the
// same UI handler (a full message-list refresh from the GET endpoint),
// so duplicate firings are harmless idempotent renders.
const JOB_POLL_INTERVAL_MS = 1500;

// Hard cap on how long we'll wait for a worker reply before giving up
// on a job we enqueued. Sized to cover the worker's worst case:
//   primary attempt:    WORKER_ROWBOAT_TIMEOUT_MS (240s)
// + stateless retry:    WORKER_ROWBOAT_TIMEOUT_MS (240s)
// + DB writes/headroom: ~60s
// = 540s
// If we hit this, the worker is wedged or the job got stuck; the user
// gets a clean error and can resend, and the server-side row will
// eventually be reclaimed by reclaim_stale_chat_jobs(). Pre-PR-#79
// round-5 this was 6 minutes which would have raced the worker on
// a legitimate double-timeout (Bugbot Medium-severity finding).
const JOB_POLL_TIMEOUT_MS = 9 * 60 * 1000;

// Map an opaque worker-side error_code to a user-facing string.
// Anything we don't recognize becomes the generic "couldn't generate
// a reply" message — better than leaking internal codes to the
// owner, who can't do anything with rowboat_http_500 anyway.
function friendlyErrorMessage(code: string | null): string {
  if (!code) return "Your coworker couldn't generate a reply. Please try again.";
  if (code === "max_attempts_exceeded") {
    return "Your coworker couldn't generate a reply after several tries. Please try again in a moment.";
  }
  return "Your coworker couldn't generate a reply. Please try again.";
}

type SendOptions = {
  /** A fresh file upload for this turn (goes as multipart). */
  file?: File | null;
  /** A picked business document id (goes in the JSON body). */
  documentId?: string;
  /**
   * Fired the moment the server has PERSISTED the user message (canonical
   * messages just replaced the optimistic echo). The page clears its
   * attachment UI here — at the same point the pre-extraction code did —
   * rather than after a worker reply settles.
   */
  onPersisted?: () => void;
};

type SendOutcome = {
  ok: boolean;
  /**
   * True when the message never reached the server (rate limit, network),
   * so the shell should restore the composer text: a fresh Send is the
   * correct retry. False once the turn is committed server-side — a
   * re-send would duplicate it.
   */
  restoreInput: boolean;
};

/**
 * One flag per (tab session, business): has the user ENGAGED with chat this
 * session (sent a message, opened a past conversation, or explicitly
 * started a new one)? Until they have, the chat view opens FRESH — an empty
 * conversation with the suggestions showing, ChatGPT-style — while History
 * keeps every past thread reachable. sessionStorage scopes it to the tab
 * session, so a new login/tab starts clean and a mid-session reload keeps
 * continuity. Server state is untouched until the first send (the POST
 * carries newThread: true then), so merely opening the panel never changes
 * which thread the chat page considers active.
 */
function freshSessionKey(businessId: string): string {
  return `ncw_chat_engaged_${businessId}`;
}

function readFreshStart(businessId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(freshSessionKey(businessId)) === null;
  } catch {
    // Storage blocked: continuity beats a fresh view that would reset on
    // every open.
    return false;
  }
}

export function useDashboardChatTransport(businessId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [viewingThreadId, setViewingThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  // Creation drafts from the latest inline turn. Ephemeral by design (same
  // transience as the library's adapt hand-off): the shell stashes the
  // draft into sessionStorage and opens the matching editor for review.
  const [drafts, setDrafts] = useState<ChatDraft[]>([]);
  // Outstanding fetch / poll lifecycle. AbortController fires on unmount,
  // "New conversation", switching threads mid-send, or a fresh send. The
  // poll loop checks signal.aborted each tick so it can exit cleanly.
  const abortRef = useRef<AbortController | null>(null);
  // The CURRENT business, for stale-closure guards: async work captured
  // under a previous business compares against this before writing state.
  const businessIdRef = useRef(businessId);
  // Fresh-session view (see freshSessionKey above). A ref mirrors the state
  // so the hydrate effect and send() read the CURRENT value without being
  // re-run/recreated when engagement flips it.
  const [freshStart, setFreshStart] = useState<boolean>(() => readFreshStart(businessId));
  const freshStartRef = useRef(freshStart);
  const engage = useCallback(() => {
    freshStartRef.current = false;
    setFreshStart(false);
    try {
      window.sessionStorage.setItem(freshSessionKey(businessId), "1");
    } catch {
      // Best-effort: without storage the fresh view simply returns next
      // mount, which is annoying but harmless.
    }
  }, [businessId]);
  // The initializer runs once for the mount-time business; the switcher can
  // change businessId with the hook still mounted, so re-read THAT
  // business's engagement before the hydrate effect below re-runs for it
  // (declared first: same-commit ordering keeps the ref correct). The view
  // resets in the same breath: the previous tenant's conversation must
  // never linger on screen while the new business hydrates, and a FRESH
  // new business would otherwise keep it forever (its hydrate deliberately
  // leaves the view alone).
  useEffect(() => {
    businessIdRef.current = businessId;
    // Tear down any in-flight work from the previous business FIRST: a late
    // reply or poll must never write the old tenant's messages back over
    // the cleared view.
    abortRef.current?.abort();
    abortRef.current = null;
    const next = readFreshStart(businessId);
    freshStartRef.current = next;
    setFreshStart(next);
    setMessages([]);
    // The old tenant's sidebar must not stay clickable (or deletable)
    // while the new business hydrates; its own fetchThreads repopulates.
    setThreads([]);
    setViewingThreadId(null);
    // The previous business's active thread must not be a send target even
    // for one frame; hydrate re-learns the new business's own.
    setActiveThreadId(null);
    setDrafts([]);
    setError(null);
    setSending(false);
    setLoadingThread(false);
    // The composer reads as busy until THIS business's hydrate lands
    // (hydrate flips it off in its finally); send() also refuses while
    // loading, returning the text to the composer.
    setLoading(true);
  }, [businessId]);

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/chat/threads?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const env = await parseEnvelope<ThreadsListResponse>(res);
      // A response captured under a previous business must not overwrite
      // the current one's sidebar, however late it lands.
      if (env.ok && businessIdRef.current === businessId) setThreads(env.data.threads);
    } catch {
      /* sidebar is best-effort; the main thread view is still functional */
    }
  }, [businessId]);

  // Settlement outcome: who delivered the assistant message, or what
  // went wrong. Realtime and polling both produce the same `ok` shape
  // so the caller doesn't need to know which path won — they just
  // refresh the message list.
  type SettleOutcome =
    | { ok: true; via: "realtime" | "poll" }
    | { ok: false; reason: string };

  // Open a Realtime channel scoped to this thread and resolve when
  // the worker INSERTs an assistant message. Resolves with `ok:false`
  // on subscribe failure or abort — the caller treats those as "this
  // path didn't win, defer to polling".
  function subscribeAssistantMessage(
    jobId: string,
    threadId: string,
    signal: AbortSignal
  ): Promise<SettleOutcome> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ ok: false, reason: "" });
        return;
      }
      const supabase = getSupabaseBrowserClient();
      // Channel name carries a timestamp so re-sends don't collide
      // with each other if the previous subscription is still in
      // teardown. Supabase rejects duplicate channel names per client.
      const channel = supabase.channel(`chat-msg-${threadId}-${Date.now()}`);
      let settled = false;
      const finish = (outcome: SettleOutcome) => {
        if (settled) return;
        settled = true;
        // removeChannel is idempotent; safe to call from multiple
        // exit paths.
        void supabase.removeChannel(channel);
        resolve(outcome);
      };
      channel
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "dashboard_chat_messages",
            filter: `thread_id=eq.${threadId}`
          },
          (payload: { new?: { id?: number | string; role?: string } | null }) => {
            const row = payload.new ?? {};
            // We only care about the worker's assistant write. The
            // user-message INSERT also fires here (we wrote it
            // server-side just before enqueueing) but we already
            // rendered that from the POST response.
            if (row.role !== "assistant") return;
            // Verify this assistant INSERT belongs to OUR job, not a
            // stale prior turn that just finished writing (e.g. a
            // reclaimed-stale job, or a previous job whose stateless
            // retry took two full ROWBOAT_TIMEOUT_MS windows). Without
            // this check the race could settle prematurely on the old
            // reply and the user's actual current-turn reply would
            // never surface — Bugbot Medium-severity finding on
            // PR #79 round-6.
            //
            // Implementation: one-shot fetch of the job row's status.
            // If the worker has stamped this job's assistant_message_id
            // to match the INSERT we just observed, it's ours and we
            // win the race. If not, keep listening — the next INSERT
            // (or the polling fallback) will land us correctly.
            void verifyAndFinish(row.id);
          }
        )
        .subscribe((status: string) => {
          // CHANNEL_ERROR / TIMED_OUT / CLOSED: Realtime path is
          // unavailable. Resolve so polling becomes the sole path.
          // SUBSCRIBED: keep the promise pending, waiting for the
          // INSERT.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            finish({ ok: false, reason: "" });
          }
        });
      signal.addEventListener("abort", () => finish({ ok: false, reason: "" }), {
        once: true
      });

      async function verifyAndFinish(insertedMessageId: number | string | undefined) {
        if (settled || signal.aborted) return;
        // The worker INSERTs the assistant message BEFORE it UPDATEs
        // the job to status='done'. If our verification fetch lands
        // in that gap (microseconds in the happy path), we'd see
        // status='processing' with assistant_message_id null, fall
        // through, and never re-fire — there's only one INSERT per
        // job. Retry briefly to cover that gap before giving up to
        // the polling fallback. Bugbot Medium-severity finding on
        // PR #79 round-7.
        const VERIFY_ATTEMPTS = 5;
        const VERIFY_DELAY_MS = 250;
        for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
          if (settled || signal.aborted) return;
          try {
            const res = await fetch(
              `/api/dashboard/chat/jobs/${encodeURIComponent(jobId)}?businessId=${encodeURIComponent(businessId)}`,
              { cache: "no-store", signal }
            );
            const env = await parseEnvelope<ChatJobStatusResponse>(res);
            if (env.ok) {
              const job = env.data;
              // status==='done' alone isn't enough: a stale job for
              // the same thread might also be done. The discriminator
              // is assistant_message_id matching the INSERT we just
              // saw. A mismatched-but-done job is from a different
              // turn, ignore.
              if (
                job.status === "done" &&
                insertedMessageId !== undefined &&
                String(job.assistantMessageId) === String(insertedMessageId)
              ) {
                finish({ ok: true, via: "realtime" });
                return;
              }
              if (job.status === "done") {
                // This job is done, but the INSERT we observed isn't
                // our assistant message — it's a stale write from
                // another turn. Stop trying: our actual write is
                // pending and our next INSERT event will re-verify.
                return;
              }
              if (job.status === "error") {
                finish({ ok: false, reason: friendlyErrorMessage(job.errorCode) });
                return;
              }
              // queued | processing, the worker hasn't stamped the
              // job yet. Brief backoff and retry; covers the
              // INSERT-then-UPDATE gap.
            }
          } catch {
            // Verification fetch failed (network blip, abort). Fall
            // through to the retry.
          }
          await sleepWithAbort(VERIFY_DELAY_MS, signal);
        }
        // Verification ran out without observing a matching done.
        // Stay subscribed, a later qualifying INSERT (e.g. a
        // worker-side stateless retry that wrote a different message)
        // will re-trigger this. The polling path is independent and
        // unchanged.
      }
    });
  }

  // Poll the job-status endpoint until the worker reports done/error.
  // Returns the final assistant content (or null if errored). Caller
  // is responsible for refreshing the message list afterwards — we
  // don't do it here so the success path can refresh once at the end
  // rather than racing the user message echo with the assistant write.
  async function pollJobUntilSettled(
    jobId: string,
    threadId: string,
    signal: AbortSignal
  ): Promise<SettleOutcome> {
    const startedAt = Date.now();
    // Bound on consecutive transient failures so we don't keep the
    // user staring at the thinking indicator for 6 minutes when both
    // Realtime is silently down AND every poll hits a network error.
    // 20 ticks × 1.5s = 30s of completely-silent failures before we
    // surface a friendly error instead of grinding to the full
    // JOB_POLL_TIMEOUT_MS. Any single successful poll resets the
    // counter — slow networks where 1-in-N requests fail still
    // succeed eventually. Bugbot Low-severity finding on PR #79
    // round-4.
    const MAX_CONSECUTIVE_FAILURES = 20;
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      if (Date.now() - startedAt > JOB_POLL_TIMEOUT_MS) {
        return {
          ok: false,
          reason: "Your coworker is taking unusually long. Please try again."
        };
      }

      let env;
      try {
        const res = await fetch(
          `/api/dashboard/chat/jobs/${encodeURIComponent(jobId)}?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store", signal }
        );
        env = await parseEnvelope<ChatJobStatusResponse>(res);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") {
          // Caller cancelled — don't surface an error, the caller
          // already manages the UI for whatever it's switching to.
          return { ok: false, reason: "" };
        }
        // One transient network failure shouldn't kill the whole
        // poll. Wait one tick and try again — the AbortController
        // will exit us if the user navigates away during the sleep.
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          return {
            ok: false,
            reason: "Network is unreachable. Please check your connection and try again."
          };
        }
        await sleepWithAbort(JOB_POLL_INTERVAL_MS, signal);
        continue;
      }
      consecutiveFailures = 0;

      if (!env.ok) {
        // 404/UNAUTHORIZED/etc. We can't recover, surface and exit.
        return { ok: false, reason: env.error.message };
      }

      const job = env.data;
      // Defensive: a polled job whose threadId no longer matches the
      // submission's threadId means something went wrong on the
      // server (worker swapped a thread? row corrupted?). Treat as
      // an error rather than render the wrong assistant bubble in
      // the wrong thread.
      if (job.threadId !== threadId) {
        return { ok: false, reason: "Conversation state changed; please reload." };
      }

      if (job.status === "done") {
        return { ok: true, via: "poll" };
      }
      if (job.status === "error") {
        return { ok: false, reason: friendlyErrorMessage(job.errorCode) };
      }
      // queued | processing — keep waiting.
      await sleepWithAbort(JOB_POLL_INTERVAL_MS, signal);
    }
    return { ok: false, reason: "" };
  }

  // Promise wrapper around setTimeout that resolves early on abort.
  // Without the abort hook, an aborted poll loop would still wait the
  // full JOB_POLL_INTERVAL_MS before checking signal.aborted on the
  // next iteration — slow shutdown on tab navigation.
  function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Watch an enqueued job to completion: race Supabase Realtime against
  // the polling fallback, then refresh the canonical message list for
  // the job's thread. Owns the `sending` flag and abortRef lifecycle so
  // both the live-send path (send) and the rehydrate path (mount /
  // thread-select with a server-reported pendingJob) behave identically.
  // `controller` is the per-watch AbortController already stored in
  // abortRef.
  async function watchJobUntilSettled(
    jobId: string,
    threadId: string,
    controller: AbortController
  ) {
    // Nested AbortController so we can tear down the LOSER of the race
    // without aborting the outer `controller` (whose signal would
    // otherwise propagate into the post-success message-list refresh
    // fetch and abort it).
    const raceController = new AbortController();
    // Outer abort cascades into the race (unmount / new conversation
    // tears down both Realtime and poll). Race-only abort does NOT
    // propagate back outward.
    const cascade = () => raceController.abort();
    if (controller.signal.aborted) raceController.abort();
    else controller.signal.addEventListener("abort", cascade, { once: true });

    const realtimePromise = subscribeAssistantMessage(
      jobId,
      threadId,
      raceController.signal
    ).then((outcome) => {
      // Realtime path that didn't win (subscribe failure / abort)
      // shouldn't terminate the race — block forever so the poll
      // path is the deciding voice.
      if (outcome.ok || outcome.reason) return outcome;
      return new Promise<SettleOutcome>(() => undefined);
    });
    const pollPromise = pollJobUntilSettled(jobId, threadId, raceController.signal);
    const result: SettleOutcome = await Promise.race([realtimePromise, pollPromise]);
    controller.signal.removeEventListener("abort", cascade);
    // Tear down the loser. The winning path already resolved; this
    // signals "stop polling / unsubscribe Realtime" without touching
    // the outer signal's abort listeners.
    raceController.abort();

    // If the user navigated away mid-race the outer signal fired,
    // which cascaded into raceController.abort() — both paths
    // returned ok:false with empty reason. Bail silently; the
    // navigation handler manages its own UI.
    if (controller.signal.aborted) {
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return;
    }

    if (!result.ok) {
      // No assistant message persisted server-side. Surface the error,
      // leave the user message in place (it's on the server). DON'T
      // restore the textarea: the user's turn is already committed,
      // a re-send would create a duplicate. They can retype if they
      // want to re-ask.
      if (result.reason) setError(result.reason);
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return;
    }

    // Worker reported done. Refresh the canonical message list for
    // OUR specific thread (threadId), not whatever thread the route
    // considers active right now. The active thread can have changed
    // during the 5-30s worker window — another browser tab, a thread
    // archive from elsewhere — and the generic
    // GET /api/dashboard/chat?businessId would return that other
    // thread's messages, overwriting ours with the wrong content.
    // Bugbot Medium-severity finding on PR #79 round-8.
    try {
      const res = await fetch(
        `/api/dashboard/chat/threads/${encodeURIComponent(threadId)}/messages`,
        { cache: "no-store", signal: controller.signal }
      );
      const env = await parseEnvelope<ThreadMessagesResponse>(res);
      if (env.ok) {
        setMessages(env.data.messages);
        // Pin the view to the thread this job belongs to. If a
        // concurrent tab swapped the active thread, the user's
        // current view stays on the thread they were chatting in
        // (correct behavior — the user will see the active-thread
        // change in the sidebar on the next refresh).
        setViewingThreadId(threadId);
      } else {
        // GET returned an error envelope (e.g. session expired
        // mid-chat, server issue between the worker write and our
        // refresh). The assistant message IS persisted — the
        // worker only marks the job done after the INSERT — so
        // surface a soft note rather than leaving the user staring
        // at a thinking indicator that has stopped without
        // explanation. Bugbot Medium-severity finding on PR #79
        // round-2.
        setError("Reply ready; refresh to see it.");
      }
    } catch (err) {
      if ((err as { name?: string } | null)?.name !== "AbortError") {
        // Network/throw failure on the GET. Same recovery as the
        // error-envelope path above: the message is on the server,
        // we just couldn't fetch it.
        setError("Reply ready; refresh to see it.");
      }
    }

    if (controller.signal.aborted) {
      // Aborted during the refresh (unmount or a business switch): the
      // trailing sidebar refresh below runs in a closure that may target
      // the PREVIOUS business, so it must not fire late.
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return;
    }
    setSending(false);
    void fetchThreads();
    if (abortRef.current === controller) abortRef.current = null;
  }

  // Initial hydrate: pull the active thread + flags AND the sidebar list
  // in parallel. Both are owner-gated so there's no security cost to
  // overlap, and overlapping cuts perceived load by ~50% on slow links.
  useEffect(() => {
    let cancelled = false;
    // Track the watcher this effect run starts so cleanup can tear it
    // down on a dependency change (e.g. businessId switch), not just on
    // unmount. Without this, a re-run overwrites abortRef.current and
    // orphans the previous poll loop + Realtime subscription.
    let localController: AbortController | null = null;
    (async () => {
      try {
        const [activeRes] = await Promise.all([
          fetch(
            `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
            { cache: "no-store" }
          ),
          fetchThreads()
        ]);
        const env = await parseEnvelope<ChatGetResponse>(activeRes);
        if (cancelled) return;
        if (env.ok) {
          // Fresh session: the view stays an EMPTY new conversation (the
          // suggestions render); the active thread is still tracked for
          // History and flags, just not displayed or targeted.
          if (!freshStartRef.current) {
            setMessages(env.data.messages);
            setViewingThreadId(env.data.threadId);
          }
          setActiveThreadId(env.data.threadId);
          setIsPaused(env.data.isPaused);
          setSafeMode(!env.data.customerChannelsEnabled);
          // The worker may still be generating a reply for this thread
          // (the owner refreshed / came back mid-turn). Re-attach the
          // Realtime+poll watcher so "thinking…" reappears and the
          // reply lands when ready, instead of vanishing on reload.
          // Skipped in a fresh session: we are not viewing that thread,
          // and its reply still lands server-side for History.
          if (env.data.pendingJob && !freshStartRef.current) {
            const controller = new AbortController();
            localController = controller;
            abortRef.current = controller;
            setSending(true);
            void watchJobUntilSettled(
              env.data.pendingJob.id,
              env.data.pendingJob.threadId,
              controller
            );
          }
        } else {
          setError(env.error.message);
        }
      } catch {
        if (!cancelled) setError("Network error loading chat history.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Abort the watcher this run spawned. Guard against nuking a newer
      // controller (e.g. one send() installed after this effect ran) by
      // only aborting when abortRef still points at our own controller.
      if (localController) {
        if (abortRef.current === localController) abortRef.current = null;
        localController.abort();
      }
    };
    // watchJobUntilSettled is a stable-behavior inner function (only
    // touches refs + state setters); listing it would re-run this
    // one-shot hydrate effect on every render. Intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, fetchThreads]);

  // Abort any in-flight POST or poll loop on unmount. Without this,
  // navigating away mid-poll keeps a 1.5s tick alive against a
  // dead component, and (worse) any setMessages it tries to call
  // logs a "set state on unmounted component" warning.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (sending || loading || loadingThread) return;
      // Clicking the thread we're already on is a cheap no-op. Avoids
      // a pointless fetch and the accompanying flash of "Loading…".
      if (threadId === viewingThreadId) return;
      // Opening a past conversation is engagement: the fresh view is over
      // for this session.
      engage();

      // Everything below may resolve AFTER a business switch tore this
      // view down; a stale closure must neither write the old tenant's
      // messages onto the new view nor attach its watcher (the switch
      // effect already reset loadingThread for us in that case).
      const forBusiness = businessId;
      const stale = () => businessIdRef.current !== forBusiness;

      // Two endpoints, one purpose. The active-thread route returns
      // exactly the same message shape PLUS the live flag state
      // (paused / safe mode), so we use it whenever we're loading the
      // currently-active thread (re-syncing flags is cheap insurance
      // for multi-tab drift). Archived threads hit the per-thread
      // read endpoint. The composer is editable in BOTH cases — on
      // submit, the POST includes whichever thread is being viewed
      // and the server reactivates if needed.
      setLoadingThread(true);
      setError(null);
      setDrafts([]);
      try {
        if (threadId === activeThreadId) {
          const res = await fetch(
            `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
            { cache: "no-store" }
          );
          const env = await parseEnvelope<ChatGetResponse>(res);
          if (stale()) return;
          if (env.ok) {
            setMessages(env.data.messages);
            // Re-sync activeThreadId in case another tab archived this
            // thread and minted a new one in the meantime — without
            // this, viewingThreadId would point at a stale id.
            setActiveThreadId(env.data.threadId);
            setViewingThreadId(env.data.threadId);
            // Switching back to the active thread while the worker is
            // still generating: re-attach the watcher so the indicator
            // and reply resume here too. selectThread early-returns
            // when sending, so we know we're not already watching.
            if (env.data.pendingJob) {
              const controller = new AbortController();
              abortRef.current = controller;
              setSending(true);
              void watchJobUntilSettled(
                env.data.pendingJob.id,
                env.data.pendingJob.threadId,
                controller
              );
            }
          } else {
            setError(env.error.message);
          }
        } else {
          const res = await fetch(
            `/api/dashboard/chat/threads/${encodeURIComponent(threadId)}/messages`,
            { cache: "no-store" }
          );
          const env = await parseEnvelope<ThreadMessagesResponse>(res);
          if (stale()) return;
          if (env.ok) {
            setMessages(env.data.messages);
            setViewingThreadId(threadId);
          } else {
            setError(env.error.message);
          }
        }
      } catch {
        if (!stale()) setError("Network error.");
      } finally {
        if (!stale()) setLoadingThread(false);
      }
    },
    // watchJobUntilSettled is a stable-behavior inner function (refs +
    // setters only); omitting it keeps this callback from changing
    // identity every render. Same rationale as the hydrate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeThreadId, businessId, engage, loading, loadingThread, sending, viewingThreadId]
  );

  async function send(text: string, options: SendOptions = {}): Promise<SendOutcome> {
    const trimmed = text.trim();
    if (!trimmed || sending || isPaused) return { ok: false, restoreInput: false };
    // Mid-hydrate (first load or a business switch): no thread may be
    // targeted yet. Hand the text back so the shells restore the composer;
    // their disabled states make this a rare race, not a normal path.
    if (loading) return { ok: false, restoreInput: true };

    // Optimistic user bubble. Stays even on error because we treat
    // the user's typed message as committed the moment they hit Send;
    // restoring the textarea on error makes resending a single click.
    const optimisticUserId = `local-user-${Date.now()}`;
    const optimisticUser: ChatMessage = {
      id: optimisticUserId,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString()
    };

    setMessages((prev) => [...prev, optimisticUser]);
    setSending(true);
    setError(null);
    setDrafts([]);

    // Cancel any prior in-flight poll. The Send button is disabled
    // while sending=true, but defensive cleanup means a fast double-
    // submit during a React batch can't leave two polls running.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // ChatGPT/Claude/Gemini-style: every thread is continuable. A fresh-
    // session first send targets NO thread and asks the server to mint a
    // new one (newThread), leaving the old active thread in History.
    const isFreshSend = freshStartRef.current;
    const targetThreadId = isFreshSend ? null : (viewingThreadId ?? activeThreadId);

    // Attachment turns: a fresh file goes as multipart; a picked document
    // goes as documentId in the JSON body.
    const attachedFile = options.file ?? null;
    const attachedDoc = options.documentId ?? "";

    let post: ChatPostResponse;
    try {
      let res: Response;
      if (attachedFile) {
        const form = new FormData();
        form.set("businessId", businessId);
        form.set("message", trimmed);
        if (targetThreadId) form.set("threadId", targetThreadId);
        if (isFreshSend) form.set("newThread", "true");
        form.set("file", attachedFile);
        res = await fetch("/api/dashboard/chat", {
          method: "POST",
          body: form,
          signal: controller.signal
        });
      } else {
        res = await fetch("/api/dashboard/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            message: trimmed,
            ...(targetThreadId ? { threadId: targetThreadId } : {}),
            ...(isFreshSend ? { newThread: true } : {}),
            ...(attachedDoc ? { documentId: attachedDoc } : {})
          }),
          signal: controller.signal
        });
      }
      const env = await parseEnvelope<ChatPostResponse>(res);
      if (!env.ok) {
        // Rate limit / paused / not found — surface the server's
        // message verbatim, restore the textarea, drop the optimistic
        // user bubble. The user's typed message never made it to the
        // server, so a fresh Send is the correct retry.
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId));
        setError(env.error.message);
        setSending(false);
        if (abortRef.current === controller) abortRef.current = null;
        return { ok: false, restoreInput: true };
      }
      post = env.data;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AbortError") {
        // Aborted by unmount / new-conversation / thread switch. The
        // respective handler manages its own UI state.
        setSending(false);
        if (abortRef.current === controller) abortRef.current = null;
        return { ok: false, restoreInput: false };
      }
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId));
      setError("Network error while sending message.");
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return { ok: false, restoreInput: true };
    }

    // Server has persisted the user message and minted (or reactivated)
    // the thread. The turn is committed: the session is engaged now.
    engage();
    // Replace our optimistic bubble with the canonical server copy so
    // timestamps + ids match a refresh, and remember the active thread so
    // the next send targets it.
    setMessages(post.messages);
    setActiveThreadId(post.activeThreadId);
    setViewingThreadId(post.threadId);
    options.onPersisted?.();
    // Refresh sidebar so the (newly) active thread's bumped updatedAt +
    // new message_count + flipped isActive flag show up without a
    // hard reload. Fire-and-forget; sidebar is best-effort.
    void fetchThreads();

    // Inline turns already carry the assistant reply (and any creation
    // drafts) in the response — nothing to watch.
    if (post.mode === "inline" || !post.jobId) {
      setDrafts(post.drafts ?? []);
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return { ok: true, restoreInput: false };
    }

    // Worker-fallback turns: wait for the worker and render the reply.
    // watchJobUntilSettled owns the same Realtime+poll race that the
    // rehydrate paths (mount / thread-select with a pendingJob) attach.
    await watchJobUntilSettled(post.jobId, post.threadId, controller);
    return { ok: true, restoreInput: false };
  }

  // Delete one conversation. Confirmation is the SHELL's job (the page
  // uses window.confirm, the companion an i18n'd confirm).
  async function deleteThread(threadId: string) {
    if (sending || loading) return;
    const forBusiness = businessId;
    const stale = () => businessIdRef.current !== forBusiness;
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/chat/threads/${encodeURIComponent(threadId)}`,
        { method: "DELETE" }
      );
      const env = await parseEnvelope<{ ok: boolean }>(res);
      if (stale()) return;
      if (!env.ok) {
        setError(env.error.message);
        return;
      }
      // If the deleted thread was on screen (active or archived), reset the
      // pane to "ready for a new conversation" — its messages are gone.
      if (viewingThreadId === threadId || activeThreadId === threadId) {
        setMessages([]);
        setViewingThreadId(null);
        if (activeThreadId === threadId) setActiveThreadId(null);
      }
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
    } catch {
      if (!stale()) setError("Network error.");
    }
  }

  // Archive the active thread so the next send starts fresh. Confirmation
  // is the shell's job, same as deleteThread.
  async function startNewConversation() {
    if (sending) return;
    const forBusiness = businessId;
    const stale = () => businessIdRef.current !== forBusiness;
    // Explicitly starting over is engagement: later opens this session
    // resume normally instead of re-showing the fresh view.
    engage();
    abortRef.current?.abort();
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const env = await parseEnvelope<{ ok: boolean }>(res);
      if (stale()) return;
      if (env.ok) {
        setMessages([]);
        setDrafts([]);
        // The previous active thread is now archived; the next POST will
        // mint a fresh active thread (its id is unknown until that POST
        // resolves). Clearing the active id locally puts the input in
        // "ready to start a new thread" mode rather than "archive view"
        // — matches what the user just confirmed.
        setActiveThreadId(null);
        setViewingThreadId(null);
        void fetchThreads();
      } else {
        setError(env.error.message);
      }
    } catch {
      if (!stale()) setError("Network error.");
    } finally {
      if (!stale()) setSending(false);
    }
  }

  return {
    messages,
    threads,
    drafts,
    sending,
    loading,
    loadingThread,
    error,
    isPaused,
    safeMode,
    activeThreadId,
    viewingThreadId,
    setError,
    send,
    selectThread,
    deleteThread,
    startNewConversation,
    refreshThreads: fetchThreads
  };
}
