"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { formatDid } from "@/lib/telnyx/format";

type Props = {
  e164: string | null;
  bridgeHeartbeatAt: string | null;
  forwardToE164?: string | null;
  transferEnabled?: boolean;
};

function bridgeHealth(heartbeatAt: string | null): {
  variant: "success" | "error" | "neutral";
  label: string;
  hint: string;
} {
  if (!heartbeatAt) {
    return {
      variant: "neutral",
      label: "Warming up",
      hint: "Your voice bridge hasn't checked in yet. This is normal right after provisioning."
    };
  }
  const ageMs = Date.now() - new Date(heartbeatAt).getTime();
  if (Number.isNaN(ageMs)) return { variant: "neutral", label: "Unknown", hint: "" };
  if (ageMs < 3 * 60 * 1000) {
    return { variant: "success", label: "Ready", hint: "Your line is ready to take calls and texts." };
  }
  return {
    variant: "error",
    label: "Needs attention",
    hint: "Bridge is stale; our team has been alerted."
  };
}

export function PhoneNumberCard({ e164, bridgeHeartbeatAt, forwardToE164, transferEnabled }: Props) {
  const [copied, setCopied] = useState(false);
  const pretty = e164 ? formatDid(e164) : null;
  const bridge = bridgeHealth(bridgeHeartbeatAt);

  async function copy() {
    if (!e164) return;
    try {
      await navigator.clipboard.writeText(e164);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied; fall through */
    }
  }

  if (!e164) {
    return (
      <div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-parchment/40 uppercase tracking-wider">Your phone number</p>
          <Badge variant="pending">Provisioning</Badge>
        </div>
        <p className="mt-2 text-sm text-parchment/70">
          We&rsquo;re still assigning your number. Check back in a few minutes — you&rsquo;ll get
          an SMS when it&rsquo;s live.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-parchment/40 uppercase tracking-wider">Your phone number</p>
        <Badge variant={bridge.variant}>{bridge.label}</Badge>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <p className="text-2xl font-semibold text-parchment font-mono tracking-wide">{pretty}</p>
        <button
          type="button"
          onClick={copy}
          className="text-xs text-signal-teal hover:underline"
          aria-label="Copy phone number"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-xs text-parchment/50">{bridge.hint}</p>
      {forwardToE164 && transferEnabled !== false && (
        <p className="mt-2 text-xs text-parchment/60">
          Warm-transfers to{" "}
          <span className="font-mono text-parchment/80">{formatDid(forwardToE164)}</span>
          {" "}when a caller asks for a human.
        </p>
      )}
      {forwardToE164 && transferEnabled === false && (
        <p className="mt-2 text-xs text-parchment/40 italic">
          Warm transfer is currently off.
        </p>
      )}
    </div>
  );
}
