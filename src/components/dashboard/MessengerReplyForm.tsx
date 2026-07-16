"use client";

/**
 * Manual owner reply box for a Messenger/Instagram DM thread. POSTs to
 * /api/dashboard/messenger/send (operate_messages), which gates on
 * Meta's 24h window and delivers through the same Send API path the AI
 * uses, then refreshes the server-rendered transcript.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type Props = {
  businessId: string;
  conversationId: string;
  /** Platform send ceiling: 2000 for Messenger/IG, 4096 for WhatsApp. */
  maxLength?: number;
  /** Drives the helper copy under the box (channel-accurate wording). */
  platform?: "messenger" | "instagram" | "whatsapp";
};

export function MessengerReplyForm({
  businessId,
  conversationId,
  maxLength = 2000,
  platform = "messenger"
}: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setSending(true);
    try {
      const res = await fetch("/api/dashboard/messenger/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, conversationId, text: trimmed })
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(json?.error?.message ?? "Could not send the reply");
        return;
      }
      setText("");
      router.refresh();
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="block text-xs text-parchment/50">Reply as your business</label>
        <textarea
          className="w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60"
          rows={3}
          maxLength={maxLength}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a reply…"
        />
        {error ? <p className="text-xs text-spark-orange">{error}</p> : null}
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-parchment/40">
            {platform === "whatsapp"
              ? "Sends on WhatsApp from your business number."
              : platform === "instagram"
                ? "Sends as an Instagram DM from your account."
                : "Sends on Messenger as your Page."}{" "}
            Your coworker keeps handling later messages automatically.
          </p>
          <Button type="submit" variant="secondary" size="sm" loading={sending} disabled={!text.trim()}>
            Send
          </Button>
        </div>
      </form>
    </Card>
  );
}
