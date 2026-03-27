"use client";

import { Suspense, useState, type FormEvent } from "react";
import { createClient } from "@supabase/supabase-js";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { ONBOARD_STORAGE_KEY } from "@/lib/onboarding/storage";

function getSupabaseBrowserClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

type StoredOnboardingData = {
  businessName?: string;
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

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? "/onboard";
  const tier = searchParams.get("tier");
  const loginHref = `/login?redirectTo=${encodeURIComponent(redirectTo)}${tier ? `&tier=${encodeURIComponent(tier)}` : ""}`;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState(() => {
    const onboarding = readStoredOnboardingData();
    return typeof onboarding?.businessName === "string" ? onboarding.businessName : "";
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmationPending, setConfirmationPending] = useState(false);

  async function handleSignup(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    setError(null);

    const onboardingData = readStoredOnboardingData();
    const onboardingDataWithLatestBusinessName = onboardingData
      ? { ...onboardingData, businessName }
      : null;

    const supabase = getSupabaseBrowserClient();
    const encodedRedirect = encodeURIComponent(redirectTo);
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { 
          business_name: businessName,
          onboarding_data: onboardingDataWithLatestBusinessName
        },
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
      setError("An account with this email already exists. Please sign in instead.");
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
            <h1 className="text-2xl font-bold text-parchment">Check your email</h1>
            <p className="text-sm text-parchment/50 max-w-xs">
              We sent a confirmation link to <span className="text-parchment font-medium">{email}</span>.
              Click the link to activate your account and get started.
            </p>
          </div>
          <Card>
            <p className="text-xs text-parchment/40 text-center">
              Didn&apos;t receive it? Check your spam folder or{" "}
              <button
                type="button"
                onClick={() => setConfirmationPending(false)}
                className="text-signal-teal hover:underline"
              >
                try again
              </button>.
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
          <h1 className="text-2xl font-bold text-parchment">Create your account</h1>
          <p className="text-sm text-parchment/50">
            {tier ? `${tier.charAt(0).toUpperCase() + tier.slice(1)} plan selected — almost there!` : "Your AI coworker starts here"}
          </p>
        </div>

        <Card>
          <form onSubmit={handleSignup} className="space-y-4">
            <Input
              label="Business Name"
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Sunrise Realty"
              required
            />
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@business.com"
              autoComplete="email"
              required
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 characters"
              autoComplete="new-password"
              required
            />

            {error && <p className="text-xs text-spark-orange">{error}</p>}

            <Button type="submit" loading={loading} className="w-full">
              Create account
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-parchment/40">
          Already have an account?{" "}
          <a href={loginHref} className="text-signal-teal hover:underline">
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
