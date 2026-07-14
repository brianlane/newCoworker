"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import DOMPurify from "dompurify";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { extractEmailAddress } from "@/lib/email/address";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { EmailComposer, type FromOption } from "@/components/dashboard/EmailComposer";
import type { EmailLogRow, EmailLogSource } from "@/lib/db/email-log";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { SearchControl } from "@/components/dashboard/SearchControl";
import { ConversationScroll } from "@/components/dashboard/ConversationScroll";
import { sortRows } from "@/lib/dashboard/sort";
import { usePersistentSort } from "@/components/dashboard/usePersistentSort";
import { matchesQuery } from "@/lib/dashboard/search";

const EMAIL_SORT_OPTIONS: SortOption[] = [
  { key: "created_at", label: "Date" },
  { key: "subject", label: "Subject" }
];

function emailSortValue(row: EmailLogRow, field: string): string | number | null | undefined {
  if (field === "subject") return row.subject;
  return row.created_at;
}

/**
 * Owner-facing email inbox.
 *
 * The server page (dashboard/emails) fetches `email_log` rows and hands them
 * here. Behaves like a normal mail client: a full-width list collapses into a
 * narrow left column when a message is opened, and the message is read in the
 * same view (a right-hand reading pane) — no modal. Sources are labelled +
 * colour-coded so the AI coworker's OWN dedicated mailbox (`tenant_mailbox_*`)
 * is visually distinct (signal-teal) from owner-mailbox / flow sends.
 *
 * The reading pane shows the full body (`body_full`), falling back to the stored
 * 500-char preview for older rows that predate full-body capture.
 */

type SourceMeta = { label: string; tagClass: string };

const SOURCE_META: Record<EmailLogSource, SourceMeta> = {
  tenant_mailbox_inbound: { label: "AI Mailbox", tagClass: "text-signal-teal" },
  tenant_mailbox_outbound: { label: "AI Mailbox", tagClass: "text-signal-teal" },
  email_trigger: { label: "Trigger", tagClass: "text-parchment/45" },
  owner_mailbox: { label: "Sent as you", tagClass: "text-parchment/45" },
  dashboard_chat: { label: "Chat", tagClass: "text-parchment/45" },
  sms_assistant: { label: "Texts", tagClass: "text-parchment/45" },
  voice_assistant: { label: "Call", tagClass: "text-parchment/45" },
  ai_flow: { label: "AiFlow", tagClass: "text-parchment/45" },
  owner_manual: { label: "You", tagClass: "text-claw-green" }
};

function sourceMeta(source: EmailLogSource): SourceMeta {
  return SOURCE_META[source] ?? SOURCE_META.ai_flow;
}

function DirectionBadge({ direction }: { direction: EmailLogRow["direction"] }) {
  const inbound = direction === "inbound";
  return (
    <span
      className={[
        "text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5",
        inbound ? "bg-signal-teal/15 text-signal-teal" : "bg-claw-green/15 text-claw-green"
      ].join(" ")}
    >
      {inbound ? "Received" : "Sent"}
    </span>
  );
}

/** Address → contact-profile link map (lowercase address keys), built server-side. */
type EmailContacts = Record<string, { customerE164: string; displayName: string | null }>;

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-parchment/5 last:border-0">
      <span className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-parchment/40">
        {label}
      </span>
      <span className="text-sm text-parchment break-all">{value}</span>
    </div>
  );
}

/**
 * From/To/Cc row: splits comma-separated recipient lists and links each
 * address that belongs to a known contact through to their profile page.
 * (Splitting on comma can separate the name half of a quoted
 * `"Last, First" <addr>` — that segment renders as plain text while the
 * `<addr>` half still resolves and links.)
 */
