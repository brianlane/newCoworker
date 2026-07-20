"use client";

/**
 * Admin contact-form sink control ("Contact form (platform)" card on the
 * admin business page).
 *
 * Operator console for `businesses.contact_form_sink`: when ON, public
 * /contact submissions ALSO enqueue a webhook-channel AiFlow event
 * (source "contact_form") for THIS business — how the internal HQ tenant
 * triages the site's contact form. At most one business fleet-wide can be
 * the sink; enabling here moves the designation and the panel says whose
 * it was. The notification email to CONTACT_EMAIL is unchanged either way.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function ContactFormSinkPanel({
  businessId,
  initialEnabled,
  currentSinkBusinessId
}: {
  businessId: string;
  initialEnabled: boolean;
  /** The business currently holding the designation (null = none). */
  currentSinkBusinessId: string | null;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [baseline, setBaseline] = useState(initialEnabled);

  const dirty = enabled !== baseline;
  const otherSink = currentSinkBusinessId && currentSinkBusinessId !== businessId;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/contact-form-sink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, enabled })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
      } else {
        setBaseline(enabled);
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
        <span className="text-xs text-parchment/40">Sink</span>
        <span
          className={[
            "rounded-full border px-3 py-0.5 text-xs font-medium",
            baseline
              ? "border-signal-teal/40 bg-signal-teal/10 text-signal-teal"
              : "border-parchment/20 bg-parchment/5 text-parchment/50"
          ].join(" ")}
        >
          {baseline ? "Receiving contact-form events" : "Not the sink"}
        </span>
      </div>

      {otherSink && !enabled && (
        <p className="rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-2 text-xs text-spark-orange">
          Another business currently holds the designation ({currentSinkBusinessId}) —
          enabling here moves it (one sink fleet-wide).
        </p>
      )}

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
        Contact-form sink (public /contact submissions also start this business&apos;s
        webhook AiFlows, source &quot;contact_form&quot;)
      </label>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
          Save
        </Button>
        {saved && !dirty && <span className="text-xs text-claw-green">Saved.</span>}
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
      <p className="text-[11px] text-parchment/35">
        Best-effort and additive: the CONTACT_EMAIL notification mail is sent either way,
        and a flow-event failure never breaks the public form. Takes effect on the next
        submission.
      </p>
    </div>
  );
}
