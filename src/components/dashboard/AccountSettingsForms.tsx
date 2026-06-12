"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

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

export function AccountSettingsForms({
  businessName,
  businessTimezone,
  email
}: {
  businessName: string;
  businessTimezone: string | null;
  email: string;
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

  // --- Email ---
  const [newEmail, setNewEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<Status>({ kind: "idle" });

  async function saveEmail(e: FormEvent) {
    e.preventDefault();
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed || trimmed === email.toLowerCase()) {
      setEmailStatus({ kind: "error", message: "Enter a new email different from your current one." });
      return;
    }
    setEmailStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed })
      });
      if (!res.ok) {
        setEmailStatus({ kind: "error", message: await readApiError(res) });
        return;
      }
      setNewEmail("");
      setEmailStatus({
        kind: "success",
        message: `Almost done — we sent a confirmation link to ${trimmed}. Click it to finish the change. Your current email stays active until then.`
      });
    } catch {
      setEmailStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  // --- Password ---
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwStatus, setPwStatus] = useState<Status>({ kind: "idle" });

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      setPwStatus({ kind: "error", message: "New password must be at least 8 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwStatus({ kind: "error", message: "New passwords do not match." });
      return;
    }
    setPwStatus({ kind: "saving" });
    try {
      const supabase = getSupabaseBrowserClient();
      // Re-authenticate with the current password before allowing a change, so a
      // hijacked-but-logged-in session can't silently rotate the password.
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword
      });
      if (reauthError) {
        setPwStatus({ kind: "error", message: "Current password is incorrect." });
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setPwStatus({ kind: "error", message: updateError.message });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwStatus({ kind: "success", message: "Password updated." });
    } catch {
      setPwStatus({ kind: "error", message: "Network error. Please try again." });
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

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">Account email</h2>
        <p className="text-xs text-parchment/40 mb-4">
          Current: <span className="text-parchment/70">{email}</span>. Changing it requires
          confirming the new address by email.
        </p>
        <form onSubmit={saveEmail} className="space-y-3">
          <Input
            label="New email"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="you@business.com"
            autoComplete="email"
          />
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" loading={emailStatus.kind === "saving"} disabled={!newEmail.trim()}>
              Send confirmation
            </Button>
            <StatusLine status={emailStatus} />
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">Password</h2>
        <p className="text-xs text-parchment/40 mb-4">
          Enter your current password to set a new one.
        </p>
        <form onSubmit={savePassword} className="space-y-3">
          <Input
            label="Current password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
          <Input
            label="New password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="At least 8 characters"
          />
          <Input
            label="Confirm new password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={pwStatus.kind === "saving"}
              disabled={!currentPassword || !newPassword || !confirmPassword}
            >
              Update password
            </Button>
            <StatusLine status={pwStatus} />
          </div>
        </form>
      </Card>
    </>
  );
}
