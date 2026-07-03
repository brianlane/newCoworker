"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SmsSegmentHint } from "./SmsSegmentHint";

type Props = {
  businessId: string;
  /** The thread's customer number / short code — the send destination. */
  toE164: string;
  /** True when this tenant's sends go RCS-first (softens the emoji hint). */
  rcsEnabled?: boolean;
};

/**
 * Reply box pinned under an SMS thread. Sends the typed text VERBATIM to the
 * thread's number (e.g. "CONFIRM" to a lead-source short code) via
 * /api/dashboard/messages/send, then refreshes the server-rendered thread so
 * the new outbound message appears inline.
 */
export function SmsThreadComposer({ businessId, toE164, rcsEnabled = false }: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();

  async function send() {
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, toE164, text })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { logged?: boolean };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message || `Could not send (${res.status}).`);
        return;
      }
      setText("");
      // Sent but not saved to history (e.g. owner_manual migration not applied
      // yet): a refresh wouldn't show it, so warn instead of silently dropping.
      if (json.data?.logged === false) {
        setError("Sent, but it couldn't be saved to history yet — it may not appear above.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline (chat convention).
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={1600}
          placeholder="Type a reply… (sent verbatim)"
          disabled={busy}
          className="flex-1 resize-none rounded-xl border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || trimmed.length === 0}
          className="rounded-xl bg-claw-green px-4 py-2.5 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      <SmsSegmentHint text={text} mode="verbatim" channel={rcsEnabled ? "rcs" : "sms"} />
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
