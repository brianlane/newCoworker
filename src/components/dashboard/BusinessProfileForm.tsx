"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import {
  BUSINESS_HOURS_DAYS,
  BUSINESS_HOURS_DAY_LABELS,
  type BusinessHours,
  type BusinessHoursDay
} from "@/lib/business-profile/profile";
import { BUSINESS_TYPE_OPTIONS } from "@/lib/onboarding/businessTypes";

type Status = { kind: "idle" | "saving" | "success" | "error"; message?: string };

type DayState = { open: boolean; from: string; to: string };

function initialDayState(hours: BusinessHours | null, day: BusinessHoursDay): DayState {
  const entry = hours?.[day];
  if (entry) return { open: true, from: entry.open, to: entry.close };
  return { open: false, from: "09:00", to: "17:00" };
}

/**
 * Settings → Business profile: structured address, industry, and per-day
 * hours. These feed the coworker's grounding directly (prompt + knowledge
 * lookup), so the copy makes that explicit.
 */
export function BusinessProfileForm({
  initialAddress,
  initialBusinessType,
  initialHours
}: {
  initialAddress: string | null;
  initialBusinessType: string | null;
  initialHours: BusinessHours | null;
}) {
  const router = useRouter();
  const [address, setAddress] = useState(initialAddress ?? "");
  const [businessType, setBusinessType] = useState(initialBusinessType ?? "");
  const [days, setDays] = useState<Record<BusinessHoursDay, DayState>>(() => {
    const out = {} as Record<BusinessHoursDay, DayState>;
    for (const day of BUSINESS_HOURS_DAYS) out[day] = initialDayState(initialHours, day);
    return out;
  });
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function setDay(day: BusinessHoursDay, patch: Partial<DayState>) {
    setDays((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    const hours: Record<string, { open: string; close: string } | null> = {};
    for (const day of BUSINESS_HOURS_DAYS) {
      const d = days[day];
      hours[day] = d.open ? { open: d.from, close: d.to } : null;
    }
    try {
      const res = await fetch("/api/account/business-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: address.trim(),
          // Always sent: "" clears the industry server-side. Omitting the
          // key would leave a previously-saved industry stuck forever.
          businessType,
          hours
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setStatus({
          kind: "error",
          message: body?.error?.message ?? "Something went wrong. Please try again."
        });
        return;
      }
      setStatus({
        kind: "success",
        message: "Business profile saved. Your coworker now answers with these details."
      });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Business profile</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Address, industry, and opening hours. Your coworker uses these to answer customer
        questions like &quot;when are you open?&quot; on calls, texts, and chat.
      </p>
      <form onSubmit={save} className="space-y-4">
        <Input
          label="Street address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={300}
          placeholder="123 Main St, Phoenix, AZ 85001"
        />
        <label className="block">
          <span className="block text-xs font-medium text-parchment/60 mb-1">Industry</span>
          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            className="w-full rounded-lg border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment focus:border-signal-teal focus:outline-none"
          >
            <option value="">Select an industry…</option>
            {BUSINESS_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        <div>
          <span className="block text-xs font-medium text-parchment/60 mb-2">Business hours</span>
          <div className="space-y-2">
            {BUSINESS_HOURS_DAYS.map((day) => {
              const d = days[day];
              return (
                <div key={day} className="flex items-center gap-3">
                  <label className="flex items-center gap-2 w-32 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={d.open}
                      onChange={(e) => setDay(day, { open: e.target.checked })}
                      className="accent-signal-teal"
                    />
                    <span className="text-sm text-parchment">
                      {BUSINESS_HOURS_DAY_LABELS[day]}
                    </span>
                  </label>
                  {d.open ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={d.from}
                        onChange={(e) => setDay(day, { from: e.target.value })}
                        className="rounded-lg border border-parchment/20 bg-deep-ink px-2 py-1 text-sm text-parchment focus:border-signal-teal focus:outline-none"
                      />
                      <span className="text-xs text-parchment/40">to</span>
                      <input
                        type="time"
                        value={d.to}
                        onChange={(e) => setDay(day, { to: e.target.value })}
                        className="rounded-lg border border-parchment/20 bg-deep-ink px-2 py-1 text-sm text-parchment focus:border-signal-teal focus:outline-none"
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-parchment/40">Closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" loading={status.kind === "saving"}>
            Save profile
          </Button>
          {status.kind === "success" && (
            <p className="text-xs text-claw-green">{status.message}</p>
          )}
          {status.kind === "error" && (
            <p className="text-xs text-spark-orange">{status.message}</p>
          )}
        </div>
      </form>
    </Card>
  );
}
