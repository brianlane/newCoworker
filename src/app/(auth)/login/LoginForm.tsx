"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import {
  readLastLoginMethod,
  rememberLastLoginMethod,
  type LoginMethod
} from "@/lib/auth/last-login-method";
import { NO_ACCOUNT_ERROR } from "@/lib/auth/account-gate";
import { SESSION_TIMEOUT_ERROR } from "@/lib/hipaa/session-timeout";
import { isPasskeyCeremonyCancellation, passkeyErrorMessage } from "@/lib/auth/passkey-errors";
import { safeInternalPath } from "@/lib/auth/safe-redirect";
import {
  browserSupportsPasskeys,
  clearStaleSupabaseAuthCookies,
  getSupabaseBrowserClient
} from "@/lib/supabase/browser";

/**
 * Wraps a sign-in button so the "Last used" pill can sit on its top edge.
 * The pill is decorative, so it never takes pointer events and is hidden from
 * screen readers in favor of the button's own accessible description.
 */
function MethodSlot({
  method,
  lastUsed,
  label,
  children
}: {
  method: LoginMethod;
  lastUsed: LoginMethod | null;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      {lastUsed === method && (
        <span className="pointer-events-none absolute -top-2 right-3 z-10 rounded-md bg-parchment px-2 py-0.5 text-[10px] font-semibold tracking-wide text-deep-ink shadow-lg shadow-black/40">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * Maps a `?error=` token to its message. Both tokens are set by a redirect
 * away from a screen that cannot show its own error: the OAuth account gate
 * in /api/auth/callback, and the HIPAA idle logout, which hard-navigates
 * here after revoking the session.
 */
function loginErrorMessage(
  token: string | null,
  t: ReturnType<typeof useTranslations<"auth">>
): string | null {
  if (token === NO_ACCOUNT_ERROR) return t("noAccountForEmail");
  if (token === SESSION_TIMEOUT_ERROR) return t("sessionTimedOut");
  return null;
}

/**
 * What is currently in flight. Sending a reset email is not a way to sign in,
 * so it gets its own token: reusing `"password"` would spin the Sign in
 * button when the owner clicked "Forgot password?".
 */
type PendingAction = LoginMethod | "reset";

export default function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Attacker-shareable ?redirectTo= must stay inside the app: router.push
  // would happily navigate to an absolute URL after sign-in.
  const redirectTo = safeInternalPath(searchParams.get("redirectTo"), "/dashboard");
  const signupHref = "/onboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // /api/auth/callback bounces an OAuth sign-in whose address has no account
  // back here with ?error=no_account (src/lib/auth/account-gate.ts). Seeded
  // into the same error slot every other failure uses, so the next attempt
  // clears it.
  const [error, setError] = useState<string | null>(() =>
    loginErrorMessage(searchParams.get("error"), t)
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [lastUsed, setLastUsed] = useState<LoginMethod | null>(null);
  const [passkeysAvailable, setPasskeysAvailable] = useState(false);

  // Both of these read browser-only state, so they resolve after hydration
  // rather than during render (a server/client mismatch would otherwise flash
  // the badge and the passkey button in and out).
  useEffect(() => {
    setLastUsed(readLastLoginMethod());
    setPasskeysAvailable(browserSupportsPasskeys());
  }, []);

  const busy = pending !== null;
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;

  function callbackUrl(target: string): string {
    return `${window.location.origin}/api/auth/callback?redirectTo=${encodeURIComponent(target)}`;
  }

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setPending("password");
    setError(null);

    try {
      await clearStaleSupabaseAuthCookies();
      const supabase = getSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      rememberLastLoginMethod("password");
      router.refresh();
      router.push(redirectTo);
    } catch {
      setError(t("signInFailed"));
    } finally {
      setPending(null);
    }
  }

  async function handleGoogle() {
    setPending("google");
    setError(null);

    try {
      await clearStaleSupabaseAuthCookies();
      const supabase = getSupabaseBrowserClient();
      // We drive the redirect ourselves so the "last used" hint is only
      // written once Supabase has actually handed us an authorization URL.
      // Letting the SDK redirect would force the write to happen before we
      // know the call succeeded, badging Google after a failure that never
      // left this page.
      const { data, error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: callbackUrl(redirectTo), skipBrowserRedirect: true }
      });
      if (oauthError || !data?.url) {
        setError(oauthError?.message ?? t("signInFailed"));
        setPending(null);
        return;
      }
      // The owner comes back through /api/auth/callback, which never renders
      // this component, so this is the last chance to record the method. An
      // abandoned consent screen leaves a stale hint: acceptable for a badge.
      rememberLastLoginMethod("google");
      window.location.assign(data.url);
      // Navigating away: leave the button spinning rather than flickering.
    } catch {
      setError(t("signInFailed"));
      setPending(null);
    }
  }

  async function handlePasskey() {
    setPending("passkey");
    setError(null);

    try {
      await clearStaleSupabaseAuthCookies();
      const supabase = getSupabaseBrowserClient();
      const { error: passkeyError } = await supabase.auth.signInWithPasskey();

      if (passkeyError) {
        if (!isPasskeyCeremonyCancellation(passkeyError)) {
          setError(passkeyErrorMessage(passkeyError, t("passkeySignInFailed")));
        }
        return;
      }

      rememberLastLoginMethod("passkey");
      router.refresh();
      router.push(redirectTo);
    } catch (err) {
      if (!isPasskeyCeremonyCancellation(err)) {
        setError(passkeyErrorMessage(err, t("passkeySignInFailed")));
      }
    } finally {
      setPending(null);
    }
  }

  async function handleMagicLink() {
    if (!email) {
      setError(t("enterEmailFirst"));
      return;
    }
    setPending("magic-link");
    setError(null);

    try {
      // Scrub stale `sb-*` cookies so the magic-link callback to
      // /api/auth/callback doesn't blow past Vercel's edge header limit. See
      // `clearStaleSupabaseAuthCookies` for the full rationale (494 / chunked
      // auth-token accumulation across abandoned sessions).
      await clearStaleSupabaseAuthCookies();
      const supabase = getSupabaseBrowserClient();
      // `shouldCreateUser` defaults to TRUE, which made this button the second
      // door into account creation: any address typed here got an empty
      // `auth.users` row and a working magic link. This is a sign-IN form, so
      // the link is only ever issued to an address that already has an
      // account; Supabase answers `otp_disabled` for anything else.
      const { error: magicError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callbackUrl(redirectTo), shouldCreateUser: false }
      });
      if (magicError) {
        setError(
          magicError.code === "otp_disabled" ? t("noAccountForEmail") : magicError.message
        );
        return;
      }
      rememberLastLoginMethod("magic-link");
      setMagicSent(true);
    } catch {
      setError(t("signInFailed"));
    } finally {
      setPending(null);
    }
  }

  async function handleForgotPassword() {
    if (!email) {
      setError(t("enterEmailFirst"));
      return;
    }
    setPending("reset");
    setError(null);

    try {
      await clearStaleSupabaseAuthCookies();
      const supabase = getSupabaseBrowserClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: callbackUrl("/reset-password")
      });
      if (resetError) {
        setError(resetError.message);
        return;
      }
      setResetSent(true);
    } catch {
      setError(t("signInFailed"));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Link href="/">
            <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full" />
          </Link>
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
            <div className="space-y-3">
              <MethodSlot method="google" lastUsed={lastUsed} label={t("lastUsed")}>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={handleGoogle}
                  loading={pending === "google"}
                  disabled={busy}
                >
                  <Image src="/google-g.svg" alt="" width={18} height={18} aria-hidden="true" />
                  {t("continueWithGoogle")}
                </Button>
              </MethodSlot>

              {passkeysAvailable && (
                <MethodSlot method="passkey" lastUsed={lastUsed} label={t("lastUsed")}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={handlePasskey}
                    loading={pending === "passkey"}
                    disabled={busy}
                  >
                    <KeyRound className="h-[18px] w-[18px]" aria-hidden="true" />
                    {t("signInWithPasskey")}
                  </Button>
                </MethodSlot>
              )}
            </div>

            <div className="relative my-4 flex items-center">
              <div className="flex-1 border-t border-parchment/10" />
              <span className="mx-3 text-xs text-parchment/30">{t("or")}</span>
              <div className="flex-1 border-t border-parchment/10" />
            </div>

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
                  disabled={busy}
                  className="text-xs text-parchment/50 hover:text-signal-teal disabled:opacity-50"
                >
                  {t("forgotPassword")}
                </button>
              </div>

              {error && <p className="text-xs text-spark-orange">{error}</p>}

              <MethodSlot method="password" lastUsed={lastUsed} label={t("lastUsed")}>
                <Button
                  type="submit"
                  loading={pending === "password"}
                  disabled={busy}
                  className="w-full"
                >
                  {t("signIn")}
                </Button>
              </MethodSlot>

              <MethodSlot method="magic-link" lastUsed={lastUsed} label={t("lastUsed")}>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={handleMagicLink}
                  loading={pending === "magic-link"}
                  disabled={busy}
                >
                  {t("sendMagicLink")}
                </Button>
              </MethodSlot>
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
