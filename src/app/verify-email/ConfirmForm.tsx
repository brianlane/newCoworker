"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Card } from "@/components/ui/Card";
import {
  confirmEmailVerificationAction,
  type ConfirmEmailVerificationResult
} from "./actions";

type Props = {
  token: string;
  email: string;
};

/**
 * Client-side host for the explicit "Confirm your email" form.
 *
 * The render is one of three states:
 *   1. Initial (no submission yet): show the email + a primary button
 *      whose `formAction` is the server action. The button submits a
 *      hidden `token` field carried over from the URL — there's nothing
 *      else the user can change.
 *   2. After action returns `kind: "ok"`: success card. Distinguishes
 *      first-confirm vs. idempotent replay via `alreadyVerified` so the
 *      copy doesn't lie if the user lands here twice.
 *   3. After action returns `kind: "error"`: error card. The CTA
 *      shape branches on `reason` because the recovery affordance is
 *      genuinely different per failure mode:
 *        - `expired` / `invalid` / `missing_token` → Sign in (`/login`):
 *          the link is unrecoverable from this page, but the dashboard's
 *          "Resend email" banner can mint a fresh token. Sign in.
 *        - `not_found` → Contact support (`mailto:`): no profile exists
 *          for the email in the token, so signing in won't help — there
 *          is no account to log into. Hand off to humans.
 *        - `internal` → Try again (`window.location.reload()`): the
 *          token itself is valid (we already cryptographically
 *          validated it on GET), so a transient DB blip from
 *          `markEmailVerifiedByEmail` is recoverable just by retrying
 *          the same submission against the same token. Reload re-runs
 *          the server-side validation and re-mounts the confirm form.
 *
 * `useActionState` is React 19's replacement for `useFormState`; it
 * gives us the action result in-component without an extra fetch +
 * setState dance, and Next.js handles the Origin/Host same-origin
 * check on the underlying POST automatically.
 */
export function ConfirmForm({ token, email }: Props) {
  const [result, formAction, pending] = useActionState<
    ConfirmEmailVerificationResult | null,
    FormData
  >(confirmEmailVerificationAction, null);

  if (result?.kind === "ok") {
    return (
      <Card className="text-center space-y-3">
        <p className="text-sm font-semibold text-claw-green">
          {result.alreadyVerified ? "Email already confirmed" : "Email confirmed"}
        </p>
        <p className="text-xs text-parchment/65">
          {result.alreadyVerified
            ? "This email was already confirmed on your account. You're all set."
            : "Thanks for confirming your email — your account is fully secured."}
        </p>
        <Link
          href="/dashboard"
          className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
        >
          Go to Dashboard →
        </Link>
      </Card>
    );
  }

  if (result?.kind === "error") {
    const heading =
      result.reason === "expired"
        ? "Verification link expired"
        : result.reason === "invalid" || result.reason === "missing_token"
          ? "Invalid verification link"
          : result.reason === "not_found"
            ? "We couldn't find your account"
            : "Something went wrong";
    const body =
      result.reason === "expired"
        ? "Verification links are valid for 7 days. Sign in and request a fresh one from the dashboard banner."
        : result.reason === "invalid" || result.reason === "missing_token"
          ? "This link doesn't look right. Sign in and request a fresh verification email from your dashboard."
          : result.reason === "not_found"
            ? "We couldn't find a NewCoworker account for the email on this verification link. Reach out to support and we'll help you sort it out."
            : "We hit a snag confirming your email. Try again — your verification link is still valid.";
    const ctaClasses =
      "inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors";
    return (
      <Card className="text-center space-y-3">
        <p className="text-sm font-semibold text-spark-orange">{heading}</p>
        <p className="text-xs text-parchment/65">{body}</p>
        {result.reason === "internal" ? (
          // Token was cryptographically valid (the page-level GET already
          // verified it before mounting this component) so a transient
          // failure inside `markEmailVerifiedByEmail` is recoverable by
          // simply re-running the same submission. A full reload re-renders
          // the server component, which re-validates the token and mounts
          // a fresh confirm form for the user to click again.
          <button type="button" onClick={() => window.location.reload()} className={ctaClasses}>
            Try again
          </button>
        ) : result.reason === "not_found" ? (
          // mailto: deliberately uses a plain <a> rather than next/link —
          // we don't want client-side navigation to intercept it, the
          // browser should hand off to the user's mail client.
          <a href="mailto:support@newcoworker.com" className={ctaClasses}>
            Contact support
          </a>
        ) : (
          <Link href="/login" className={ctaClasses}>
            Sign in
          </Link>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="text-center space-y-1">
        <p className="text-sm text-parchment/70">
          Click below to confirm{" "}
          <span className="font-medium text-parchment/90">{email}</span> as the email on your
          NewCoworker account.
        </p>
        <p className="text-xs text-parchment/45">
          We require this extra click so automated mailbox scanners can&apos;t confirm your account
          on your behalf.
        </p>
      </div>
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pending ? "Confirming…" : "Confirm email"}
        </button>
      </form>
    </Card>
  );
}
