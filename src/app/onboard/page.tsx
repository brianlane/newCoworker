import { redirect } from "next/navigation";
import { hasActiveSubscriptionForCurrentUser } from "@/lib/onboarding/active-subscriber-guard";
import OnboardPlanClient from "./OnboardPlanClient";

// The guard reads auth cookies + the DB on every hit; never cache this page.
export const dynamic = "force-dynamic";

export default async function OnboardPage() {
  // Signed-in owners with live service manage their plan from Billing —
  // re-onboarding from scratch is how a live business once got clobbered.
  if (await hasActiveSubscriptionForCurrentUser()) {
    redirect("/dashboard/billing");
  }
  return <OnboardPlanClient />;
}
