"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import type { TierLimits } from "@/lib/plans/limits";
import type { EnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";

function str(n: number | undefined): string {
  if (n === undefined) return "";
  if (!Number.isFinite(n)) return "";
  return String(n);
}

type ThrottleChoice = "inherit" | "true" | "false";

export function EnterpriseLimitsEditor({
  businessId,
  effectiveLimits,
  initialOverride
}: {
  businessId: string;
  effectiveLimits: TierLimits;
  initialOverride: EnterpriseLimitsOverride | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [voiceInc, setVoiceInc] = useState(str(initialOverride?.voiceIncludedSecondsPerStripePeriod));
  const [maxConc, setMaxConc] = useState(str(initialOverride?.maxConcurrentCalls));
  const [voiceDay, setVoiceDay] = useState(str(initialOverride?.voiceMinutesPerDay));
  const [smsMonth, setSmsMonth] = useState(str(initialOverride?.smsPerMonth));
  const [throttle, setThrottle] = useState<ThrottleChoice>(
    initialOverride?.smsThrottled === true ? "true" : initialOverride?.smsThrottled === false ? "false" : "inherit"
  );

  const built = useMemo((): EnterpriseLimitsOverride | null => {
    const o: EnterpriseLimitsOverride = {};
    if (voiceInc.trim()) {
      const n = Number(voiceInc);
      if (Number.isFinite(n)) o.voiceIncludedSecondsPerStripePeriod = Math.floor(n);
    }
    if (maxConc.trim()) {
      const n = Number(maxConc);
      if (Number.isFinite(n)) o.maxConcurrentCalls = Math.floor(n);
    }
    if (voiceDay.trim()) {
      const n = Number(voiceDay);
      if (Number.isFinite(n) && n > 0) o.voiceMinutesPerDay = n;
    }
    if (smsMonth.trim()) {
      const n = Number(smsMonth);
      if (Number.isFinite(n) && n > 0) o.smsPerMonth = n;
    }
    if (throttle === "true") o.smsThrottled = true;
    if (throttle === "false") o.smsThrottled = false;
    return Object.keys(o).length ? o : null;
  }, [voiceInc, maxConc, voiceDay, smsMonth, throttle]);

  async function save() {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, enterpriseLimits: built })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
      } else {
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function clearOverrides() {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/enterprise-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, enterpriseLimits: null })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Clear failed");
      } else {
        setVoiceInc("");
        setMaxConc("");
        setVoiceDay("");
        setSmsMonth("");
        setThrottle("inherit");
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <p className="text-parchment/50 text-xs">
        Leave a field empty to use the platform default. Current effective values: included voice{" "}
        {effectiveLimits.voiceIncludedSecondsPerStripePeriod}s / period · concurrent calls{" "}
        {effectiveLimits.maxConcurrentCalls}
        {effectiveLimits.voiceMinutesPerDay === Infinity
          ? " · daily voice: unlimited"
          : ` · daily voice: ${effectiveLimits.voiceMinutesPerDay} min`}
        {effectiveLimits.smsPerMonth === Infinity
          ? " · SMS: unlimited / month"
          : ` · SMS: ${effectiveLimits.smsPerMonth}/month`}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Included voice seconds (Stripe period)</span>
          <input
            className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-parchment"
            value={voiceInc}
            onChange={(e) => setVoiceInc(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 150000"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Max concurrent calls</span>
          <input
            className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-parchment"
            value={maxConc}
            onChange={(e) => setMaxConc(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 10"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Voice minutes / day (cap)</span>
          <input
            className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-parchment"
            value={voiceDay}
            onChange={(e) => setVoiceDay(e.target.value)}
            inputMode="numeric"
            placeholder="empty = unlimited"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">SMS / month</span>
          <input
            className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-parchment"
            value={smsMonth}
            onChange={(e) => setSmsMonth(e.target.value)}
            inputMode="numeric"
            placeholder="empty = unlimited"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">SMS throttle</span>
          <select
            className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-parchment"
            value={throttle}
            onChange={(e) => setThrottle(e.target.value as ThrottleChoice)}
          >
            <option value="inherit">Platform default (off)</option>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" onClick={save} loading={loading}>
          Save limits
        </Button>
        <Button size="sm" variant="secondary" onClick={clearOverrides} loading={loading}>
          Clear overrides
        </Button>
        {saved && <span className="text-xs text-claw-green">Saved</span>}
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
