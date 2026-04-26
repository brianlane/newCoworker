/**
 * Change-plan orchestrator (PR 8 of subscription lifecycle overhaul).
 *
 * Triggered by the Stripe webhook on `checkout.session.completed` when the
 * session carries `metadata.lifecycleAction === "changePlan"`. Drives the
 * fresh-provision + SSH-migrate + old-plan teardown path laid out in the
 * master plan:
 *
 *   1. Capture OLD VM id + resolve its public IP via Hostinger.
 *   2. SSH-backup the old VM's durable data (vault, memory) to Supabase
 *      Storage (`data-migration.backupBusinessData`).
 *   3. `orchestrateProvisioning` the NEW VM at the new tier. This mints a
 *      new keypair, purchases a new VPS, runs `deploy-client.sh`, and
 *      swings the per-tenant Cloudflare tunnel hostname onto the new box
 *      by re-using the same tunnel token.
 *   4. SSH-restore the backed-up data onto the new VM.
 *   5. Atomically bump `customer_profiles.lifetime_subscription_count`,
 *      create the NEW `subscriptions` row as `active`, set
 *      `business.customer_profile_id`, and wire up a commitment schedule.
 *   6. Cancel the OLD Stripe subscription + release any commitment
 *      schedule (no proration, no refund).
 *   7. Cancel the OLD Hostinger billing subscription (DELETE
 *      /api/billing/v1/subscriptions/{id}) so we stop paying the instant
 *      the new VM is live.
 *   8. Mark the OLD `subscriptions` row `canceled` with
 *      `cancel_reason = "upgrade_switch"`.
 *
 * All steps after the backup are best-effort guarded: a failure in (6)/(7)
 * leaves the new VM live and the new sub active — an operator can mop up
 * the orphan Stripe/Hostinger row via admin tooling. We do NOT unwind the
 * new provisioning on teardown failures because the customer has already
 * paid for the new plan.
 *
 * This function is invoked fire-and-forget by the webhook; errors are
 * logged but never bubble back up so Stripe keeps receiving 200s.
 */

import type Stripe from "stripe";
import { randomUUID } from "crypto";

