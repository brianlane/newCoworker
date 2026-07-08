"use client";

/**
 * White-label branding editor (enterprise): product name, https logo URL,
 * accent color. Used on the dashboard settings page (owner/manager) and the
 * admin enterprise business page — both talk to /api/dashboard/branding,
 * which enforces manage_settings + the enterprise tier gate server-side.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { Branding } from "@/lib/plans/branding";

export function BrandingEditor({
  businessId,
  initialBranding
}: {
  businessId: string;
  initialBranding: Branding | null;
}) {
  const router = useRouter();
  const [productName, setProductName] = useState(initialBranding?.productName ?? "");
  const [logoUrl, setLogoUrl] = useState(initialBranding?.logoUrl ?? "");
  const [accentColor, setAccentColor] = useState(initialBranding?.accentColor ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(branding: Branding | null) {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/dashboard/branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, branding })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
      } else {
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  function save() {
    const branding: Branding = {};
    if (productName.trim()) branding.productName = productName.trim();
    if (logoUrl.trim()) branding.logoUrl = logoUrl.trim();
    if (accentColor.trim()) branding.accentColor = accentColor.trim();
    void submit(Object.keys(branding).length > 0 ? branding : null);
  }

  function clearAll() {
    setProductName("");
    setLogoUrl("");
    setAccentColor("");
    void submit(null);
  }

  const inputCls =
    "w-full rounded-md bg-deep-ink border border-parchment/15 px-3 py-2 text-sm text-parchment";

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">White-label branding</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Put your own name, logo, and accent color on this dashboard. Leave a field empty to keep
        the platform default; changes apply on the next page load.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Product name</span>
          <input
            className={inputCls}
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="Acme Assistant"
            maxLength={60}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-parchment/40">Accent color (#hex)</span>
          <input
            className={inputCls}
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            placeholder="#22c55e"
            maxLength={7}
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs text-parchment/40">Logo URL (https, square works best)</span>
          <input
            className={inputCls}
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://cdn.example.com/logo.png"
            maxLength={500}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} loading={loading}>
          Save branding
        </Button>
        <Button size="sm" variant="secondary" onClick={clearAll} loading={loading}>
          Reset to platform branding
        </Button>
        {saved && <span className="text-xs text-claw-green">Saved</span>}
      </div>
      {error && <p className="text-xs text-spark-orange mt-2">{error}</p>}
    </Card>
  );
}
