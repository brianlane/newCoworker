"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";

/**
 * Blocking clickwrap overlay for signed-in users with no acceptance row for
 * the CURRENT legal versions (src/lib/legal/versions.ts): OAuth, passkey,
 * and magic-link first-timers, accounts predating the ledger, and everyone
 * again when a version bumps. Rendered by the dashboard layout over every
 * /dashboard route; never rendered under admin view-as (the accept endpoint
 * refuses view-as too, so the guard holds on both sides).
 */
export function TermsAcceptanceGate() {
  const t = useTranslations("dashboard.termsGate");
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!checked) {
      setError(t("checkboxRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/legal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setSubmitting(false);
      setError(t("failed"));
    }
  }

  const link = (href: string) => {
    const LinkChunk = (chunks: React.ReactNode) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-signal-teal hover:underline"
      >
        {chunks}
      </a>
    );
    return LinkChunk;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep-ink/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-parchment/10 bg-deep-ink p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-parchment">{t("title")}</h2>
        <p className="mt-2 text-sm text-parchment/70">{t("body")}</p>
        <label className="mt-4 flex items-start gap-2 text-sm text-parchment/70">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            {t.rich("checkboxLabel", { terms: link("/terms"), privacy: link("/privacy") })}
          </span>
        </label>
        {error && (
          <p className="mt-2 text-xs text-spark-orange" role="alert">
            {error}
          </p>
        )}
        <Button onClick={accept} loading={submitting} className="mt-4 w-full">
          {t("accept")}
        </Button>
      </div>
    </div>
  );
}
