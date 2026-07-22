"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { BlogSettingsRow } from "@/lib/blog/shared";

function Toggle({
  checked,
  onChange,
  label,
  help
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  help: string;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-claw-green"
      />
      <span>
        <span className="block text-sm font-medium text-parchment">{label}</span>
        <span className="block text-xs text-parchment/45">{help}</span>
      </span>
    </label>
  );
}

/**
 * Automation settings card on /admin/blog: the weekly-digest toggles and
 * the Instagram cross-post target/mode.
 */
export function BlogSettingsCard({ initialSettings }: { initialSettings: BlogSettingsRow }) {
  const t = useTranslations("admin.blogPage");
  const [settings, setSettings] = useState(initialSettings);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const save = async () => {
    setState("saving");
    try {
      const response = await fetch("/api/admin/blog/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      setState(response.ok ? "saved" : "error");
    } catch {
      setState("error");
    }
  };

  const set = <K extends keyof BlogSettingsRow>(key: K, value: BlogSettingsRow[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setState("idle");
  };

  return (
    <div className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-6">
      <h2 className="mb-4 text-lg font-semibold text-parchment">{t("settingsTitle")}</h2>
      <div className="space-y-4">
        <p className="text-xs text-parchment/45">{t("rotationHelp")}</p>
        <Toggle
          checked={settings.digest_enabled}
          onChange={(v) => set("digest_enabled", v)}
          label={t("digestEnabled")}
          help={t("digestEnabledHelp")}
        />
        <Toggle
          checked={settings.auto_tutorial_enabled}
          onChange={(v) => set("auto_tutorial_enabled", v)}
          label={t("autoTutorial")}
          help={t("autoTutorialHelp")}
        />
        <Toggle
          checked={settings.auto_business_tips_enabled}
          onChange={(v) => set("auto_business_tips_enabled", v)}
          label={t("autoBusinessTips")}
          help={t("autoBusinessTipsHelp")}
        />
        <Toggle
          checked={settings.auto_feature_enabled}
          onChange={(v) => set("auto_feature_enabled", v)}
          label={t("autoFeature")}
          help={t("autoFeatureHelp")}
        />
        <Toggle
          checked={settings.digest_as_draft}
          onChange={(v) => set("digest_as_draft", v)}
          label={t("digestAsDraft")}
          help={t("digestAsDraftHelp")}
        />
        <Toggle
          checked={settings.digest_include_image}
          onChange={(v) => set("digest_include_image", v)}
          label={t("digestIncludeImage")}
          help={t("digestIncludeImageHelp")}
        />
        <div>
          <label className="block text-sm font-medium text-parchment" htmlFor="igBusinessId">
            {t("igBusiness")}
          </label>
          <p className="text-xs text-parchment/45">{t("igBusinessHelp")}</p>
          <input
            id="igBusinessId"
            type="text"
            value={settings.instagram_business_id ?? ""}
            onChange={(e) => set("instagram_business_id", e.target.value.trim() || null)}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="mt-2 w-full max-w-md rounded-lg border border-parchment/15 bg-transparent px-3 py-2 text-sm text-parchment placeholder:text-parchment/25 focus:border-claw-green focus:outline-none"
          />
        </div>
        <Toggle
          checked={settings.instagram_publish_immediately}
          onChange={(v) => set("instagram_publish_immediately", v)}
          label={t("igImmediate")}
          help={t("igImmediateHelp")}
        />
      </div>
      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={state === "saving"}
          className="rounded-lg bg-claw-green px-4 py-2 text-sm font-medium text-deep-ink hover:opacity-90 disabled:opacity-50"
        >
          {t("saveSettings")}
        </button>
        {state === "saved" && <span className="text-sm text-claw-green">{t("settingsSaved")}</span>}
        {state === "error" && <span className="text-sm text-red-400">{t("error")}</span>}
      </div>
    </div>
  );
}
