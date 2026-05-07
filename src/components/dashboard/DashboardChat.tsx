"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { Badge } from "@/components/ui/Badge";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
import { parseEnvelope } from "@/lib/client/api-envelope";
import {
  consumeNdjsonChunk,
  flushNdjsonBuffer,
  type NdjsonBuffer
} from "@/lib/client/ndjson-stream";

type Role = "user" | "assistant" | "system";

type ChatMessage = {
  id: number | string;
  role: Role;
  content: string;
  createdAt?: string;
};

type Props = {
  businessId: string;
  businessName: string;
};

type ChatGetResponse = {
  threadId: string | null;
  messages: ChatMessage[];
  isPaused: boolean;
  customerChannelsEnabled: boolean;
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

function formatTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function formatThreadDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(d);
}

// Stream events emitted by POST /api/dashboard/chat (NDJSON, one
// per line). See route.ts for the canonical contract.
type StreamEvent =
  | { type: "meta"; threadId: string; activeThreadId: string }
  | { type: "delta"; content: string }
  | { type: "ping" }
  | { type: "done"; threadId: string; messages: ChatMessage[] }
  | { type: "error"; code: string; message: string };

export function DashboardChat({ businessId, businessName }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [viewingThreadId, setViewingThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Outstanding stream POST. Aborted on unmount, "New conversation",
  // or a new send (defense-in-depth against double-submit; the submit
  // button is disabled while `sending` so this should never trip
  // mid-flight, but better safe than orphaned-tokens).
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/chat/threads?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const env = await parseEnvelope<ThreadsListResponse>(res);
      if (env.ok) setThreads(env.data.threads);
    } catch {
      /* sidebar is best-effort; the main thread view is still functional */
    }
  }, [businessId]);

  // Initial hydrate: pull the active thread + flags AND the sidebar list
  // in parallel. Both are owner-gated so there's no security cost to
  // overlap, and overlapping cuts perceived load by ~50% on slow links.
  useEffect(() => {
    let cancelled = false;
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
          setMessages(env.data.messages);
          setActiveThreadId(env.data.threadId);
          setViewingThreadId(env.data.threadId);
          setIsPaused(env.data.isPaused);
          setSafeMode(!env.data.customerChannelsEnabled);
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
    };
  }, [businessId, fetchThreads]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Abort any in-flight streaming POST when the component unmounts.
  // Without this, navigating away mid-generation leaves the server
  // happily streaming tokens nobody will ever read; the route's
  // request.signal.aborted check tears down the upstream Rowboat call
  // as soon as the AbortController fires.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (sending || loadingThread) return;
      // Clicking the thread we're already on is a cheap no-op. Avoids
      // a pointless fetch and the accompanying flash of "Loading…".
      if (threadId === viewingThreadId) return;

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
      try {
        if (threadId === activeThreadId) {
          const res = await fetch(
            `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
            { cache: "no-store" }
          );
          const env = await parseEnvelope<ChatGetResponse>(res);
          if (env.ok) {
            setMessages(env.data.messages);
            // Re-sync activeThreadId in case another tab archived this
            // thread and minted a new one in the meantime — without
            // this, viewingThreadId would point at a stale id.
            setActiveThreadId(env.data.threadId);
            setViewingThreadId(env.data.threadId);
          } else {
            setError(env.error.message);
          }
        } else {
          const res = await fetch(
            `/api/dashboard/chat/threads/${encodeURIComponent(threadId)}/messages`,
            { cache: "no-store" }
          );
          const env = await parseEnvelope<ThreadMessagesResponse>(res);
          if (env.ok) {
            setMessages(env.data.messages);
            setViewingThreadId(threadId);
          } else {
            setError(env.error.message);
          }
        }
      } catch {
        setError("Network error.");
      } finally {
        setLoadingThread(false);
      }
    },
    [activeThreadId, businessId, loadingThread, sending, viewingThreadId]
  );

  async function handleSubmit(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending || isPaused) return;

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
    // Placeholder assistant bubble that will fill incrementally as
    // deltas arrive. We insert it on the first `meta` event (NOT
    // up front) so a slow preflight error doesn't briefly flash an
    // empty assistant bubble.
    const inflightAssistantId = `local-assistant-${Date.now()}`;

    setMessages((prev) => [...prev, optimisticUser]);
    setInput("");
    setSending(true);
    setError(null);

    // Cancel any prior in-flight stream — defensive; the Send button
    // is disabled while sending=true, but a fast double-submit during
    // the React batch could otherwise leak two readers.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // ChatGPT/Claude/Gemini-style: every thread is continuable.
    const targetThreadId = viewingThreadId ?? activeThreadId;

    let assistantBubbleInserted = false;
    // Tracks whether the user has actually SEEN any assistant content
    // in the bubble. Distinct from `assistantBubbleInserted`, which
    // flips on the server's `meta` event (always sent before Rowboat
    // is even called). Cursor Bugbot Medium on PR #76 commit 334bc4e:
    // pre-fix the error/partial-stream branches keyed off
    // `assistantBubbleInserted`, but since `meta` is unconditional
    // that meant a Rowboat failure BEFORE any token still left an
    // empty bubble on screen with no way to restore the textarea.
    // Branching on `firstDeltaRendered` instead means: "if you saw
    // content, we keep it; if you only saw an empty placeholder, we
    // tear it down and let you edit-and-resend."
    let firstDeltaRendered = false;
    let streamErrored = false;
    // Tracks whether we received the server's `done` event. Used to
    // distinguish a clean stream close (done) from a connection-cut
    // close (Vercel function reaper at maxDuration, TCP drop, server
    // crash) — the latter MUST surface an error so the owner knows
    // the reply may be incomplete instead of leaving them staring at
    // a half-finished bubble that looks like the model just stopped
    // (Cursor Bugbot Low on PR #76).
    let streamDone = false;
    let res: Response | null = null;

    try {
      res = await fetch("/api/dashboard/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          message: trimmed,
          ...(targetThreadId ? { threadId: targetThreadId } : {})
        }),
        signal: controller.signal
      });
    } catch (err) {
      // Network failure (DNS, TLS, abort). On abort we silently bail —
      // unmount/new-conversation handlers reset their own UI. On any
      // other failure surface a friendly error.
      if ((err as { name?: string } | null)?.name !== "AbortError") {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId));
        setInput(trimmed);
        setError("Network error while sending message.");
      }
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return;
    }

    if (!res.body) {
      // Server returned a response with no body — extraordinarily rare
      // (would have to be a buggy intermediary stripping the stream).
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId));
      setInput(trimmed);
      setError("Unexpected server response.");
      setSending(false);
      if (abortRef.current === controller) abortRef.current = null;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const ndjsonState: NdjsonBuffer = { buffer: "" };

    const handleEvent = (ev: StreamEvent) => {
      if (ev.type === "meta") {
        if (!assistantBubbleInserted) {
          assistantBubbleInserted = true;
          setMessages((prev) => [
            ...prev,
            {
              id: inflightAssistantId,
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString()
            }
          ]);
        }
      } else if (ev.type === "delta") {
        // Mark the moment the user sees MEANINGFUL content. The
        // error / partial-stream branches below use this — NOT
        // `assistantBubbleInserted` — to decide whether to preserve
        // the bubble (because the owner is mid-read and yanking it
        // is jarring) vs tear it down (because the bubble has only
        // ever been an empty placeholder, or whitespace).
        //
        // Cursor Bugbot Low on PR #76 commit e722c7d: trim before
        // testing length. Pre-fix this was `length > 0`, but a
        // whitespace-only stream (Rowboat emits a leading "\n\n"
        // and then errors) would flip the flag, the server's
        // post-error friendly-message gate uses
        // `buffered.trim().length === 0` (so it surfaces a
        // pre-meaningful-content error), and the bubble was never
        // persisted server-side. Mismatched gates left a whitespace
        // bubble visible until refresh. Aligning on "trimmed
        // non-empty == meaningful content" keeps server and client
        // in lockstep.
        if (ev.content.trim().length > 0) firstDeltaRendered = true;
        // Streaming append. Find the in-flight bubble by stable local
        // id — locating by index would race against React's reconciler
        // batching multiple deltas in a single tick.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === inflightAssistantId
              ? { ...m, content: m.content + ev.content }
              : m
          )
        );
      } else if (ev.type === "ping") {
        // Heartbeat — server signaling "still working, don't time out".
        // Nothing to render.
      } else if (ev.type === "done") {
        streamDone = true;
        // Replace the optimistic / in-flight pair with the server's
        // canonical message list (real DB ids, ordered by created_at,
        // any server-side normalization applied). Keeps the rendered
        // history consistent with what a refresh would show.
        setMessages(ev.messages);
        setActiveThreadId(ev.threadId);
        setViewingThreadId(ev.threadId);
        // Refresh sidebar so the (newly) active thread's bumped
        // updatedAt + new message_count + flipped isActive flag show
        // up without a hard reload.
        void fetchThreads();
      } else if (ev.type === "error") {
        streamErrored = true;
        // Branching mirrors the post-loop "stream closed without
        // done/error" handler below. Both branches handle the same
        // conceptual scenario — a stream interruption where the user
        // has either (a) seen partial assistant content already, or
        // (b) only seen the empty placeholder. The server has not
        // persisted the assistant turn either way, so we never need
        // to keep the bubble for DB-consistency reasons — only UX.
        //
        // Cursor Bugbot Medium on PR #76 commit 334bc4e: keying off
        // `assistantBubbleInserted` was wrong because that flag flips
        // on `meta`, which the server unconditionally sends BEFORE
        // calling Rowboat. A Rowboat failure pre-token would arrive
        // as an `error` event AFTER `meta` had already inserted the
        // empty bubble, and the !assistantBubbleInserted check would
        // be false — leaving an orphaned empty bubble on screen with
        // no way to restore the textarea. Branching on
        // `firstDeltaRendered` (set only when actual content was
        // appended) fixes this: "did you see content?" is the right
        // question, "did meta arrive?" is the wrong one.
        if (!firstDeltaRendered) {
          // The bubble (if inserted) only ever showed an empty
          // placeholder. Safe to drop the optimistic user message +
          // the placeholder and restore the textarea so the owner
          // can edit-and-resend in one click. Matches the
          // pre-streaming UX exactly.
          setMessages((prev) =>
            prev.filter((m) => m.id !== optimisticUserId && m.id !== inflightAssistantId)
          );
          setInput(trimmed);
        }
        // If content WAS rendered, leave the optimistic user message
        // and the partial assistant bubble in place — the owner saw
        // those tokens, yanking them mid-read is jarring. We do NOT
        // restore the textarea here: the user's message is on the
        // server (we received `meta`), and a re-send would create a
        // duplicate user turn. Owner can re-ask if they want the
        // full answer.
        setError(ev.message);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const { events } = consumeNdjsonChunk<StreamEvent>(
          ndjsonState,
          decoder.decode(value, { stream: true })
        );
        for (const ev of events) handleEvent(ev);
      }
      // Flush any trailing partial line (shouldn't happen with a well-
      // formed server, but tolerant parsing avoids dropping a final
      // event when an intermediary clips the trailing newline).
      const { events: trailingEvents } = flushNdjsonBuffer<StreamEvent>(ndjsonState);
      for (const ev of trailingEvents) handleEvent(ev);
      if (!streamErrored && !streamDone) {
        if (!firstDeltaRendered) {
          // Stream closed before any visible token reached the user.
          // Could be: server never emitted meta (very rare), server
          // emitted meta but Rowboat hung and the function got
          // reaped before the first delta, or any other pre-token
          // failure mode. Either way the user sees only an empty
          // placeholder bubble (or no bubble) — drop it, drop the
          // optimistic user message, and restore the textarea so
          // they can edit-and-resend.
          setMessages((prev) =>
            prev.filter((m) => m.id !== optimisticUserId && m.id !== inflightAssistantId)
          );
          setInput(trimmed);
          setError("Your coworker didn't respond. Please try again.");
        } else {
          // Stream closed AFTER one or more `delta` events but
          // BEFORE `done` or `error`. Most likely cause: Vercel's
          // function reaper at maxDuration, an intermediate proxy
          // dropping the connection, or the server process crashing
          // mid-generation. We KEEP the partial assistant bubble
          // (the user already saw those tokens — yanking them looks
          // like a bug) but surface a clear error so the owner knows
          // the reply is incomplete and can resend. The textarea is
          // NOT restored: the user's message did make it to the
          // server (we got `meta` back), and resending would persist
          // a duplicate user turn — better to let them retype if
          // they want, after seeing the partial reply.
          setError("The reply was cut off — please ask again to get the full answer.");
        }
      }
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AbortError") {
        // Aborted by unmount / new-conversation. The respective handler
        // already manages its own UI state.
      } else {
        setMessages((prev) =>
          prev.filter((m) => m.id !== optimisticUserId && m.id !== inflightAssistantId)
        );
        setInput(trimmed);
        setError("Network error while reading the reply.");
      }
    } finally {
      setSending(false);
      try {
        reader.releaseLock();
      } catch {
        /* already released by abort */
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function handleKeyDown(evt: KeyboardEvent<HTMLTextAreaElement>) {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      evt.currentTarget.form?.requestSubmit();
    }
  }

  async function handleNewConversation() {
    if (sending) return;
    if (
      !window.confirm(
        "Start a new conversation? You can still revisit past conversations from the sidebar."
      )
    ) {
      return;
    }
    abortRef.current?.abort();
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const env = await parseEnvelope<{ ok: boolean }>(res);
      if (env.ok) {
        setMessages([]);
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
      setError("Network error.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-6xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Chat with your coworker</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Private chat with {businessName}&rsquo;s AI
          </p>
        </div>
        <div className="flex items-center gap-2">
          {safeMode && <Badge variant="pending">Safe mode</Badge>}
          {isPaused && <Badge variant="error">Paused</Badge>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleNewConversation}
            disabled={sending || loading}
          >
            New conversation
          </Button>
        </div>
      </div>

      {isPaused && (
        <Card className="border-spark-orange/50 bg-spark-orange/10">
          <p className="text-sm font-semibold text-spark-orange">Your coworker is paused</p>
          <p className="text-xs text-parchment/60 mt-1">
            Resume your coworker from the dashboard to chat.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* Conversation history sidebar */}
        <Card className="p-0 overflow-hidden">
          <div className="px-3 py-2 border-b border-parchment/10">
            <p className="text-xs font-medium uppercase tracking-wider text-parchment/50">
              Conversations
            </p>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {threads.length === 0 ? (
              <div className="px-3 py-3 text-xs text-parchment/40">
                {loading ? "Loading…" : "No conversations yet."}
              </div>
            ) : (
              <ul className="flex flex-col">
                {threads.map((t) => {
                  const selected = t.id === viewingThreadId;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => selectThread(t.id)}
                        disabled={sending || loadingThread}
                        className={[
                          "w-full text-left px-3 py-2 border-b border-parchment/5 hover:bg-parchment/5 disabled:cursor-not-allowed disabled:opacity-60",
                          selected ? "bg-signal-teal/10" : ""
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm text-parchment truncate">
                            {t.title?.trim() || "Untitled conversation"}
                          </p>
                          {t.isActive && (
                            <Badge variant="online">Active</Badge>
                          )}
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[0.7rem] text-parchment/40">
                          <span>{formatThreadDate(t.updatedAt)}</span>
                          <span>
                            {t.messageCount} {t.messageCount === 1 ? "message" : "messages"}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {/*
          Conversation pane. Every thread is continuable now — sending
          a message while viewing an archived thread reactivates it
          server-side and continues the conversation, ChatGPT/Claude/
          Gemini-style. No archive banner, no read-only state.
        */}
        <Card className="p-0 overflow-hidden">
          <div
            ref={scrollRef}
            className="flex flex-col gap-3 max-h-[60vh] min-h-[340px] overflow-y-auto px-4 py-4"
          >
            {loading || loadingThread ? (
              <div className="text-sm text-parchment/40">Loading…</div>
            ) : messages.length === 0 ? (
              <div className="text-sm text-parchment/50">
                Say hi or ask your coworker anything — they&rsquo;ll remember context for this conversation.
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={[
                    "flex flex-col max-w-[88%] rounded-xl px-3 py-2",
                    m.role === "user"
                      ? "self-end bg-signal-teal/15 border border-signal-teal/30 text-parchment"
                      : "self-start bg-parchment/5 border border-parchment/10 text-parchment"
                  ].join(" ")}
                >
                  <div className="text-[0.78rem] uppercase tracking-wider text-parchment/40">
                    {m.role === "user" ? "You" : "Coworker"}
                    {m.createdAt ? (
                      <span className="normal-case tracking-normal ml-2 text-parchment/30">
                        {formatTime(m.createdAt)}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm leading-relaxed">
                    {m.role === "assistant" ? (
                      <ChatMarkdown text={m.content} />
                    ) : (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    )}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className="self-start text-xs text-parchment/40 italic">
                Your coworker is thinking…
              </div>
            )}
          </div>

          <form
            onSubmit={handleSubmit}
            className="border-t border-parchment/10 bg-deep-ink/40 px-4 py-3"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isPaused
                  ? "Your coworker is paused. Resume from the dashboard to chat."
                  : "Message your coworker. Enter to send, Shift+Enter for a newline."
              }
              disabled={sending || isPaused}
              maxLength={4000}
              rows={3}
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-parchment/40">
                {input.length}/4000
              </span>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={sending}
                disabled={sending || isPaused || !input.trim()}
              >
                Send
              </Button>
            </div>
          </form>
        </Card>
      </div>

      {error && (
        <Card className="border-spark-orange/50 bg-spark-orange/10">
          <p className="text-sm text-spark-orange">{error}</p>
        </Card>
      )}
    </div>
  );
}
