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
  const [status, setStatus] = useState<"provisioning" | "online" | "awaiting_confirmation" | "error">("provisioning");

  useEffect(() => {
    // Poll dashboard for status every 5 seconds up to 2 minutes
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch("/api/business/status");
        if (res.status === 401) {
          setStatus("awaiting_confirmation");
          clearInterval(interval);
          return;
        }
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
            {status === "online"
              ? "Your Coworker is Live!"
              : status === "awaiting_confirmation"
                ? "Payment received"
                : "Setting things up…"}
          </h1>
          <p className="text-sm text-parchment/50 mt-2">
            {status === "online"
              ? "Everything is ready. Head to your dashboard."
              : status === "awaiting_confirmation"
                ? "Confirm your email to finish activating your account and access your dashboard."
                : "We're provisioning your VPS and configuring your AI coworker. This takes 2–5 minutes."}
          </p>
        </div>

        {status === "provisioning" && (
          <Card className="text-left space-y-3">
            {[
              "Provisioning Hostinger VPS",
              "Installing Ollama + Bifrost router",
              "Configuring Rowboat agent",
              "Creating inworld.ai voice agent",
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

        {status === "awaiting_confirmation" && (
          <p className="text-xs text-parchment/40">
            Check your inbox for the confirmation link, then sign in to continue.
          </p>
        )}
      </div>
    </div>
  );
}
