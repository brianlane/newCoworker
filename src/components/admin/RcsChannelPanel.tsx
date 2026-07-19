"use client";

/**
 * Admin RCS channel control ("Messaging channel (RCS)" card on the admin
 * business page).
 *
 * Operator console for `business_channel_settings`: the Telnyx RCS agent id
 * and the per-tenant enable switch. This is only one leg of the send-time
 * gate — outbound RCS additionally requires the enterprise tier
 * (`rcsTierAllowed`), so the panel shows a warning (rather than hiding) when
 * the tier would demote sends to plain SMS anyway.
 *
 * Toggling takes effect on the tenant's NEXT send: the channel gate is read
 * per message, no deploy or restart involved.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function RcsChannelPanel({
  businessId,
  initialAgentId,
  initialEnabled,
  tierAllows
}: {
  businessId: string;
  initialAgentId: string | null;
  initialEnabled: boolean;
  /** Whether the tenant's tier passes rcsTierAllowed (enterprise-only). */
  tierAllows: boolean;
}) {
  const router = useRouter();
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Local baseline of what the server currently holds, advanced on every
  // successful save. Comparing against props instead would leave `dirty`
  // stuck true until a server refresh, so the "Saved." hint could never
  // show and the Save button would stay armed after a successful write.
  const [baseline, setBaseline] = useState<{ agentId: string | null; enabled: boolean }>({
    agentId: initialAgentId,
    enabled: initialEnabled
  });

  const dirty = enabled !== baseline.enabled || (agentId.trim() || null) !== baseline.agentId;
  const effectivelyOn = enabled && agentId.trim().length > 0 && tierAllows;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/rcs-channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          rcsAgentId: agentId.trim() || null,
          rcsEnabled: enabled
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
      } else {
        setBaseline({ agentId: agentId.trim() || null, enabled });
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-parchment/40">Channel</span>
        <span
          className={[
            "rounded-full border px-3 py-0.5 text-xs font-medium",
            effectivelyOn
              ? "border-signal-teal/40 bg-signal-teal/10 text-signal-teal"
              : "border-parchment/20 bg-parchment/5 text-parchment/50"
          ].join(" ")}
        >
          {effectivelyOn ? "RCS-first (SMS fallback)" : "Plain SMS"}
        </span>
      </div>

      {!tierAllows && (
        <p className="rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-2 text-xs text-spark-orange">
          This tenant&apos;s tier is not RCS-eligible (enterprise only) — settings here are
          saved but sends stay plain SMS until the tier allows it.
        </p>
      )}

      <label className="block space-y-1">
        <span className="text-xs text-parchment/40">Telnyx RCS agent id</span>
        <input
          type="text"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setSaved(false);
          }}
          placeholder="e.g. new_coworker_jut3q1af_agent"
          disabled={saving}
          className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
        />
      </label>

      <label className="flex items-center gap-2 text-sm text-parchment/70">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setSaved(false);
          }}
          disabled={saving}
          className="h-4 w-4 accent-claw-green"
        />
        RCS enabled (customer-facing sends go RCS-first with SMS fallback)
      </label>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
          Save
        </Button>
        {saved && !dirty && <span className="text-xs text-claw-green">Saved.</span>}
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
      <p className="text-[11px] text-parchment/35">
        Takes effect on the tenant&apos;s next send — the gate is read per message. The agent
        must have a messaging profile AND webhook_url set on the Telnyx side or inbound RCS
        replies are silently dropped (see PRDs/tier-economics-jul-2026.md).
      </p>
    </div>
  );
}
