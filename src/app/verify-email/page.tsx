import Link from "next/link";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { verifyEmailVerificationToken } from "@/lib/email/verification-token";
import { ConfirmForm } from "./ConfirmForm";

export const dynamic = "force-dynamic";

type ServerOutcome =
  | { kind: "valid"; token: string; email: string }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "invalid" };

function resolveServerOutcome(rawToken: string | undefined): ServerOutcome {
  if (!rawToken) return { kind: "missing" };
  const verified = verifyEmailVerificationToken(rawToken);
  if (verified.ok) return { kind: "valid", token: rawToken, email: verified.email };
  if (verified.reason === "expired") return { kind: "expired" };
  return { kind: "invalid" };
}

type Props = {
  searchParams: Promise<{ token?: string | string[] }>;
};

/**
 * GET handler for the email-verification flow.
 *
 * CRITICAL CONTRACT: this page MUST NOT mutate any database row. Mailbox
 * safe-link scanners (Microsoft Safe Links, Mimecast, Proofpoint, Gmail
 * TLS inspector, etc.) GET-fetch URLs that arrive in inbound emails as
 * a security pre-flight, often before the human has even opened the
 * inbox. An earlier revision of this page called `markEmailVerifiedByEmail`
 * inline on the GET path, which silently consumed the verification on
 * the scanner's behalf — flipping `customer_profiles.email_verified_at`
 * for accounts whose owner never actually clicked the link. The
 * dashboard banner would then disappear with no user action, making the
 * verification signal worthless and removing the resend affordance for
 * users who genuinely needed it.
 *
 * Today this page only:
 *   1. Reads the HMAC-signed token from the URL.
 *   2. Decides which static screen to render (valid / expired / invalid /
 *      missing). Token verification is purely cryptographic — no DB
 *      reads, no side effects.
 *   3. For the `valid` branch, mounts {@link ConfirmForm}, which renders
 *      a button that POSTs to {@link confirmEmailVerificationAction}.
 *      That server action is the SINGLE place that flips the column.
 *
 * The signed-token + 7-day TTL are the credentials that authenticate
 * the human-side intent ("I have access to the inbox we sent this to");
 * the explicit POST submission is the credential that authenticates
 * the human-side action ("…and I'm choosing to confirm now"). Both
 * are required.
 */
export default async function VerifyEmailPage({ searchParams }: Props) {
  const sp = await searchParams;
  const rawToken = Array.isArray(sp.token) ? sp.token[0] : sp.token;
  const outcome = resolveServerOutcome(rawToken);
  const t = await getTranslations("auth");

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <Image
            src="/logo.png"
            alt="New Coworker"
            width={64}
            height={64}
            className="rounded-full mx-auto"
          />
          <h1 className="text-2xl font-bold text-parchment mt-6">
            {outcome.kind === "valid"
              ? t("verifyConfirmTitle")
              : outcome.kind === "expired"
                ? t("verifyExpiredTitle")
                : t("verifyInvalidTitle")}
          </h1>
          <p className="text-sm text-parchment/60 mt-2">
            {outcome.kind === "valid"
              ? t("verifyConfirmBlurb")
              : outcome.kind === "expired"
                ? t("verifyExpiredBlurb")
                : t("verifyInvalidBlurb")}
          </p>
        </div>

        {outcome.kind === "valid" ? (
          <ConfirmForm token={outcome.token} email={outcome.email} />
        ) : (
          <Card className="text-center">
            <Link
              href="/login"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
            >
              {t("signIn")}
            </Link>
          </Card>
        )}
      </div>
    </div>
  );
}
