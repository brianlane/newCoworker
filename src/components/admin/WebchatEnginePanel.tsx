"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";

/**
 * Admin → business → Web chat card body: shows the widget's state and
 * flips the REPLY ENGINE between the box chat-worker ('vps') and the
 * platform-side direct Gemini responder ('gemini'). Saves through
 * POST /api/admin/webchat/[businessId]; the poll route reads the stored
 * value per turn, so the flip applies to the visitor's next message with
 * no redeploy and no box contact.
 */

export type WebchatEngine = "vps" | "gemini";

export function WebchatEnginePanel({
  businessId,
  initialEngine,
  widgetConfigured,
  widgetEnabled
}: {
  businessId: string;
  initialEngine: WebchatEngine;
  widgetConfigured: boolean;
  widgetEnabled: boolean;
}) {
  const [engine, setEngine] = useState<WebchatEngine>(initialEngine);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async (next: WebchatEngine) => {
    setBusy(true);
    setStatus(null);
    // Snapshot for rollback: an optimistic flip that fails to persist must
    // revert, or the card lies about who is actually answering visitors.
    const prev = engine;
    setEngine(next);
    try {
      const res = await fetch(`/api/admin/webchat/${businessId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyEngine: next })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { replyEngine: WebchatEngine };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok || !json.data) {
        throw new Error(json?.error?.message ?? `Save failed (HTTP ${res.status})`);
      }
      setEngine(json.data.replyEngine);
      setStatus("Saved.");
    } catch (err) {
      setEngine(prev);
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-parchment/70">Widget</span>
        {widgetConfigured ? (
          <Badge variant={widgetEnabled ? "success" : "neutral"}>
            {widgetEnabled ? "enabled" : "disabled by owner"}
          </Badge>
        ) : (
          <Badge variant="neutral">not set up yet</Badge>
        )}
      </div>

      <fieldset className="space-y-2" disabled={busy}>
        <legend className="text-xs text-parchment/40 mb-1">Reply engine</legend>
        <label className="flex items-start gap-2 text-sm text-parchment/80 cursor-pointer">
          <input
            type="radio"
            name={`webchat-engine-${businessId}`}
            className="mt-1"
            checked={engine === "vps"}
            onChange={() => void save("vps")}
          />
          <span>
            <span className="font-medium text-parchment">VPS chat-worker</span>
            <span className="block text-xs text-parchment/40">
              Default. Replies come from the Rowboat agent on the tenant&apos;s box — requires a
              live, provisioned VPS.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-parchment/80 cursor-pointer">
          <input
            type="radio"
            name={`webchat-engine-${businessId}`}
            className="mt-1"
            checked={engine === "gemini"}
            onChange={() => void save("gemini")}
          />
          <span>
            <span className="font-medium text-parchment">Platform Gemini (no VPS)</span>
            <span className="block text-xs text-parchment/40">
              Replies are generated centrally with the same vault grounding, restricted webchat
              tools, and shared AI-budget metering. Use when the tenant has no live box (pooled /
              lapsed hardware).
            </span>
          </span>
        </label>
      </fieldset>

      {status && <p className="text-xs text-parchment/50">{status}</p>}
    </div>
  );
}
