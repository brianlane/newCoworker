"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { formatDid } from "@/lib/telnyx/format";
import { resolveBridgeHealthState, type BridgeHealthState } from "@/lib/telnyx/bridge-health";
import type { BusinessTelnyxMessagingCampaignStatus } from "@/lib/db/telnyx-routes";

type Props = {
  e164: string | null;
  bridgeHeartbeatAt: string | null;
  forwardToE164?: string | null;
  transferEnabled?: boolean;
  /**
   * Per-business 10DLC (A2P SMS) carrier-registration status. When `pending`
   * or `rejected` we show a callout explaining why outbound SMS may not be
   * delivering yet — Verizon/AT&T/T-Mobile silently drop A2P traffic from
   * unregistered numbers, and that failure mode is otherwise invisible to
   * the owner. Pass `null` if 10DLC isn't configured at the platform level
   * yet (e.g. during cold-start before the campaign is created).
   */
  smsCampaignStatus?: BusinessTelnyxMessagingCampaignStatus | null;
};

const TENANT_HEALTH_COPY: Record<
  BridgeHealthState,
  { variant: "success" | "error" | "neutral"; label: string; hint: string }
> = {
  pending: {
    variant: "neutral",
    label: "Warming up",
    hint: "Your voice bridge hasn't checked in yet. This is normal right after provisioning."
  },
  healthy: {
    variant: "success",
    label: "Ready",
    hint: "Your line is ready to take calls and texts."
  },
  stale: {
    variant: "error",
    label: "Needs attention",
    hint: "Bridge is stale; our team has been alerted."
  },
  unknown: { variant: "neutral", label: "Unknown", hint: "" }
};

/**
 * SMS-deliverability copy keyed off the 10DLC campaign status. Kept as a
 * pure function so we can unit-test the messaging without rendering React.
 */
export function resolveSmsCampaignCopy(
  status: BusinessTelnyxMessagingCampaignStatus | null | undefined
): { variant: "neutral" | "success" | "error" | "pending"; label: string; hint: string } | null {
  if (!status) return null;
  if (status === "registered") return null; // happy path — no banner
  if (status === "unregistered") return null;
  if (status === "rejected") {
    return {
      variant: "error",
      label: "SMS registration needs attention",
      hint:
        "US carriers rejected the most recent registration attempt for this number. " +
        "We'll automatically retry; outbound SMS may not deliver until this clears."
    };
  }
  // pending
  return {
    variant: "pending",
    label: "SMS being registered with carriers",
    hint:
      "Your number is being registered with US carriers (10DLC). " +
      "Inbound SMS works now; outbound replies may not deliver until registration " +
      "completes — typically 1-2 business days."
  };
}

export function PhoneNumberCard({
  e164,
  bridgeHeartbeatAt,
  forwardToE164,
  transferEnabled,
  smsCampaignStatus
}: Props) {
  const [copied, setCopied] = useState(false);
  const pretty = e164 ? formatDid(e164) : null;
  const bridge = TENANT_HEALTH_COPY[resolveBridgeHealthState(bridgeHeartbeatAt)];

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
      {(() => {
        const copy = resolveSmsCampaignCopy(smsCampaignStatus);
        if (!copy) return null;
        return (
          <div
            className="mt-3 rounded-md border border-parchment/15 bg-parchment/5 p-3"
            data-testid="sms-campaign-banner"
          >
            <div className="flex items-center gap-2">
              <Badge variant={copy.variant}>{copy.label}</Badge>
            </div>
            <p className="mt-2 text-xs text-parchment/70">{copy.hint}</p>
          </div>
        );
      })()}
    </div>
  );
}
