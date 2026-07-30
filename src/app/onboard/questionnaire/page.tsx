import { redirect } from "next/navigation";
import { hasActiveSubscriptionForCurrentUser } from "@/lib/onboarding/active-subscriber-guard";
import { listMembershipPackAddonOptions } from "@/lib/billing/membership-pack-addons";
import QuestionnaireClient from "./QuestionnaireClient";

// The guard reads auth cookies + the DB on every hit; never cache this page.
// Pack catalog also reads Stripe Price env vars that differ between build and
// runtime, so static bake would hide add-ons in production.
export const dynamic = "force-dynamic";

export default async function QuestionnairePage() {
  // Signed-in owners with live service manage their plan from Billing.
  // Resuming a stale questionnaire draft against an existing business is the
  // exact path that once overwrote a live tenant's config.
  if (await hasActiveSubscriptionForCurrentUser()) {
    redirect("/dashboard/billing");
  }
  const packAddonOptions = listMembershipPackAddonOptions();
  return <QuestionnaireClient packAddonOptions={packAddonOptions} />;
}
