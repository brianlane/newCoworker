"use client";

/**
 * The Ask AI companion panel: the SAME conversation as /dashboard/chat
 * (same endpoints, same active thread, same Realtime+poll race via
 * useDashboardChatTransport), reachable from every dashboard page as a
 * slide-over. Deliberately leaner than the page: text-only composer (the
 * full chat keeps attachments and images), route-aware suggested prompts
 * on the empty state, and a Chat/History tab pair.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { History, MessageSquare, Plus, Sparkles, X } from "lucide-react";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
import {
  useDashboardChatTransport,
  type ChatDraft
} from "@/components/dashboard/useDashboardChatTransport";
import { stashDraftForEditor } from "@/components/dashboard/chat-draft-handoff";
import {
  companionPromptGroupForPath,
  companionPromptKeys
} from "@/lib/dashboard-chat/companion-prompts";

// Matches MAX_MESSAGE_CHARS in /api/dashboard/chat; the composer blocks
// instead of clipping, same policy as the full chat page.
const MAX_MESSAGE_CHARS = 16_000;

function formatThreadDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

type PanelProps = {
  businessId: string;
  onClose: () => void;
};

export function CompanionPanel({ businessId, onClose }: PanelProps) {
  const t = useTranslations("dashboard.companion");
  return (
    <>
      {/* Mobile backdrop; the panel is a full-screen sheet below sm. */}
      <button
        type="button"
        aria-label={t("launcher.close")}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-deep-ink/60 backdrop-blur-[2px] sm:hidden"
      />
      <div
        role="dialog"
        aria-label={t("panel.title")}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-parchment/10 bg-deep-ink shadow-2xl sm:w-[400px]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-parchment/10 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="h-4 w-4 shrink-0 text-claw-green" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-parchment truncate">{t("panel.title")}</p>
              <p className="text-[11px] text-parchment/40 truncate">{t("panel.subtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/dashboard/chat"
              onClick={onClose}
              className="rounded px-2 py-1 text-[11px] text-parchment/50 hover:bg-parchment/5 hover:text-parchment"
            >
              {t("panel.openFull")}
            </Link>
            <button
              type="button"
              aria-label={t("launcher.close")}
              onClick={onClose}
              className="rounded p-1.5 text-parchment/50 hover:bg-parchment/5 hover:text-parchment"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
        <CompanionChatBody businessId={businessId} onClose={onClose} />
      </div>
    </>
  );
}