function RecipientsRow({
  label,
  value,
  emailContacts
}: {
  label: string;
  value: string | null;
  emailContacts: EmailContacts;
}) {
  const parts = (value ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className="flex gap-3 py-1.5 border-b border-parchment/5 last:border-0">
      <span className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-parchment/40">
        {label}
      </span>
      <span className="text-sm text-parchment break-all">
        {parts.length === 0
          ? "–"
          : parts.map((part, i) => {
              const addr = extractEmailAddress(part);
              const contact = addr ? emailContacts[addr] : undefined;
              return (
                <span key={`${part}-${i}`}>
                  {i > 0 ? ", " : ""}
                  {contact ? (
                    <Link
                      href={`/dashboard/customers/${encodeURIComponent(contact.customerE164)}`}
                      className="underline decoration-parchment/30 underline-offset-2 hover:text-claw-green transition-colors"
                    >
                      {part}
                      {contact.displayName ? (
                        <span className="text-parchment/60"> · {contact.displayName}</span>
                      ) : null}
                    </Link>
                  ) : (
                    part
                  )}
                </span>
              );
            })}
      </span>
    </div>
  );
}

type Attachment = {
  filename: string;
  mime_type: string;
  size_bytes: number;
  url: string | null;
};

type BodyState =
  | { status: "loading" }
  | {
      status: "loaded";
      bodyFull: string | null;
      bodyPreview: string | null;
      bodyHtml: string | null;
      attachments: Attachment[];
    }
  | { status: "error" };

/**
 * Sanitized srcdoc for the HTML reading pane. DOMPurify strips scripts, event
 * handlers, and other active content; WHOLE_DOCUMENT keeps the email's
 * <head><style> (most marketing mail styles via a head stylesheet). A
 * <base target="_blank"> is injected so every link opens in a new tab — the
 * iframe itself is sandboxed without scripts, and links escape via the
 * sandbox's allow-popups-to-escape-sandbox token.
 */
