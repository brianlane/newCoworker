"use client";

import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("auth");
  const [result, formAction, pending] = useActionState<
    ConfirmEmailVerificationResult | null,
    FormData
  >(confirmEmailVerificationAction, null);

  if (result?.kind === "ok") {
    return (
      <Card className="text-center space-y-3">
        <p className="text-sm font-semibold text-claw-green">
          {result.alreadyVerified ? t("verifyAlreadyConfirmed") : t("verifyConfirmed")}
        </p>
        <p className="text-xs text-parchment/65">
          {result.alreadyVerified ? t("verifyAlreadyConfirmedBody") : t("verifyConfirmedBody")}
        </p>
        <Link
          href="/dashboard"
          className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
        >
          {t("goToDashboard")}
        </Link>
      </Card>
    );
  }

  if (result?.kind === "error") {
    const heading =
      result.reason === "expired"
        ? t("verifyExpiredTitle")
        : result.reason === "invalid" || result.reason === "missing_token"
          ? t("verifyInvalidTitle")
          : result.reason === "not_found"
            ? t("verifyNotFoundTitle")
            : t("verifyErrorTitle");
    const body =
      result.reason === "expired"
        ? t("verifyExpiredBlurb")
        : result.reason === "invalid" || result.reason === "missing_token"
          ? t("verifyInvalidBlurb")
          : result.reason === "not_found"
            ? t("verifyNotFoundBody")
            : t("verifyInternalBody");
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
            {t("tryAgain")}
          </button>
        ) : result.reason === "not_found" ? (
          // mailto: deliberately uses a plain <a> rather than next/link —
          // we don't want client-side navigation to intercept it, the
          // browser should hand off to the user's mail client.
          <a href="mailto:support@newcoworker.com" className={ctaClasses}>
            {t("contactSupport")}
          </a>
        ) : (
          <Link href="/login" className={ctaClasses}>
            {t("signIn")}
          </Link>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="text-center space-y-1">
        <p className="text-sm text-parchment/70">
          {t.rich("verifyClickBelow", {
            email,
            strong: (chunks: ReactNode) => (
              <span className="font-medium text-parchment/90">{chunks}</span>
            )
          })}
        </p>
        <p className="text-xs text-parchment/45">{t("verifyScannersNote")}</p>
      </div>
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pending ? t("confirming") : t("confirmEmail")}
        </button>
      </form>
    </Card>
  );
}
