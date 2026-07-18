"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Props = {
  customerE164: string;
  initialLanguage: "en" | "es" | null;
  initialSource: "detected" | "owner_set" | null;
};

export function ContactLanguageEditor({
  customerE164,
  initialLanguage,
  initialSource
}: Props) {
  const t = useTranslations("dashboard.contacts");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [language, setLanguage] = useState<"en" | "es" | "">(initialLanguage ?? "");
  const [source, setSource] = useState<"detected" | "owner_set" | null>(initialSource);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: "en" | "es" | "") {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/contacts/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerE164,
          language: next === "" ? null : next
        })
      });
      if (!res.ok) throw new Error("save failed");
      setLanguage(next);
      // A save from this editor is by definition an owner override; clearing
      // the field clears the source too. Keeps the hint correct without
      // waiting on router.refresh().
      setSource(next === "" ? null : "owner_set");
      router.refresh();
    } catch {
      setError(tCommon("languageSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="text-xs text-parchment/50">{t("languageLabel")}</label>
      <select
        value={language}
        disabled={saving}
        onChange={(e) => void save(e.target.value as "en" | "es" | "")}
        className="w-full rounded-md border border-parchment/15 bg-deep-ink/50 px-2 py-1.5 text-sm text-parchment"
      >
        <option value="">—</option>
        <option value="en">{t("languageEnglish")}</option>
        <option value="es">{t("languageSpanish")}</option>
      </select>
      <p className="text-[11px] text-parchment/40">{t("languageHelp")}</p>
      {source === "detected" && language && (
        <p className="text-[11px] text-parchment/35">{t("languageDetected")}</p>
      )}
      {source === "owner_set" && language && (
        <p className="text-[11px] text-parchment/35">{t("languageOwnerSet")}</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
