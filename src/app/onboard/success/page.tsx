"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { StatusDot } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ONBOARD_STORAGE_KEY, type OnboardingData } from "@/lib/onboarding/storage";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { getPasswordValidationError, PASSWORD_RULES } from "@/lib/password";

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
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [status, setStatus] = useState<SuccessStatus>("verifying_payment");
  const [error, setError] = useState<string | null>(null);
  const [signupEmail, setSignupEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const rawOnboarding = localStorage.getItem(ONBOARD_STORAGE_KEY);
    const onboardingData = rawOnboarding ? JSON.parse(rawOnboarding) as OnboardingData : null;
    if (onboardingData?.ownerEmail) {
      setSignupEmail(onboardingData.ownerEmail);
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
          throw new Error(verifyJson?.error?.message ?? "Could not verify your payment.");
        }

        const verifyJson = await verifyRes.json();
        const ownerEmail = verifyJson.data?.ownerEmail;
        if (typeof ownerEmail !== "string" || !ownerEmail) {
          throw new Error("Could not determine the paid account email.");
        }

        setSignupEmail(ownerEmail);
        const rawOnboarding = localStorage.getItem(ONBOARD_STORAGE_KEY);
        if (rawOnboarding) {
          const onboardingData = JSON.parse(rawOnboarding) as OnboardingData;
          localStorage.setItem(
            ONBOARD_STORAGE_KEY,
            JSON.stringify({ ...onboardingData, ownerEmail })
          );
        }

        setStatus("needs_password");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    }

    void resolvePostPaymentState();
  }, [sessionId]);

  useEffect(() => {
    if (status !== "provisioning") return;

    let interval: ReturnType<typeof setInterval> | null = null;
    let attempts = 0;

    interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch("/api/business/status");
        if (res.status === 401) {
          setStatus("awaiting_confirmation");
          if (interval) clearInterval(interval);
          return;
        }

        const json = await res.json();
        if (json.data?.status === "online") {
          setStatus("online");
          if (interval) clearInterval(interval);
        }
      } catch {
        // ignore transient polling failures
      }

      if (attempts >= 24 && interval) {
        clearInterval(interval);
      }
    }, 5000);

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  async function handleCreatePassword(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setError(null);

    if (!signupEmail.trim()) {
      setError("Email is required");
      return;
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    try {
      setSubmitting(true);
      const rawOnboarding = localStorage.getItem(ONBOARD_STORAGE_KEY);
      const onboardingData = rawOnboarding ? JSON.parse(rawOnboarding) as OnboardingData : null;
      const supabase = getSupabaseBrowserClient();
      const encodedRedirect = encodeURIComponent("/onboard/success");
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: signupEmail,
        password,
        options: {
          data: {
            business_name: onboardingData?.businessName,
            onboarding_data: onboardingData ? { ...onboardingData, ownerEmail: signupEmail } : undefined
          },
          emailRedirectTo: `${window.location.origin}/api/auth/callback?redirectTo=${encodedRedirect}`
        }
      });

      if (signUpError) {
        throw new Error(signUpError.message);
      }

      const identities = signUpData.user?.identities ?? [];
      if (identities.length === 0) {
        throw new Error("An account with this email already exists. Sign in to access your dashboard.");
      }

      if (onboardingData) {
        localStorage.setItem(
          ONBOARD_STORAGE_KEY,
          JSON.stringify({ ...onboardingData, ownerEmail: signupEmail })
        );
      }

      if (signUpData.session) {
        window.history.replaceState({}, "", "/onboard/success");
        setStatus("provisioning");
        return;
      }

      window.history.replaceState({}, "", "/onboard/success");
      setStatus("awaiting_confirmation");
    } catch (err) {
      setStatus("needs_password");
      setError(err instanceof Error ? err.message : "Could not create your account.");
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
          <p className="text-sm text-parchment/50 mt-3">Step 4 of 4</p>
          <h1 className="text-2xl font-bold text-parchment mt-2">
            {status === "needs_password"
              ? "Create your password"
              : status === "provisioning"
                  ? "Setting things up…"
                  : status === "online"
                    ? "Your Coworker is Live!"
                    : status === "awaiting_confirmation"
                      ? "Check your email"
                      : status === "error"
                        ? "We hit a snag"
                        : "Confirming your payment"}
          </h1>
          <p className="text-sm text-parchment/50 mt-2">
            {status === "needs_password"
              ? "Payment succeeded. Create your password to finish account setup."
              : status === "provisioning"
                  ? "We're provisioning your VPS and configuring your AI coworker. This takes 2–5 minutes."
                  : status === "online"
                    ? "Everything is ready. Head to your dashboard."
                    : status === "awaiting_confirmation"
                      ? "We sent your confirmation link after payment. Confirm your email to continue."
                      : status === "error"
                        ? error ?? "We could not finish account setup after payment."
                        : "Verifying your Stripe payment before we create your account."}
          </p>
        </div>

        {status === "verifying_payment" && (
          <Card>
            <p className="text-sm text-parchment/70 text-center">Checking your payment status…</p>
          </Card>
        )}

        {status === "needs_password" && (
          <Card>
            <form onSubmit={handleCreatePassword} className="space-y-4">
              <Input
                label="Email"
                type="email"
                value={signupEmail}
                placeholder="you@business.com"
                autoComplete="email"
                readOnly
                required
              />
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="8+ chars, 1 uppercase, 1 number"
                autoComplete="new-password"
                required
              />
              <Input
                label="Confirm Password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Re-enter your password"
                autoComplete="new-password"
                required
              />
              <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
                <p className="font-medium text-parchment/75">Password rules</p>
                <ul className="mt-1 list-disc pl-4 space-y-1">
                  {PASSWORD_RULES.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
              {error && <p className="text-xs text-spark-orange">{error}</p>}
              <Button type="submit" loading={submitting} className="w-full">
                Create Account
              </Button>
            </form>
          </Card>
        )}

        {status === "provisioning" && (
          <Card className="text-left space-y-3">
            {[
              "Provisioning Hostinger VPS",
              "Installing Ollama + Bifrost router",
              "Configuring Rowboat agent",
              "Creating inworld.ai voice agent",
              "Attaching Twilio phone number",
              "Injecting soul.md + identity.md"
            ].map((step, i) => (
              <div key={step} className="flex items-center gap-3 text-sm">
                <StatusDot status={i < 2 ? "online" : "offline"} />
                <span className={i < 2 ? "text-parchment" : "text-parchment/40"}>{step}</span>
              </div>
            ))}
          </Card>
        )}

        {status === "online" && (
          <div className="text-center">
            <a
              href="/dashboard"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-8 py-3 font-semibold hover:bg-opacity-90 transition-colors"
            >
              Go to Dashboard →
            </a>
          </div>
        )}

        {status === "awaiting_confirmation" && (
          <Card>
            <p className="text-xs text-parchment/40 text-center">
              Check your inbox for the confirmation link, then sign in to continue.
            </p>
          </Card>
        )}

        {status === "error" && (
          <Card>
            <p className="text-xs text-spark-orange text-center">
              Try again from this page, or sign in if your account already exists.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
