"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  businessId: string;
  /** Heading for the panel, e.g. "New email" or "Reply". */
  title: string;
  /** Prefilled recipient (reply). */
  initialTo?: string;
  /** Prefilled subject (reply uses the "Re:" form). */
  initialSubject?: string;
  /** Prefilled cc, comma-separated. */
  initialCc?: string;
  onCancel: () => void;
  /** Called after a fully-logged send so the parent can collapse/refresh. */
  onSent?: () => void;
};

// Mirror the server-side z.string().email() strictness so the Send button
// disables before a doomed round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Owner email composer — used for both "compose new" and "reply in thread".
 * Sends from the owner's connected mailbox via /api/dashboard/emails/send and
 * refreshes the server-rendered Emails list so the new `owner_manual` row
 * appears. The subject + body go out exactly as typed (plain text).
 */
export function EmailComposer({
  businessId,
  title,
  initialTo = "",
  initialSubject = "",
  initialCc = "",
  onCancel,
  onSent
}: Props) {
  const router = useRouter();
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [showCc, setShowCc] = useState(initialCc.trim().length > 0);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Latches true once a send succeeds but the row couldn't be logged. The
  // message already went out, so we lock the form to stop the owner editing +
  // re-sending the same content into a duplicate.
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // On open, bring the panel into view and focus a field. It mounts above the
  // split list/reading layout, so on mobile (where the reading pane fills the
  // viewport) it can otherwise appear off-screen and look like nothing
  // happened. A reply has its recipient prefilled, so focus the body; a new
  // email focuses the recipient.
  useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const field = initialTo.trim() ? bodyRef.current : toRef.current;
    field?.focus();
  }, [initialTo]);

  const toTrimmed = to.trim();
  const subjectTrimmed = subject.trim();
  const bodyTrimmed = body.trim();
  const canSend =
    EMAIL_RE.test(toTrimmed) &&
    subjectTrimmed.length > 0 &&
    bodyTrimmed.length > 0 &&
    !busy &&
    !sent;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dashboard/emails/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          toEmail: toTrimmed,
          subject,
          bodyText: body,
          ...(cc.trim() ? { cc: cc.trim() } : {})
        })
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
      // Sent, but the row couldn't be saved (e.g. the owner_manual migration
      // isn't applied). Don't refresh into a list that won't show it. Latch
      // `sent` so the (already-delivered) message can't be edited and re-sent
      // into a duplicate — the owner closes the panel via Cancel.
      if (json.data?.logged === false) {
        setNotice(
          "Sent — but it couldn't be saved to the Emails list yet, so it may not appear here. Close this panel; don't resend."
        );
        setSent(true);
        return;
      }
      onSent?.();
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Once a send latches `sent` (delivered but unlogged), lock the inputs so the
  // same message can't be edited and re-sent.
  const locked = busy || sent;

  return (
    <div
      ref={containerRef}
      className="w-full space-y-2 rounded-xl border border-parchment/15 bg-deep-ink/40 p-3 scroll-mt-4"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-parchment">{title}</span>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs text-parchment/50 transition-colors hover:text-parchment/80"
        >
          {sent ? "Close" : "Cancel"}
        </button>
      </div>
      <input
        ref={toRef}
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="To (name@example.com)"
        disabled={locked}
        className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      {showCc ? (
        <input
          type="text"
          value={cc}
          onChange={(e) => setCc(e.target.value)}
          placeholder="Cc (comma-separated)"
          disabled={locked}
          className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowCc(true)}
          disabled={locked}
          className="text-[11px] text-parchment/50 transition-colors hover:text-parchment/80"
        >
          + Add Cc
        </button>
      )}
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        maxLength={150}
        disabled={locked}
        className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        maxLength={4000}
        placeholder="Message (sent verbatim, plain text)"
        disabled={locked}
        className="w-full resize-y rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      {error && <p className="text-xs text-red-300">{error}</p>}
      {notice && <p className="text-xs text-spark-orange/90">{notice}</p>}
      {!sent && (
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
      )}
    </div>
  );
}
