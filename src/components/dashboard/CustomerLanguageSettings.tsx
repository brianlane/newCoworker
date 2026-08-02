"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";

/**
 * Settings card: the coworker's default customer-facing language, the
 * language it opens with when a customer's own language is unknown or
 * ambiguous (SMS, voice IVR, and the live voice persona all read it; the
 * per-contact detected language still overrides per person). Saves
 * optimistically on change and reverts on failure, same pattern as
 * FlowSafetySettings.
 */
export function CustomerLanguageSettings({
  initialLanguage
}: {
  initialLanguage: "en" | "es";
}) {
  const t = useTranslations("dashboard.settings");
  const [language, setLanguage] = useState<"en" | "es">(initialLanguage);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async (next: "en" | "es") => {
    setBusy(true);
    setStatus(null);
    const prev = language;
    setLanguage(next);
    try {
      const res = await fetch("/api/account/customer-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) throw new Error(json.error?.message ?? t("customerLanguageError"));
      setStatus(t("customerLanguageSaved"));
    } catch (e) {
      setLanguage(prev);
      setStatus(e instanceof Error ? e.message : t("customerLanguageError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">{t("customerLanguageTitle")}</h2>
      <p className="text-xs text-parchment/40 mb-3">{t("customerLanguageBlurb")}</p>
      <label className="flex items-center gap-3 text-sm text-parchment/80">
        <span>{t("customerLanguageLabel")}</span>
        <select
          className="bg-transparent border border-parchment/20 rounded px-2 py-1 text-sm text-parchment"
          value={language}
          disabled={busy}
          onChange={(ev) => save(ev.target.value as "en" | "es")}
        >
          <option value="en">{t("customerLanguageEnglish")}</option>
          <option value="es">{t("customerLanguageSpanish")}</option>
        </select>
      </label>
      {status && <p className="mt-2 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
