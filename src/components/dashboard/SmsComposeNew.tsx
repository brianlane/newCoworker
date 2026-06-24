"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = { businessId: string };

// Mirror the server-side validation so the button disables before a doomed
// round-trip: E.164 or a bare 3-8 digit short code.
const PHONE_RE = /^(\+[1-9]\d{6,15}|\d{3,8})$/;

/**
 * "New message" composer on the Text history index. Sends a brand-new SMS to
 * an arbitrary number via /api/dashboard/messages/send, then routes the owner
 * into the resulting thread (which now has at least one logged message).
 */
export function SmsComposeNew({ businessId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toTrimmed = to.trim();
  const textTrimmed = text.trim();
  const canSend = PHONE_RE.test(toTrimmed) && textTrimmed.length > 0 && !busy;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, toE164: toTrimmed, text })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message || `Could not send (${res.status}).`);
        return;
      }
      setOpen(false);
      setText("");
      router.push(`/dashboard/messages/${encodeURIComponent(toTrimmed)}`);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
      >
        New message
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-parchment/15 bg-deep-ink/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-parchment">New message</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          className="text-xs text-parchment/50 transition-colors hover:text-parchment/80"
        >
          Cancel
        </button>
      </div>
      <input
        type="tel"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="+15551234567 or short code"
        disabled={busy}
        className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={1600}
        placeholder="Message (sent verbatim)"
        disabled={busy}
        className="w-full resize-none rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
