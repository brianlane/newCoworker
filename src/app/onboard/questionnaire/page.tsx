import { redirect } from "next/navigation";
import { hasActiveSubscriptionForCurrentUser } from "@/lib/onboarding/active-subscriber-guard";
import QuestionnaireClient from "./QuestionnaireClient";

// The guard reads auth cookies + the DB on every hit; never cache this page.
export const dynamic = "force-dynamic";

export default async function QuestionnairePage() {
  // Signed-in owners with live service manage their plan from Billing —
  // resuming a stale questionnaire draft against an existing business is the
  // exact path that once overwrote a live tenant's config.
  if (await hasActiveSubscriptionForCurrentUser()) {
    redirect("/dashboard/billing");
  }
  return <QuestionnaireClient />;
}
