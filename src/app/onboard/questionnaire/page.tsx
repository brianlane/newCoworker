"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";

type Step = 1 | 2 | 3;

interface FormData {
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  serviceArea: string;
  typicalInquiry: string;
  teamSize: string;
  crmUsed: string;
}

const EMPTY_FORM: FormData = {
  businessName: "",
  businessType: "real_estate",
  ownerName: "",
  phone: "",
  serviceArea: "",
  typicalInquiry: "",
  teamSize: "1",
  crmUsed: ""
};

export default function QuestionnairePage() {
  return (
    <Suspense>
      <QuestionnaireForm />
    </Suspense>
  );
}

function QuestionnaireForm() {
  const searchParams = useSearchParams();
  const tier = (searchParams.get("tier") ?? "starter") as "starter" | "standard";

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        window.location.href = `/signup?redirectTo=${encodeURIComponent(`/onboard/questionnaire?tier=${tier}`)}`;
      } else {
        setAuthChecked(true);
      }
    });
  }, [tier]);

  function update(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      // Create the business record
      const businessId = crypto.randomUUID();
      const createRes = await fetch("/api/business/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: form.businessName,
          tier,
          businessType: form.businessType,
          ownerName: form.ownerName,
          phone: form.phone,
          serviceArea: form.serviceArea,
          typicalInquiry: form.typicalInquiry,
          teamSize: form.teamSize,
          crmUsed: form.crmUsed
        })
      });
      if (!createRes.ok) throw new Error("Failed to create business");

      // Create Stripe checkout
      const checkoutRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, businessId })
      });
      const checkoutJson = await checkoutRes.json();
      if (!checkoutRes.ok) throw new Error(checkoutJson.error?.message ?? "Checkout failed");

      window.location.href = checkoutJson.data.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-deep-ink flex items-center justify-center">
        <p className="text-parchment/50 text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg space-y-6">
        <div>
          <div className="flex gap-2 mb-4">
            {([1, 2, 3] as Step[]).map((s) => (
              <div
                key={s}
                className={[
                  "h-1 flex-1 rounded-full transition-colors",
                  s <= step ? "bg-claw-green" : "bg-parchment/10"
                ].join(" ")}
              />
            ))}
          </div>
          <h1 className="text-2xl font-bold text-parchment">
            {step === 1
              ? "Tell us about your business"
              : step === 2
                ? "Communication style"
                : "Review & proceed to payment"}
          </h1>
          <p className="text-sm text-parchment/50 mt-1">Step {step} of 3</p>
        </div>

        <Card>
          {step === 1 && (
            <div className="space-y-4">
              <Input
                label="Business Name"
                value={form.businessName}
                onChange={(e) => update("businessName", e.target.value)}
                placeholder="Sunrise Realty"
                required
              />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-parchment/80">Business Type</label>
                <select
                  value={form.businessType}
                  onChange={(e) => update("businessType", e.target.value)}
                  className="rounded-lg border border-parchment/20 bg-deep-ink/50 px-3 py-2 text-sm text-parchment focus:outline-none focus:ring-2 focus:ring-signal-teal"
                >
                  <option value="real_estate">Real Estate</option>
                  <option value="dental">Dental Office</option>
                  <option value="hvac">HVAC</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <Input
                label="Your Name"
                value={form.ownerName}
                onChange={(e) => update("ownerName", e.target.value)}
                placeholder="Amy Laidlaw"
                required
              />
              <Input
                label="Phone Number"
                type="tel"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+1 (555) 000-0000"
              />
              <Input
                label="Service Area / Market"
                value={form.serviceArea}
                onChange={(e) => update("serviceArea", e.target.value)}
                placeholder="Phoenix Metro, AZ"
              />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <Textarea
                label="Typical customer inquiry"
                value={form.typicalInquiry}
                onChange={(e) => update("typicalInquiry", e.target.value)}
                rows={4}
                placeholder="Describe common situations: leads asking about listings, showing requests, offer status questions..."
              />
              <Input
                label="Team size"
                type="number"
                min={1}
                value={form.teamSize}
                onChange={(e) => update("teamSize", e.target.value)}
                placeholder="1"
              />
              <Input
                label="CRM in use (optional)"
                value={form.crmUsed}
                onChange={(e) => update("crmUsed", e.target.value)}
                placeholder="Follow Up Boss, HubSpot, Google Sheets..."
              />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3 text-sm">
              <div className="bg-parchment/5 rounded-lg p-4 space-y-2">
                <h3 className="font-semibold text-parchment">Order Summary</h3>
                <div className="flex justify-between text-parchment/70">
                  <span>Plan</span>
                  <span className="capitalize">{tier}</span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Business</span>
                  <span>{form.businessName || "—"}</span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Monthly</span>
                  <span>{tier === "starter" ? "$199/mo" : "$299/mo"}</span>
                </div>
                {tier === "standard" && (
                  <div className="flex justify-between text-parchment/70">
                    <span>Setup fee</span>
                    <span>$499 (one-time)</span>
                  </div>
                )}
              </div>
              {error && <p className="text-spark-orange text-xs">{error}</p>}
            </div>
          )}
        </Card>

        <div className="flex gap-3">
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as Step)}>
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button
              className="flex-1"
              onClick={() => setStep((s) => (s + 1) as Step)}
              disabled={step === 1 && !form.businessName}
            >
              Continue →
            </Button>
          ) : (
            <Button className="flex-1" onClick={handleSubmit} loading={loading}>
              Proceed to Payment
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
