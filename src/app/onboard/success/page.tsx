"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useLocale, useTranslations } from "next-intl";
import { ONBOARD_STORAGE_KEY, clearOnboardingStorage, type OnboardingData } from "@/lib/onboarding/storage";
import {
  clearStaleSupabaseAuthCookies,
  getSupabaseBrowserClient,
  resetSupabaseBrowserClientCache
} from "@/lib/supabase/browser";
import type { AppLocale } from "@/i18n/routing";
import { getPasswordRules, getPasswordValidationError } from "@/lib/password";
import { CoworkerProvisioningProgress } from "@/components/dashboard/CoworkerProvisioningProgress";

type SuccessStatus =
  | "verifying_payment"
  | "needs_password"
  | "provisioning"
  | "online"
  | "awaiting_confirmation"
  | "error";

export default function OnboardSuccessPage() {
  return (
    <Suspense>
      <OnboardSuccessContent />
    </Suspense>
  );
}

function OnboardSuccessContent() {
  const t = useTranslations("marketing.onboard");
  const tAuth = useTranslations("auth");
  const locale = useLocale() as AppLocale;
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [status, setStatus] = useState<SuccessStatus>("verifying_payment");
  const [error, setError] = useState<string | null>(null);
  const [signupEmail, setSignupEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showRecoveryNotice, setShowRecoveryNotice] = useState(false);
  const [businessId, setBusinessId] = useState<string | null>(null);

  useEffect(() => {
    const rawOnboarding = localStorage.getItem(ONBOARD_STORAGE_KEY);
    const onboardingData = rawOnboarding ? JSON.parse(rawOnboarding) as OnboardingData : null;
    if (onboardingData?.ownerEmail) {
      setSignupEmail(onboardingData.ownerEmail);
    }
    if (onboardingData?.businessId) {
      setBusinessId(onboardingData.businessId);
    }
  }, []);

  useEffect(() => {
    async function resolvePostPaymentState() {
      if (!sessionId) {
        setStatus("provisioning");
        return;
      }

      try {
        setStatus("verifying_payment");
        const verifyRes = await fetch("/api/onboard/finalize-signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId })
        });

        if (!verifyRes.ok) {
          const verifyJson = await verifyRes.json().catch(() => null);
          throw new Error(verifyJson?.error?.message ?? t("errVerifyPayment"));
        }

        const verifyJson = await verifyRes.json();
        const ownerEmail = verifyJson.data?.ownerEmail;
        const verifiedBusinessId = verifyJson.data?.businessId;
        const recoveredOnboardingData = verifyJson.data?.onboardingData as OnboardingData | null | undefined;
        const onboardingDraftRecovered = verifyJson.data?.onboardingDraftRecovered === true;
        if (typeof ownerEmail !== "string" || !ownerEmail) {
          throw new Error(t("errPaidEmail"));
        }

        setSignupEmail(ownerEmail);
        if (typeof verifiedBusinessId === "string" && verifiedBusinessId) {
          // Stamp the verified businessId into local state so the
          // CoworkerProvisioningProgress widget can mount immediately
          // when the user transitions to "provisioning" — without this,
          // the widget has to wait on the first /api/business/status
          // poll roundtrip, leaving a 5-second blank gap where the user
          // sees no progress signal.
          setBusinessId(verifiedBusinessId);
        }
        const rawOnboarding = localStorage.getItem(ONBOARD_STORAGE_KEY);
        const onboardingData = rawOnboarding ? JSON.parse(rawOnboarding) as OnboardingData : null;
        const nextOnboardingData = recoveredOnboardingData
          ? { ...recoveredOnboardingData, businessId: verifiedBusinessId, ownerEmail, persistedToDatabase: true }
          : onboardingData
            ? { ...onboardingData, businessId: verifiedBusinessId, ownerEmail, persistedToDatabase: true }
            : null;
        if (nextOnboardingData) {
          localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(nextOnboardingData));
        }
        setShowRecoveryNotice(!onboardingDraftRecovered && !nextOnboardingData);

        setStatus("needs_password");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : t("errGeneric"));
      }
    }

    void resolvePostPaymentState();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is stable per locale; re-running on t identity would refetch payment state
  }, [sessionId]);

  useEffect(() => {
    // Onboarding is over once the coworker is online — scrub the local
    // draft so its resumable businessId can't be replayed into a fresh
    // onboarding months later against this (now live) business.
    if (status === "online") clearOnboardingStorage();
  }, [status]);

  useEffect(() => {
    if (status !== "provisioning") return;

    let interval: ReturnType<typeof setInterval> | null = null;

    // Provisioning is server-side (Stripe webhook → orchestrator). It
    // typically completes in 2–5 minutes but can take longer. We poll
    // /api/business/status purely to detect the "online" terminal — the
    // real percent + failure UI comes from the embedded
    // CoworkerProvisioningProgress widget below, which polls
    // /api/provisioning/status on its own. Previously this polled for
    // only 2 minutes and then stopped silently, leaving slow tenants
    // stranded on a fake step list with no escape hatch. We now keep
    // polling indefinitely while the user is on this page, and the UI
    // always exposes a "Go to dashboard" button so the user is never
    // trapped regardless of provisioning latency.
    async function pollOnce() {
      try {
        const res = await fetch("/api/business/status");
        if (res.status === 401) {
          setStatus("awaiting_confirmation");
          if (interval) clearInterval(interval);
          return;
        }

        const json = await res.json();
        if (typeof json.data?.id === "string") {
          setBusinessId((prev) => prev ?? json.data.id);
        }
        if (json.data?.status === "online") {
          setStatus("online");
          if (interval) clearInterval(interval);
        }
      } catch {
        // ignore transient polling failures
      }
    }

    void pollOnce();
    interval = setInterval(pollOnce, 5000);

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  async function handleCreatePassword(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setError(null);

    if (!signupEmail.trim()) {
      setError(t("errEmailRequired"));
      return;
    }

    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    if (password !== confirmPassword) {
      setError(tAuth("passwordsDoNotMatch"));
      return;
    }

    if (!sessionId) {
      // The Stripe-signed sessionId is the credential the server uses to
      // mint the auth user. Without it, /api/onboard/set-password has no
      // way to bind the password to a paid checkout — refuse rather than
      // silently dropping the request.
      setError(t("errSessionExpired"));
      return;
    }

    try {
      setSubmitting(true);
      const rawOnboarding = localStorage.getItem(ONBOARD_STORAGE_KEY);
      const onboardingData = rawOnboarding ? JSON.parse(rawOnboarding) as OnboardingData : null;

      // Scrub any stale `sb-*` cookies BEFORE we sign in. This protects
      // the subsequent dashboard requests (which include every chunked
      // auth-token cookie in their headers) from Vercel's ~32KB edge
      // header limit if the browser is carrying leftover cookies from
      // earlier abandoned auth attempts. See `clearStaleSupabaseAuthCookies`
      // for the full rationale.
      await clearStaleSupabaseAuthCookies();

      // Mint (or update) the auth user server-side. This goes through
      // `auth.admin.createUser({ email_confirm: true })` in the route,
      // which deliberately replaces the old client-side
      // `supabase.auth.signUp({ emailRedirectTo })` flow: that flow
      // forced an email-confirmation roundtrip whose callback to
      // /api/auth/callback was the original 494 REQUEST_HEADER_TOO_LARGE
      // failure surface for new signups.
      const setPasswordRes = await fetch("/api/onboard/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, password })
      });
      const setPasswordJson = await setPasswordRes.json().catch(() => null);

      if (setPasswordRes.status === 409 || setPasswordJson?.error?.code === "CONFLICT") {
        // The server detected that an auth user already exists for the
        // email Stripe billed and that user was NOT minted by this
        // checkout. We deliberately refuse to set a password in that
        // case (see /api/onboard/set-password's docstring for the
        // takeover attack this prevents). The customer's payment is
        // still bound to their business via /api/onboard/finalize-signup,
        // so steering them to /login is the correct recovery — they
        // sign in with their existing credentials and the new business
        // shows up under the same email-keyed authorization.
        window.history.replaceState({}, "", "/onboard/success");
        setStatus("awaiting_confirmation");
        return;
      }

      if (!setPasswordRes.ok) {
        throw new Error(setPasswordJson?.error?.message ?? t("errCreateAccount"));
      }
      const resolvedEmail =
        (typeof setPasswordJson?.data?.ownerEmail === "string" && setPasswordJson.data.ownerEmail) ||
        signupEmail;

      const supabase = getSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: resolvedEmail,
        password
      });

      if (signInError) {
        // The set-password call above already passed, so the auth user
        // exists with this password — but the immediate sign-in didn't
        // establish a session. Steer the user to /login (via
        // `awaiting_confirmation`) to retry with a clean cookie jar.
        window.history.replaceState({}, "", "/onboard/success");
        setStatus("awaiting_confirmation");
        return;
      }

      resetSupabaseBrowserClientCache();

      // Re-persist the onboarding draft so a refresh after sign-in
      // still has the locally-cached business context. We deliberately
      // do NOT re-overlay the email here: the page-mount useEffect
      // already wrote the verified Stripe-side email back into
      // localStorage when /api/onboard/finalize-signup succeeded, so
      // any further overlay just risks drift if the user ever edits
      // it from another tab. (Also flagged by CodeQL js/clear-text-
      // storage-of-sensitive-information — the field was already
      // present, so refraining from re-writing keeps the same data
      // surface without adding a new write site.)
      if (onboardingData) {
        localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(onboardingData));
      }

      window.history.replaceState({}, "", "/onboard/success");
      setStatus("provisioning");
    } catch (err) {
      setStatus("needs_password");
      setError(err instanceof Error ? err.message : t("errCreateAccount"));
    } finally {
      setSubmitting(false);
    }
  }

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
          <div className="mt-6 flex gap-2">
            {[1, 2, 3, 4].map((item) => (
              <div
                key={item}
                className={[
                  "h-1 flex-1 rounded-full transition-colors",
                  item < 4
                    || status === "needs_password"
                    || status === "awaiting_confirmation"
                    || status === "provisioning"
                    || status === "online"
                    ? "bg-claw-green"
                    : "bg-parchment/10"
                ].join(" ")}
              />
            ))}
          </div>
          <p className="text-sm text-parchment/50 mt-3">{t("step4")}</p>
          <h1 className="text-2xl font-bold text-parchment mt-2">
            {status === "needs_password"
              ? t("titleNeedsPassword")
              : status === "provisioning"
                  ? t("titleProvisioning")
                  : status === "online"
                    ? t("titleOnline")
                    : status === "awaiting_confirmation"
                      ? t("titleAwaiting")
                      : status === "error"
                        ? t("titleError")
                        : t("titleVerifying")}
          </h1>
          <p className="text-sm text-parchment/50 mt-2">
            {status === "needs_password"
              ? t("blurbNeedsPassword")
              : status === "provisioning"
                  ? t("blurbProvisioning")
                  : status === "online"
                    ? t("blurbOnline")
                      : status === "awaiting_confirmation"
                      ? t("blurbAwaiting")
                      : status === "error"
                        ? error ?? t("errorFallback")
                        : t("blurbVerifying")}
          </p>
        </div>

        {status === "verifying_payment" && (
          <Card>
            <p className="text-sm text-parchment/70 text-center">{t("checkingPayment")}</p>
          </Card>
        )}

        {showRecoveryNotice && status === "needs_password" && (
          <Card>
            <p className="text-xs text-parchment/70 text-center">{t("recoveryNotice")}</p>
          </Card>
        )}

        {status === "needs_password" && (
          <Card>
            <form onSubmit={handleCreatePassword} className="space-y-4">
              <Input
                label={tAuth("email")}
                type="email"
                value={signupEmail}
                placeholder={tAuth("emailPlaceholder")}
                autoComplete="email"
                readOnly
                required
              />
              <Input
                label={tAuth("password")}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={tAuth("passwordPlaceholder")}
                autoComplete="new-password"
                required
              />
              <Input
                label={tAuth("confirmPassword")}
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder={tAuth("confirmPasswordPlaceholder")}
                autoComplete="new-password"
                required
              />
              <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
                <p className="font-medium text-parchment/75">{tAuth("passwordRules")}</p>
                <ul className="mt-1 list-disc pl-4 space-y-1">
                  {getPasswordRules(locale).map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
              {error && <p className="text-xs text-spark-orange">{error}</p>}
              <Button type="submit" loading={submitting} className="w-full">
                {t("createAccountCta")}
              </Button>
            </form>
          </Card>
        )}

        {status === "provisioning" && (
          <div className="space-y-4">
            {businessId ? (
              <CoworkerProvisioningProgress businessId={businessId} />
            ) : (
              <Card>
                <p className="text-sm text-parchment/70 text-center">{t("provisioningBackground")}</p>
              </Card>
            )}
            {/*
              Always expose an escape hatch to the dashboard. Provisioning
              runs server-side (Stripe webhook → orchestrator) and the
              dashboard already renders the same real-time progress widget,
              handles the failure case, and gives the user a usable
              workspace shell while the VPS continues to come up. Without
              this button users whose provisioning takes longer than a few
              minutes (or whose deploy step partially failed) had no way
              off this page.
            */}
            <div className="text-center">
              <a
                href="/dashboard"
                onClick={clearOnboardingStorage}
                className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
              >
                {t("goToDashboard")}
              </a>
              <p className="text-xs text-parchment/45 mt-2">{t("provisioningMonitor")}</p>
            </div>
          </div>
        )}

        {status === "online" && (
          <div className="text-center">
            <a
              href="/dashboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-8 py-3 font-semibold hover:bg-opacity-90 transition-colors"
            >
              {t("goToDashboard")}
            </a>
          </div>
        )}

        {status === "awaiting_confirmation" && (
          <Card className="space-y-3 text-center">
            <p className="text-xs text-parchment/60">{t("awaitingBody")}</p>
            <a
              href="/login"
              onClick={clearOnboardingStorage}
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-6 py-2.5 text-sm font-semibold hover:bg-opacity-90 transition-colors"
            >
              {tAuth("signIn")}
            </a>
          </Card>
        )}

        {status === "error" && (
          <Card>
            <p className="text-xs text-spark-orange text-center">{t("errorRetry")}</p>
          </Card>
        )}
      </div>
    </div>
  );
}
