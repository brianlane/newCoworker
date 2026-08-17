"use client";

import { useState, type FormEvent } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { PASSWORD_RULES, PASSWORD_MIN_LENGTH, getPasswordValidationError } from "@/lib/password";
import { changeAccountPassword } from "@/lib/account/password-change";
import { terminateOtherSessions } from "@/lib/auth/terminate-other-sessions";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { OwnLoginNotice } from "@/components/dashboard/OwnLoginNotice";

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
 * Settings → Account: the login email and password cards (split out of the
 * old AccountSettingsForms when Settings became a multi-page hub; the
 * business name/timezone cards live in BusinessBasicsForms on the Business
 * page).
 *
 * `email` is the account being administered, which under admin view-as is the
 * TENANT's login, not the signed-in operator's (see loadSettingsContext).
 *
 * The two cards split under view-as, and the notices say so:
 *   * Email is retargeted server-side, applies IMMEDIATELY (the operator has
 *     no confirmation link to click), and so gets different success copy.
 *   * Password is NOT retargeted. It runs in the browser against the caller's
 *     own Supabase session, so it changes the OPERATOR's password. Labeled
 *     rather than silently hidden, because an unlabeled password form on a
 *     page that otherwise represents the tenant is exactly how an operator
 *     rotates their own credentials by accident.
 */
export function AccountCredentialsForms({
  email,
  callerEmail,
  impersonating = false,
  impersonationNotice,
  ownLoginNotice
}: {
  email: string;
  /**
   * The SIGNED-IN user's own email. Only the password card uses it, and it
   * must not be the `email` above: `changeAccountPassword` re-authenticates
   * with `signInWithPassword({ email, currentPassword })` against the caller's
   * own browser session, so handing it the impersonated tenant's address would
   * fail every re-auth under view-as. Defaults to `email`, which is the same
   * value whenever nobody is impersonating.
   */
  callerEmail?: string;
  impersonating?: boolean;
  impersonationNotice?: string;
  ownLoginNotice?: string;
}) {
  // --- Email ---
  const [newEmail, setNewEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<Status>({ kind: "idle" });

  async function saveEmail(e: FormEvent) {
    e.preventDefault();
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed || trimmed === email.toLowerCase()) {
      setEmailStatus({
        kind: "error",
        message: impersonating
          ? "Enter a new email different from this account's current one."
          : "Enter a new email different from your current one."
      });
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
        // Two different flows, so two different truths. The owner's change
        // waits on confirmation links; an operator's applies on the spot,
        // and promising a link they will never receive would read as failure.
        message: impersonating
          ? `Done. This account's login is now ${trimmed}, effective immediately.`
          : `Almost done. We sent a confirmation link to both ${email} and ${trimmed}. Click the link in each inbox to finish the change. Your current email stays active until then.`
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
    const passwordError = getPasswordValidationError(newPassword);
    if (passwordError) {
      setPwStatus({ kind: "error", message: passwordError });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwStatus({ kind: "error", message: "New passwords do not match." });
      return;
    }
    setPwStatus({ kind: "saving" });
    try {
      const supabase = getSupabaseBrowserClient();
      const result = await changeAccountPassword(supabase.auth, {
        // The caller's own login, never the impersonated tenant's: this
        // re-authenticates the live browser session.
        email: callerEmail ?? email,
        currentPassword,
        newPassword
      });
      if (!result.ok) {
        setPwStatus({ kind: "error", message: result.message });
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // CASA 2.2.2: revoke other sessions after a successful password change.
      // Keep success messaging if termination fails; the password already changed.
      try {
        await terminateOtherSessions(supabase);
        setPwStatus({
          kind: "success",
          message: "Password updated. Other signed-in sessions were signed out."
        });
      } catch {
        setPwStatus({
          kind: "success",
          message:
            "Password updated, but other sessions could not be signed out automatically. Sign out everywhere from Settings if needed."
        });
      }
    } catch {
      setPwStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">Account email</h2>
        <OwnLoginNotice show={impersonating && Boolean(impersonationNotice)}>
          {impersonationNotice ?? ""}
        </OwnLoginNotice>
        <p className="text-xs text-parchment/40 mb-4">
          Current: <span className="text-parchment/70">{email}</span>.{" "}
          {impersonating
            ? "Changing it takes effect immediately."
            : "Changing it requires confirming from both your current address and the new one."}
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
              {impersonating ? "Change email now" : "Send confirmation"}
            </Button>
            <StatusLine status={emailStatus} />
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-1">Password</h2>
        <OwnLoginNotice show={impersonating && Boolean(ownLoginNotice)}>
          {ownLoginNotice ?? ""}
        </OwnLoginNotice>
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
            placeholder={`${PASSWORD_MIN_LENGTH}+ chars, upper, lower, number, symbol`}
          />
          <Input
            label="Confirm new password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
          <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
            <p className="font-medium text-parchment/75">Password rules</p>
            <ul className="mt-1 list-disc pl-4 space-y-1">
              {PASSWORD_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
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
