"use client";

/**
 * The /dashboard/chat page shell. All transport state (optimistic send,
 * inline-vs-worker branch, the Realtime+poll race, thread management)
 * lives in useDashboardChatTransport, shared with the Ask AI companion
 * panel, while this component keeps the page-only concerns: the
 * composer, attachments (file / document / image), draft cards, confirm
 * dialogs, and layout.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { Badge } from "@/components/ui/Badge";
import { ChatMarkdown, chatImageFromLine } from "@/components/ui/ChatMarkdown";
import { parseEnvelope } from "@/lib/client/api-envelope";
import {
  useDashboardChatTransport,
  type ChatDraft
} from "@/components/dashboard/useDashboardChatTransport";
import { stashDraftForEditor } from "@/components/dashboard/chat-draft-handoff";

type Props = {
  businessId: string;
  businessName: string;
};

type DocumentOption = {
  id: string;
  title: string;
  status: string;
};

// Must match MAX_MESSAGE_CHARS in /api/dashboard/chat (route.ts). The
// composer BLOCKS an over-long send with a highlighted counter instead of
// the old maxLength attribute, which silently clipped pastes mid-sentence.
const MAX_MESSAGE_CHARS = 16_000;

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Message stamps carry the date once the message is no longer from today
// (and the year once it is no longer this year). A thread reopened days
// later used to show bare clock times, so "5:11 AM" from three weeks ago
// read as this morning (KYP Ads, Aug 2026: a Jul 30 roster change was
// mistaken for a fresh one).
function formatTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (sameCalendarDay(d, now)) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(d);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function formatThreadDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  if (sameCalendarDay(d, new Date())) {
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
    safeMode,
    viewingThreadId,
    setError,
    send,
    selectThread,
    deleteThread,
    startNewConversation
  } = useDashboardChatTransport(businessId);

  const [input, setInput] = useState("");
  // Trimmed length, the route validates AFTER trim(), so a paste with
  // trailing whitespace/newlines must not be blocked when its real body fits.
  const trimmedInputLength = input.trim().length;
  const inputTooLong = trimmedInputLength > MAX_MESSAGE_CHARS;
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // File/document attachment for the next turn (PDF / text / markdown / CSV,
  // read by the platform Gemini path; distinct from the image attach).
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null);
  const [attachedDocumentId, setAttachedDocumentId] = useState("");
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  // Two-tap delete (same pattern as the companion panel): first click arms
  // this row's confirm, second click deletes. In-app instead of the native
  // window.confirm dialog.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const confirmResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmResetRef.current) clearTimeout(confirmResetRef.current);
    };
  }, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Attach a photo: upload to the private generated-images bucket, then drop
  // its owner-authenticated proxy URL into the composer as image markdown.
  // The coworker sees the URL in the message and can pass it to
  // dashboard_generate_image (inputImageUrl) to edit the photo.
  const attachImage = useCallback(
    async (file: File) => {
      setUploadingImage(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("businessId", businessId);
        form.append("file", file);
        const res = await fetch("/api/dashboard/images", { method: "POST", body: form });
        const json = await parseEnvelope<{ imageUrl: string }>(res);
        if (!json.ok) {
          setError(json.error.message);
          return;
        }
        setInput((prev) =>
          `${prev.trimEnd()}${prev.trim() ? "\n" : ""}![Attached image](${json.data.imageUrl})\n`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Image upload failed");
      } finally {
        setUploadingImage(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [businessId, setError]
  );

  // Ready business documents for the attachment picker. Best-effort: on
  // failure the picker just stays empty (fresh uploads still work).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/documents?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const env = await parseEnvelope<{ documents?: DocumentOption[] }>(res);
        if (!cancelled && env.ok && env.data.documents) {
          setDocuments(env.data.documents.filter((d) => d.status === "ready"));
        }
      } catch {
        /* picker stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  function clearAttachment() {
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setAttachedFileName(null);
    setAttachedDocumentId("");
  }

  // Open a creation draft in its editor via the shared hand-off (one
  // sessionStorage contract for both shells; the companion panel uses the
  // same helper). Nothing is saved until the owner saves it there.
  function openDraft(draft: ChatDraft) {
    if (!stashDraftForEditor(draft, (href) => router.push(href))) {
      setError("Could not open the draft: your browser blocked session storage.");
    }
  }

  async function handleSubmit(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    const trimmed = input.trim();
    // Over-long input BLOCKS the send (highlighted counter) instead of
    // silently clipping, the old maxLength attribute truncated a pasted
    // onboarding brief mid-sentence with zero signal (KYP Ads, Jul 15).
    if (!trimmed || sending || isPaused || trimmed.length > MAX_MESSAGE_CHARS) return;

    // Attachment turns: a fresh file goes as multipart; a picked document
    // goes as documentId in the JSON body.
    const attachedFile = attachmentInputRef.current?.files?.[0] ?? null;

    setInput("");
    const outcome = await send(trimmed, {
      file: attachedFile,
      documentId: attachedDocumentId || undefined,
      // Clear the attachment UI the moment the server persisted the turn,
      // the same point the pre-extraction code cleared it.
      onPersisted: clearAttachment
    });
    // The message never reached the server (rate limit, network): restore
    // the textarea so resending is a single click.
    if (outcome.restoreInput) setInput(trimmed);
  }

  function handleKeyDown(evt: KeyboardEvent<HTMLTextAreaElement>) {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      evt.currentTarget.form?.requestSubmit();
    }
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
    confirmResetRef.current = setTimeout(() => setConfirmingDeleteId(null), 4000);
  }

  // No confirmation: starting over is non-destructive (the previous
  // conversation stays in the sidebar, continuable), and the native
  // window.confirm dialog read like a system alert.
  async function handleNewConversation() {
    if (sending) return;
    await startNewConversation();
  }

  return (
    <div className="flex flex-col gap-4 max-w-6xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Chat with your coworker</h1>
          <p className="text-sm text-parchment/50 mt-1">
            Private chat with {businessName}&rsquo;s AI, attach a file to work on it, or ask it
            to draft an automation or agent
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
                    <li key={t.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => selectThread(t.id)}
                        disabled={sending || loading || loadingThread}
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
                      <button
                        type="button"
                        aria-label="Delete conversation"
                        data-testid="thread-delete"
                        onClick={() => armOrDeleteThread(t.id)}
                        disabled={sending || loading || loadingThread}
                        className={
                          confirmingDeleteId === t.id
                            ? "absolute right-1.5 top-1.5 inline-flex items-center justify-center rounded border border-spark-orange/60 bg-spark-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-spark-orange disabled:opacity-50 cursor-pointer"
                            : "absolute right-1.5 top-1.5 hidden group-hover:inline-flex items-center justify-center rounded px-1 text-parchment/40 hover:text-spark-orange text-sm leading-none disabled:opacity-50 cursor-pointer"
                        }
                      >
                        {confirmingDeleteId === t.id ? "Delete?" : "×"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {/*
          Conversation pane. Every thread is continuable now; sending
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
                Say hi or ask your coworker anything; they&rsquo;ll remember context for this conversation.
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
                      <p className="whitespace-pre-wrap">
                        {m.content.split("\n").map((line, li) => {
                          // Owner-attached images (same-origin proxy markdown)
                          // render as thumbnails instead of raw markdown text.
                          const img = chatImageFromLine(line);
                          return (
                            <span key={li}>
                              {li > 0 && "\n"}
                              {img ? (
                                // eslint-disable-next-line @next/next/no-img-element -- proxy route, not a static asset
                                <img
                                  src={img.src}
                                  alt={img.alt}
                                  className="max-h-48 max-w-full rounded-lg border border-parchment/10"
                                  loading="lazy"
                                />
                              ) : (
                                line
                              )}
                            </span>
                          );
                        })}
                      </p>
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
            {drafts.length > 0 && (
              <div className="self-start flex flex-col gap-2 max-w-[88%]">
                {drafts.map((draft, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-claw-green/40 bg-claw-green/5 px-3 py-2"
                  >
                    <p className="text-xs font-semibold text-claw-green">
                      {draft.kind === "aiflow" ? "AiFlow draft ready" : "Agent draft ready"}
                    </p>
                    <p className="text-xs text-parchment/60 mt-0.5">
                      {draft.kind === "aiflow"
                        ? "Review the drafted automation in the builder, then save it there. It saves switched OFF: turn it on in the builder when you're ready, or it will never run."
                        : `"${draft.name}", review and save it on the Agents page. Nothing is saved yet.`}
                    </p>
                    {draft.kind === "aiflow" && draft.warnings.length > 0 && (
                      <p className="text-[11px] text-spark-orange mt-1">
                        {draft.warnings.length} thing{draft.warnings.length === 1 ? "" : "s"} to
                        review, shown in the builder.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => openDraft(draft)}
                      className="mt-2 inline-flex items-center rounded-md bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink hover:bg-opacity-90 transition-colors"
                    >
                      {draft.kind === "aiflow" ? "Open in AiFlows builder" : "Open in Agents"}
                    </button>
                  </div>
                ))}
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
              rows={3}
            />
            {(attachedFileName || attachedDocumentId) && (
              <div className="mt-2 flex items-center gap-2 text-xs text-parchment/60">
                <span className="rounded border border-signal-teal/40 bg-signal-teal/10 px-2 py-0.5">
                  {attachedFileName ??
                    `Document: ${
                      documents.find((d) => d.id === attachedDocumentId)?.title ?? "selected"
                    }`}
                </span>
                <button
                  type="button"
                  className="text-parchment/40 hover:text-parchment"
                  onClick={clearAttachment}
                >
                  Remove
                </button>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span
                className={
                  inputTooLong ? "text-xs font-semibold text-spark-orange" : "text-xs text-parchment/40"
                }
              >
                {trimmedInputLength.toLocaleString()}/{MAX_MESSAGE_CHARS.toLocaleString()}
                {inputTooLong && ", too long to send; trim it or attach it as a file"}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  data-testid="chat-image-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void attachImage(file);
                  }}
                />
                <input
                  ref={attachmentInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv"
                  className="hidden"
                  data-testid="chat-file-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setAttachedFileName(file.name);
                      setAttachedDocumentId("");
                    }
                  }}
                />
                {documents.length > 0 && !attachedFileName && (
                  <select
                    className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment/70 focus:border-signal-teal focus:outline-none max-w-44"
                    value={attachedDocumentId}
                    disabled={sending || isPaused}
                    onChange={(e) => setAttachedDocumentId(e.target.value)}
                  >
                    <option value="">Attach a document…</option>
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sending || isPaused}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  Attach file
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  loading={uploadingImage}
                  disabled={sending || isPaused || uploadingImage}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Attach image
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={sending}
                  disabled={sending || isPaused || !input.trim() || inputTooLong}
                >
                  Send
                </Button>
              </div>
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
