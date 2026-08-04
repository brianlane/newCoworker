/**
 * Typed accessors for the auto-reload tables and RPCs.
 *
 * All writes that move the rule's state machine go through the RPCs
 * (`usage_pack_auto_reload_claim` / `_settle` / `_resume_stale`), never
 * through direct column updates, because the claim's atomicity and the
 * settle's budget refund are the double-charge guards. Direct table writes
 * here are limited to the tenant's own settings and the authorized card.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AutoReloadCategory } from "@/lib/billing/auto-reload";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

async function client(db?: SupabaseClient): Promise<SupabaseClient> {
  return db ?? (await createSupabaseServiceClient());
}

export type AutoReloadRule = {
  businessId: string;
  category: AutoReloadCategory;
  enabled: boolean;
  packId: string;
  thresholdUnits: number;
  monthlyLimitCents: number | null;
  monthKey: string;
  monthSpentCents: number;
  monthCharges: number;
  cooldownMinutes: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  pausedAt: string | null;
  pausedReason: string | null;
  disabledReason: string | null;
};

export type AutoReloadCard = {
  businessId: string;
  stripePaymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  consentAt: string;
  revokedAt: string | null;
};

export type AutoReloadEvent = {
  id: number;
  category: AutoReloadCategory;
  packId: string;
  amountCents: number;
  unitsGranted: number | null;
  status: string;
  failureCode: string | null;
  failureMessage: string | null;
  stripePaymentIntentId: string | null;
  createdAt: string;
  settledAt: string | null;
};

type RuleRow = {
  business_id: string;
  category: string;
  enabled: boolean;
  pack_id: string;
  threshold_units: number | string;
  monthly_limit_cents: number | null;
  month_key: string;
  month_spent_cents: number;
  month_charges: number;
  cooldown_minutes: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  paused_at: string | null;
  paused_reason: string | null;
  disabled_reason: string | null;
};

function mapRule(row: RuleRow): AutoReloadRule {
  return {
    businessId: row.business_id,
    category: row.category as AutoReloadCategory,
    enabled: row.enabled,
    packId: row.pack_id,
    // bigint comes back as a string from PostgREST once it exceeds 2^53,
    // and chat thresholds are in micros, so always coerce.
    thresholdUnits: Number(row.threshold_units),
    monthlyLimitCents: row.monthly_limit_cents,
    monthKey: row.month_key,
    monthSpentCents: row.month_spent_cents,
    monthCharges: row.month_charges,
    cooldownMinutes: row.cooldown_minutes,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures,
    pausedAt: row.paused_at,
    pausedReason: row.paused_reason,
    disabledReason: row.disabled_reason
  };
}

export async function listAutoReloadRules(
  businessId: string,
  db?: SupabaseClient
): Promise<AutoReloadRule[]> {
  const supabase = await client(db);
  const { data, error } = await supabase
    .from("usage_pack_auto_reload_rules")
    .select("*")
    .eq("business_id", businessId);
  if (error) throw new Error(`listAutoReloadRules: ${error.message}`);
  return ((data ?? []) as RuleRow[]).map(mapRule);
}

export type UpsertAutoReloadRuleInput = {
  category: AutoReloadCategory;
  enabled: boolean;
  packId: string;
  thresholdUnits: number;
  monthlyLimitCents: number | null;
  cooldownMinutes: number;
};

export async function upsertAutoReloadRule(
  businessId: string,
  input: UpsertAutoReloadRuleInput,
  db?: SupabaseClient
): Promise<AutoReloadRule> {
  const supabase = await client(db);
  const { data, error } = await supabase
    .from("usage_pack_auto_reload_rules")
    .upsert(
      {
        business_id: businessId,
        category: input.category,
        enabled: input.enabled,
        pack_id: input.packId,
        threshold_units: input.thresholdUnits,
        monthly_limit_cents: input.monthlyLimitCents,
        cooldown_minutes: input.cooldownMinutes,
        // Saving clears a recoverable pause: the tenant has just looked at
        // the card and made a decision, which is the acknowledgement a 3DS or
        // budget pause was waiting for.
        paused_at: null,
        paused_reason: null,
        // An explicit enable also clears the system-disable state. Leaving
        // `disabled_reason` set would make the billing page say "turned off
        // after three declines" next to a toggle that is on, and leaving the
        // counter at its ceiling would re-disable on the very next decline
        // instead of giving the new card three chances. A dispute is the one
        // reason that cannot be cleared this way; the settings route refuses
        // to enable in that state.
        ...(input.enabled ? { disabled_reason: null, consecutive_failures: 0 } : {}),
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,category" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`upsertAutoReloadRule: ${error.message}`);
  return mapRule(data as RuleRow);
}

export async function getAutoReloadCard(
  businessId: string,
  db?: SupabaseClient
): Promise<AutoReloadCard | null> {
  const supabase = await client(db);
  const { data, error } = await supabase
    .from("usage_pack_auto_reload_cards")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getAutoReloadCard: ${error.message}`);
  if (!data) return null;
  const row = data as {
    business_id: string;
    stripe_payment_method_id: string;
    card_brand: string | null;
    card_last4: string | null;
    card_exp_month: number | null;
    card_exp_year: number | null;
    consent_at: string;
    revoked_at: string | null;
  };
  return {
    businessId: row.business_id,
    stripePaymentMethodId: row.stripe_payment_method_id,
    cardBrand: row.card_brand,
    cardLast4: row.card_last4,
    cardExpMonth: row.card_exp_month,
    cardExpYear: row.card_exp_year,
    consentAt: row.consent_at,
    revokedAt: row.revoked_at
  };
}

export type SaveAutoReloadCardInput = {
  stripePaymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  consentUserId: string | null;
  consentIp: string | null;
  consentTextVersion: string;
};

export async function saveAutoReloadCard(
  businessId: string,
  input: SaveAutoReloadCardInput,
  db?: SupabaseClient
): Promise<void> {
  const supabase = await client(db);
  const { error } = await supabase.from("usage_pack_auto_reload_cards").upsert(
    {
      business_id: businessId,
      stripe_payment_method_id: input.stripePaymentMethodId,
      card_brand: input.cardBrand,
      card_last4: input.cardLast4,
      card_exp_month: input.cardExpMonth,
      card_exp_year: input.cardExpYear,
      consent_at: new Date().toISOString(),
      consent_user_id: input.consentUserId,
      consent_ip: input.consentIp,
      consent_text_version: input.consentTextVersion,
      // Re-authorizing after a revoke (dispute, detached card) clears it.
      revoked_at: null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "business_id" }
  );
  if (error) throw new Error(`saveAutoReloadCard: ${error.message}`);
}

/**
 * Restore rules we switched off ONLY because the card went away.
 *
 * Replacing a card can emit `payment_method.detached` for the old method
 * before the setup Checkout completes for the new one, so a tenant who did
 * exactly the right thing would otherwise end up with auto-reload silently
 * off and no signal saying so.
 *
 * Scoped to `disabled_reason = 'card_detached'`, which only the detach
 * handler sets. A rule switched off for repeated declines, a dispute, or a
 * cancelled subscription stays off: those need a deliberate decision from the
 * tenant, not a card swap.
 */
