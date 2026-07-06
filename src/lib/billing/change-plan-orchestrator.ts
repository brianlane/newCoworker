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
 * SAME-TIER SWITCHES (contract-period changes): the hardware is already the
 * right size, but the box's Hostinger BILLING TERM may not match the new
 * commitment. Hostinger term SKUs are ~40-65% cheaper per month than
 * monthly renewal (live catalog Jul 2026: kvm1 $19.49/mo monthly renewal vs
 * $6.49/mo first 2-year period; kvm2 $24.49 vs $8.99), and the public API
 * cannot change an existing subscription's billing cycle (only auto-renew
 * on/off — cycle changes are hPanel-only). So:
 *
 *   - Customer commits to a LONGER term than the box's current cycle →
 *     run the full migration (steps 1-4, 7) onto a freshly TERM-BOUGHT box
 *     of the same size; the old monthly box is pooled with auto-renew off.
 *   - Same/shorter commitment, cycle already covers the target, or the
 *     cycle can't be verified → period-only fast path: steps 1-4 and 7 are
 *     skipped, the box keeps its existing Hostinger billing subscription
 *     (inherited onto the new sub row), and only the Stripe swap + DB
 *     bookkeeping (steps 5, 6, 8) execute.
 *
 * Either way, ops gets a term-alignment summary email when the switch
 * completes (including a MANUAL CHECK flag when verification failed).
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
  resolveDeployedVpsSize,
  resolveVpsSize,
  vpsSizeFromHostingerPlan,
  type VpsSize
} from "@/lib/vps/size";
import {
  ensureCommitmentSchedule,
  getStripe
} from "@/lib/stripe/client";
import {
  createSubscription,
  getSubscription,
  getSubscriptionByStripeSubscriptionId,
  isCanceledInGrace,
  isCommitmentElapsed,
  stripeSubscriptionPeriodCache,
  updateSubscription,
  updateSubscriptionIfNotWiped,
  type CancelReason
} from "@/lib/db/subscriptions";
import { getBusiness, setBusinessCustomerProfile } from "@/lib/db/businesses";
import { getCommitmentMonths, type BillingPeriod } from "@/lib/plans/tier";
import {
  decrementLifetimeSubscriptionCount,
  incrementLifetimeSubscriptionCount,
  upsertCustomerProfile
} from "@/lib/db/customer-profiles";
import { logger } from "@/lib/logger";
import {
  sendOpsVpsDeletionEmail,
  sendOpsPlanChangeEmail,
  sendOpsTermAlignmentEmail
} from "@/lib/email/ops-notify";
import { releaseVpsToPool } from "@/lib/db/vps-inventory";
import {
  hostingerTermForBillingPeriod,
  hostingerTermMonths
} from "@/lib/hostinger/provision";

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
  /**
   * Set by /api/billing/change-plan when the old sub's commitment had
   * elapsed (month-to-month rollover phase) — a same-business re-contract.
   * Requests a lifetime-cap exemption; re-verified against the old sub row
   * before the increment is skipped.
   */
  recontract: boolean;
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
    sessionEmail: session.customer_details?.email ?? session.customer_email ?? null,
    recontract: session.metadata?.recontract === "1"
  };
}

/* c8 ignore start -- env-var fallbacks: tests stub the live Hostinger
   pathways via vi.mock, so the missing-base-url / missing-token branches
   never fire in CI. The `??` defaults exist purely so a forgotten Vercel
   env var surfaces as a clean 401 from the API rather than a TypeError
   at construction. Pre-existing pattern; mirrors lifecycle-executor.ts. */
function hostingerClient(): HostingerClient {
  return new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
}
/* c8 ignore stop */

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

/**
 * Months per billing cycle the box's Hostinger subscription currently runs
 * on (1 = monthly renewal, 12/24 = term-bought). Null when the subscription
 * can't be found or the response lacks cycle fields — callers must treat
 * null as "can't verify; leave the hardware alone and flag ops".
 */
