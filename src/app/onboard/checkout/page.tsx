"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { OrderSummaryCard } from "@/components/OrderSummaryCard";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ONBOARD_STORAGE_KEY, type OnboardingData } from "@/lib/onboarding/storage";

export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutContent />
    </Suspense>
  );
}

function CheckoutContent() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<OnboardingData | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        let foundData: OnboardingData | null = null;
        const businessId = searchParams.get("businessId");
        const draftToken = searchParams.get("draftToken");
        const requestedDraft = Boolean(businessId && draftToken);
        let storedData: OnboardingData | null = null;

        try {
          const stored = localStorage.getItem(ONBOARD_STORAGE_KEY);
          if (stored) {
            storedData = JSON.parse(stored) as OnboardingData;
          }
        } catch {
          /* localStorage unavailable */
        }

        if (businessId && draftToken) {
          const draftRes = await fetch(
            `/api/onboard/draft?businessId=${encodeURIComponent(businessId)}&draftToken=${encodeURIComponent(draftToken)}`
          );
          if (draftRes.ok) {
            const draftJson = await draftRes.json();
            foundData = draftJson.data?.onboardingData as OnboardingData;
          }
        }

        const storedMatchesRequestedDraft =
          storedData &&
          storedData.businessId === businessId &&
          storedData.draftToken === draftToken;

        // Prefer the local copy when it is for the same draft and has already
        // advanced beyond the server snapshot, such as after business creation.
        if (
          storedMatchesRequestedDraft &&
          storedData?.persistedToDatabase &&
          !foundData?.persistedToDatabase
        ) {
          foundData = storedData;
        }

        if (!foundData && storedData && (!requestedDraft || storedMatchesRequestedDraft)) {
          foundData = storedData;
        }

        if (foundData) {
          localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(foundData));
          setData(foundData);
        } else if (requestedDraft) {
          setError("We could not load that checkout draft. Please return to onboarding and continue again.");
        }
      } finally {
        setLoadingData(false);
      }
    }
    void loadData();
  }, [searchParams]);

  async function handleCheckout() {
    if (!data) return;
    setLoading(true);
    setError(null);

    try {
      const businessId = data.businessId ?? crypto.randomUUID();
      let onboardingData: OnboardingData = data;

      if (!data.persistedToDatabase) {
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
          onboardingToken: createJson.data?.onboardingToken ?? undefined,
          persistedToDatabase: true
        };
        localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(onboardingData));
        setData(onboardingData);
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

      if (onboardingData.businessId && onboardingData.draftToken) {
        const draftRes = await fetch("/api/onboard/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: onboardingData.businessId,
            draftToken: onboardingData.draftToken,
            onboardingData
          })
        });

        const draftJson = await draftRes.json().catch(() => null);
        if (!draftRes.ok) {
          throw new Error(draftJson?.error?.message ?? "Failed to sync onboarding draft");
        }
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
          signupUserId: onboardingData.signupUserId,
          draftToken: onboardingData.draftToken
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
            {error ?? "It looks like you haven&apos;t completed the onboarding questionnaire yet."}
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
