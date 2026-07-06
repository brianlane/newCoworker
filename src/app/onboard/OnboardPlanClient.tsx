import Image from "next/image";
import { PlanCards } from "@/components/pricing/PlanCards";

/**
 * Plan-selection step of onboarding. The actual tier cards / period toggle
 * live in the shared `PlanCards` component, which the public /pricing page
 * renders too — one definition, no copy drift.
 */
export default function OnboardPage() {
  return (
    <div className="min-h-screen bg-deep-ink px-4 py-12">
      <div className="max-w-5xl mx-auto space-y-10">
        <div className="text-center space-y-3">
          <Image
            src="/logo.png"
            alt="New Coworker"
            width={56}
            height={56}
            className="rounded-full mx-auto"
          />
          <h1 className="text-3xl font-bold text-parchment">Choose your plan</h1>
          <p className="text-parchment/50 max-w-md mx-auto">
            Your new coworker will handle calls, texts, emails, and more, so you can focus on your business.
          </p>
        </div>

        <PlanCards />
      </div>
    </div>
  );
}
