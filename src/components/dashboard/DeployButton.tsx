"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

export function DeployButton({ businessId }: { businessId: string }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeploy() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/provisioning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Provisioning failed");
      } else {
        setDone(true);
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  if (done) return <span className="text-xs text-claw-green">✓ Deploying…</span>;

  return (
    <div>
      <Button size="sm" onClick={handleDeploy} loading={loading}>
        Deploy
      </Button>
      {error && <p className="text-xs text-spark-orange mt-1">{error}</p>}
    </div>
  );
}