function sanitizedEmailDoc(html: string): string {
  const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true });
  const base = '<base target="_blank">';
  return /<head[\s>]/i.test(clean)
    ? clean.replace(/<head([^>]*)>/i, `<head$1>${base}`)
    : `${base}${clean}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reading pane. Mounted with a `key={row.id}` so it remounts (fresh state) per
 * selection — that lets us initialise to "loading" without a synchronous
 * setState in the effect. The full body is fetched on demand (the list omits it
 * to avoid pulling every message body), falling back to the row's preview while
 * loading or on error.
 */
function ReadingPane({
  row,
  businessId,
  canReply,
  emailContacts,
  onClose,
  onReply,
  onDeleted
}: {
  row: EmailLogRow;
  businessId: string;
  canReply: boolean;
  emailContacts: EmailContacts;
  onClose: () => void;
  onReply: () => void;
  onDeleted: () => void;
}) {
  const meta = sourceMeta(row.source);
  const [state, setState] = useState<BodyState>({ status: "loading" });
  const [deleteState, setDeleteState] = useState<"idle" | "deleting" | "error">("idle");

  async function deleteEmail() {
    if (!window.confirm("Delete this email from your history?")) return;
    setDeleteState("deleting");
    try {
      const res = await fetch(
        `/api/dashboard/emails/${row.id}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setDeleteState("error");
        return;
      }
      onDeleted();
    } catch {
      setDeleteState("error");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/dashboard/emails/${row.id}?businessId=${encodeURIComponent(businessId)}`, {
      signal: controller.signal
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as {
          data?: {
            body_full: string | null;
            body_preview: string | null;
            body_html?: string | null;
            attachments?: Attachment[];
          };
        };
        setState({
          status: "loaded",
          bodyFull: json.data?.body_full ?? null,
          bodyPreview: json.data?.body_preview ?? null,
          bodyHtml: json.data?.body_html ?? null,
          attachments: json.data?.attachments ?? []
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => controller.abort();
  }, [row.id, businessId]);

  // body_full === null means the row predates full-body capture (legacy preview
  // only). An empty string is a real captured body (e.g. an email with no text
  // part) and must NOT fall back to the preview note.
  const hasFullBody = state.status === "loaded" && state.bodyFull !== null;
  const loadedBody =
    state.status === "loaded" ? (hasFullBody ? state.bodyFull : state.bodyPreview) : row.body_preview;

  // Prefer the real HTML rendering when captured; the owner can flip to the
  // plain-text view. Sanitized once per message (memo keyed on the html).
  const bodyHtml = state.status === "loaded" ? state.bodyHtml : null;
  const [showPlain, setShowPlain] = useState(false);
  const emailDoc = useMemo(
    () => (bodyHtml && bodyHtml.trim().length > 0 ? sanitizedEmailDoc(bodyHtml) : null),
    [bodyHtml]
  );
  const renderHtml = emailDoc !== null && !showPlain;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <DirectionBadge direction={row.direction} />
          <span className={`text-[10px] uppercase tracking-wide font-mono ${meta.tagClass}`}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {canReply && (
            <button
              type="button"
              onClick={onReply}
              className="rounded-lg border border-claw-green/40 px-3 py-1 text-xs font-semibold text-claw-green transition-colors hover:bg-claw-green/10"
            >
              Reply
            </button>
          )}
          <button
            type="button"
            data-testid="email-delete"
            onClick={() => void deleteEmail()}
            disabled={deleteState === "deleting"}
            className="rounded-lg border border-spark-orange/40 px-3 py-1 text-xs font-semibold text-spark-orange transition-colors hover:bg-spark-orange/10 disabled:opacity-50"
          >
            {deleteState === "deleting" ? "Deleting…" : "Delete"}
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-parchment/40 hover:text-parchment text-xl leading-none"
          >
            ×
          </button>
        </div>
      </div>
      {deleteState === "error" && (
        <p className="mb-3 text-xs text-spark-orange">Couldn&apos;t delete — try again.</p>
      )}

      <h2 className="text-lg font-bold text-parchment mb-4 break-words">
        {row.subject || "(no subject)"}
      </h2>

      <div className="mb-4">
        <RecipientsRow label="From" value={row.from_email} emailContacts={emailContacts} />
        <RecipientsRow label="To" value={row.to_email} emailContacts={emailContacts} />
        {row.cc_email && (
          <RecipientsRow label="Cc" value={row.cc_email} emailContacts={emailContacts} />
        )}
        {row.bcc_email && <DetailRow label="Bcc" value={row.bcc_email} />}
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[11px] uppercase tracking-wide text-parchment/40">
            Date
          </span>
          <span className="text-sm text-parchment">
            <LocalDateTime iso={row.created_at} style="detail" />
          </span>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="block text-[11px] uppercase tracking-wide text-parchment/40">
            Message
          </span>
          <span className="flex items-center gap-3">
            {emailDoc !== null && (
              <button
                type="button"
                onClick={() => setShowPlain((v) => !v)}
                className="text-[10px] uppercase tracking-wide text-parchment/40 hover:text-parchment/80 transition-colors"
              >
                {showPlain ? "Rich view" : "Plain text"}
              </button>
            )}
            {state.status === "loading" && (
              <span className="text-[10px] text-parchment/40">Loading full message…</span>
            )}
          </span>
        </div>
        {renderHtml ? (
          // Sandboxed (no scripts, opaque origin) iframe: the email's own CSS
          // renders inside without leaking into the dashboard, and DOMPurify
          // has already stripped active content. allow-popups (+escape) lets
          // links — retargeted to _blank via an injected <base> — open in a
          // normal new tab.
          <iframe
            title="Email message"
            srcDoc={emailDoc}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            className="w-full h-[65vh] rounded-md border border-parchment/10 bg-white"
          />
        ) : (
          <div className="rounded-md border border-parchment/10 bg-deep-ink/40 p-3 text-sm text-parchment/90 whitespace-pre-wrap break-words">
            {loadedBody && loadedBody.length > 0 ? loadedBody : "(no body captured)"}
          </div>
        )}
        {state.status === "error" && (
          <p className="mt-1 text-[10px] text-spark-orange/80">
            Couldn&apos;t load the full message; showing the stored preview.
          </p>
        )}
        {state.status === "loaded" && !hasFullBody && !renderHtml && (
          <p className="mt-1 text-[10px] text-parchment/30">
            Stored preview (first 500 characters).
          </p>
        )}
      </div>

      {state.status === "loaded" && state.attachments.length > 0 && (
        <div className="mb-4">
          <span className="block text-[11px] uppercase tracking-wide text-parchment/40 mb-1.5">
            {state.attachments.length} attachment{state.attachments.length === 1 ? "" : "s"}
          </span>
          <ul className="space-y-1.5">
            {state.attachments.map((a, i) => {
              const inner = (
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-parchment/40">📎</span>
                  <span className="truncate text-parchment/90">{a.filename}</span>
                  <span className="shrink-0 text-[10px] text-parchment/40">
                    {formatBytes(a.size_bytes)}
                  </span>
                </span>
              );
              return (
                <li key={`${a.filename}-${i}`}>
                  {a.url ? (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 rounded-md border border-parchment/10 bg-deep-ink/40 px-3 py-2 text-sm hover:border-signal-teal/40 hover:bg-signal-teal/5 transition-colors"
                    >
                      {inner}
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-signal-teal">
                        Download
                      </span>
                    </a>
                  ) : (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-parchment/10 bg-deep-ink/40 px-3 py-2 text-sm opacity-60">
                      {inner}
                      <span className="shrink-0 text-[10px] text-parchment/40">Unavailable</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(row.provider_message_id || row.flow_id || row.run_id) && (
        <div className="pt-3 border-t border-parchment/10">
          <span className="block text-[11px] uppercase tracking-wide text-parchment/40 mb-1.5">
            Details
          </span>
          {row.provider_message_id && (
            <DetailRow label="Message-Id" value={row.provider_message_id} />
          )}
          {row.flow_id && <DetailRow label="Flow" value={row.flow_id} />}
          {row.run_id && <DetailRow label="Run" value={row.run_id} />}
        </div>
      )}
    </Card>
  );
}

type ComposerState =
  | { mode: "new" }
  // sourceId binds the draft to the message being replied to, so switching
  // messages can't leave a stale recipient/subject in the composer.
  | { mode: "reply"; sourceId: string; to: string; subject: string };

/** Enabled tenant_email flows offered as replay targets (built server-side). */
export type ReplayFlowOption = { id: string; name: string };

/** Inbound AI-mailbox mail that never matched a flow — the replayable set. */
function isUnmatchedInbound(row: EmailLogRow): boolean {
  return (
    row.direction === "inbound" &&
    row.source === "tenant_mailbox_inbound" &&
    !row.flow_id &&
    !row.run_id
  );
}

// Keep in sync with MAX_REPLAY_EMAILS in src/lib/email/replay.ts (not imported
// here to keep the server-only lib out of the client bundle).
const REPLAY_BATCH_CAP = 100;

type ReplayState =
  | { status: "idle" }
  | { status: "confirm"; flowId: string }
  | { status: "submitting"; flowId: string }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

/**
 * "Replay missed emails" panel: inbound AI-mailbox messages that arrived
 * while no flow was enabled (flow_id null) can be re-run through an enabled
 * tenant_email flow as BACKFILL runs — brand-new leads get filed + contacted;
 * leads already saved as contacts are filed-and-finished without outreach, so
 * a replay can never double-text.
 */
function ReplayPanel({
  businessId,
  unmatchedIds,
  flows,
  onReplayed
}: {
  businessId: string;
  unmatchedIds: string[];
  flows: ReplayFlowOption[];
  onReplayed: () => void;
}) {
  const [state, setState] = useState<ReplayState>({ status: "idle" });
  const batch = unmatchedIds.slice(0, REPLAY_BATCH_CAP);

  async function submit(flowId: string) {
    setState({ status: "submitting", flowId });
    try {
      const res = await fetch(
        `/api/dashboard/emails/replay?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId, emailLogIds: batch })
        }
      );
      const json = (await res.json().catch(() => null)) as {
        data?: { summary?: { enqueued: number; duplicates: number; skipped: number; errors: number } };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.data?.summary) {
        setState({
          status: "error",
          message: json?.error?.message ?? "Replay failed — try again in a minute."
        });
        return;
      }
      const s = json.data.summary;
      const parts = [`${s.enqueued} queued`];
      if (s.duplicates > 0) parts.push(`${s.duplicates} already replayed`);
      if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
      if (s.errors > 0) parts.push(`${s.errors} failed`);
      setState({
        status: "done",
        message: `${parts.join(", ")}. Leads already in your contacts are filed without re-texting.`
      });
      onReplayed();
    } catch {
      setState({ status: "error", message: "Replay failed — try again in a minute." });
    }
  }

  if (state.status === "done") {
    return (
      <div className="rounded-lg border border-signal-teal/30 bg-signal-teal/5 px-4 py-3 text-sm text-parchment/80">
        {state.message}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-spark-orange/30 bg-spark-orange/5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-parchment/80">
          <span className="font-semibold text-parchment">
            {unmatchedIds.length} inbox email{unmatchedIds.length === 1 ? "" : "s"}
          </span>{" "}
          arrived without an active flow — no contact was created and nobody was texted.
        </p>
        {(state.status === "idle" || state.status === "error") && (
          <button
            type="button"
            onClick={() => setState({ status: "confirm", flowId: flows[0].id })}
            className="rounded-lg border border-spark-orange/40 px-3 py-1.5 text-xs font-semibold text-spark-orange transition-colors hover:bg-spark-orange/10"
          >
            Replay through flow…
          </button>
        )}
      </div>
      {state.status === "error" && (
        <p className="mt-2 text-xs text-spark-orange">{state.message}</p>
      )}
      {(state.status === "confirm" || state.status === "submitting") && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label htmlFor="replay-flow" className="text-xs text-parchment/60">
            Flow
          </label>
          <select
            id="replay-flow"
            value={state.flowId}
            onChange={(e) => setState({ status: "confirm", flowId: e.target.value })}
            disabled={state.status === "submitting"}
            className="rounded-md border border-parchment/20 bg-deep-ink px-2 py-1.5 text-sm text-parchment"
          >
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => submit(state.flowId)}
            disabled={state.status === "submitting"}
            className="rounded-lg bg-spark-orange px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
          >
            {state.status === "submitting"
              ? "Replaying…"
              : `Replay ${batch.length} email${batch.length === 1 ? "" : "s"}`}
          </button>
          <button
            type="button"
            onClick={() => setState({ status: "idle" })}
            disabled={state.status === "submitting"}
            className="text-xs text-parchment/50 hover:text-parchment"
          >
            Cancel
          </button>
          <p className="w-full text-[11px] text-parchment/40">
            New leads run the full flow (contact + follow-up text). Leads already in your
            contacts are filed without any outreach.
          </p>
        </div>
      )}
    </div>
  );
}

