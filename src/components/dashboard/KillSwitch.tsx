"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type Props = {
  businessId: string;
  initiallyPaused: boolean;
  /** Shorter copy for admin emergency card */
  compact?: boolean;
};

export function KillSwitch({ businessId, initiallyPaused, compact }: Props) {
  const router = useRouter();
  const [paused, setPaused] = useState(initiallyPaused);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setPausedState(next: boolean) {
    if (!next) {
      if (
        !window.confirm(
          "Resume your AI coworker? Automated tasks and integrations can run again."
        )
      ) {
        return;
      }
    } else {
      if (
        !window.confirm(
          "Pause your AI coworker immediately? This stops automated actions until you resume."
        )
      ) {
        return;
      }
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/business/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, paused: next })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Could not update kill switch");
        return;
      }
      setPaused(next);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className={paused ? "border-spark-orange/50 bg-spark-orange/5" : undefined}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-parchment mb-1">
            {compact ? "Kill switch" : "Emergency pause (kill switch)"}
          </h2>
          <p className="text-xs text-parchment/50 max-w-xl">
            {paused
              ? "Your coworker is paused. Resume when you are ready for automation to continue."
              : compact
                ? "Immediately pause all automated coworker actions for this client."
                : "Use this if you need to stop your coworker right away. You can resume anytime."}
          </p>
          {error && <p className="text-xs text-spark-orange mt-2">{error}</p>}
        </div>
        <div className="shrink-0">
          {paused ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={loading}
              onClick={() => setPausedState(false)}
            >
              Resume coworker
            </Button>
          ) : (
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={loading}
              onClick={() => setPausedState(true)}
            >
              Pause coworker
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
