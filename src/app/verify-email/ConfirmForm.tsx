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
 *   3. After action returns `kind: "error"`: error card. The reason
 *      carries through to the copy + the redirect target — `expired`
 *      and `invalid` route the user to /login (so they can request a
 *      fresh email from the dashboard banner), while `not_found` and
 *      `internal` keep them on the same page.
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
            ? "We couldn't find a NewCoworker account for that email. Sign in to check the address on file, or contact support."
            : "We hit a snag confirming your email. Please try again from your dashboard, or contact support if it persists.";
    const cta =
      result.reason === "expired" || result.reason === "invalid" || result.reason === "missing_token"
        ? { label: "Sign in", href: "/login" }
        : { label: "Sign in", href: "/login" };
    return (
      <Card className="text-center space-y-3">
        <p className="text-sm font-semibold text-spark-orange">{heading}</p>
        <p className="text-xs text-parchment/65">{body}</p>
        <Link
          href={cta.href}
          className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
        >
          {cta.label}
        </Link>
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
