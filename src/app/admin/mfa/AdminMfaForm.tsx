"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type AdminMfaFormProps = {
  email: string | null;
};

type Factor = {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
};

export default function AdminMfaForm({ email }: AdminMfaFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrollId, setEnrollId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  function getSafeNext(): string {
    const next = searchParams.get("next") ?? "/admin/dashboard";
    if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/admin/mfa")) {
      return "/admin/dashboard";
    }
    return next;
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data, error: listError } = await supabase.auth.mfa.listFactors();
        if (listError) {
          if (active) setError(listError.message);
          return;
        }
        const totp = (data?.totp ?? []) as Factor[];
        const verified = totp.filter((f) => f.status === "verified");
        if (!active) return;
        setFactors(verified);
        if (verified[0]) {
          setFactorId(verified[0].id);
          return;
        }
        // Drop unfinished enrollments before creating a new one. A reload
        // otherwise stacks unverified factors and can block MFA setup.
        const unverified = totp.filter((f) => f.status !== "verified");
        for (const factor of unverified) {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
        const { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: "Admin authenticator"
        });
        if (enrollError) {
          setError(enrollError.message);
          return;
        }
        setEnrollId(enrollData.id);
        setQrCode(enrollData.totp.qr_code);
        setSecret(enrollData.totp.secret);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load MFA factors");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const supabase = getSupabaseBrowserClient();
      const targetFactorId = factorId ?? enrollId;
      if (!targetFactorId) {
        setError("No authenticator factor is available.");
        return;
      }
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
      router.refresh();
      router.replace(getSafeNext());
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
        <Button className="w-full" type="submit" disabled={submitting} loading={submitting}>
          {submitting ? "Verifying…" : "Verify and continue"}
        </Button>
      </form>
    </Card>
  );
}
