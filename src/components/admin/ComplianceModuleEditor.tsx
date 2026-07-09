"use client";

/**
 * Admin "Custom compliance" card (enterprise): tenant-specific guardrail
 * text + restricted terms, layered on top of (never replacing) the platform
 * guardrails. Saving rewrites the marker-delimited soul.md block and
 * re-seeds the tenant vault, so changes reach the live agent within a
 * minute — no redeploy.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import type { ComplianceModule } from "@/lib/compliance/module";

export function ComplianceModuleEditor({
  businessId,
  initialModule
}: {
  businessId: string;
  initialModule: ComplianceModule | null;
}) {
  const router = useRouter();
  const [customPrompt, setCustomPrompt] = useState(initialModule?.customPrompt ?? "");
  const [terms, setTerms] = useState((initialModule?.forbiddenTerms ?? []).join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(module: ComplianceModule | null): Promise<boolean> {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/admin/compliance-module", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, complianceModule: module })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
        return false;
      }
      setSaved(true);
      router.refresh();
      return true;
    } catch {
      setError("Network error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  function save() {
    const parsedTerms = terms
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const nextModule: ComplianceModule = {};
    if (customPrompt.trim()) nextModule.customPrompt = customPrompt.trim();
    if (parsedTerms.length > 0) nextModule.forbiddenTerms = parsedTerms;
    void submit(Object.keys(nextModule).length > 0 ? nextModule : null);
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-parchment/50 text-xs">
        Business-specific compliance rules, applied IN ADDITION to the platform guardrails
        (never instead of them). Saving updates the live agent within about a minute via a
        vault re-seed.
      </p>
      <label className="block space-y-1">
        <span className="text-xs text-parchment/40">Custom guardrail text (10–2000 chars)</span>
        <textarea
          className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-sm text-parchment min-h-24"
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          placeholder="Never quote settlement amounts. Always read the recorded-line disclosure before discussing account details."
          maxLength={2000}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-parchment/40">Restricted terms (comma-separated, never discussed)</span>
        <input
          className="w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-sm text-parchment"
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          placeholder="pending litigation, merger, layoffs"
        />
      </label>
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" onClick={save} loading={loading}>
          Save module
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const ok = await submit(null);
            if (ok) {
              setCustomPrompt("");
              setTerms("");
            }
          }}
          loading={loading}
        >
          Clear module
        </Button>
        {saved && <span className="text-xs text-claw-green">Saved — vault re-seed scheduled</span>}
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
