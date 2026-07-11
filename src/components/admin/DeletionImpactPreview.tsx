"use client";

import { useEffect, useState } from "react";

type Impact = {
  businessName: string;
  counts: {
    contacts: number;
    voiceTranscripts: number;
    smsInbound: number;
    smsOutbound: number;
    emails: number;
    aiflows: number;
    employees: number;
    dashboardMembers: number;
  };
  hasVps: boolean;
  didE164: string | null;
};

/**
 * BizBlasts-style data-count preview rendered inside the admin
 * force-cancel / force-refund confirm dialogs, so the operator sees exactly
 * what the destructive action removes before clicking through.
 */
export function DeletionImpactPreview({ businessId }: { businessId: string }) {
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/deletion-impact?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { impact: Impact };
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!res.ok || !json?.ok || !json.data) {
          setError(json?.error?.message ?? "Could not load the impact preview.");
          return;
        }
        setImpact(json.data.impact);
      } catch {
        if (!cancelled) setError("Network error loading the impact preview.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (error) return <p className="text-xs text-parchment/40">{error}</p>;
  if (!impact) return <p className="text-xs text-parchment/40">Loading impact preview…</p>;

  return (
    <ul
      className="rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-2 text-xs text-parchment/70 list-disc list-inside space-y-0.5"
      data-testid="admin-deletion-impact"
    >
      <li>{impact.counts.contacts} contacts</li>
      <li>{impact.counts.voiceTranscripts} call transcripts</li>
      <li>{impact.counts.smsInbound + impact.counts.smsOutbound} text messages</li>
      <li>{impact.counts.emails} emails</li>
      <li>{impact.counts.aiflows} AiFlows</li>
      <li>{impact.counts.employees} team-roster employees</li>
      {impact.counts.dashboardMembers > 0 && (
        <li>{impact.counts.dashboardMembers} invited dashboard logins</li>
      )}
      {impact.didE164 && <li>DID {impact.didE164} released</li>}
      {impact.hasVps && <li>Live VPS torn down</li>}
    </ul>
  );
}
