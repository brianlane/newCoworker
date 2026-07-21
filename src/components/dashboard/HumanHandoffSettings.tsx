"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";

/**
 * Employees-page card for team-first human handoff. OFF (default): when a
 * customer asks for a person (needs-human escalation), the owner is paged
 * immediately. ON: the whole active roster is texted a claim offer at once
 * (first "1" wins, "2" passes) and the owner is alerted only when nobody
 * claims within 10 minutes. The toggle also manages the seeded
 * "Human handoff — offer to team first" flow (visible on /dashboard/aiflows,
 * templates editable there).
 */
export function HumanHandoffSettings({
  businessId,
  initialTeamFirst
}: {
  businessId: string;
  initialTeamFirst: boolean;
}) {
  const t = useTranslations("dashboard.humanHandoff");
  const [teamFirst, setTeamFirst] = useState(initialTeamFirst);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setStatus(null);
    const prev = teamFirst;
    setTeamFirst(next);
    try {
      const res = await fetch("/api/business/needs-human-team-first", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, teamFirst: next })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) throw new Error(json.error?.message ?? t("saveFailed"));
      setStatus(t("saved"));
    } catch (e) {
      setTeamFirst(prev);
      setStatus(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">{t("title")}</h2>
      <label className="flex items-start gap-3 text-sm text-parchment/80">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={teamFirst}
          disabled={busy}
          onChange={(ev) => toggle(ev.target.checked)}
        />
        <span>
          {t("toggleLabel")}
          <span className="block text-xs text-parchment/40 mt-1">{t("toggleHelp")}</span>
        </span>
      </label>
      {status && <p className="mt-2 text-xs text-parchment/50">{status}</p>}
    </Card>
  );
}
