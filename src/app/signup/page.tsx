"use client";

import { Suspense, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import type { AppLocale } from "@/i18n/routing";
import { buildSignupAuthMetadata } from "@/lib/onboarding/auth-metadata";
import { ONBOARD_STORAGE_KEY } from "@/lib/onboarding/storage";
import { getPasswordRules, getPasswordValidationError } from "@/lib/password";
import { clearStaleSupabaseAuthCookies, getSupabaseBrowserClient } from "@/lib/supabase/browser";

type StoredOnboardingData = {
  businessName?: string;
  ownerEmail?: string;
  [key: string]: unknown;
};

function readStoredOnboardingData(): StoredOnboardingData | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(ONBOARD_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as StoredOnboardingData) : null;
  } catch {
    return null;
  }
}

function readPrefilledOwnerEmail(): string {
  const stored = readStoredOnboardingData();
  return typeof stored?.ownerEmail === "string" ? stored.ownerEmail : "";
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const t = useTranslations("auth");
  const locale = useLocale() as AppLocale;
  const passwordRules = getPasswordRules(locale);
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? "/onboard";
  const tier = searchParams.get("tier");
  const period = searchParams.get("period");
  const loginHref = `/login?redirectTo=${encodeURIComponent(redirectTo)}${tier ? `&tier=${encodeURIComponent(tier)}` : ""}`;
  // Default deep-link back into the questionnaire keeps users on the review step (where
  // the persisted onboarding data lands them anyway). The "Change it" email link below
  // appends `&step=1` so the user actually arrives on the step that owns the email field
  // — otherwise the questionnaire's hydration logic drops them on step 3 (review), which
  // has no email input and turns the link into a dead-end.
  const questionnaireBaseHref = `/onboard/questionnaire?tier=${encodeURIComponent(tier ?? "starter")}&period=${encodeURIComponent(period ?? "biennial")}`;
  const questionnaireEditEmailHref = `${questionnaireBaseHref}&step=1`;

  const [email, setEmail] = useState(() => readPrefilledOwnerEmail());
  // Track whether the email came from the onboarding questionnaire so we can render it
  // as a non-editable confirmation line (matching `/onboard/success`) instead of a duplicate input.
  const [emailFromOnboarding] = useState(() => readPrefilledOwnerEmail().length > 0);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [businessName, setBusinessName] = useState(() => {
    const onboarding = readStoredOnboardingData();
    return typeof onboarding?.businessName === "string" ? onboarding.businessName : "";
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmationPending, setConfirmationPending] = useState(false);

  async function handleSignup(e: FormEvent) {
    e.preventDefault();
    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setError(t("passwordsDoNotMatch"));
      return;
    }
    setLoading(true);
    setError(null);

    const onboardingData = readStoredOnboardingData();
    const onboardingDataWithLatestBusinessName = onboardingData
      ? { ...onboardingData, businessName }
      : null;

    // Scrub stale `sb-*` auth cookies before kicking off the new signup so
    // the eventual /api/auth/callback request (when the user clicks the
    // confirmation email) carries at most a fresh PKCE code-verifier. Without
    // this, accumulated chunked auth-token cookies from prior abandoned
    // sessions can blow past Vercel's ~32 KB header limit and trigger a 494
    // REQUEST_HEADER_TOO_LARGE at the edge — which we can't recover from
    // server-side because Vercel rejects the request before middleware runs.
    await clearStaleSupabaseAuthCookies();

    const supabase = getSupabaseBrowserClient();
    const encodedRedirect = encodeURIComponent(redirectTo);
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: buildSignupAuthMetadata(businessName, onboardingDataWithLatestBusinessName),
        emailRedirectTo: `${window.location.origin}/api/auth/callback?redirectTo=${encodedRedirect}`
      }
    });

    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    if (signUpData.session) {
      router.push(redirectTo);
      return;
    }

    const identities = signUpData.user?.identities ?? [];
    if (identities.length === 0) {
      setError(t("accountExists"));
      return;
    }

    setConfirmationPending(true);
  }

  if (confirmationPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full" />
            <h1 className="text-2xl font-bold text-parchment">{t("checkYourEmail")}</h1>
            <p className="text-sm text-parchment/50 max-w-xs">
              {t.rich("confirmationSent", {
                email,
                strong: (chunks: ReactNode) => (
                  <span className="text-parchment font-medium">{chunks}</span>
                )
              })}
            </p>
          </div>
          <Card>
            <p className="text-xs text-parchment/40 text-center">
              {t.rich("didntReceive", {
                retry: (chunks: ReactNode) => (
                  <button
                    type="button"
                    onClick={() => setConfirmationPending(false)}
                    className="text-signal-teal hover:underline"
                  >
                    {chunks}
                  </button>
                )
              })}
            </p>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full" />
          <h1 className="text-2xl font-bold text-parchment">{t("signupTitle")}</h1>
          <p className="text-sm text-parchment/50">
            {tier
              ? t("signupTierSelected", {
                  tier: tier.charAt(0).toUpperCase() + tier.slice(1)
                })
              : t("signupBlurb")}
          </p>
          <a href={questionnaireBaseHref} className="text-sm text-signal-teal hover:underline">
            {t("backToOnboarding")}
          </a>
        </div>

        <Card>
          <form onSubmit={handleSignup} className="space-y-4">
            <Input
              label={t("businessName")}
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder={t("businessNamePlaceholder")}
              required
            />
            {emailFromOnboarding ? (
              <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-parchment/45">
                  {t("email")}
                </p>
                <p className="mt-1 text-parchment break-all">{email}</p>
                <p className="mt-1 text-[11px] text-parchment/45">
                  {t("emailFromOnboarding")}{" "}
                  <a href={questionnaireEditEmailHref} className="text-signal-teal hover:underline">
                    {t("changeIt")}
                  </a>
                </p>
              </div>
            ) : (
              <Input
                label={t("email")}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
                autoComplete="email"
                required
              />
            )}
            <Input
              label={t("password")}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
              autoComplete="new-password"
              required
            />
            <Input
              label={t("confirmPassword")}
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t("confirmPasswordPlaceholder")}
              autoComplete="new-password"
              required
            />
            <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
              <p className="font-medium text-parchment/75">{t("passwordRules")}</p>
              <ul className="mt-1 list-disc pl-4 space-y-1">
                {passwordRules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </div>

            {error && <p className="text-xs text-spark-orange">{error}</p>}

            <Button type="submit" loading={loading} className="w-full">
              {t("createAccountCta")}
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-parchment/40">
          {t("alreadyHaveAccount")}{" "}
          <a href={loginHref} className="text-signal-teal hover:underline">
            {t("signIn")}
          </a>
        </p>
      </div>
    </div>
  );
}
