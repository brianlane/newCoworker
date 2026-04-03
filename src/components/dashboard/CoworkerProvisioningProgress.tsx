"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

type StatusPayload = {
  ok: boolean;
  data?: {
    percent: number;
    updatedAt: string | null;
    complete: boolean;
  };
};

type Props = {
  businessId: string;
};

export function CoworkerProvisioningProgress({ businessId }: Props) {
  const [percent, setPercent] = useState(0);
  const [hidden, setHidden] = useState(false);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/provisioning/status?businessId=${encodeURIComponent(businessId)}`, {
      credentials: "same-origin"
    });
    const json = (await res.json()) as StatusPayload;
    if (!json.ok || !json.data) return;
    setPercent(Math.max(0, Math.min(100, json.data.percent)));
    if (json.data.complete) {
      setHidden(true);
    }
  }, [businessId]);

  useEffect(() => {
    const initial = setTimeout(() => void poll(), 0);
    const id = setInterval(() => void poll(), 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [poll]);

  if (hidden) return null;

  return (
    <Card className="overflow-hidden border-signal-teal/30">
      <div className="flex flex-col items-center justify-center gap-6 py-10 px-4">
        <div className="relative h-36 w-36">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden>
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="10"
              className="text-parchment/15"
            />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${(percent / 100) * 264} 264`}
              className="text-signal-teal transition-[stroke-dasharray] duration-500 ease-out"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-4xl font-bold tabular-nums text-parchment">{percent}</span>
          </div>
        </div>
        <div className="h-2 w-full max-w-xs rounded-full bg-parchment/10">
          <div
            className="h-full rounded-full bg-signal-teal transition-all duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </Card>
  );
}
