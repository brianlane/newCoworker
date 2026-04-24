/**
 * Customer profiles: one row per abuse-identity, used to enforce
 *   * lifetime-once 30-day money-back guarantee (refund_used_at), and
 *   * 3-lifetime-subscription cap per profile (lifetime_subscription_count).
 *
 * Upsert/merge is done in-DB via the `upsert_customer_profile(email, stripe_id, ip)`
 * SECURITY DEFINER function so the merge logic (which keys win, what gets
 * null-coalesced) is guaranteed atomic under concurrent checkouts. See the
 * migration [20260501000000_subscription_lifecycle.sql].
 *
 * Callers must pass a *normalized* email. Normalization = lowercase, trim,
 * and Gmail plus-aliases collapsed (`foo+bar@gmail.com` → `foo@gmail.com`)
 * — kept out of the DB so the normalization stays in TypeScript and is
 * easy to unit-test.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type CustomerProfileRow = {
  id: string;
  normalized_email: string;
  stripe_customer_id: string | null;
  last_signup_ip: string | null;
  lifetime_subscription_count: number;
  refund_used_at: string | null;
  first_paid_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Max concurrent subscription lifetimes allowed per profile (answer to Q26). */
export const LIFETIME_SUBSCRIPTION_CAP = 3;

/**
 * Normalize an email for profile keying. Lowercase + trim + collapse Gmail
 * plus-aliases. Any throwing on malformed input is intentional — we should
 * never have reached checkout with a value that can't be normalized.
 */
export function normalizeEmailForProfile(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) {
    throw new Error(`normalizeEmailForProfile: invalid email "${email}"`);
  }
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  const normalizedLocal = isGmail ? local.split("+")[0].replace(/\./g, "") : local.split("+")[0];
  const normalizedDomain = isGmail ? "gmail.com" : domain;
  return `${normalizedLocal}@${normalizedDomain}`;
}

export async function upsertCustomerProfile(
  input: {
    email: string;
    stripeCustomerId?: string | null;
    signupIp?: string | null;
  },
  client?: SupabaseClient
): Promise<string> {
  const db = client ?? (await createSupabaseServiceClient());
  const normalized = normalizeEmailForProfile(input.email);
  const { data, error } = await db.rpc("upsert_customer_profile", {
    p_normalized_email: normalized,
    p_stripe_customer_id: input.stripeCustomerId ?? null,
    p_last_signup_ip: input.signupIp ?? null
  });
  if (error) throw new Error(`upsertCustomerProfile: ${error.message}`);
  if (typeof data !== "string") {
    throw new Error(`upsertCustomerProfile: expected uuid, got ${typeof data}`);
  }
  return data;
}

export async function getCustomerProfileById(
  id: string,
  client?: SupabaseClient
): Promise<CustomerProfileRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("customer_profiles")
    .select()
    .eq("id", id)
    .single();
  if (error) return null;
  return data as CustomerProfileRow;
}

export async function getCustomerProfileByEmail(
  email: string,
  client?: SupabaseClient
): Promise<CustomerProfileRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const normalized = normalizeEmailForProfile(email);
  const { data, error } = await db
    .from("customer_profiles")
    .select()
    .eq("normalized_email", normalized)
    .single();
  if (error) return null;
  return data as CustomerProfileRow;
}

/**
 * Atomically bump the lifetime count. Called from the Stripe webhook on
 * `checkout.session.completed` — never from request handlers — so we only
 * count paid subscription lifetimes, not abandoned checkouts.
 */
export async function incrementLifetimeSubscriptionCount(
  profileId: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("increment_customer_profile_lifetime_count", {
    p_profile_id: profileId
  });
  if (error) throw new Error(`incrementLifetimeSubscriptionCount: ${error.message}`);
  if (typeof data !== "number") {
    throw new Error(`incrementLifetimeSubscriptionCount: expected number, got ${typeof data}`);
  }
  return data;
}

/** Stamp refund_used_at on the first successful lifetime refund. Idempotent. */
export async function markRefundUsed(
  profileId: string,
  at: Date,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("customer_profiles")
    .update({ refund_used_at: at.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .is("refund_used_at", null);
  if (error) throw new Error(`markRefundUsed: ${error.message}`);
}

/** Stamp first_paid_at once — the 30-day window anchor (answer to Q1). */
export async function markFirstPaidIfUnset(
  profileId: string,
  at: Date,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("customer_profiles")
    .update({ first_paid_at: at.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", profileId)
    .is("first_paid_at", null);
  if (error) throw new Error(`markFirstPaidIfUnset: ${error.message}`);
}

/**
 * True iff `now` is within 30 days of `first_paid_at` AND the lifetime
 * refund has not been used. Returns false for profiles that have never paid.
 */
export function isWithinLifetimeRefundWindow(
  profile: Pick<CustomerProfileRow, "first_paid_at" | "refund_used_at">,
  now: Date = new Date()
): boolean {
  if (profile.refund_used_at) return false;
  if (!profile.first_paid_at) return false;
  const paidMs = new Date(profile.first_paid_at).getTime();
  const windowMs = 30 * 24 * 60 * 60 * 1000;
  return now.getTime() - paidMs <= windowMs;
}
