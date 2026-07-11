"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type Status = { kind: "idle" | "saving" | "success" | "error"; message?: string };

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? "Something went wrong. Please try again.";
  } catch {
    return "Something went wrong. Please try again.";
  }
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "success") {
    return <p className="text-xs text-claw-green">{status.message}</p>;
  }
  if (status.kind === "error") {
    return <p className="text-xs text-spark-orange">{status.message}</p>;
  }
  return null;
}

/**
 * Settings → Business: the business name and timezone cards (split out of
 * the old AccountSettingsForms when Settings became a multi-page hub — the
 * login email/password cards live in AccountCredentialsForms on the Account
 * page).
 */
export function BusinessBasicsForms({
  businessName,
  businessTimezone
}: {
  businessName: string;
  businessTimezone: string | null;
}) {
  const router = useRouter();

  // --- Business name ---
  const [name, setName] = useState(businessName);
  const [nameStatus, setNameStatus] = useState<Status>({ kind: "idle" });

  // --- Timezone ---
  // Browser-detected zone pre-fills the picker when nothing is saved yet.
  // Detected in an effect (not at render) so the server-rendered HTML and
  // the client's first paint agree and hydration stays clean.
  const [detectedTz, setDetectedTz] = useState("");
  const [timezone, setTimezone] = useState(businessTimezone ?? "");
  const [tzStatus, setTzStatus] = useState<Status>({ kind: "idle" });
  const [tzOptions, setTzOptions] = useState<string[]>(businessTimezone ? [businessTimezone] : []);
  useEffect(() => {
    // Browser-only detection has to happen post-hydration; deferring the
    // state writes to a microtask keeps the effect itself render-clean
    // (react-hooks/set-state-in-effect) while still resolving before paint
    // matters for this below-the-fold card.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setDetectedTz(detected);
      setTzOptions(Intl.supportedValuesOf("timeZone"));
      setTimezone((prev) => prev || detected);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveTimezone(e: FormEvent) {
    e.preventDefault();
    const value = timezone.trim();
    if (!value || value === businessTimezone) return;
    setTzStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/account/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: value })
      });
      if (!res.ok) {
        setTzStatus({ kind: "error", message: await readApiError(res) });
        return;
      }
      setTzStatus({ kind: "success", message: "Timezone updated. Your coworker now thinks in this timezone." });
      router.refresh();
    } catch {
      setTzStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === businessName) return;
    setNameStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/account/business-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed })
      });
      if (!res.ok) {
        setNameStatus({ kind: "error", message: await readApiError(res) });
        return;
      }
      setNameStatus({ kind: "success", message: "Business name updated." });
      router.refresh();
    } catch {
      setNameStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">Business</h2>
        <p className="text-xs text-parchment/40 mb-4">The name shown across your dashboard.</p>
        <form onSubmit={saveName} className="space-y-3">
          <Input
            label="Business name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="Your business name"
          />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={nameStatus.kind === "saving"}
              disabled={!name.trim() || name.trim() === businessName}
            >
              Save
            </Button>
            <StatusLine status={nameStatus} />
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">Timezone</h2>
        <p className="text-xs text-parchment/40 mb-4">
          Your coworker uses this to talk about dates and times in your local time and to book
          appointments on the right local hour.
          {!businessTimezone && detectedTz && (
            <> Detected from your browser: <span className="text-parchment/70">{detectedTz}</span>.</>
          )}
        </p>
        <form onSubmit={saveTimezone} className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-parchment/60 mb-1">Business timezone</span>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-lg border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment focus:border-signal-teal focus:outline-none"
            >
              <option value="" disabled>
                Select a timezone…
              </option>
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={tzStatus.kind === "saving"}
              disabled={!timezone.trim() || timezone === businessTimezone}
            >
              Save
            </Button>
            <StatusLine status={tzStatus} />
          </div>
        </form>
      </Card>
    </>
  );
}
