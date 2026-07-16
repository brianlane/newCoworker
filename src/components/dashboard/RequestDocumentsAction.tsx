"use client";

/**
 * "Request documents" quick action on the customer profile: staff list what
 * they need, the coworker texts the customer with the AI mailbox address to
 * send files to, and the contact is tagged `awaiting-documents` so open
 * requests are trackable (Contacts tag filter / task board). The
 * "Confirm document receipt" starter flow closes the loop when the files
 * arrive at the mailbox.
 *
 * Composed entirely from existing endpoints — the metered dashboard SMS
 * send and the contacts tag PATCH (which fires the normal tag_changed
 * automation hooks) — so it inherits their quota, validation, and audit
 * behavior.
 */

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export const AWAITING_DOCUMENTS_TAG = "awaiting-documents";

type Props = {
  businessId: string;
  customerE164: string;
  /** Display name used in the greeting ("" → generic greeting). */
  customerName: string;
  /** The AI coworker's inbound mailbox address the customer sends files to. */
  mailboxAddress: string;
  /** The contact's current tags (the PATCH replaces the whole set). */
  currentTags: string[];
};

export function RequestDocumentsAction({
  businessId,
  customerE164,
  customerName,
  mailboxAddress,
  currentTags
}: Props) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const alreadyAwaiting = currentTags.some(
    (t) => t.trim().toLowerCase() === AWAITING_DOCUMENTS_TAG
  );

  async function send() {
    const list = docs.trim().replace(/\s+/g, " ");
    if (!list) {
      setError("List the documents you need first.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const greeting = customerName.trim() ? `Hi ${customerName.trim().split(/\s+/)[0]}, ` : "Hi, ";
      const text =
        `${greeting}could you please send us: ${list}? ` +
        `You can email them to ${mailboxAddress} and I'll confirm as soon as they arrive. Thank you!`;
      const sendRes = await fetch("/api/dashboard/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, toE164: customerE164, text })
      });
      const sendJson = (await sendRes.json()) as { ok: boolean; error?: { message?: string } };
      if (!sendJson.ok) {
        setError(sendJson.error?.message ?? "Could not send the request");
        return;
      }
      // Tag AFTER the send succeeded so a quota refusal never leaves a
      // phantom "awaiting" state. Best-effort: a tag failure still counts
      // as sent (the text went out), it just isn't tracked.
      if (!alreadyAwaiting) {
        await fetch(
          `/api/dashboard/customers/${encodeURIComponent(customerE164)}?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags: [...currentTags, AWAITING_DOCUMENTS_TAG] })
          }
        ).catch(() => {});
      }
      setSent(true);
      setDocs("");
    } catch {
      setError("Could not send the request — try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-parchment">Request documents</h2>
          <p className="text-xs text-parchment/50 mt-0.5">
            Text this customer a list of documents to email to your AI mailbox
            {alreadyAwaiting ? " — a request is already outstanding" : ""}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Request"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <textarea
            className="w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none min-h-16"
            value={docs}
            onChange={(e) => setDocs(e.target.value)}
            placeholder="e.g. driver's license, proof of address, current policy declaration page"
            maxLength={600}
          />
          <div className="flex items-center gap-3">
            <Button type="button" variant="primary" size="sm" onClick={send} loading={sending}>
              Text the request
            </Button>
            {sent && <span className="text-xs text-claw-green">Request sent and tagged.</span>}
          </div>
          {error && (
            <p className="text-xs text-spark-orange" role="alert">
              {error}
            </p>
          )}
          <p className="text-[11px] text-parchment/40">
            Files arrive at {mailboxAddress}; install the “Confirm document receipt” flow on the
            AiFlows page to auto-confirm and get briefed. The {AWAITING_DOCUMENTS_TAG} tag tracks
            open requests.
          </p>
        </div>
      )}
    </Card>
  );
}
