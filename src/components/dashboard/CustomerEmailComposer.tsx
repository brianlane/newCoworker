"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  businessId: string;
  customerE164: string;
  email: string;
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

/**
 * Owner-initiated "email this person" from the customer profile. Sends through
 * the owner's connected mailbox to the profile's linked address; on success the
 * outbound row rolls back up into the Email history above it.
 */
export function CustomerEmailComposer({ businessId, customerE164, email }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(
          customerE164
        )}/email?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subject.trim(), bodyText: body.trim() })
        }
      );
      if (!res.ok) throw new Error(await readError(res));
      setSubject("");
      setBody("");
      setOpen(false);
      setStatus("Sent.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-parchment/20 text-parchment/80 px-3 py-1.5 text-xs hover:bg-parchment/5 transition-colors"
        >
          Email this person
        </button>
        {status && <span className="text-xs text-claw-green/90">{status}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-parchment/10 pt-3">
      <p className="text-[11px] text-parchment/50">
        To <span className="font-mono text-parchment/70">{email}</span> — sent
        from your connected mailbox.
      </p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value.slice(0, 150))}
        placeholder="Subject"
        className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, 4000))}
        placeholder="Write your message…"
        rows={5}
        className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={sending || !subject.trim() || !body.trim()}
          className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {sending ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={sending}
          className="rounded-lg border border-parchment/20 text-parchment/70 px-4 py-2 text-sm hover:bg-parchment/5 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
