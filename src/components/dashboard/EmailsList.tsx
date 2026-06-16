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

function ReadingPane({ row, onClose }: { row: EmailLogRow; onClose: () => void }) {
  const meta = sourceMeta(row.source);
  const body = row.body_full && row.body_full.length > 0 ? row.body_full : row.body_preview;

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
        <span className="block text-[11px] uppercase tracking-wide text-parchment/40 mb-1.5">
          Message
        </span>
        <div className="rounded-md border border-parchment/10 bg-deep-ink/40 p-3 text-sm text-parchment/90 whitespace-pre-wrap break-words">
          {body && body.length > 0 ? body : "(no body captured)"}
        </div>
        {!row.body_full && (
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

export function EmailsList({ rows }: { rows: EmailLogRow[] }) {
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
          <ReadingPane row={selected} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}
