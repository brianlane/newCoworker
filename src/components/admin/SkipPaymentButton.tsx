"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function SkipPaymentButton({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSkip() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/skip-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Failed to skip payment");
      } else {
        setDone(true);
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  if (done) return <span className="text-xs text-claw-green">✓ Activated — provisioning started</span>;

  return (
    <div className="space-y-1">
      <Button size="sm" variant="secondary" onClick={handleSkip} loading={loading}>
        Skip Payment &amp; Provision
      </Button>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}