export async function reenableAutoReloadAfterCardAuthorized(
  businessId: string,
  db?: SupabaseClient
): Promise<number> {
  const supabase = await client(db);
  const { data, error } = await supabase
    .from("usage_pack_auto_reload_rules")
    .update({
      enabled: true,
      disabled_reason: null,
      paused_at: null,
      paused_reason: null,
      consecutive_failures: 0,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("disabled_reason", "card_detached")
    .select("category");
  if (error) throw new Error(`reenableAutoReloadAfterCardAuthorized: ${error.message}`);
  return ((data ?? []) as unknown[]).length;
}

export async function revokeAutoReloadCard(
  businessId: string,
  db?: SupabaseClient
): Promise<void> {
  const supabase = await client(db);
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("usage_pack_auto_reload_cards")
    .update({ revoked_at: now, updated_at: now })
    .eq("business_id", businessId)
    .is("revoked_at", null);
  if (error) throw new Error(`revokeAutoReloadCard: ${error.message}`);
}

export async function listAutoReloadEvents(
  businessId: string,
  limit = 5,
  db?: SupabaseClient
): Promise<AutoReloadEvent[]> {
  const supabase = await client(db);
  const { data, error } = await supabase
    .from("usage_pack_auto_reload_events")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listAutoReloadEvents: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    category: row.category as AutoReloadCategory,
    packId: String(row.pack_id),
    amountCents: Number(row.amount_cents),
    unitsGranted: row.units_granted === null ? null : Number(row.units_granted),
    status: String(row.status),
    failureCode: (row.failure_code as string | null) ?? null,
    failureMessage: (row.failure_message as string | null) ?? null,
    stripePaymentIntentId: (row.stripe_payment_intent_id as string | null) ?? null,
    createdAt: String(row.created_at),
    settledAt: (row.settled_at as string | null) ?? null
  }));
}

