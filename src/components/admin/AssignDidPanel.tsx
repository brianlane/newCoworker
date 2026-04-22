"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatDid } from "@/lib/telnyx/format";
import { resolveBridgeHealthState, type BridgeHealthState } from "@/lib/telnyx/bridge-health";

type AvailableNumber = {
  phone_number: string;
  vanity_format?: string;
  cost_information?: { monthly_cost?: string; upfront_cost?: string; currency?: string } | null;
  region_information?: Array<{ region_type?: string; region_name?: string }>;
};

type AssignDidPanelProps = {
  businessId: string;
  currentE164: string | null;
  currentBridgeOrigin: string | null;
  bridgeHeartbeatAt: string | null;
  forwardToE164: string | null;
  transferEnabled: boolean;
  smsFallbackEnabled: boolean;
  defaultAreaCode?: string;
  defaultState?: string;
};

const ADMIN_HEALTH_COPY: Record<
  BridgeHealthState,
  { variant: "success" | "error" | "neutral"; label: string }
> = {
  pending: { variant: "neutral", label: "Never" },
  healthy: { variant: "success", label: "Healthy" },
  stale: { variant: "error", label: "Stale" },
  unknown: { variant: "neutral", label: "Unknown" }
};

export function AssignDidPanel(props: AssignDidPanelProps) {
  const router = useRouter();
  const [areaCode, setAreaCode] = useState(props.defaultAreaCode ?? "");
  const [admin, setAdmin] = useState(props.defaultState ?? "");
  const [manual, setManual] = useState("");
  const [search, setSearch] = useState<AvailableNumber[]>([]);
  const [loading, setLoading] = useState<"search" | "assign" | "order" | "settings" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [forward, setForward] = useState(props.forwardToE164 ?? "");
  const [transferEnabled, setTransferEnabled] = useState(props.transferEnabled);
  const [smsFallbackEnabled, setSmsFallbackEnabled] = useState(props.smsFallbackEnabled);

  const bridge = ADMIN_HEALTH_COPY[resolveBridgeHealthState(props.bridgeHeartbeatAt)];

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading("search");
    try {
      const res = await fetch("/api/admin/telnyx/search-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          areaCode: areaCode.trim() || undefined,
          administrativeArea: admin.trim() || undefined
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Search failed");
        setSearch([]);
      } else {
        setSearch((json.data?.numbers ?? []) as AvailableNumber[]);
        if ((json.data?.numbers ?? []).length === 0) {
          setNotice("No available numbers matched those filters.");
        }
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(null);
    }
  }

  async function handleAssign(toE164: string) {
    setError(null);
    setNotice(null);
    setLoading("assign");
    try {
      const res = await fetch("/api/admin/telnyx/assign-did", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: props.businessId, toE164, associateWithPlatform: true })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Assign failed");
      } else {
        setNotice(`Assigned ${toE164}`);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(null);
    }
  }

  async function handleOrder(toE164: string) {
    setError(null);
    setNotice(null);
    setLoading("order");
    try {
      const match = /^\+1(\d{3})/.exec(toE164);
      const res = await fetch("/api/admin/telnyx/order-did", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: props.businessId,
          // Pass the exact number so the backend orders the DID the admin
          // clicked on, not an arbitrary one from the same area code. The
          // area/state filters are kept as a fallback hint for the rare case
          // the picked number is already gone at order time.
          specificNumber: toE164,
          areaCode: match ? match[1] : undefined,
          administrativeArea: admin.trim() || undefined
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Order failed");
      } else {
        setNotice(`Ordered and assigned ${json.data?.route?.to_e164 ?? "number"}`);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(null);
    }
  }

  async function handleManualAssign(e: FormEvent) {
    e.preventDefault();
    if (!manual.trim()) return;
    await handleAssign(manual.trim());
    setManual("");
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading("settings");
    try {
      const res = await fetch("/api/admin/telnyx/update-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: props.businessId,
          forwardToE164: forward.trim().length === 0 ? null : forward.trim(),
          transferEnabled,
          smsFallbackEnabled
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Save failed");
      } else {
        setNotice("Transfer settings saved");
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-parchment/40">Current DID:</span>
        {props.currentE164 ? (
          <span className="font-mono text-parchment">{formatDid(props.currentE164)}</span>
        ) : (
          <span className="text-parchment/40 italic">not assigned</span>
        )}
        <span className="text-parchment/40">·</span>
        <span className="text-parchment/40">Bridge:</span>
        <Badge variant={bridge.variant}>{bridge.label}</Badge>
        {props.currentBridgeOrigin && (
          <span className="text-parchment/30 text-xs font-mono truncate max-w-[240px]">
            {props.currentBridgeOrigin}
          </span>
        )}
      </div>

      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-parchment/60 flex flex-col">
          Area code
          <input
            className="mt-1 w-24 rounded-md border border-parchment/20 bg-deep-ink/60 px-2 py-1 text-sm font-mono text-parchment focus:border-signal-teal focus:outline-none"
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value)}
            maxLength={3}
            placeholder="212"
          />
        </label>
        <label className="text-xs text-parchment/60 flex flex-col">
          State
          <input
            className="mt-1 w-20 rounded-md border border-parchment/20 bg-deep-ink/60 px-2 py-1 text-sm uppercase text-parchment focus:border-signal-teal focus:outline-none"
            value={admin}
            onChange={(e) => setAdmin(e.target.value.toUpperCase())}
            maxLength={2}
            placeholder="NY"
          />
        </label>
        <Button type="submit" size="sm" variant="ghost" loading={loading === "search"}>
          Search
        </Button>
      </form>

      {search.length > 0 && (
        <ul className="divide-y divide-parchment/10 rounded-md border border-parchment/10">
          {search.map((n) => (
            <li key={n.phone_number} className="flex items-center justify-between gap-3 px-3 py-2">
              <div>
                <p className="text-sm font-mono text-parchment">{formatDid(n.phone_number)}</p>
                <p className="text-xs text-parchment/40">
                  {n.region_information
                    ?.map((r) => r.region_name)
                    .filter(Boolean)
                    .join(", ") || "—"}
                  {n.cost_information?.monthly_cost
                    ? ` · $${n.cost_information.monthly_cost}/mo`
                    : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={loading === "order"}
                  onClick={() => handleOrder(n.phone_number)}
                >
                  Buy &amp; assign
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleManualAssign} className="flex items-end gap-2">
        <label className="text-xs text-parchment/60 flex flex-col flex-1 max-w-xs">
          Already-owned E.164
          <input
            className="mt-1 rounded-md border border-parchment/20 bg-deep-ink/60 px-2 py-1 text-sm font-mono text-parchment focus:border-signal-teal focus:outline-none"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="+15551234567"
          />
        </label>
        <Button type="submit" size="sm" variant="ghost" loading={loading === "assign"} disabled={!manual.trim()}>
          Assign existing
        </Button>
      </form>

      <form onSubmit={handleSaveSettings} className="rounded-md border border-parchment/10 p-3 space-y-3">
        <p className="text-xs uppercase tracking-wider text-parchment/50">
          Warm-transfer &amp; SMS fallback
        </p>
        <label className="text-xs text-parchment/60 flex flex-col max-w-xs">
          Owner phone (E.164)
          <input
            className="mt-1 rounded-md border border-parchment/20 bg-deep-ink/60 px-2 py-1 text-sm font-mono text-parchment focus:border-signal-teal focus:outline-none"
            value={forward}
            onChange={(e) => setForward(e.target.value)}
            placeholder="+16025551234"
          />
          <span className="mt-1 text-[11px] text-parchment/40">
            Used when the AI transfers a caller and when the voice bridge fails to attach.
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={transferEnabled}
            onChange={(e) => setTransferEnabled(e.target.checked)}
          />
          Let the AI warm-transfer callers to this number
        </label>
        <label className="flex items-center gap-2 text-xs text-parchment/70">
          <input
            type="checkbox"
            checked={smsFallbackEnabled}
            onChange={(e) => setSmsFallbackEnabled(e.target.checked)}
          />
          SMS this number if the voice bridge fails to attach
        </label>
        <Button type="submit" size="sm" variant="secondary" loading={loading === "settings"}>
          Save transfer settings
        </Button>
      </form>

      {error && <p className="text-xs text-spark-orange">{error}</p>}
      {notice && <p className="text-xs text-claw-green">{notice}</p>}
    </div>
  );
}
