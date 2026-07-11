/**
 * Self-serve account deletion support (BizBlasts-style typed-DELETE flow):
 * the impact preview an owner (or admin) sees before a destructive wipe,
 * and the eligibility gate that routes paying tenants through the proper
 * cancellation lifecycle instead of a raw row delete.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusiness } from "@/lib/db/businesses";
import { getTelnyxVoiceRouteForBusiness } from "@/lib/db/telnyx-routes";
import { isCanceledInGrace, type SubscriptionRow } from "@/lib/db/subscriptions";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** The exact phrase the user must type to arm the delete button. */
export const DELETE_CONFIRM_PHRASE = "DELETE";

export type AccountDeletionCounts = {
  contacts: number;
  voiceTranscripts: number;
  smsInbound: number;
  smsOutbound: number;
  emails: number;
  aiflows: number;
  /** Employees page roster (ai_flow_team_members — AiFlow routing). */
  employees: number;
  /** Dashboard logins invited via Settings → Team (business_members). */
  dashboardMembers: number;
};

export type AccountDeletionImpact = {
  businessName: string;
  counts: AccountDeletionCounts;
  /** True when a live VPS is still attached to the business row. */
  hasVps: boolean;
  /** The coworker's phone number that will be released, if any. */
  didE164: string | null;
};

const COUNT_TABLES: Array<{ key: keyof AccountDeletionCounts; table: string }> = [
  { key: "contacts", table: "contacts" },
  { key: "voiceTranscripts", table: "voice_call_transcripts" },
  { key: "smsInbound", table: "sms_inbound_jobs" },
  { key: "smsOutbound", table: "sms_outbound_log" },
  { key: "emails", table: "email_log" },
  { key: "aiflows", table: "ai_flows" },
  { key: "employees", table: "ai_flow_team_members" },
  { key: "dashboardMembers", table: "business_members" }
];

/**
 * Business-scoped data counts + release flags shown in the deletion
 * confirmation dialog. Count failures degrade to 0 (the preview is
 * informational; a flaky count must never block the page), but a missing
 * business is a hard null so callers can 404.
 */
export async function getAccountDeletionImpact(
  businessId: string,
  client?: SupabaseClient
): Promise<AccountDeletionImpact | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const business = await getBusiness(businessId, db);
  if (!business) return null;

  const counts: AccountDeletionCounts = {
    contacts: 0,
    voiceTranscripts: 0,
    smsInbound: 0,
    smsOutbound: 0,
    emails: 0,
    aiflows: 0,
    employees: 0,
    dashboardMembers: 0
  };

  await Promise.all(
    COUNT_TABLES.map(async ({ key, table }) => {
      const { count, error } = await db
        .from(table)
        .select("*", { head: true, count: "exact" })
        .eq("business_id", businessId);
      if (!error && typeof count === "number") counts[key] = count;
    })
  );

  let didE164: string | null = null;
  try {
    const route = await getTelnyxVoiceRouteForBusiness(businessId, db);
    didE164 = route?.to_e164 ?? null;
  } catch {
    // DID lookup is display-only; a read hiccup must not block the preview.
  }

  return {
    businessName: business.name,
    counts,
    hasVps: Boolean(business.hostinger_vps_id),
    didE164
  };
}

export type AccountDeletionEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "active_subscription"
        | "past_due_subscription"
        | "canceled_in_grace"
        | "checkout_in_flight";
    };

/** The row fields the eligibility gate needs. */
export type AccountDeletionSubscriptionFields = Pick<
  SubscriptionRow,
  "status" | "grace_ends_at" | "wiped_at" | "stripe_subscription_id"
>;

/**
 * A paying (or payment-owing) tenant must go through the cancellation
 * lifecycle first — it owns Stripe teardown, the data backup, and the grace
 * window. A canceled subscription still inside its retention grace window is
 * ALSO refused: the grace sweep owns the eventual wipe, and a hard delete
 * here would skip the backup/reactivation guarantees the owner was promised
 * at cancel time. A non-canceled row that already carries a
 * `stripe_subscription_id` (a paid checkout whose webhook is still in
 * flight — the same state `isCheckoutBlockingSubscription` blocks on) is
 * refused too: deleting the tenant then could leave live Stripe billing
 * behind. Eligible: no row, pending with no Stripe subscription (never
 * paid), or canceled with the grace window over (or already wiped).
 */
export function resolveAccountDeletionEligibility(
  subscription: AccountDeletionSubscriptionFields | null,
  now: Date = new Date()
): AccountDeletionEligibility {
  if (!subscription) return { eligible: true };
  if (subscription.status === "active") {
    return { eligible: false, reason: "active_subscription" };
  }
  if (subscription.status === "past_due") {
    return { eligible: false, reason: "past_due_subscription" };
  }
  if (isCanceledInGrace(subscription, now)) {
    return { eligible: false, reason: "canceled_in_grace" };
  }
  if (subscription.status !== "canceled" && subscription.stripe_subscription_id !== null) {
    return { eligible: false, reason: "checkout_in_flight" };
  }
  return { eligible: true };
}
