"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type { EmailLogRow, EmailLogSource } from "@/lib/db/email-log";

/**
 * Owner-facing email list + detail modal.
 *
 * The server page (dashboard/emails) fetches `email_log` rows and hands them
 * here. We render a compact list where each row is keyboard-focusable and opens
 * a detail modal with everything `email_log` retains for that message. Sources
 * are labelled + colour-coded so the AI coworker's OWN dedicated mailbox
 * (`tenant_mailbox_*`) is visually distinct from owner-mailbox / flow sends.
 *
 * Note: `email_log` stores only a 500-char `body_preview`, not the full body,
 * so the modal shows that preview as the message text.
 */

type SourceMeta = { label: string; tagClass: string };

const SOURCE_META: Record<EmailLogSource, SourceMeta> = {
  tenant_mailbox_inbound: { label: "AI Mailbox", tagClass: "text-spark-orange" },
  tenant_mailbox_outbound: { label: "AI Mailbox", tagClass: "text-spark-orange" },
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

function EmailDetailModal({ row, onClose }: { row: EmailLogRow; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta = sourceMeta(row.source);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-deep-ink/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto bg-deep-ink border border-parchment/15 rounded-xl shadow-2xl p-5 sm:p-6">
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
          <div className="flex gap-3 py-1.5 border-b border-parchment/5">
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
            {row.body_preview && row.body_preview.length > 0 ? row.body_preview : "(no body captured)"}
          </div>
          <p className="mt-1 text-[10px] text-parchment/30">Stored preview (first 500 characters).</p>
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
      </div>
    </div>
  );
}

export function EmailsList({ rows }: { rows: EmailLogRow[] }) {
  const [selected, setSelected] = useState<EmailLogRow | null>(null);

  return (
    <>
      <Card padding="sm">
        <ul className="divide-y divide-parchment/10">
          {rows.map((r) => {
            const meta = sourceMeta(r.source);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r)}
                  className="w-full text-left px-3 py-3 rounded-md transition-colors hover:bg-parchment/5 focus:bg-parchment/5 focus:outline-none"
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
                  {(r.cc_email || r.bcc_email) && (
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

      {selected && <EmailDetailModal row={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
