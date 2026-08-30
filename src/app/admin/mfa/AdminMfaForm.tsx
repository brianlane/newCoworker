"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeAdminNextPath } from "@/lib/auth/admin-aal";
import {
  describeMfaLoadFailure,
  listMfaFactorsWithRetry,
  splitTotpFactors,
  type MfaFactorSummary
} from "@/lib/auth/mfa-factor-load";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type AdminMfaFormProps = {
  email: string | null;
};

export default function AdminMfaForm({ email }: AdminMfaFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [factors, setFactors] = useState<MfaFactorSummary[]>([]);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollId, setEnrollId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  // Two separate errors on purpose. `loadError` explains why there is nothing
  // to verify against, and submitting must never erase it: clearing it left
  // the admin staring at "No authenticator factor is available", which
  // describes the empty form state and says nothing about the real cause.
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const loadRunRef = useRef(0);

  function getSafeNext(): string {
    return safeAdminNextPath(searchParams.get("next"));
  }

  const loadFactors = useCallback(async () => {
    const runId = loadRunRef.current + 1;
    loadRunRef.current = runId;
    const isStale = () => loadRunRef.current !== runId;

    setLoading(true);
    setLoadError("");
    setError("");
    setFactorId(null);
    setEnrollId(null);
    setQrCode(null);
    setSecret(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error: listError } = await listMfaFactorsWithRetry(() =>
        supabase.auth.mfa.listFactors()
      );
      if (isStale()) return;
      if (listError) {
        setLoadError(describeMfaLoadFailure(listError));
        return;
      }
      const { totp: totpFactors, verified } = splitTotpFactors(data);
      setFactors(verified);
      if (verified[0]) {
        setFactorId(verified[0].id);
        return;
      }
      // Drop unfinished enrollments before creating a new one. A reload
      // otherwise stacks unverified factors and can block MFA setup.
      for (const factor of totpFactors) {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
        if (isStale()) return;
      }
      const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Admin authenticator"
      });
      if (isStale()) return;
      if (enrollError) {
        setLoadError(describeMfaLoadFailure(enrollError));
        return;
      }
      setEnrollId(enrollData.id);
      setQrCode(enrollData.totp.qr_code);
      setSecret(enrollData.totp.secret);
    } catch (err) {
      if (isStale()) return;
      setLoadError(describeMfaLoadFailure(err));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFactors();
    return () => {
      // Invalidate the in-flight run so a late resolve cannot write state
      // into an unmounted or superseded form.
      loadRunRef.current += 1;
    };
  }, [loadFactors]);

  const targetFactorId = factorId ?? enrollId;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!targetFactorId) {
      setError(
        loadError ||
          "Your authenticator has not loaded yet. Wait for it to finish, or reload the page."
      );
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const supabase = getSupabaseBrowserClient();
      const { data: challengeData, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId: targetFactorId });
      if (challengeError) {
        setError(challengeError.message);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: targetFactorId,
        challengeId: challengeData.id,
        code: code.trim()
      });
      if (verifyError) {
        setError(verifyError.message);
        return;
      }
      // Navigate before refresh so an AAL2 server redirect on this page
      // cannot beat the intended deep link with /admin/dashboard.
      const next = getSafeNext();
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <p className="text-sm text-parchment/50">Loading authenticator…</p>
      </Card>
    );
  }

  // Nothing loaded, so there is nothing a code could be checked against.
  // Show the real reason and a way back instead of a form that can only fail.
  if (loadError) {
    return (
      <Card>
        {email && (
          <p className="text-xs text-parchment/40 mb-4 truncate">Signed in as {email}</p>
        )}
        <div className="rounded-lg bg-spark-orange/10 border border-spark-orange/30 px-3 py-2 mb-4">
          <p className="text-sm text-spark-orange">{loadError}</p>
        </div>
        <Button className="w-full" type="button" onClick={() => void loadFactors()}>
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      {email && (
        <p className="text-xs text-parchment/40 mb-4 truncate">Signed in as {email}</p>
      )}
      {qrCode && (
        <div className="mb-4 space-y-2">
          <p className="text-sm text-parchment/70">
            Scan this QR code with your authenticator app, then enter the 6-digit
            code.
          </p>
          {/* Supabase returns an inline SVG data URL for TOTP enrollment. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrCode}
            alt="Authenticator QR code"
            className="mx-auto rounded-lg bg-white p-2 w-48 h-48"
          />
          {secret && (
            <p className="text-xs text-parchment/40 break-all">
              Manual key: <span className="text-parchment/70">{secret}</span>
            </p>
          )}
        </div>
      )}
      {!qrCode && factors.length > 0 && (
        <p className="text-sm text-parchment/70 mb-4">
          Enter the 6-digit code from your authenticator app.
        </p>
      )}
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          label="Authentication code"
          id="totp"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
        />
        {error && (
          <div className="rounded-lg bg-spark-orange/10 border border-spark-orange/30 px-3 py-2">
            <p className="text-sm text-spark-orange">{error}</p>
          </div>
        )}
        <Button
          className="w-full"
          type="submit"
          disabled={submitting || !targetFactorId}
          loading={submitting}
        >
          {submitting ? "Verifying…" : "Verify and continue"}
        </Button>
      </form>
    </Card>
  );
}
