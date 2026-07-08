"use client";

/**
 * Admin BYOS enrollment console (enterprise businesses only).
 *
 * Two-step SSH-handover flow against POST /api/admin/byos/enroll:
 *   1. Prepare — operator enters the customer box's IP/hostname + region;
 *      the server pins vps_provider='byos', mints (or reuses) the per-box
 *      keypair, and returns the PUBLIC key to hand to the customer.
 *   2. Verify & provision — the server probes SSH auth for immediate
 *      feedback, then runs the standard provisioning pipeline in the
 *      background; progress appears in the provisioning-log card below.
 *
 * Requirements shown to the operator mirror what provisioning expects:
 * fresh Ubuntu 24.04, root SSH on port 22, outbound 443 open, nothing else
 * running on the box.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

type Enrollment = {
  host: string;
  publicKey: string;
  fingerprintSha256: string;
  region: string;
};

export function ByosEnrollmentPanel({
  businessId,
  initialProvider,
  initialRegion,
  initialEnrollment
}: {
  businessId: string;
  initialProvider: string;
  initialRegion: string;
  initialEnrollment: Enrollment | null;
}) {
  const router = useRouter();
  const [host, setHost] = useState(initialEnrollment?.host ?? "");
  const [region, setRegion] = useState(initialRegion === "ca" ? "ca" : "us");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(initialEnrollment);
  const [provider, setProvider] = useState(initialProvider);
  const [loading, setLoading] = useState<"prepare" | "provision" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function callEnroll(body: Record<string, unknown>) {
    const res = await fetch("/api/admin/byos/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId, ...body })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? "Request failed");
    return json.data;
  }

  async function prepare() {
    setLoading("prepare");
    setError(null);
    setNotice(null);
    try {
      const data = await callEnroll({ action: "prepare", host, region });
      setEnrollment({
        host: data.host,
        publicKey: data.publicKey,
        fingerprintSha256: data.fingerprintSha256,
        region: data.region
      });
      setProvider("byos");
      setNotice(
        data.reusedExistingKey
          ? "Existing key reused (host updated). The key already installed on the box keeps working."
          : "Key minted. Hand the public key below to the customer."
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(null);
    }
  }

  async function provision() {
    setLoading("provision");
    setError(null);
    setNotice(null);
    try {
      const data = await callEnroll({ action: "provision" });
      setNotice(
        `SSH probe to ${data.host} passed — provisioning started. Follow progress in the provisioning logs below.`
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-parchment/40">Provider</span>
        <span className="rounded-full border border-signal-teal/40 bg-signal-teal/10 px-3 py-0.5 text-xs font-medium text-signal-teal">
          {provider}
        </span>
        {enrollment && (
          <span className="text-xs text-parchment/50 font-mono">
            {enrollment.host} · {enrollment.region}
          </span>
        )}
      </div>

      <p className="text-xs text-parchment/50">
        Customer box requirements: fresh Ubuntu 24.04, root SSH on port 22, outbound 443
        open, no other workloads. Enrollment pins this tenant to their own box — no
        Hostinger purchase, pool, or teardown applies afterward.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-parchment/50">
          Box IP / hostname
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="203.0.113.7"
            className="rounded-lg border border-parchment/20 bg-transparent px-3 py-1.5 text-sm text-parchment font-mono w-56"
          />
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
        <Button
          size="sm"
          variant="secondary"
          onClick={prepare}
          loading={loading === "prepare"}
          disabled={host.trim().length === 0 || loading !== null}
        >
          {enrollment ? "Re-prepare (update host)" : "Prepare enrollment"}
        </Button>
      </div>

      {enrollment && (
        <div className="space-y-2 rounded-lg border border-parchment/15 bg-deep-ink/60 p-3">
          <p className="text-xs text-parchment/60">
            Customer step — append this public key to <code>/root/.ssh/authorized_keys</code> on
            the box (fingerprint <span className="font-mono">{enrollment.fingerprintSha256}</span>):
          </p>
          <pre className="max-h-24 overflow-auto rounded-md bg-deep-ink p-2 text-[10px] font-mono text-parchment/80 whitespace-pre-wrap break-all">
            {enrollment.publicKey}
          </pre>
          <Button size="sm" onClick={provision} loading={loading === "provision"} disabled={loading !== null}>
            Verify SSH &amp; provision
          </Button>
        </div>
      )}

      {notice && <p className="text-xs text-signal-teal">{notice}</p>}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
