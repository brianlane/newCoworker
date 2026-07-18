"use client";

import { Suspense, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { clearStaleSupabaseAuthCookies, getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") ?? "/dashboard";
  const signupHref = "/onboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await clearStaleSupabaseAuthCookies();
      const supabase = getSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      router.refresh();
      router.push(redirectTo);
    } catch {
      setError(t("signInFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink() {
    if (!email) {
      setError(t("enterEmailFirst"));
      return;
    }
    setLoading(true);
    setError(null);
    // Scrub stale `sb-*` cookies so the magic-link callback to
    // /api/auth/callback doesn't blow past Vercel's edge header limit. See
    // `clearStaleSupabaseAuthCookies` for the full rationale (494 / chunked
    // auth-token accumulation across abandoned sessions).
    await clearStaleSupabaseAuthCookies();
    const supabase = getSupabaseBrowserClient();
    const encodedRedirect = encodeURIComponent(redirectTo);
    const { error: magicError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback?redirectTo=${encodedRedirect}`
      }
    });
    setLoading(false);
    if (magicError) {
      setError(magicError.message);
    } else {
      setMagicSent(true);
    }
  }

  async function handleForgotPassword() {
    if (!email) {
      setError(t("enterEmailFirst"));
      return;
    }
    setLoading(true);
    setError(null);
    await clearStaleSupabaseAuthCookies();
    const supabase = getSupabaseBrowserClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/api/auth/callback?redirectTo=/reset-password`
    });
    setLoading(false);
    if (resetError) {
      setError(resetError.message);
    } else {
      setResetSent(true);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full" />
          <h1 className="text-2xl font-bold text-parchment">{t("welcomeBack")}</h1>
          <p className="text-sm text-parchment/50">{t("signInBlurb")}</p>
        </div>

        {magicSent ? (
          <Card>
            <p className="text-center text-sm text-signal-teal">
              {t.rich("magicSentTo", { email, strong })}
            </p>
          </Card>
        ) : resetSent ? (
          <Card>
            <p className="text-center text-sm text-signal-teal">
              {t.rich("resetSentTo", { email, strong })}
            </p>
          </Card>
        ) : (
          <Card>
            <form onSubmit={handleSignIn} className="space-y-4">
              <Input
                label={t("email")}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("emailPlaceholder")}
                autoComplete="email"
                required
              />
              <Input
                label={t("password")}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />

              <div className="flex justify-end -mt-2">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className="text-xs text-parchment/50 hover:text-signal-teal"
                >
                  {t("forgotPassword")}
                </button>
              </div>

              {error && <p className="text-xs text-spark-orange">{error}</p>}

              <Button type="submit" loading={loading} className="w-full">
                {t("signIn")}
              </Button>

              <div className="relative flex items-center">
                <div className="flex-1 border-t border-parchment/10" />
                <span className="mx-3 text-xs text-parchment/30">{t("or")}</span>
                <div className="flex-1 border-t border-parchment/10" />
              </div>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={handleMagicLink}
                loading={loading}
              >
                {t("sendMagicLink")}
              </Button>
            </form>
          </Card>
        )}

        <p className="text-center text-sm text-parchment/40">
          {t("noAccount")}{" "}
          <a href={signupHref} className="text-signal-teal hover:underline">
            {t("getStarted")}
          </a>
        </p>
      </div>
    </div>
  );
}
