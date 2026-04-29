"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";

type Props = {
  email: string;
};

type SendState = "idle" | "sending" | "sent" | "error";

/**
 * Dashboard banner shown while `customer_profiles.email_verified_at` is
 * null. The first verification email is sent inline from
 * `/api/onboard/set-password` immediately after user mint, so the most
 * common reason this banner shows up after onboarding is "the user
 * didn't click the link yet". The "Resend email" button gives them a
 * single-click recovery path that re-mints a fresh HMAC token and
 * dispatches a new email via `/api/email/send-verification` (which
 * pins the recipient to the signed-in user's account email — see that
 * route's docstring for why a body parameter would be a vector).
 *
 * This is intentionally a soft notice, not a hard gate. A hard gate
 * would prevent users from using their freshly-paid workspace if our
 * Resend integration is having a bad minute, which is a worse failure
 * mode than "this banner shows up briefly while the email lands".
 */
export function UnverifiedEmailBanner({ email }: Props) {
  const [state, setState] = useState<SendState>("idle");

  async function handleResend() {
    if (state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/email/send-verification", { method: "POST" });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <Card className="border-spark-orange/40 bg-spark-orange/10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-spark-orange">Confirm your email</p>
          <p className="text-xs text-parchment/65">
            We sent a verification link to{" "}
            <span className="font-medium text-parchment/90">{email}</span>. Click the link in
            that email to confirm your account.
          </p>
          {state === "sent" && (
            <p className="text-xs text-claw-green">Verification email resent. Check your inbox.</p>
          )}
          {state === "error" && (
            <p className="text-xs text-spark-orange">
              Could not resend right now. Please try again in a minute.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleResend}
          disabled={state === "sending"}
          className="self-start rounded-lg border border-spark-orange/40 px-4 py-2 text-xs font-semibold text-parchment hover:bg-spark-orange/10 transition-colors disabled:opacity-60 disabled:cursor-not-allowed sm:self-auto"
        >
          {state === "sending" ? "Sending…" : "Resend email"}
        </button>
      </div>
    </Card>
  );
}
