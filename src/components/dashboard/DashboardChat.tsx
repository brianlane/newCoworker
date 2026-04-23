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

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

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

async function parseEnvelope<T>(res: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await res.json()) as ApiEnvelope<T>;
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server response" }
    };
  }
}

function formatTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/chat?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const env = await parseEnvelope<ChatGetResponse>(res);
        if (cancelled) return;
        if (env.ok) {
          setMessages(env.data.messages);
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
  }, [businessId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  async function handleSubmit(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || sending || isPaused) return;

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
        "Start a new conversation? Previous messages stay archived but won't be shown here."
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
    <div className="flex flex-col gap-4 max-w-4xl">
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

      <Card className="p-0 overflow-hidden">
        <div
          ref={scrollRef}
          className="flex flex-col gap-3 max-h-[60vh] min-h-[340px] overflow-y-auto px-4 py-4"
        >
          {loading ? (
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

      {error && (
        <Card className="border-spark-orange/50 bg-spark-orange/10">
          <p className="text-sm text-spark-orange">{error}</p>
        </Card>
      )}
    </div>
  );
}
