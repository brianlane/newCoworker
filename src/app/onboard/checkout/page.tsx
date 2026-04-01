"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { OrderSummaryCard } from "@/components/OrderSummaryCard";
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
      const businessId = data.businessId ?? crypto.randomUUID();
      let onboardingData: OnboardingData = data;

      if (!data.businessId) {
        const createRes = await fetch("/api/business/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            ownerEmail: data.ownerEmail,
            signupUserId: data.signupUserId,
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
        const createJson = await createRes.json();
        if (!createRes.ok) throw new Error(createJson.error?.message ?? "Failed to create business");
        onboardingData = {
          ...data,
          businessId,
          onboardingToken: createJson.data?.onboardingToken ?? undefined
        };
      }

      if (onboardingData.assistantChat?.drafts) {
        const configRes = await fetch("/api/business/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            ownerEmail: onboardingData.ownerEmail,
            onboardingToken: onboardingData.onboardingToken,
            signupUserId: onboardingData.signupUserId,
            soulMd: onboardingData.assistantChat.drafts.soulMd,
            identityMd: onboardingData.assistantChat.drafts.identityMd,
            memoryMd: onboardingData.assistantChat.drafts.memoryMd
          })
        });

        if (!configRes.ok) throw new Error("Failed to save assistant profile");
      }

      const checkoutRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: onboardingData.tier,
          businessId,
          billingPeriod: onboardingData.billingPeriod ?? "biennial",
          ownerEmail: onboardingData.ownerEmail,
          onboardingToken: onboardingData.onboardingToken,
          signupUserId: onboardingData.signupUserId
        })
      });
      const checkoutJson = await checkoutRes.json();
      if (!checkoutRes.ok) throw new Error(checkoutJson.error?.message ?? "Checkout failed");

      const { checkoutUrl } = checkoutJson.data ?? {};
      if (!checkoutUrl) throw new Error("Invalid checkout response");

      localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify({ ...onboardingData, businessId }));
      window.location.href = checkoutUrl;
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

  const billingPeriod = data.billingPeriod ?? "biennial";
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
            <OrderSummaryCard
              tier={data.tier}
              period={billingPeriod}
              businessName={data.businessName}
              preferFirstMonthLabel
            />
            <p className="text-xs text-parchment/30 text-center">
              30-day money-back guarantee · Cancel within 30 days for a full refund
            </p>
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