/** The address to reply to: the other party on the message. */
function replyRecipient(row: EmailLogRow): string {
  return (row.direction === "inbound" ? row.from_email : row.to_email) ?? "";
}

// Keep in sync with the `subject` max in POST /api/dashboard/emails/send.
const MAX_SUBJECT_LEN = 150;

/**
 * Prefix "Re: " unless the subject already carries one, capped to the send
 * route's subject limit so replying to a near-limit subject can't produce a
 * prefilled value the API rejects.
 */
function replySubject(row: EmailLogRow): string {
  const subject = (row.subject ?? "").trim();
  const full = !subject ? "Re:" : /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  return full.length > MAX_SUBJECT_LEN ? full.slice(0, MAX_SUBJECT_LEN) : full;
}

/**
 * Default sender for a reply: reply AS the identity the thread used. Coworker
 * mailbox threads (tenant_mailbox_*) reply as the coworker (""); threads on the
 * owner's connected mailbox reply from the first connected mailbox when one is
 * available, falling back to the coworker. The owner can still change it.
 */
function replyFromId(row: EmailLogRow | undefined, fromOptions: FromOption[]): string {
  if (!row || row.source.startsWith("tenant_mailbox")) return "";
  return fromOptions.find((o) => o.id !== "")?.id ?? "";
}

