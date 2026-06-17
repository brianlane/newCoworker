"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { EmailLogRow, EmailLogSource } from "@/lib/db/email-log";

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
  ai_flow: { label: "AiFlow", tagClass: "text-parchment/45" }
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

type BodyState =
  | { status: "loading" }
  | { status: "loaded"; bodyFull: string | null; bodyPreview: string | null }
  | { status: "error" };

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
  onClose
}: {
  row: EmailLogRow;
  businessId: string;
  onClose: () => void;
}) {
  const meta = sourceMeta(row.source);
  const [state, setState] = useState<BodyState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/dashboard/emails/${row.id}?businessId=${encodeURIComponent(businessId)}`, {
      signal: controller.signal
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as {
          data?: { body_full: string | null; body_preview: string | null };
        };
        setState({
          status: "loaded",
          bodyFull: json.data?.body_full ?? null,
          bodyPreview: json.data?.body_preview ?? null
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

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <DirectionBadge direction={row.direction} />
          <span className={`text-[10px] uppercase tracking-wide font-mono ${meta.tagClass}`}>
            {meta.label}
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-parchment/40 hover:text-parchment text-xl leading-none"
        >
          ×
        </button>
      </div>

      <h2 className="text-lg font-bold text-parchment mb-4 break-words">
        {row.subject || "(no subject)"}
      </h2>

      <div className="mb-4">
        <DetailRow label="From" value={row.from_email ?? "—"} />
        <DetailRow label="To" value={row.to_email ?? "—"} />
        {row.cc_email && <DetailRow label="Cc" value={row.cc_email} />}
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
          {state.status === "loading" && (
            <span className="text-[10px] text-parchment/40">Loading full message…</span>
          )}
        </div>
        <div className="rounded-md border border-parchment/10 bg-deep-ink/40 p-3 text-sm text-parchment/90 whitespace-pre-wrap break-words">
          {loadedBody && loadedBody.length > 0 ? loadedBody : "(no body captured)"}
        </div>
        {state.status === "error" && (
          <p className="mt-1 text-[10px] text-spark-orange/80">
            Couldn&apos;t load the full message — showing the stored preview.
          </p>
        )}
        {state.status === "loaded" && !hasFullBody && (
          <p className="mt-1 text-[10px] text-parchment/30">
            Stored preview (first 500 characters).
          </p>
        )}
      </div>

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

export function EmailsList({ rows, businessId }: { rows: EmailLogRow[]; businessId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return (
    <div className="flex gap-4 items-start">
      {/* List column: full-width until a message is opened, then it collapses to
          a narrow left rail (hidden on mobile while reading). */}
      <div
        className={[
          "transition-all duration-300 ease-in-out",
          selected ? "hidden md:block md:w-72 lg:w-80 shrink-0" : "w-full"
        ].join(" ")}
      >
        <Card padding="sm">
          <ul className="divide-y divide-parchment/10">
            {rows.map((r) => {
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
                      {r.body_preview ? ` — ${r.body_preview}` : ""}
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
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
