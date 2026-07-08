"use client";

/**
 * Admin provider/region pin control (enterprise businesses only).
 *
 * Sets `businesses.vps_provider` + `vps_region` via POST
 * /api/admin/vps-provider. The pin drives which provisioner the
 * orchestrator uses on the NEXT provision (hostinger purchase/pool, OVH
 * Beauharnois purchase); it never moves a live box — the server refuses a
 * provider switch while a box exists. BYOS pinning happens through the
 * SSH-handover enrollment card instead.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function VpsProviderPanel({
  businessId,
  initialProvider,
  initialRegion,
  hasBox
}: {
  businessId: string;
  initialProvider: string;
  initialRegion: string;
  hasBox: boolean;
}) {
  const router = useRouter();
  const [provider, setProvider] = useState(initialProvider);
  const [region, setRegion] = useState(initialRegion);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = provider !== initialProvider || region !== initialRegion;

  async function apply() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/vps-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, provider, region })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Update failed");
      } else {
        setNotice(`Pinned to ${provider} · ${region}. Takes effect on the next provision.`);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-parchment/50">
        Drives which provider the NEXT provision uses. OVH (Beauharnois, Quebec) is the
        platform-owned Canadian data-residency option; BYOS is pinned via the
        SSH-handover card. {hasBox ? "A box exists — provider switches are blocked until it is torn down." : ""}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-parchment/50">
          Provider
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-parchment/20 bg-deep-ink px-3 py-1.5 text-sm text-parchment"
          >
            <option value="hostinger">Hostinger (US fleet)</option>
            <option value="ovh">OVHcloud (Canada / Beauharnois)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-parchment/50">
          Region
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="rounded-lg border border-parchment/20 bg-deep-ink px-3 py-1.5 text-sm text-parchment"
          >
            <option value="us">US</option>
            <option value="ca">Canada (data residency)</option>
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={apply} loading={loading} disabled={!dirty || loading}>
          Pin provider
        </Button>
      </div>
      {notice && <p className="text-xs text-signal-teal">{notice}</p>}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
