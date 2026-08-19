"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import type { AppLocale } from "@/i18n/routing";
import { getPasswordRules, getPasswordValidationError } from "@/lib/password";
import { terminateOtherSessions } from "@/lib/auth/terminate-other-sessions";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * Landing page for the password-reset link. The email link points at
 * /api/auth/callback?redirectTo=/reset-password, which exchanges the recovery
 * code for a session before redirecting here, so by the time this renders the
 * user has a (recovery) session and can set a new password via updateUser.
 */
export default function ResetPasswordPage() {
  const t = useTranslations("auth");
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const {
          data: { session }
        } = await supabase.auth.getSession();
        if (active) setHasSession(Boolean(session));
      } catch {
        if (active) setHasSession(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const passwordError = getPasswordValidationError(password, locale);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (password !== confirm) {
      setError(t("resetMismatch"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      // CASA 2.2.2: revoke other sessions after a successful password reset.
      // Password already changed; do not surface termination failures as reset failure.
      try {
        await terminateOtherSessions(supabase);
      } catch {
        // best-effort; current recovery session remains signed in
      }
      setDone(true);
      setTimeout(() => {
        router.refresh();
        router.push("/dashboard");
      }, 1200);
    } catch {
      setError(t("resetGenericError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep-ink px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full" />
          <h1 className="text-2xl font-bold text-parchment">{t("resetTitle")}</h1>
        </div>

        {done ? (
          <Card>
            <p className="text-center text-sm text-claw-green">{t("resetDone")}</p>
          </Card>
        ) : hasSession === false ? (
          <Card>
            <p className="text-center text-sm text-spark-orange">{t("resetLinkInvalid")}</p>
            <a
              href="/login"
              className="mt-4 block text-center text-sm text-signal-teal hover:underline"
            >
              {t("backToSignIn")}
            </a>
          </Card>
        ) : (
          <Card>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label={t("newPassword")}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("newPasswordPlaceholder")}
                autoComplete="new-password"
                required
              />
              <Input
                label={t("confirmNewPassword")}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
              <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
                <p className="font-medium text-parchment/75">{t("passwordRules")}</p>
                <ul className="mt-1 list-disc pl-4 space-y-1">
                  {getPasswordRules(locale).map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
              {error && <p className="text-xs text-spark-orange">{error}</p>}
              <Button type="submit" loading={loading} disabled={hasSession === null} className="w-full">
                {t("updatePassword")}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
