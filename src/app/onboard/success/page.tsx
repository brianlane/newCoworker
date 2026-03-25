"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { StatusDot } from "@/components/ui/StatusDot";

export default function OnboardSuccessPage() {
  return (
    <Suspense>
      <OnboardSuccessContent />
    </Suspense>
  );
}

function OnboardSuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id");
  const [status, setStatus] = useState<"provisioning" | "online" | "error">("provisioning");

  useEffect(() => {
    // Poll dashboard for status every 5 seconds up to 2 minutes
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch("/api/business/status");
        const json = await res.json();
        if (json.data?.status === "online") {
          setStatus("online");
          clearInterval(interval);
        }
      } catch {
        // ignore
      }
      if (attempts >= 24) {
        clearInterval(interval);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
      <div className="max-w-md w-full space-y-6 text-center">
        <Image
          src="/logo.png"
          alt="New Coworker"
          width={64}
          height={64}
          className="rounded-full mx-auto"
        />

        <div>
          <h1 className="text-2xl font-bold text-parchment">
            {status === "online" ? "Your Coworker is Live!" : "Setting things up…"}
          </h1>
          <p className="text-sm text-parchment/50 mt-2">
            {status === "online"
              ? "Everything is ready. Head to your dashboard."
              : "We're provisioning your VPS and configuring your AI coworker. This takes 2–5 minutes."}
          </p>
        </div>

        {status !== "online" && (
          <Card className="text-left space-y-3">
            {[
              "Provisioning Hostinger KVM 8 VPS",
              "Installing Ollama + Bifrost router",
              "Configuring OpenClaw agent",
              "Creating ElevenLabs voice agent",
              "Attaching Twilio phone number",
              "Injecting soul.md + identity.md"
            ].map((step, i) => (
              <div key={step} className="flex items-center gap-3 text-sm">
                <StatusDot status={i < 2 ? "online" : "offline"} />
                <span className={i < 2 ? "text-parchment" : "text-parchment/40"}>{step}</span>
              </div>
            ))}
          </Card>
        )}

        {status === "online" && (
          <a
            href="/dashboard"
            className="inline-block rounded-lg bg-claw-green text-deep-ink px-8 py-3 font-semibold hover:bg-opacity-90 transition-colors"
          >
            Go to Dashboard →
          </a>
        )}
      </div>
    </div>
  );
}
