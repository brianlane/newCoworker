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

type ChatPostResponse = {
  threadId: string;
  reply: string;
  messages: ChatMessage[];
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

  // The viewer is in "archived read-only mode" when it's pointed at a
  // thread that isn't the live active one. Cleanly derived from state
  // so individual handlers don't have to keep their own copy in sync.
  const isViewingArchive =
    viewingThreadId !== null && viewingThreadId !== activeThreadId;

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

  const selectThread = useCallback(
    async (threadId: string) => {
      if (sending || loadingThread) return;
      // Clicking the thread we're already on is a cheap no-op. Avoids a
      // pointless fetch and the accompanying flash of "Loading…".
      if (threadId === viewingThreadId) return;
      // Returning to the active thread: re-hydrate via the canonical
      // active-thread endpoint so we pick up any messages added by a
      // background tab and so the post path stays consistent with what's
      // rendered. Also re-sync `activeThreadId` from the response —
      // another tab may have hit "New conversation" since we hydrated,
      // archiving our local active id and minting a new one. Without
      // this, `viewingThreadId` would diverge from the stale
      // `activeThreadId`, `isViewingArchive` would flip back on, and
      // the composer would lock — clicking "Back to current" again
      // would just re-enter this same broken path. Every other code
      // path that fetches active-thread state updates BOTH ids; keep
      // this one consistent.
      if (threadId === activeThreadId) {
        setLoadingThread(true);
        setError(null);
        try {
          const res = await fetch(
            `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
            { cache: "no-store" }
          );
          const env = await parseEnvelope<ChatGetResponse>(res);
          if (env.ok) {
            setMessages(env.data.messages);
            setActiveThreadId(env.data.threadId);
            setViewingThreadId(env.data.threadId);
          } else {
            setError(env.error.message);
          }
        } catch {
          setError("Network error.");
        } finally {
          setLoadingThread(false);
        }
        return;
      }

      // Read-only archive view.
      setLoadingThread(true);
      setError(null);
      try {
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
    if (!trimmed || sending || isPaused || isViewingArchive) return;

    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString()
    };
    setMessages((prev) => [...prev, optimistic]);
    setInput("");
    setSending(true);
    setError(null);

    try {
      const res = await fetch("/api/dashboard/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, message: trimmed })
      });
      const env = await parseEnvelope<ChatPostResponse>(res);
      if (env.ok) {
        setMessages(env.data.messages);
        setActiveThreadId(env.data.threadId);
        setViewingThreadId(env.data.threadId);
        // Refresh sidebar so the active thread's bumped updatedAt + new
        // message_count appear without a hard reload.
        void fetchThreads();
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setInput(trimmed);
        setError(env.error.message);
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setInput(trimmed);
      setError("Network error while sending message.");
    } finally {
      setSending(false);
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
            Private chat with {businessName}&rsquo;s local AI. Runs on your own server; nothing is shared with other tenants.
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

        {/* Active conversation pane */}
        <Card className="p-0 overflow-hidden">
          {isViewingArchive && (
            <div className="border-b border-parchment/10 bg-signal-teal/5 px-4 py-2 flex items-center justify-between gap-3">
              <p className="text-xs text-signal-teal">
                Viewing an archived conversation (read-only).
              </p>
              {/*
                The escape hatch out of archive view MUST always render
                whenever isViewingArchive is true — otherwise the user is
                trapped with a locked composer and no obvious way back.
                Two regimes share the button:
                  - There IS an active thread: "Back to current" rehydrates
                    via selectThread() and unlocks the composer against it.
                  - There is NOT an active thread (post-"New conversation",
                    pre-first-send): "Start new conversation" clears the
                    viewer locally so isViewingArchive flips to false; the
                    next POST mints a fresh active thread.
              */}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (activeThreadId) {
                    void selectThread(activeThreadId);
                  } else {
                    setMessages([]);
                    setViewingThreadId(null);
                    setError(null);
                  }
                }}
                disabled={loadingThread}
              >
                {activeThreadId ? "Back to current" : "Start new conversation"}
              </Button>
            </div>
          )}

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
                isViewingArchive
                  ? activeThreadId
                    ? "Archived conversation — go back to current to send a new message."
                    : "Archived conversation — start a new conversation to send a message."
                  : isPaused
                    ? "Your coworker is paused. Resume from the dashboard to chat."
                    : "Message your coworker. Enter to send, Shift+Enter for a newline."
              }
              disabled={sending || isPaused || isViewingArchive}
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
                disabled={sending || isPaused || isViewingArchive || !input.trim()}
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