export type AutoReloadCandidate = {
  businessId: string;
  category: AutoReloadCategory;
  packId: string;
  thresholdUnits: number;
  monthlyLimitCents: number | null;
  cooldownMinutes: number;
  ownerEmail: string | null;
  businessName: string | null;
  tier: string | null;
  enterpriseLimits: unknown;
  phone: string | null;
  timezone: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePeriodStart: string | null;
  stripePaymentMethodId: string;
};

export async function listAutoReloadCandidates(
  limit: number,
  db?: SupabaseClient
): Promise<AutoReloadCandidate[]> {
  const supabase = await client(db);
  const { data, error } = await supabase.rpc("usage_pack_auto_reload_candidates", {
    p_limit: limit
  });
  if (error) throw new Error(`listAutoReloadCandidates: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    businessId: String(row.business_id),
    category: row.category as AutoReloadCategory,
    packId: String(row.pack_id),
    thresholdUnits: Number(row.threshold_units),
    monthlyLimitCents: row.monthly_limit_cents === null ? null : Number(row.monthly_limit_cents),
    cooldownMinutes: Number(row.cooldown_minutes),
    ownerEmail: (row.owner_email as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
    tier: (row.tier as string | null) ?? null,
    enterpriseLimits: row.enterprise_limits ?? null,
    phone: (row.phone as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
    stripeSubscriptionId: (row.stripe_subscription_id as string | null) ?? null,
    stripePeriodStart: (row.stripe_period_start as string | null) ?? null,
    stripePaymentMethodId: String(row.stripe_payment_method_id)
  }));
}

export type AutoReloadClaimResult =
  | { ok: true; eventId: number; attemptKey: string }
  | { ok: false; reason: string };

export async function claimAutoReload(
  params: {
    businessId: string;
    category: AutoReloadCategory;
    packId: string;
    amountCents: number;
    balanceUnits: number;
    thresholdUnits: number;
    platformMaxCents: number | null;
    currency: string;
  },
  db?: SupabaseClient
): Promise<AutoReloadClaimResult> {
  const supabase = await client(db);
  const { data, error } = await supabase.rpc("usage_pack_auto_reload_claim", {
    p_business_id: params.businessId,
    p_category: params.category,
    p_pack_id: params.packId,
    p_amount_cents: params.amountCents,
    p_balance_units: params.balanceUnits,
    p_threshold_units: params.thresholdUnits,
    p_platform_max_cents: params.platformMaxCents,
    p_currency: params.currency
  });
  if (error) throw new Error(`claimAutoReload: ${error.message}`);
  const payload = (data ?? {}) as { ok?: boolean; event_id?: number; attempt_key?: string; reason?: string };
  if (payload.ok === true) {
    return { ok: true, eventId: Number(payload.event_id), attemptKey: String(payload.attempt_key) };
  }
  return { ok: false, reason: payload.reason ?? "unknown" };
}

export type AutoReloadResumeResult =
  | { ok: true; eventId: number; packId: string; amountCents: number; currency: string }
  | { ok: false; reason: string };

export async function resumeStaleAutoReload(
  businessId: string,
  category: AutoReloadCategory,
  db?: SupabaseClient
): Promise<AutoReloadResumeResult> {
  const supabase = await client(db);
  const { data, error } = await supabase.rpc("usage_pack_auto_reload_resume_stale", {
    p_business_id: businessId,
    p_category: category
  });
  if (error) throw new Error(`resumeStaleAutoReload: ${error.message}`);
  const payload = (data ?? {}) as {
    ok?: boolean;
    event_id?: number;
    pack_id?: string;
    amount_cents?: number;
    currency?: string;
    reason?: string;
  };
  if (payload.ok === true) {
    return {
      ok: true,
      eventId: Number(payload.event_id),
      packId: String(payload.pack_id),
      amountCents: Number(payload.amount_cents),
      currency: payload.currency ?? "usd"
    };
  }
  return { ok: false, reason: payload.reason ?? "unknown" };
}

export type SettleAutoReloadInput = {
  eventId: number;
  status:
    | "succeeded"
    | "failed"
    | "requires_action"
    | "skipped_monthly_limit"
    | "skipped_pack_unavailable"
    | "skipped_no_card"
    | "skipped_inactive_subscription";
  unitsGranted?: number | null;
  failureKind?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  paymentIntentId?: string | null;
  grantSourceId?: string | null;
};

export async function settleAutoReload(
  input: SettleAutoReloadInput,
  db?: SupabaseClient
): Promise<{ ok: boolean; disabled: boolean; reason?: string }> {
  const supabase = await client(db);
  const { data, error } = await supabase.rpc("usage_pack_auto_reload_settle", {
    p_event_id: input.eventId,
    p_status: input.status,
    p_units_granted: input.unitsGranted ?? null,
    p_failure_kind: input.failureKind ?? null,
    p_failure_code: input.failureCode ?? null,
    p_failure_message: input.failureMessage ?? null,
    p_payment_intent_id: input.paymentIntentId ?? null,
    p_grant_source_id: input.grantSourceId ?? null
  });
  if (error) throw new Error(`settleAutoReload: ${error.message}`);
  const payload = (data ?? {}) as { ok?: boolean; disabled?: boolean; reason?: string };
  return {
    ok: payload.ok === true,
    disabled: payload.disabled === true,
    reason: payload.reason
  };
}

/**
 * Stop auto-reload everywhere a detached card was authorized.
 *
 * Stripe's `payment_method.detached` event does not name a business, so the
 * card table is the lookup. Without this the sweep would keep trying a card
 * that no longer exists and burn a failure strike on every tick.
 */
export async function disableAutoReloadForBusinessesByPaymentMethod(
  paymentMethodId: string,
  db?: SupabaseClient
): Promise<number> {
  const supabase = await client(db);
  const { data, error } = await supabase
    .from("usage_pack_auto_reload_cards")
    .select("business_id")
    .eq("stripe_payment_method_id", paymentMethodId)
    .is("revoked_at", null);
  if (error) throw new Error(`disableAutoReloadForBusinessesByPaymentMethod: ${error.message}`);

  const rows = (data ?? []) as Array<{ business_id: string }>;
  for (const row of rows) {
    await disableAutoReloadForBusiness(row.business_id, "card_detached", supabase);
    await revokeAutoReloadCard(row.business_id, supabase);
  }
  return rows.length;
}

export async function disableAutoReloadForBusiness(
  businessId: string,
  reason: string,
  db?: SupabaseClient
): Promise<number> {
  const supabase = await client(db);
  const { data, error } = await supabase.rpc("usage_pack_auto_reload_disable_for_business", {
    p_business_id: businessId,
    p_reason: reason
  });
  if (error) throw new Error(`disableAutoReloadForBusiness: ${error.message}`);
  return Number(data ?? 0);
}
