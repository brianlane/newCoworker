import Link from "next/link";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { markEmailVerifiedByEmail } from "@/lib/db/customer-profiles";
import { verifyEmailVerificationToken } from "@/lib/email/verification-token";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type Outcome =
  | { kind: "ok"; alreadyVerified: boolean }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "error" };

async function resolveOutcome(token: string | undefined): Promise<Outcome> {
  if (!token) return { kind: "invalid" };

  const verified = verifyEmailVerificationToken(token);
  if (!verified.ok) {
    return verified.reason === "expired" ? { kind: "expired" } : { kind: "invalid" };
  }

  try {
    const result = await markEmailVerifiedByEmail(verified.email);
    if (!result.ok) return { kind: "not_found" };
    return { kind: "ok", alreadyVerified: result.alreadyVerified };
  } catch (err) {
    logger.error("verify-email: markEmailVerifiedByEmail failed", {
      email: verified.email,
      error: err instanceof Error ? err.message : String(err)
    });
    return { kind: "error" };
  }
}

function renderCopy(outcome: Outcome): { heading: string; body: string; cta: { label: string; href: string } } {
  switch (outcome.kind) {
    case "ok":
      return {
        heading: outcome.alreadyVerified ? "Email already confirmed" : "Email confirmed",
        body: outcome.alreadyVerified
          ? "Your email was already confirmed on this account. You're all set."
          : "Thanks for confirming your email — your account is fully secured.",
        cta: { label: "Go to Dashboard →", href: "/dashboard" }
      };
    case "expired":
      return {
        heading: "Verification link expired",
        body: "Verification links are valid for 7 days. Sign in and request a fresh one from the dashboard banner.",
        cta: { label: "Sign in", href: "/login" }
      };
    case "invalid":
      return {
        heading: "Invalid verification link",
        body: "This link doesn't look right. Sign in and request a fresh verification email from your dashboard.",
        cta: { label: "Sign in", href: "/login" }
      };
    case "not_found":
      return {
        heading: "We couldn't find your account",
        body: "We couldn't find a NewCoworker account for that email. Sign in to check the address on file, or contact support.",
        cta: { label: "Sign in", href: "/login" }
      };
    case "error":
    default:
      return {
        heading: "Something went wrong",
        body: "We hit a snag confirming your email. Please try again from your dashboard, or contact support if it persists.",
        cta: { label: "Sign in", href: "/login" }
      };
  }
}

type Props = {
  searchParams: Promise<{ token?: string | string[] }>;
};

export default async function VerifyEmailPage({ searchParams }: Props) {
  const sp = await searchParams;
  const rawToken = Array.isArray(sp.token) ? sp.token[0] : sp.token;
  const outcome = await resolveOutcome(rawToken);
  const { heading, body, cta } = renderCopy(outcome);

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
          <h1 className="text-2xl font-bold text-parchment mt-6">{heading}</h1>
          <p className="text-sm text-parchment/60 mt-2">{body}</p>
        </div>
        <Card className="text-center">
          <Link
            href={cta.href}
            className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            {cta.label}
          </Link>
        </Card>
      </div>
    </div>
  );
}