async function currentHostingerCycleMonths(
  billingSubscriptionId: string,
  client: HostingerClient
): Promise<number | null> {
  try {
    const subs = await client.listBillingSubscriptions();
    const row = subs.find((s) => s.id === billingSubscriptionId);
    if (!row) return null;
    // Live API (Jul 2026) returns billing_period/billing_period_unit; the
    // legacy period/period_unit pair is kept as a fallback for older shapes.
    const period = row.billing_period ?? row.period;
    const unit = row.billing_period_unit ?? row.period_unit;
    if (typeof period !== "number" || (unit !== "month" && unit !== "year")) return null;
    return unit === "year" ? period * 12 : period;
  } catch (err) {
    logger.warn("changePlan: Hostinger billing-cycle lookup failed", {
      billingSubscriptionId,
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
    sessionEmail,
    recontract
  } = meta;

  // Webhook re-delivery idempotency. Stripe re-delivers
  // `checkout.session.completed` on ack timeouts, manual replays, and
  // periodic delivery sweeps, and the webhook entrypoint has no
  // event-id deduplication. After a successful first run the
  // most-recent `subscriptions` row for this business is the new active
  // sub linked to `stripeSubscriptionId`, so a naïve re-entry would
  // (a) miss `previousSubscriptionId` (since `getSubscription` returns
  // most-recent and the new row IS most-recent) and fall into the
  // `sub mismatch` abort branch which calls `cancelStripeSubscriptionSafely`
  // on `stripeSubscriptionId` — i.e. the LIVE customer-paid subscription —
  // or (b) re-bump the lifetime counter past the cap and hit the
  // cap-rejected branch which also cancels the live sub. Detect the
  // already-completed signature here and bail before either lands.
  if (stripeSubscriptionId) {
    const existingByStripe = await getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
    if (
      existingByStripe &&
      existingByStripe.business_id === businessId &&
      existingByStripe.status === "active"
    ) {
      logger.info("changePlan: idempotency hit; orchestrator already completed", {
        eventId,
        businessId,
        previousSubscriptionId,
        stripeSubscriptionId,
        subscriptionRowId: existingByStripe.id
      });
      return;
    }
  }

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
    // Stripe has already captured the customer's payment for the new
    // plan, but we can't orchestrate anything without a business row to
    // pin it to. Cancel the freshly-minted Stripe sub here so the user
    // isn't silently auto-renewed on a plan we'll never provision. (An
    // operator can triage the outstanding first-cycle charge — this path
    // should be vanishingly rare since the checkout route validates the
    // business up front.)
    logger.warn("changePlan: business missing; abort", { businessId });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    return;
  }

  // `getSubscription` returns the most-recent sub for this business which,
  // at this moment in the flow, should be the OLD active one. We sanity-
  // check against `previousSubscriptionId` so a stale/ooo replay doesn't
  // clobber a newer row.
  const oldSub = await getSubscription(businessId);
  if (!oldSub) {
    logger.warn("changePlan: no existing subscription; abort", { businessId });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    return;
  }
  if (oldSub.id !== previousSubscriptionId) {
    logger.warn("changePlan: sub mismatch; abort", {
      businessId,
      current: oldSub.id,
      expected: previousSubscriptionId
    });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
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

  // Same-business re-contract exemption: when the checkout route stamped
  // `recontract` (old sub was a term plan whose commitment had elapsed),
  // don't count the new contract against the lifetime abuse cap — a loyal
  // customer re-committing every 1-2 years isn't churning refunds. The flag
  // is re-verified against the old sub row (paid Stripe sub + elapsed
  // commitment) so a stale/forged metadata value can't skip the counter.
  const verifiedRecontract =
    recontract && Boolean(oldSub.stripe_subscription_id) && isCommitmentElapsed(oldSub);
  if (recontract && !verifiedRecontract) {
    logger.warn("changePlan: recontract flag failed re-verification; counting lifetime", {
      businessId,
      previousSubscriptionId
    });
  }

  if (customerProfileId && !verifiedRecontract) {
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

  // Old VPS coordinates, captured BEFORE provisioning overwrites them.
  // (`business` was read before `orchestrateProvisioning`, so this stays the
  // OLD VM id even after the DB row is repointed to the new VM.)
  const oldVpsIdRaw = business.hostinger_vps_id;
  const oldVmId =
    oldVpsIdRaw && /^\d+$/.test(oldVpsIdRaw) ? Number.parseInt(oldVpsIdRaw, 10) : null;

  // ── Same-tier switches: the hardware is already the right size, but the
  // box's Hostinger BILLING TERM may not match the new commitment. Term
  // SKUs are ~40-65% cheaper per month than monthly renewal, and the
  // public API cannot change an existing subscription's cycle (hPanel
  // only) — so a LONGER commitment triggers the full migration onto a
  // freshly term-bought box of the same size. Everything else stays on
  // the period-only fast path: skip snapshot / backup / re-provision /
  // restore (steps 1-4) AND the old-Hostinger teardown (step 7 — the box
  // keeps its existing Hostinger subscription; touching it would destroy
  // the customer's live VPS). Only the Stripe/DB steps (5, 6, 8) run.
  const sameTier = tier === oldSub.tier;
  const targetTermMonths = hostingerTermMonths(hostingerTermForBillingPeriod(billingPeriod));
  let currentCycleMonths: number | null = null;
  let termAlignment = false;
  let termAlignmentSkipReason: string | null = null;
  if (sameTier && targetTermMonths > 1) {
    if (oldVmId === null || !oldSub.hostinger_billing_subscription_id) {
      termAlignmentSkipReason =
        "no VM / Hostinger billing subscription recorded for the old plan — verify the box's billing cycle in hPanel";
    } else {
      currentCycleMonths = await currentHostingerCycleMonths(
        oldSub.hostinger_billing_subscription_id,
        hostinger
      );
      if (currentCycleMonths === null) {
        termAlignmentSkipReason =
          "the box's current Hostinger billing cycle could not be verified — check hPanel and change the renewal period manually if it is still monthly";
      } else if (currentCycleMonths < targetTermMonths) {
        termAlignment = true;
      }
    }
  }
  const migrateVps = !sameTier || termAlignment;
  if (sameTier) {
    logger.info(
      termAlignment
        ? "changePlan: same-tier period switch needs a longer Hostinger term; migrating onto a term-bought box"
        : "changePlan: same-tier period switch; skipping VPS migration",
      {
        businessId,
        tier,
        // billing_period is already nullable on the row; log as-is.
        oldBillingPeriod: oldSub.billing_period,
        newBillingPeriod: billingPeriod,
        currentCycleMonths,
        targetTermMonths,
        termAlignmentSkipReason
      }
    );
  }

  // Ops visibility: a tier change OR a term-alignment migration is about to
  // run minutes of unattended hardware migration (snapshot → backup →
  // new-VM purchase → restore → old-box teardown). Tell the operator it
  // STARTED — the existing deletion-request email only marks the end, so
  // without this a stuck migration was invisible until a customer
  // complained. Fire-and-forget (sendOpsPlanChangeEmail never throws);
  // fast-path period switches touch no hardware and stay quiet here (they
  // get the term-alignment summary email at completion instead).
  if (migrateVps) {
    const oldTierForSize = oldSub.tier === "starter" ? "starter" : "standard";
    await sendOpsPlanChangeEmail({
      businessId,
      ownerName: business.owner_name ?? null,
      ownerEmail: business.owner_email,
      fromTier: oldSub.tier,
      toTier: tier,
      billingPeriod,
      oldVirtualMachineId: oldVmId,
      // Old box: deployed-size resolution (null pin on a legacy box = the
      // historical default it was actually provisioned on). New box: the
      // forward-looking default for the target tier under the same pin.
      fromHardware: resolveDeployedVpsSize(oldTierForSize, business.vps_size ?? null),
      toHardware: resolveVpsSize(tier, business.vps_size ?? null)
    });
  }

  let newProv: Awaited<ReturnType<typeof orchestrateProvisioning>> | null = null;
  if (migrateVps) {
    // ── Step 1: snapshot the old VPS as a safety net before migration.
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
    // Stripe sub so it cannot renew without a corresponding DB row/VPS
    // AND roll back the lifetime counter we just bumped, so a transient
    // provisioning failure doesn't permanently burn one of the customer's
    // three lifetime slots for a subscription they never received.
    try {
      newProv = await orchestrateProvisioning({
        businessId,
        tier,
        // Hardware pin survives tier changes: an operator-set vps_size keeps
        // the business on that box size; null keeps the tier default.
        vpsSize: business.vps_size ?? null,
        // Buy the new box at the customer's committed Hostinger term
        // (biennial → 2-year SKU, annual → 1-year) — for a term-alignment
        // migration this discount is the entire point of the move, so that
        // path also skips the adopt-first pool claim (a pooled box is
        // typically a monthly-cycle lapser and would defeat the purpose).
        billingPeriod,
        skipPoolAdopt: termAlignment,
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
      if (customerProfileId) {
        await rollbackLifetimeCount(customerProfileId, businessId, "changePlan");
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
    // A fast-path switch keeps the existing box, so the new sub row inherits
    // the old Hostinger billing subscription (still paying for the same VM).
    // On any migration (tier change OR term alignment) we must NOT fall back
    // to the old billing id — step 7 is about to disable it, and pinning it
    // to the active row would leave the new VPS's real billing untracked
    // while referencing dead billing. A null from provisioning stays null
    // (operator-triaged via the existing lookup fallback inside
    // provisionVpsForBusiness).
    hostinger_billing_subscription_id: migrateVps
      ? (newProv?.hostingerBillingSubscriptionId ?? null)
      : oldSub.hostinger_billing_subscription_id,
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

  // ── Step 7: stop the OLD box and disable its Hostinger auto-renewal.
  // Hostinger removed the public cancel-subscription API (DELETE 404s), so
  // the old VM can only be deleted manually in hPanel — we email ops the
  // deletion request and let auto-renew-off cap the spend in the meantime.
  // NEVER runs on the period-only fast path — that box (and its Hostinger
  // billing) is still the customer's live workspace.
  // Runs when we know about the billing subscription OR just the VM: a
  // missing billing id (e.g. provisioning-time lookup failed) must not
  // suppress the ops email, or the orphaned box never gets deleted.
  if (migrateVps && (oldSub.hostinger_billing_subscription_id || oldVmId !== null)) {
    if (oldVmId !== null) {
      try {
        await hostinger.stopVirtualMachine(oldVmId);
      } catch (err) {
        logger.warn("changePlan: old VPS stop failed before auto-renew disable (continuing)", {
          businessId,
          oldVmId,
          error: errorMessage(err)
        });
      }
    }
    if (oldSub.hostinger_billing_subscription_id) {
      try {
        await hostinger.disableBillingAutoRenewal(oldSub.hostinger_billing_subscription_id);
        logger.info("changePlan: old Hostinger billing auto-renew disabled", {
          businessId,
          billingSubscriptionId: oldSub.hostinger_billing_subscription_id
        });
      } catch (err) {
        logger.warn("changePlan: old Hostinger auto-renew disable failed (continuing)", {
          businessId,
          billingSubscriptionId: oldSub.hostinger_billing_subscription_id,
          error: errorMessage(err)
        });
      }
    }
    // Fleet economics Phase B: the replaced box stays owned (Hostinger
    // refunds are locked out until ≈Dec 30 2026) — return it to the reuse
    // pool so the next matching-size signup adopts it instead of buying.
    // Best-effort: pool bookkeeping never fails a plan change.
    if (oldVmId !== null) {
      // Seed label for boxes with no vps_inventory row (releaseVpsToPool
      // keeps the recorded plan for tracked ones). The business's vps_size
      // pin is useless here — Step 3 already re-pinned it to the NEW box —
      // so ask Hostinger for the released box's ACTUAL plan; that also
      // covers a kvm1 box whose purchase-time inventory record failed,
      // which the historical tier-default fallback would mislabel kvm2.
      let releasedPlan: VpsSize = oldSub.tier === "starter" ? "kvm2" : "kvm8";
      try {
        const oldVm = await hostinger.getVirtualMachine(oldVmId);
        releasedPlan = vpsSizeFromHostingerPlan(oldVm.plan) ?? releasedPlan;
      } catch (err) {
        logger.warn("changePlan: released-box plan lookup failed (using tier default)", {
          businessId,
          oldVmId,
          error: errorMessage(err)
        });
      }
      try {
        await releaseVpsToPool({
          vmId: oldVmId,
          plan: releasedPlan,
          hostingerBillingSubscriptionId: oldSub.hostinger_billing_subscription_id,
          notes: `returned by upgrade_switch of business ${businessId}; auto-renew off — lapses at period end unless adopted`
        });
      } catch (err) {
        logger.warn("changePlan: pool return of old VPS failed (continuing)", {
          businessId,
          oldVmId,
          error: errorMessage(err)
        });
      }
    }
    await sendOpsVpsDeletionEmail({
      businessId,
      virtualMachineId: oldVmId,
      hostingerBillingSubscriptionId: oldSub.hostinger_billing_subscription_id,
      ownerName: business.owner_name ?? null,
      ownerEmail: business.owner_email,
      tier: oldSub.tier,
      signupDate: oldSub.created_at,
      refundIssued: false,
      cancelReason: "upgrade_switch",
      vmState: [
        oldVmId !== null ? "old plan's VM stopped" : "no VM recorded",
        oldSub.hostinger_billing_subscription_id
          ? "auto-renew disabled"
          : "no Hostinger billing id — renewal may still be active, check hPanel",
        "tenant migrated to a new VPS"
      ].join("; ")
    });
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

  // ── Contract-switch summary for ops. Sent on every SAME-TIER period
  // switch after the whole orchestration lands, so the operator always
  // hears what happened to the Hostinger side: migrated onto a term-bought
  // box, nothing needed, or "go check hPanel" when the cycle couldn't be
  // verified. Tier changes stay on the existing started/deletion emails.
  if (sameTier) {
    const detail = termAlignment
      ? `The box was on a ${currentCycleMonths}-month Hostinger cycle; the tenant was migrated onto a new same-size box bought at the ${targetTermMonths}-month term (cheaper per month), and the old box was pooled with auto-renew off.`
      : termAlignmentSkipReason
        ? `A ${targetTermMonths}-month Hostinger term was wanted but the automation could not act: ${termAlignmentSkipReason}.`
        : targetTermMonths <= 1
          ? "New contract is month-to-month — the box keeps its current Hostinger billing cycle."
          : `The box's Hostinger cycle (${currentCycleMonths}mo) already covers the ${targetTermMonths}-month target — nothing to change.`;
    await sendOpsTermAlignmentEmail({
      businessId,
      ownerName: business.owner_name ?? null,
      ownerEmail: business.owner_email,
      tier,
      oldBillingPeriod: oldSub.billing_period,
      newBillingPeriod: billingPeriod,
      outcome: termAlignment ? "aligned" : termAlignmentSkipReason ? "skipped" : "not_needed",
      currentCycleMonths,
      targetTermMonths,
      oldVirtualMachineId: oldVmId,
      /* c8 ignore next -- termAlignment implies newProv (a failed provision returns early above) */
      newVirtualMachineId: termAlignment ? (newProv?.vpsId ?? null) : null,
      detail
    });
  }

  logger.info("changePlan: complete", {
    eventId,
    businessId,
    previousSubscriptionId,
    newTier: tier,
    newBillingPeriod: billingPeriod,
    migrateVps,
    termAlignment
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

  // Webhook re-delivery idempotency. See the analogous guard in
  // `runChangePlanFromCheckout` for the full rationale. After a
  // successful first run the grace row was flipped in place to
  // `status: "active"` with `stripe_subscription_id = stripeSubscriptionId`,
  // so a naïve re-entry would fall into the `not in grace` abort branch
  // (status now active, fails `isCanceledInGrace`) and cancel the LIVE
  // Stripe subscription via `cancelStripeSubscriptionSafely`. The
  // lifetime-cap re-bump on re-entry is the same hazard. Detect the
  // already-completed signature and bail before either branch executes.
  if (stripeSubscriptionId) {
    const existingByStripe = await getSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
    if (
      existingByStripe &&
      existingByStripe.business_id === businessId &&
      existingByStripe.status === "active"
    ) {
      logger.info("resubscribe: idempotency hit; orchestrator already completed", {
        eventId,
        businessId,
        stripeSubscriptionId,
        subscriptionRowId: existingByStripe.id
      });
      return;
    }
  }

  const business = await getBusiness(businessId);
  if (!business) {
    // Stripe already charged the customer for the new subscription but
    // we have no business row to attach it to — cancel the new Stripe
    // sub here so we don't auto-renew indefinitely for a resubscribe
    // flow we can't complete. (Matches the changePlan orchestrator.)
    logger.warn("resubscribe: business missing; abort", { businessId });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    return;
  }
  const oldSub = await getSubscription(businessId);
  if (!oldSub || !isCanceledInGrace(oldSub)) {
    // The grace window lapsed (or the old sub was wiped / never
    // canceled) between checkout-creation and checkout-completion. The
    // customer has been charged but we refuse to resubscribe outside of
    // grace — cancel the brand-new Stripe sub so it can't silently
    // auto-renew forever against a tenant we've stopped serving. The
    // cap-reached branch below already does this; mirror it here.
    logger.warn("resubscribe: latest subscription is not in grace; abort", {
      businessId,
      subscriptionId: oldSub?.id ?? null,
      status: oldSub?.status ?? null
    });
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
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
      vpsSize: business.vps_size ?? null,
      // Term-aware purchase: a resubscriber committing to a term contract
      // funds a term-priced Hostinger box, same as a fresh signup.
      billingPeriod,
      ownerEmail: business.owner_email
    });
  } catch (err) {
    logger.error("resubscribe: provisioning failed; aborting restore/update", {
      businessId,
      error: errorMessage(err)
    });
    // The customer was charged for the new subscription but provisioning
    // failed. Cancel the fresh Stripe sub so it can't silently renew
    // against a resubscribe we never completed, AND roll back the
    // lifetime counter we just bumped so they don't lose a lifetime
    // slot for service they never received. Matches the changePlan
    // provisioning-failed branch.
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    if (customerProfileId) {
      await rollbackLifetimeCount(customerProfileId, businessId, "resubscribe");
    }
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
      // Restore is fail-CLOSED. The customer reactivated specifically
      // to recover their old workspace; if we proceed past a restore
      // failure, the optimistic write below would flip the row to
      // `active` on a fresh empty VPS and the customer would be
      // charged for service we silently never delivered. The
      // `updateSubscriptionIfNotWiped` guard a few lines down only
      // catches the race where `wiped_at` is set, NOT the broader
      // class of restore failures: missing `data_backups` row (e.g.
      // grace-sweep partially executed and deleted the artifact
      // before `wiped_at` was stamped — which we also fixed in the
      // grace-sweep planner ordering, but defense-in-depth catches
      // any other path that nukes the backup early), Supabase
      // Storage download empty/404, sha256 corruption, missing SSH
      // key, or any transient SSH error. In every case the new VM
      // does not have the customer's data, so we must NOT bill them.
      // Abort: cancel the brand-new Stripe sub (so it can't auto-
      // renew forever for service we'll never provide), roll back
      // the lifetime counter (so they don't lose a slot for an
      // attempt that never landed), and log loudly so operators
      // get a paged signal instead of a silent empty workspace.
      logger.error(
        "resubscribe: restore failed; aborting before optimistic write to prevent silent empty-workspace activation",
        {
          eventId,
          businessId,
          newVpsHost,
          stripeSubscriptionId,
          error: errorMessage(err)
        }
      );
      if (stripeSubscriptionId) {
        await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
      }
      if (customerProfileId) {
        await rollbackLifetimeCount(customerProfileId, businessId, "resubscribe");
      }
      return;
    }
  } else {
    // No reachable VPS host means the just-provisioned VM is
    // unreachable — same fail-closed reasoning as the restore-throw
    // branch above. Proceeding would charge the customer for a
    // workspace they cannot reach, with no operator signal.
    logger.error(
      "resubscribe: new VPS host unresolvable; aborting before optimistic write",
      {
        eventId,
        businessId,
        vpsId: newProv.vpsId,
        stripeSubscriptionId
      }
    );
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    if (customerProfileId) {
      await rollbackLifetimeCount(customerProfileId, businessId, "resubscribe");
    }
    return;
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

  // Optimistic write guard against a concurrent grace-sweep wipe.
  // Between this orchestrator's `getSubscription` (line ~584) and the
  // write below, the grace-sweep cron may have run for this same row,
  // stamped `wiped_at`, deleted the Supabase Storage backup artifact,
  // stopped the VM, and canceled Hostinger billing — all of which
  // finalise the prior lifetime. Naively writing `wiped_at: null` here
  // would silently resurrect that wiped row to active on a fresh VPS
  // that has none of the customer's data (the backup that
  // `restoreBusinessData` would have read is already gone). Use a
  // conditional UPDATE keyed on `wiped_at IS NULL` so we only
  // overwrite when the wipe hasn't landed yet; on miss, abort and
  // cancel the brand-new Stripe subscription so it doesn't auto-renew
  // forever for a tenant we'll never serve. Operator triage handles
  // any refund.
  const writePatch = {
    status: "active" as const,
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
  };
  const updated = await updateSubscriptionIfNotWiped(oldSub.id, writePatch);
  if (!updated) {
    logger.warn(
      "resubscribe: grace-sweep wiped row between orchestrator entry and final write; aborting and canceling new Stripe sub",
      {
        eventId,
        businessId,
        subscriptionRowId: oldSub.id,
        stripeSubscriptionId
      }
    );
    if (stripeSubscriptionId) {
      await cancelStripeSubscriptionSafely(stripeSubscriptionId, businessId);
    }
    if (customerProfileId) {
      await rollbackLifetimeCount(customerProfileId, businessId, "resubscribe");
    }
    return;
  }

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
 * Compensating decrement for the lifetime counter when we aborted a
 * subscription AFTER bumping the counter. Logged-not-thrown so it can't
 * mask the underlying provisioning error the caller is already
 * surfacing. Floor-at-zero is enforced server-side by the
 * `decrement_customer_profile_lifetime_count` RPC so a replay can't
 * produce a negative count.
 */
async function rollbackLifetimeCount(
  profileId: string,
  businessId: string,
  flow: "changePlan" | "resubscribe"
): Promise<void> {
  try {
    await decrementLifetimeSubscriptionCount(profileId);
    logger.info(`${flow}: rolled back lifetime subscription count after provisioning failure`, {
      businessId,
      profileId
    });
  } catch (err) {
    logger.warn(`${flow}: lifetime count rollback failed (continuing)`, {
      businessId,
      profileId,
      error: errorMessage(err)
    });
  }
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
