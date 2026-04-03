"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

type Props = {
  businessId: string;
  initiallyConnected: boolean;
};

export function GoogleIntegrationActions({ businessId, initiallyConnected }: Props) {
  const [connected, setConnected] = useState(initiallyConnected);
  const [loading, setLoading] = useState(false);

  async function disconnect() {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, provider: "google" })
      });
      if (res.ok) {
        setConnected(false);
        window.location.reload();
      }
    } finally {
      setLoading(false);
    }
  }

  if (connected) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={disconnect} loading={loading}>
        Disconnect Google
      </Button>
    );
  }

  return (
    <a
      href={`/api/integrations/google?businessId=${encodeURIComponent(businessId)}`}
      className="inline-flex items-center justify-center gap-2 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-deep-ink focus:ring-claw-green px-3 py-1.5 text-sm rounded-md bg-claw-green text-deep-ink hover:bg-opacity-90 font-semibold"
    >
      Connect Google
    </a>
  );
}
