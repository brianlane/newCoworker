"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Button } from "@/components/ui/Button";
import { ONBOARD_STORAGE_KEY } from "@/lib/onboarding/storage";
import { BUSINESS_TYPE_OPTIONS, DEFAULT_BUSINESS_TYPE } from "@/lib/onboarding/businessTypes";
import { getMonthlyRateDisplay } from "@/lib/pricing";

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
  businessType: DEFAULT_BUSINESS_TYPE,
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const tier = (searchParams.get("tier") ?? "starter") as "starter" | "standard";
  const period = (searchParams.get("period") ?? "biennial") as "monthly" | "annual" | "biennial";

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  function update(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleSubmit() {
    setError(null);
    try {
      localStorage.setItem(
        ONBOARD_STORAGE_KEY,
        JSON.stringify({ tier, billingPeriod: period, ...form })
      );
      router.push(`/signup?tier=${encodeURIComponent(tier)}&period=${encodeURIComponent(period)}&redirectTo=/onboard/checkout`);
    } catch {
      setError("Could not save your details. Please try again.");
    }
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
                : "Review & create account"}
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
                  {BUSINESS_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <Input
                label="Your Name"
                value={form.ownerName}
                onChange={(e) => update("ownerName", e.target.value)}
                placeholder="Jane Doe"
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
                placeholder="Phoenix, AZ or Completely Virtual"
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
                  <span>Billing period</span>
                  <span className="capitalize">
                    {period === "biennial" ? "24 months" : period === "annual" ? "12 months" : "1 month"}
                  </span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Business</span>
                  <span>{form.businessName || "—"}</span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Monthly rate</span>
                  <span>{getMonthlyRateDisplay(tier, period)}</span>
                </div>
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
            <Button className="flex-1" onClick={handleSubmit}>
              Create Account →
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
