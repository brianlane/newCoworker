"use client";

/**
 * Per-contact SMS reply mode control (contacts.sms_reply_mode).
 *
 * Three modes, persisted via PATCH /api/dashboard/customers/:e164:
 *   auto          — the assistant replies to this contact's texts (default).
 *   suppress      — no automatic reply. AiFlows you've set up and manual
 *                   sends from the thread still work.
 *   forward_owner — no automatic reply; the text is forwarded to the owner's
 *                   cell with "What would you like me to say?" and the
 *                   owner's reply is sent to the contact.
 *
 * Rendered on the contact profile page and the SMS thread page. The API
 * creates a minimal contact row when the number only has thread history.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { parseEnvelope } from "@/lib/client/api-envelope";
import type { SmsReplyMode } from "@/lib/customer-memory/types";

type Props = {
  businessId: string;
  customerE164: string;
  initialMode: SmsReplyMode;
};

const MODE_OPTIONS: Array<{ mode: SmsReplyMode; label: string; description: string }> = [
  {
    mode: "auto",
    label: "Auto-reply",
    description: "Your coworker replies to this contact's texts like normal."
  },
  {
    mode: "suppress",
    label: "Suppress replies",
    description:
      "No automatic replies to this contact. Your AiFlows and manual sends from this thread still work; use this for lead-source or bot numbers."
  },
  {
    mode: "forward_owner",
    label: "Suppress & ask me",
    description:
      "No automatic reply; their text is forwarded to your cell with \u201CWhat would you like me to say?\u201D and your reply is sent to them."
  }
];

export function ContactReplyModeToggle({ businessId, customerE164, initialMode }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<SmsReplyMode>(initialMode);
  const [saving, setSaving] = useState<SmsReplyMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(next: SmsReplyMode) {
    if (next === mode || saving) return;
    setError(null);
    setSaving(next);
    const prev = mode;
    setMode(next);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(customerE164)}?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ smsReplyMode: next })
        }
      );
      const env = await parseEnvelope<{ ok: boolean }>(res);
      if (!env.ok) {
        setError(env.error.message);
        setMode(prev);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error");
      setMode(prev);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Text replies</h2>
      <p className="text-xs text-parchment/50 mb-4">
        How your coworker handles texts from this contact.
      </p>
      <div className="flex flex-col gap-2">
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.mode;
          return (
            <button
              key={opt.mode}
              type="button"
              disabled={saving !== null}
              onClick={() => save(opt.mode)}
              aria-pressed={active}
              className={[
                "text-left rounded-lg border px-3 py-2.5 transition-colors disabled:opacity-60",
                active
                  ? "border-claw-green/60 bg-claw-green/10"
                  : "border-parchment/15 hover:border-parchment/30"
              ].join(" ")}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={[
                    "inline-block h-2 w-2 rounded-full",
                    active ? "bg-claw-green" : "bg-parchment/20"
                  ].join(" ")}
                />
                <span className="text-sm font-medium text-parchment">
                  {opt.label}
                  {saving === opt.mode && (
                    <span className="ml-2 text-xs text-parchment/40">saving…</span>
                  )}
                </span>
              </span>
              <span className="block text-xs text-parchment/50 mt-1 ml-4">
                {opt.description}
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-spark-orange mt-3">{error}</p>}
    </Card>
  );
}