import {
  HostingerClient,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";
import {
  backupBusinessData,
  restoreBusinessData
} from "@/lib/hostinger/data-migration";
import { orchestrateProvisioning } from "@/lib/provisioning/orchestrate";
import {
  ensureCommitmentSchedule,
  getStripe
} from "@/lib/stripe/client";
import {
  createSubscription,
  getSubscription,
  isCanceledInGrace,
  stripeSubscriptionPeriodCache,
  updateSubscription,
  type CancelReason
} from "@/lib/db/subscriptions";
import { getBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import { getCommitmentMonths, type BillingPeriod } from "@/lib/plans/tier";
import {
  incrementLifetimeSubscriptionCount,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { logger } from "@/lib/logger";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkoutObjectId<T extends { id?: string }>(value: string | T | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

export type ChangePlanMetadata = {
  businessId: string;
  previousSubscriptionId: string;
  tier: "starter" | "standard";
  billingPeriod: BillingPeriod;
  /** Stripe customer id (from session.customer). */
  stripeCustomerId: string | null;
  /** Stripe subscription id created by the new checkout session. */
  stripeSubscriptionId: string | null;
  /** Email the user paid with, used to merge customer_profiles. */
  sessionEmail: string | null;
};

/**
 * Extract + validate change-plan metadata from a Checkout Session. Returns
 * null (and logs) if any required field is missing so the caller can bail
 * without a mid-orchestration crash.
 */
export function parseChangePlanSessionMetadata(
  session: Stripe.Checkout.Session
): ChangePlanMetadata | null {
  const businessId = session.metadata?.businessId;
  const previousSubscriptionId = session.metadata?.previousSubscriptionId;
  const tierRaw = session.metadata?.tier;
  const billingPeriodRaw = session.metadata?.billingPeriod;

  if (!businessId || !previousSubscriptionId || !tierRaw || !billingPeriodRaw) {
    logger.warn("changePlan: missing required metadata; skipping", {
      sessionId: session.id,
      businessId: businessId ?? null,
      previousSubscriptionId: previousSubscriptionId ?? null,
      tier: tierRaw ?? null,
      billingPeriod: billingPeriodRaw ?? null
    });
    return null;
  }
  if (tierRaw !== "starter" && tierRaw !== "standard") {
    logger.warn("changePlan: unsupported tier", { sessionId: session.id, tier: tierRaw });
    return null;
  }
  if (
    billingPeriodRaw !== "monthly" &&
    billingPeriodRaw !== "annual" &&
    billingPeriodRaw !== "biennial"
  ) {
    logger.warn("changePlan: unsupported billingPeriod", {
      sessionId: session.id,
      billingPeriod: billingPeriodRaw
    });
    return null;
  }

  return {
    businessId,
    previousSubscriptionId,
    tier: tierRaw,
    billingPeriod: billingPeriodRaw,
    stripeCustomerId: checkoutObjectId(session.customer),
    stripeSubscriptionId: checkoutObjectId(session.subscription),
    sessionEmail: session.customer_details?.email ?? session.customer_email ?? null
  };
}

function hostingerClient(): HostingerClient {
  return new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
}

async function resolveVmIp(
  virtualMachineId: number,
  client: HostingerClient
): Promise<string | null> {
  try {
    const vm = await client.getVirtualMachine(virtualMachineId);
    return vm.ipv4?.find((addr) => addr?.address)?.address ?? null;
  } catch (err) {
    logger.warn("changePlan: resolveVmIp failed", {
      virtualMachineId,
      error: errorMessage(err)
    });
    return null;
  }
}

export async function runChangePlanFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
): Promise<void> {
  const meta = parseChangePlanSessionMetadata(session);
  if (!meta) return;

  const {
    businessId,
    previousSubscriptionId,
    tier,
    billingPeriod,
    stripeCustomerId,
    stripeSubscriptionId,
    sessionEmail
  } = meta;

  logger.info("changePlan: start", {
    eventId,
    businessId,
    previousSubscriptionId,
    tier,
    billingPeriod,
    newStripeSubId: stripeSubscriptionId
  });

  const business = await getBusiness(businessId);
  if (!business) {
    logger.warn("changePlan: business missing; abort", { businessId });
    return;
  }

  // `getSubscription` returns the most-recent sub for this business which,
  // at this moment in the flow, should be the OLD active one. We sanity-
  // check against `previousSubscriptionId` so a stale/ooo replay doesn't
  // clobber a newer row.
  const oldSub = await getSubscription(businessId);
  if (!oldSub) {
    logger.warn("changePlan: no existing subscription; abort", { businessId });
    return;
  }
  if (oldSub.id !== previousSubscriptionId) {
    logger.warn("changePlan: sub mismatch; abort", {
      businessId,
      current: oldSub.id,
      expected: previousSubscriptionId
    });
    return;
  }

  // Abuse profile: re-upsert so the new paid lifetime is attributed to the
  // same profile (handles the edge case where Stripe created a fresh
  // customer or the DB row was missing a profile attachment).
  let customerProfileId: string | null =
    oldSub.customer_profile_id ?? business.customer_profile_id ?? null;
  if (sessionEmail) {
    try {
      customerProfileId = await upsertCustomerProfile({
        email: sessionEmail,
        stripeCustomerId,
        signupIp: null
      });
    } catch (err) {
      logger.warn("changePlan: customer_profiles upsert failed (continuing)", {
        businessId,
        error: errorMessage(err)
      });
    }
  }

  if (customerProfileId) {
    try {
      await incrementLifetimeSubscriptionCount(customerProfileId);
    } catch (err) {
      logger.warn("changePlan: lifetime subscription cap reached; abort", {
        businessId,
        profileId: customerProfileId,
        error: errorMessage(err)
      });
      // Stripe Checkout has already captured the customer's money for the
      // new plan, but we're refusing to provision because the atomic
      // `increment_customer_profile_lifetime_count` RPC enforces
      // `lifetime_subscription_count < LIFETIME_SUBSCRIPTION_CAP`. The
      // upstream UI cap check narrows the race (two concurrent checkouts,
      // or a checkout crossing a different change-plan's completion) but
      // cannot close it, so we MUST proactively cancel the new Stripe
      // subscription here — otherwise it stays live, auto-renews on the
      // next cycle, and we've charged the customer indefinitely for a
      // service we committed never to provide. Matches the
      // provisioning-failed abort path above.
      //
      // We intentionally do not auto-refund the initial charge from this
      // path: it's operator-triaged (same as the provisioning-failed
      // branch) because the event is rare and surfacing it in Stripe
      // dashboards / ops logs lets humans decide whether a refund is
      // appropriate per customer.
      if (stripeSubscriptionId) {
        await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
      }
      return;
    }
  }

  const hostinger = hostingerClient();

  // ── Step 1: capture old VPS coordinates BEFORE provisioning overwrites them.
  const oldVpsIdRaw = business.hostinger_vps_id;
  const oldVmId =
    oldVpsIdRaw && /^\d+$/.test(oldVpsIdRaw) ? Number.parseInt(oldVpsIdRaw, 10) : null;
  const oldVpsHost = oldVmId !== null ? await resolveVmIp(oldVmId, hostinger) : null;

  if (oldVmId !== null) {
    try {
      await hostinger.createSnapshot(oldVmId);
      logger.info("changePlan: old VPS snapshot requested", { businessId, oldVmId });
    } catch (err) {
      logger.warn("changePlan: old VPS snapshot failed (continuing)", {
        businessId,
        oldVmId,
        error: errorMessage(err)
      });
    }
  }

  // ── Step 2: SSH backup of durable data. If the old VPS is unreachable we
  // continue — a missing backup means the new VM boots with fresh template
  // state, which is better than aborting a paid plan change.
  let backupOk = false;
  if (oldVpsHost) {
    try {
      await backupBusinessData({ businessId, vpsHost: oldVpsHost });
      backupOk = true;
      logger.info("changePlan: old VPS backed up", { businessId, oldVpsHost });
    } catch (err) {
      logger.error("changePlan: backup failed (continuing without data migration)", {
        businessId,
        oldVpsHost,
        error: errorMessage(err)
      });
    }
  } else {
    logger.warn("changePlan: no old VPS host resolvable; skipping backup", {
      businessId,
      oldVpsIdRaw
    });
  }

  // ── Step 3: provision a NEW VM at the new tier. `orchestrateProvisioning`
  // internally overwrites `businesses.hostinger_vps_id` with the new VM
  // id, mints a new SSH key, and re-registers the per-tenant Cloudflare
  // tunnel (so DNS swings onto the new VM once the new cloudflared
  // connects). If provisioning fails, immediately cancel the freshly paid
  // Stripe sub so it cannot renew without a corresponding DB row/VPS.
  let newProv: Awaited<ReturnType<typeof orchestrateProvisioning>>;
  try {
    newProv = await orchestrateProvisioning({
      businessId,
      tier,
      ownerEmail: business.owner_email
    });
  } catch (err) {
    logger.error("changePlan: new provisioning failed; aborting without teardown", {
      businessId,
      error: errorMessage(err)
    });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    return;
  }

  // ── Step 4: restore durable data on the NEW VM (only if backup landed).
  // Uses the SSH key stored by the fresh provisioning via the default
  // sshKeyLookup (which returns the newest key for the business).
  const newVmId = Number.parseInt(newProv.vpsId, 10);
  const newVpsHost = Number.isFinite(newVmId) ? await resolveVmIp(newVmId, hostinger) : null;
  if (backupOk && newVpsHost) {
    try {
      await restoreBusinessData({ businessId, vpsHost: newVpsHost });
      logger.info("changePlan: data restored onto new VPS", { businessId, newVpsHost });
    } catch (err) {
      logger.error("changePlan: restore failed (customer may need manual recovery)", {
        businessId,
        newVpsHost,
        error: errorMessage(err)
      });
    }
  }

  // ── Step 5: mark NEW Stripe sub active + wire commitment schedule.
  const now = new Date();
  const commitmentMonths = getCommitmentMonths(billingPeriod);
  const renewalAt = new Date(now);
  renewalAt.setDate(1);
  renewalAt.setMonth(renewalAt.getMonth() + commitmentMonths);

  let newStripeSub: Stripe.Subscription | null = null;
  if (stripeSubscriptionId) {
    try {
      const stripe = getStripe();
      newStripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (err) {
      logger.warn("changePlan: Stripe subscription retrieve failed (continuing)", {
        businessId,
        stripeSubscriptionId,
        error: errorMessage(err)
      });
    }
  }
  const periodCache = newStripeSub ? stripeSubscriptionPeriodCache(newStripeSub) : {};

  await createSubscription({
    id: randomUUID(),
    business_id: businessId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    tier,
    status: "active",
    billing_period: billingPeriod,
    renewal_at: renewalAt.toISOString(),
    commitment_months: commitmentMonths,
    customer_profile_id: customerProfileId,
    hostinger_billing_subscription_id: newProv.hostingerBillingSubscriptionId,
    ...periodCache
  });

  if (customerProfileId) {
    try {
      await setBusinessCustomerProfile(businessId, customerProfileId);
    } catch (err) {
      logger.warn("changePlan: setBusinessCustomerProfile failed (continuing)", {
        businessId,
        error: errorMessage(err)
      });
    }
  }

  if (stripeSubscriptionId) {
    try {
      await ensureCommitmentSchedule({ subscriptionId: stripeSubscriptionId, tier, billingPeriod });
    } catch (err) {
      logger.warn("changePlan: ensureCommitmentSchedule failed (continuing)", {
        businessId,
        stripeSubscriptionId,
        error: errorMessage(err)
      });
    }
  }

  // ── Step 6: cancel OLD Stripe subscription immediately (no proration).
  // Release any commitment schedule first so Stripe doesn't auto-recreate
  // the sub on the scheduled phase transition.
  if (oldSub.stripe_subscription_id) {
    await cancelStripeSubscriptionSafely(oldSub.stripe_subscription_id, businessId);
  }

  // ── Step 7: cancel OLD Hostinger billing subscription so we stop paying
  // as soon as the new VM is live. This is what also destroys the old VM.
  if (oldSub.hostinger_billing_subscription_id) {
    try {
      if (oldVmId !== null) {
        try {
          await hostinger.stopVirtualMachine(oldVmId);
        } catch (err) {
          logger.warn("changePlan: old VPS stop failed before billing cancel (continuing)", {
            businessId,
            oldVmId,
            error: errorMessage(err)
          });
        }
      }
      await hostinger.cancelBillingSubscription(
        oldSub.hostinger_billing_subscription_id,
        "newcoworker-upgrade-switch"
      );
      logger.info("changePlan: old Hostinger billing canceled", {
        businessId,
        billingSubscriptionId: oldSub.hostinger_billing_subscription_id
      });
    } catch (err) {
      logger.warn("changePlan: old Hostinger billing cancel failed (continuing)", {
        businessId,
        billingSubscriptionId: oldSub.hostinger_billing_subscription_id,
        error: errorMessage(err)
      });
    }
  }

  // ── Step 8: mark the OLD subscription row canceled. No grace window —
  // the customer is still an active tenant, just on a different plan.
  const upgradeSwitch: CancelReason = "upgrade_switch";
  await updateSubscription(previousSubscriptionId, {
    status: "canceled",
    canceled_at: now.toISOString(),
    cancel_reason: upgradeSwitch,
    grace_ends_at: null,
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    stripe_subscription_cached_at: now.toISOString()
  });

  logger.info("changePlan: complete", {
    eventId,
    businessId,
    previousSubscriptionId,
    newTier: tier,
    newBillingPeriod: billingPeriod
  });
}

export async function runResubscribeFromCheckout(
  session: Stripe.Checkout.Session,
  eventId: string
): Promise<void> {
  const businessId = session.metadata?.businessId;
  if (!businessId) {
    logger.warn("resubscribe: missing businessId metadata; skipping", {
      sessionId: session.id
    });
    return;
  }

  const stripeCustomerId = checkoutObjectId(session.customer);
  const stripeSubscriptionId = checkoutObjectId(session.subscription);
  const sessionEmail = session.customer_details?.email ?? session.customer_email ?? null;

  const business = await getBusiness(businessId);
  if (!business) {
    logger.warn("resubscribe: business missing; abort", { businessId });
    return;
  }
  const oldSub = await getSubscription(businessId);
  if (!oldSub || !isCanceledInGrace(oldSub)) {
    logger.warn("resubscribe: latest subscription is not in grace; abort", {
      businessId,
      subscriptionId: oldSub?.id ?? null,
      status: oldSub?.status ?? null
    });
    return;
  }

  // `GraceBanner` reactivates without posting a tier/period (the grace-
  // state tenant wants the SAME plan back, not a plan change), and the
  // `/api/billing/reactivate` route fills in defaults from the old sub
  // row before creating the Stripe Checkout. Mirror that fallback here
  // so a single missing metadata field never silently aborts a webhook
  // that's already taken the customer's money — if tier/period are
  // present and valid on the session we use them, otherwise we fall back
  // to the same defaults the route would have used.
  const tierRaw = session.metadata?.tier;
  const billingPeriodRaw = session.metadata?.billingPeriod;
  const tierFromMeta =
    tierRaw === "starter" || tierRaw === "standard" ? tierRaw : null;
  const tierFromSub =
    oldSub.tier === "starter" || oldSub.tier === "standard" ? oldSub.tier : null;
  const tier = tierFromMeta ?? tierFromSub;
  const billingPeriodFromMeta =
    billingPeriodRaw === "monthly" ||
    billingPeriodRaw === "annual" ||
    billingPeriodRaw === "biennial"
      ? billingPeriodRaw
      : null;
  const billingPeriodFromSub =
    oldSub.billing_period === "monthly" ||
    oldSub.billing_period === "annual" ||
    oldSub.billing_period === "biennial"
      ? oldSub.billing_period
      : null;
  const billingPeriod = billingPeriodFromMeta ?? billingPeriodFromSub;
  if (!tier || !billingPeriod) {
    logger.warn("resubscribe: unresolvable tier/billingPeriod; skipping", {
      sessionId: session.id,
      businessId,
      metaTier: tierRaw ?? null,
      metaBillingPeriod: billingPeriodRaw ?? null,
      // tier is a non-null enum in the DB schema; billing_period is
      // nullable, log as-is. No `?? null` fallbacks here — they'd be
      // either dead code (tier) or a no-op (billing_period already null).
      subTier: oldSub.tier,
      subBillingPeriod: oldSub.billing_period
    });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    return;
  }

  logger.info("resubscribe: start", {
    eventId,
    businessId,
    tier,
    billingPeriod,
    stripeSubscriptionId,
    tierSource: tierFromMeta ? "metadata" : "sub_row",
    billingPeriodSource: billingPeriodFromMeta ? "metadata" : "sub_row"
  });

  let customerProfileId: string | null =
    session.metadata?.customerProfileId ??
    oldSub.customer_profile_id ??
    business.customer_profile_id ??
    null;
  if (sessionEmail) {
    try {
      customerProfileId = await upsertCustomerProfile({
        email: sessionEmail,
        stripeCustomerId,
        signupIp: null
      });
    } catch (err) {
      logger.warn("resubscribe: customer_profiles upsert failed (continuing)", {
        businessId,
        error: errorMessage(err)
      });
    }
  }

  if (customerProfileId) {
    try {
      await incrementLifetimeSubscriptionCount(customerProfileId);
    } catch (err) {
      logger.warn("resubscribe: lifetime subscription cap reached; abort", {
        businessId,
        profileId: customerProfileId,
        error: errorMessage(err)
      });
      // Same reasoning as the changePlan cap-reached branch: Stripe has
      // already captured payment for the new plan, so we must cancel the
      // new subscription here to prevent silent auto-renewal of a sub the
      // customer will never receive service on. Refunds are left for
      // operator triage.
      if (stripeSubscriptionId) {
        await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
      }
      return;
    }
  }

  let newProv: Awaited<ReturnType<typeof orchestrateProvisioning>>;
  try {
    newProv = await orchestrateProvisioning({
      businessId,
      tier,
      ownerEmail: business.owner_email
    });
  } catch (err) {
    logger.error("resubscribe: provisioning failed; aborting restore/update", {
      businessId,
      error: errorMessage(err)
    });
    return;
  }

  const hostinger = hostingerClient();
  const newVmId = Number.parseInt(newProv.vpsId, 10);
  const newVpsHost = Number.isFinite(newVmId) ? await resolveVmIp(newVmId, hostinger) : null;
  if (newVpsHost) {
    try {
      await restoreBusinessData({ businessId, vpsHost: newVpsHost });
      logger.info("resubscribe: data restored onto new VPS", { businessId, newVpsHost });
    } catch (err) {
      logger.error("resubscribe: restore failed (customer may need manual recovery)", {
        businessId,
        newVpsHost,
        error: errorMessage(err)
      });
    }
  } else {
    logger.warn("resubscribe: no new VPS host resolvable; skipping restore", {
      businessId,
      vpsId: newProv.vpsId
    });
  }

  const now = new Date();
  const commitmentMonths = getCommitmentMonths(billingPeriod);
  const renewalAt = new Date(now);
  renewalAt.setDate(1);
  renewalAt.setMonth(renewalAt.getMonth() + commitmentMonths);

  let newStripeSub: Stripe.Subscription | null = null;
  if (stripeSubscriptionId) {
    try {
      newStripeSub = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
    } catch (err) {
      logger.warn("resubscribe: Stripe subscription retrieve failed (continuing)", {
        businessId,
        stripeSubscriptionId,
        error: errorMessage(err)
      });
    }
  }
  const periodCache = newStripeSub ? stripeSubscriptionPeriodCache(newStripeSub) : {};

  await updateSubscription(oldSub.id, {
    status: "active",
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    tier,
    billing_period: billingPeriod,
    renewal_at: renewalAt.toISOString(),
    commitment_months: commitmentMonths,
    customer_profile_id: customerProfileId,
    hostinger_billing_subscription_id: newProv.hostingerBillingSubscriptionId,
    canceled_at: null,
    cancel_reason: null,
    grace_ends_at: null,
    wiped_at: null,
    vps_stopped_at: null,
    cancel_at_period_end: false,
    ...periodCache
  });

  if (customerProfileId) {
    try {
      await setBusinessCustomerProfile(businessId, customerProfileId);
    } catch (err) {
      logger.warn("resubscribe: setBusinessCustomerProfile failed (continuing)", {
        businessId,
        error: errorMessage(err)
      });
    }
  }

  if (stripeSubscriptionId) {
    try {
      await ensureCommitmentSchedule({ subscriptionId: stripeSubscriptionId, tier, billingPeriod });
    } catch (err) {
      logger.warn("resubscribe: ensureCommitmentSchedule failed (continuing)", {
        businessId,
        stripeSubscriptionId,
        error: errorMessage(err)
      });
    }
  }

  logger.info("resubscribe: complete", { eventId, businessId, tier, billingPeriod });
}

/**
 * Stripe subscription cancel that swallows 404/already-canceled errors and
 * releases any attached schedule so the cancel sticks. Does not refund.
 *
 * Exported for reuse by the checkout activation path in the Stripe
 * webhook, which needs the same "cancel a just-minted Stripe sub when we
 * refuse to provision" semantics when the atomic lifetime cap increment
 * rejects a concurrent signup.
 */
export async function cancelStripeSubscriptionSafely(
  subscriptionId: string,
  businessId: string
): Promise<void> {
  const stripe = getStripe();
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const rawSchedule: string | Stripe.SubscriptionSchedule | null | undefined = sub.schedule;
    const scheduleId: string | null = !rawSchedule
      ? null
      : typeof rawSchedule === "string"
        ? rawSchedule
        : rawSchedule.id;
    if (scheduleId) {
      try {
        await stripe.subscriptionSchedules.release(scheduleId);
      } catch (err) {
        logger.warn("changePlan: schedule release failed (continuing)", {
          businessId,
          scheduleId,
          error: errorMessage(err)
        });
      }
    }
    if (sub.status !== "canceled") {
      await stripe.subscriptions.cancel(subscriptionId, { prorate: false });
    }
  } catch (err) {
    const message = errorMessage(err);
    // Don't fail the whole orchestrator if Stripe says the sub is already
    // gone — the teardown goal is achieved either way.
    if (/No such subscription|resource_missing/i.test(message)) {
      logger.info("changePlan: old Stripe sub already gone", { businessId, subscriptionId });
      return;
    }
    logger.error("changePlan: Stripe cancel failed", {
      businessId,
      subscriptionId,
      error: message
    });
  }
}
