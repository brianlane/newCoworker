"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ONBOARD_STORAGE_KEY, type OnboardingData } from "@/lib/onboarding/storage";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function CheckoutPage() {
  const [data, setData] = useState<OnboardingData | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: { user } } = await supabase.auth.getUser();
        let foundData: OnboardingData | null = null;

        if (user?.user_metadata?.onboarding_data) {
          foundData = user.user_metadata.onboarding_data as OnboardingData;
          if (user.user_metadata.business_name && typeof user.user_metadata.business_name === "string") {
            foundData = { ...foundData, businessName: user.user_metadata.business_name };
          }
        }

        if (!foundData) {
          try {
            const stored = localStorage.getItem(ONBOARD_STORAGE_KEY);
            if (stored) {
              foundData = JSON.parse(stored) as OnboardingData;
            }
          } catch {
            /* localStorage unavailable */
          }
        }

        if (foundData) {
          setData(foundData);
        }
      } finally {
        setLoadingData(false);
      }
    }
    loadData();
  }, []);

  async function handleCheckout() {
    if (!data) return;
    setLoading(true);
    setError(null);

    try {
      const businessId = crypto.randomUUID();
      const createRes = await fetch("/api/business/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: data.businessName,
          tier: data.tier,
          businessType: data.businessType,
          ownerName: data.ownerName,
          phone: data.phone,
          serviceArea: data.serviceArea,
          typicalInquiry: data.typicalInquiry,
          teamSize: data.teamSize,
          crmUsed: data.crmUsed
        })
      });
      if (!createRes.ok) throw new Error("Failed to create business");

      const checkoutRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: data.tier, businessId })
      });
      const checkoutJson = await checkoutRes.json();
      if (!checkoutRes.ok) throw new Error(checkoutJson.error?.message ?? "Checkout failed");

      localStorage.removeItem(ONBOARD_STORAGE_KEY);
      window.location.href = checkoutJson.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  if (loadingData) {
    return (
      <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full mx-auto" />
          <h1 className="text-2xl font-bold text-parchment">Loading your plan...</h1>
          <p className="text-sm text-parchment/50">Please wait while we prepare your checkout details.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-6">
          <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full mx-auto" />
          <h1 className="text-2xl font-bold text-parchment">No plan selected</h1>
          <p className="text-sm text-parchment/50">
            It looks like you haven&apos;t completed the onboarding questionnaire yet.
          </p>
          <a
            href="/onboard"
            className="inline-block rounded-lg bg-claw-green text-deep-ink px-8 py-3 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Choose a Plan
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <Image src="/logo.png" alt="New Coworker" width={56} height={56} className="rounded-full mx-auto" />
          <h1 className="text-2xl font-bold text-parchment mt-4">Ready to launch</h1>
          <p className="text-sm text-parchment/50 mt-1">Review your order and proceed to payment.</p>
        </div>

        <Card>
          <div className="space-y-3 text-sm">
            <div className="bg-parchment/5 rounded-lg p-4 space-y-2">
              <h3 className="font-semibold text-parchment">Order Summary</h3>
              <div className="flex justify-between text-parchment/70">
                <span>Plan</span>
                <span className="capitalize">{data.tier}</span>
              </div>
              <div className="flex justify-between text-parchment/70">
                <span>Business</span>
                <span>{data.businessName || "—"}</span>
              </div>
              <div className="flex justify-between text-parchment/70">
                <span>Monthly</span>
                <span>{data.tier === "starter" ? "$199/mo" : "$299/mo"}</span>
              </div>
              {data.tier === "standard" && (
                <div className="flex justify-between text-parchment/70">
                  <span>Setup fee</span>
                  <span>$499 (one-time)</span>
                </div>
              )}
            </div>
          </div>
        </Card>

        {error && (
          <p className="text-spark-orange text-xs text-center">{error}</p>
        )}

        <Button className="w-full" onClick={handleCheckout} loading={loading}>
          Proceed to Payment
        </Button>

        <p className="text-center text-xs text-parchment/30">
          You&apos;ll be redirected to Stripe for secure payment.
        </p>
      </div>
    </div>
  );
}