function CompanionChatBody({ businessId, onClose }: { businessId: string; onClose: () => void }) {
  const t = useTranslations("dashboard.companion");
  const pathname = usePathname();
  const router = useRouter();
  const {
    messages,
    threads,
    drafts,
    sending,
    loading,
    loadingThread,
    error,
    isPaused,
    viewingThreadId,
    setError,
    send,
    selectThread,
    deleteThread,
    startNewConversation
  } = useDashboardChatTransport(businessId);

  const [tab, setTab] = useState<"chat" | "history">("chat");
  const [input, setInput] = useState("");
  // Two-tap delete: the first click arms THIS row's confirm (the button
  // turns into a labeled "Delete?"), the second click deletes. In-app
  // instead of window.confirm, whose native browser dialog reads like a
  // system alert.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const confirmResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmResetRef.current) clearTimeout(confirmResetRef.current);
    };
  }, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, tab]);

  async function submitText(text: string) {
    const trimmed = text.trim();
    // `loading` guards the first-open race: the hydrate GET unconditionally
    // replaces `messages`, so a send landing before it would be wiped from
    // the UI (Bugbot Medium on PR #1383).
    if (!trimmed || sending || loading || isPaused || trimmed.length > MAX_MESSAGE_CHARS) return;
    setInput("");
    setTab("chat");
    const outcome = await send(trimmed);
    if (outcome.restoreInput) setInput(trimmed);
  }

  function handleSubmit(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    void submitText(input);
  }

  function handleKeyDown(evt: KeyboardEvent<HTMLTextAreaElement>) {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      evt.currentTarget.form?.requestSubmit();
    }
  }

  function openDraft(draft: ChatDraft) {
    if (stashDraftForEditor(draft, (href) => router.push(href))) {
      // The editor opens UNDER the panel (full-width on mobile), so a
      // successful hand-off must close the companion or the navigation
      // looks like it failed (Bugbot Medium on PR #1383).
      onClose();
    } else {
      setError("Could not open the draft: your browser blocked session storage.");
    }
  }

  // No confirmation: starting over is non-destructive (the previous
  // conversation stays in History, continuable), and the native
  // window.confirm dialog read like a system alert.
  async function handleNewConversation() {
    if (sending) return;
    setTab("chat");
    await startNewConversation();
  }

  function armOrDeleteThread(threadId: string) {
    if (sending) return;
    if (confirmingDeleteId === threadId) {
      if (confirmResetRef.current) clearTimeout(confirmResetRef.current);
      setConfirmingDeleteId(null);
      void deleteThread(threadId);
      return;
    }
    setConfirmingDeleteId(threadId);
    if (confirmResetRef.current) clearTimeout(confirmResetRef.current);
    // Disarm on its own so a stray first click can't leave a live Delete
    // button waiting minutes later.
    confirmResetRef.current = setTimeout(() => setConfirmingDeleteId(null), 4000);
  }

  const promptKeys = companionPromptKeys(companionPromptGroupForPath(pathname ?? "/dashboard"));

  return (
    <>
      <div className="flex items-center gap-1 border-b border-parchment/10 px-2 py-1.5">
        <TabButton
          active={tab === "chat"}
          onClick={() => setTab("chat")}
          icon={<MessageSquare className="h-3.5 w-3.5" aria-hidden />}
          label={t("panel.tabChat")}
        />
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          icon={<History className="h-3.5 w-3.5" aria-hidden />}
          label={t("panel.tabHistory")}
        />
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void handleNewConversation()}
            disabled={sending || loading}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-parchment/50 hover:bg-parchment/5 hover:text-parchment disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t("panel.newConversation")}
          </button>
        </div>
      </div>

      {error && (
        <p className="border-b border-spark-orange/30 bg-spark-orange/10 px-4 py-2 text-xs text-spark-orange">
          {error}
        </p>
      )}

      {tab === "history" ? (
        <div className="flex-1 overflow-y-auto">
          {threads.length === 0 ? (
            <p className="px-4 py-4 text-xs text-parchment/40">
              {loading ? t("panel.loading") : t("panel.historyEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col">
              {threads.map((thread) => (
                <li key={thread.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      setTab("chat");
                      void selectThread(thread.id);
                    }}
                    disabled={sending || loading || loadingThread}
                    className={[
                      "w-full border-b border-parchment/5 px-4 py-2.5 text-left hover:bg-parchment/5 disabled:opacity-60",
                      thread.id === viewingThreadId ? "bg-signal-teal/10" : ""
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm text-parchment">
                        {thread.title?.trim() || t("panel.untitled")}
                      </p>
                      {thread.isActive && (
                        <span className="rounded-full border border-claw-green/40 bg-claw-green/10 px-1.5 text-[10px] text-claw-green">
                          {t("panel.active")}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] text-parchment/40">
                      <span>{formatThreadDate(thread.updatedAt)}</span>
                      <span>{t("panel.messageCount", { count: thread.messageCount })}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={t("panel.deleteConfirm")}
                    onClick={() => armOrDeleteThread(thread.id)}
                    disabled={sending || loading || loadingThread}
                    className={
                      confirmingDeleteId === thread.id
                        ? "absolute right-2 top-1.5 inline-flex rounded border border-spark-orange/60 bg-spark-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-spark-orange disabled:opacity-50"
                        : "absolute right-2 top-1.5 hidden rounded px-1 text-sm leading-none text-parchment/40 hover:text-spark-orange group-hover:inline-flex disabled:opacity-50"
                    }
                  >
                    {confirmingDeleteId === thread.id ? t("panel.confirmDelete") : "×"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {loading || loadingThread ? (
            <p className="text-sm text-parchment/40">{t("panel.loading")}</p>
          ) : messages.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-parchment/50">{t("panel.empty")}</p>
              <div className="mt-2 flex flex-col gap-2">
                {promptKeys.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void submitText(t(key))}
                    disabled={sending || loading || isPaused}
                    className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-left text-sm text-parchment/80 hover:border-signal-teal/40 hover:bg-signal-teal/10 disabled:opacity-50"
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={[
                  "flex max-w-[92%] flex-col rounded-xl px-3 py-2",
                  message.role === "user"
                    ? "self-end border border-signal-teal/30 bg-signal-teal/15 text-parchment"
                    : "self-start border border-parchment/10 bg-parchment/5 text-parchment"
                ].join(" ")}
              >
                <div className="text-sm leading-relaxed">
                  {message.role === "assistant" ? (
                    <ChatMarkdown text={message.content} />
                  ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  )}
                </div>
              </div>
            ))
          )}
          {sending && (
            <p className="self-start text-xs italic text-parchment/40">{t("panel.thinking")}</p>
          )}
          {drafts.length > 0 && (
            <div className="flex max-w-[92%] flex-col gap-2 self-start">
              {drafts.map((draft, index) => (
                <div
                  key={index}
                  className="rounded-xl border border-claw-green/40 bg-claw-green/5 px-3 py-2"
                >
                  <p className="text-xs font-semibold text-claw-green">
                    {draft.kind === "aiflow" ? t("panel.draftAiflow") : t("panel.draftAgent")}
                  </p>
                  <p className="mt-0.5 text-xs text-parchment/60">{t("panel.draftReview")}</p>
                  <button
                    type="button"
                    onClick={() => openDraft(draft)}
                    className="mt-2 inline-flex items-center rounded-md bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-claw-green/90"
                  >
                    {draft.kind === "aiflow" ? t("panel.draftOpenAiflow") : t("panel.draftOpenAgent")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t border-parchment/10 bg-deep-ink/40 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isPaused ? t("panel.pausedPlaceholder") : t("panel.inputPlaceholder")}
          disabled={sending || loading || isPaused}
          rows={2}
          className="w-full resize-none rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-parchment/30">{t("panel.attachHint")}</span>
          <button
            type="submit"
            disabled={
              sending || loading || isPaused || !input.trim() || input.trim().length > MAX_MESSAGE_CHARS
            }
            className="rounded-md bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-claw-green/90 disabled:opacity-50"
          >
            {t("panel.send")}
          </button>
        </div>
      </form>
    </>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs",
        active
          ? "bg-parchment/10 font-semibold text-parchment"
          : "text-parchment/50 hover:bg-parchment/5 hover:text-parchment"
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}