export function EmailsList({
  rows,
  businessId,
  fromOptions = [],
  emailContacts = {},
  replayFlows = []
}: {
  rows: EmailLogRow[];
  businessId: string;
  /** Sender options for the composer's "From" picker (coworker mailbox first). */
  fromOptions?: FromOption[];
  /** Lowercase address → contact profile link (built server-side). */
  emailContacts?: EmailContacts;
  /** Enabled tenant_email flows offered as replay targets (built server-side). */
  replayFlows?: ReplayFlowOption[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const unmatchedIds = rows.filter(isUnmatchedInbound).map((r) => r.id);
  const [query, setQuery] = useState("");
  const [sort, setSort] = usePersistentSort(
    "dashboard.emails.sort",
    { field: "created_at", dir: "desc" },
    EMAIL_SORT_OPTIONS.map((o) => o.key)
  );
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  // Filter + sort the already-loaded page in the browser. Selection still
  // resolves against the full `rows`, so an open message stays open even if a
  // later query would hide it from the list.
  const visibleRows = sortRows(
    rows.filter((r) =>
      matchesQuery(query, [r.subject, r.from_email, r.to_email, r.body_preview])
    ),
    (r) => emailSortValue(r, sort.field),
    sort.dir
  );

  // The composer is intentionally independent of which message is open in the
  // reading pane: navigating (open another, close, Escape) never touches an
  // in-progress draft, so we can't silently drop unsent text. A reply is bound
  // to its source message via `sourceId` (in the remount key + prefill), and
  // only one composer is open at a time (the Reply/Compose buttons hide while
  // one is open), so a draft can't bleed across messages or send to the wrong
  // recipient. The composer is dismissed only by its own Cancel/Send.
  useEffect(() => {
    if (!selected) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <div className="space-y-4">
      {replayFlows.length > 0 && unmatchedIds.length > 0 && (
        <ReplayPanel
          businessId={businessId}
          unmatchedIds={unmatchedIds}
          flows={replayFlows}
          // Re-fetch the server rows so replayed mail shows its flow/run stamp
          // (and drops out of the unmatched count).
          onReplayed={() => router.refresh()}
        />
      )}
      <div className="flex justify-end">
        {!composer && (
          <button
            type="button"
            onClick={() => setComposer({ mode: "new" })}
            className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
          >
            Compose
          </button>
        )}
      </div>

      {composer && (
        <EmailComposer
          // Remount with fresh prefill whenever the target changes (new vs a
          // specific reply to a specific message), so initialTo/initialSubject
          // take effect and a stale draft can't carry over.
          key={
            composer.mode === "reply"
              ? `reply:${composer.sourceId}:${composer.to}:${composer.subject}`
              : "new"
          }
          businessId={businessId}
          title={composer.mode === "reply" ? "Reply" : "New email"}
          initialTo={composer.mode === "reply" ? composer.to : ""}
          initialSubject={composer.mode === "reply" ? composer.subject : ""}
          fromOptions={fromOptions}
          initialFromId={
            composer.mode === "reply"
              ? replyFromId(
                  rows.find((r) => r.id === composer.sourceId),
                  fromOptions
                )
              : ""
          }
          onCancel={() => setComposer(null)}
          onSent={() => setComposer(null)}
        />
      )}

      <div className="flex gap-4 items-start">
      {/* List column: full-width until a message is opened, then it collapses to
          a narrow left rail (hidden on mobile while reading). */}
      <div
        className={[
          "transition-all duration-300 ease-in-out",
          selected ? "hidden md:block md:w-72 lg:w-80 shrink-0" : "w-full"
        ].join(" ")}
      >
        {rows.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <SearchControl
              value={query}
              onChange={setQuery}
              placeholder="Search subject, sender, or body…"
              idPrefix="emails-search"
            />
            <SortControl
              options={EMAIL_SORT_OPTIONS}
              field={sort.field}
              dir={sort.dir}
              onChange={setSort}
              idPrefix="emails-sort"
            />
          </div>
        )}
        <Card padding="sm">
          {rows.length === 0 && (
            <div className="text-center py-8">
              <p className="text-parchment/60">No email activity yet.</p>
              <p className="text-xs text-parchment/40 mt-2">
                Use Compose to send one, or it will appear here once your coworker sends or
                receives email.
              </p>
            </div>
          )}
          {rows.length > 0 && visibleRows.length === 0 && (
            <div className="py-6 text-center text-sm text-parchment/50">
              No emails match “{query}”.
            </div>
          )}
          <ConversationScroll maxHeightClass="max-h-[70vh]" className="pr-1">
          <ul className="divide-y divide-parchment/10">
            {visibleRows.map((r) => {
              const meta = sourceMeta(r.source);
              const isActive = r.id === selectedId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={isActive ? "true" : undefined}
                    className={[
                      "w-full text-left px-3 py-3 rounded-md transition-colors focus:outline-none",
                      isActive
                        ? "bg-signal-teal/10 border-l-2 border-signal-teal"
                        : "hover:bg-parchment/5 focus:bg-parchment/5 border-l-2 border-transparent"
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <DirectionBadge direction={r.direction} />
                      <span
                        className={`text-[10px] uppercase tracking-wide font-mono ${meta.tagClass}`}
                      >
                        {meta.label}
                      </span>
                      <span className="text-sm font-semibold text-parchment truncate">
                        {r.subject || "(no subject)"}
                      </span>
                    </div>
                    <p className="text-xs text-parchment/60 mt-1 truncate">
                      {r.direction === "inbound"
                        ? `From ${r.from_email ?? "unknown"}`
                        : `To ${r.to_email ?? "unknown"}`}
                      {r.body_preview ? `: ${r.body_preview}` : ""}
                    </p>
                    {!selected && (r.cc_email || r.bcc_email) && (
                      <p className="text-[10px] text-parchment/40 mt-0.5 truncate">
                        {r.cc_email ? `Cc ${r.cc_email}` : ""}
                        {r.cc_email && r.bcc_email ? " · " : ""}
                        {r.bcc_email ? `Bcc ${r.bcc_email}` : ""}
                      </p>
                    )}
                    <p className="text-[10px] text-parchment/40 mt-0.5">
                      <LocalDateTime iso={r.created_at} />
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
          </ConversationScroll>
        </Card>
      </div>

      {/* Reading pane: opens in the same view to the right of the list. */}
      {selected && (
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="md:hidden mb-3 text-xs text-parchment/60 hover:text-parchment"
          >
            ← Back to inbox
          </button>
          <ReadingPane
            key={selected.id}
            row={selected}
            businessId={businessId}
            canReply={!composer}
            emailContacts={emailContacts}
            onClose={() => setSelectedId(null)}
            onReply={() =>
              setComposer({
                mode: "reply",
                sourceId: selected.id,
                to: replyRecipient(selected),
                subject: replySubject(selected)
              })
            }
            onDeleted={() => {
              setSelectedId(null);
              // Re-fetch the server rows so the deleted email drops out of
              // the list immediately.
              router.refresh();
            }}
          />
        </div>
      )}
      </div>
    </div>
  );
}
