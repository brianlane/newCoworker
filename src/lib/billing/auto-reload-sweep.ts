/**
 * The auto-reload sweep: find tenants below their threshold, charge the card
 * they authorized, grant the pack.
 *
 * Runs as a Next.js internal route rather than an edge function because the
 * balance math needs contracts that only exist here: the chat base cap is
 * env-and-tier derived (`chatSpendBaseCapMicrosForTier`), the SMS cap needs
 * the Mexico clamp (`effectiveSmsMonthlyCap`), and the charge needs the
 * Stripe Node SDK. Porting those to Deno would mean a second copy of three
 * enforcement contracts.
 *
 * Every external dependency is injectable so the whole loop is testable
 * without a network, and the integration suite can run it against real
 * Postgres with only the charge faked.
 */
import {
  AUTO_RELOAD_CATEGORIES,
  AUTO_RELOAD_MAX_CONSECUTIVE_FAILURES,
  autoReloadPlatformEnabled,
  autoReloadPlatformMaxMonthlyCents,
  classifyChargeFailure,
  isBelowThreshold,
  resolveAutoReloadPack,
  type AutoReloadCategory
} from "@/lib/billing/auto-reload";
import { resolvePackChargeAmount } from "@/lib/billing/auto-reload-pricing";
import {
  claimAutoReload,
  listAutoReloadCandidates,
  listFlaggedAutoReloadCandidates,
  resumeStaleAutoReload,
  settleAutoReload,
  type AutoReloadCandidate
} from "@/lib/db/auto-reload";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";
import { getChatSpendSnapshotForBusiness, getSmsBonusTextsRemaining } from "@/lib/db/chat-usage";
import { getBillingWindowUsageTotals } from "@/lib/db/usage";
import { effectiveSmsMonthlyCap } from "@/lib/plans/limits";
import { createOffSessionPackCharge, getStripe } from "@/lib/stripe/client";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import {
  buildAutoReloadAlertEmail,
  type AutoReloadAlertKind
} from "@/lib/email/templates/auto-reload-alert";
import { logger } from "@/lib/logger";
import type { PlanTier } from "@/lib/plans/tier";

export const AUTO_RELOAD_BATCH_LIMIT = 200;
export const AUTO_RELOAD_CHUNK_SIZE = 10;

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Grant RPC and metadata key per family. */
const GRANT_SPEC: Record<
  AutoReloadCategory,
  {
    rpc: string;
    amountParam: string;
    checkoutKind: "voice_bonus_seconds" | "sms_bonus_texts" | "chat_credit_micros";
    unitKey: "voiceSeconds" | "smsTexts" | "creditMicros";
  }
> = {
  voice: {
    rpc: "apply_voice_bonus_grant_from_checkout",
    amountParam: "p_seconds_purchased",
    checkoutKind: "voice_bonus_seconds",
    unitKey: "voiceSeconds"
  },
  sms: {
    rpc: "apply_sms_bonus_grant_from_checkout",
    amountParam: "p_texts_purchased",
    checkoutKind: "sms_bonus_texts",
    unitKey: "smsTexts"
  },
  chat: {
    rpc: "apply_chat_credit_grant_from_checkout",
    amountParam: "p_credit_micros",
    checkoutKind: "chat_credit_micros",
    unitKey: "creditMicros"
  }
};

export type ChargeOutcome =
  | { ok: true; paymentIntentId: string }
  | { ok: false; error: unknown };

export type AutoReloadSweepDeps = {
  client?: SupabaseClient;
  now?: () => Date;
  limit?: number;
  /** Injected so integration tests can drive the real loop without Stripe. */
  charge?: (params: {
    candidate: AutoReloadCandidate;
    eventId: number;
    packId: string;
    grantUnits: number;
    amountCents: number;
    currency: string;
  }) => Promise<ChargeOutcome>;
  resolvePrice?: typeof resolvePackChargeAmount;
  /**
   * Candidate source. Overridden by the integration suite so a test can scope
   * the sweep to the tenant it seeded: every itest file shares one database,
   * and a sweep that picked up a neighbouring test's tenant would charge it.
   */
  listCandidates?: (limit: number, db: SupabaseClient) => Promise<AutoReloadCandidate[]>;
  /**
   * "full" rescans every armed rule; "flagged" looks only at rules a consume
   * path stamped since the last tick.
   *
   * Two jobs share this function. The flagged pass runs every minute and is
   * normally a no-op, which is what makes a near-real-time reaction cheap. The
   * full pass keeps running every 15 minutes as the backstop for anything the
   * stamps miss, so a missed stamp costs latency, never a missed top-up.
   *
   * Both go through the same claim, so the cooldown and the unique attempt key
   * still prevent the two from charging the same tenant twice.
   */
  mode?: "full" | "flagged";
  notify?: (params: {
    candidate: AutoReloadCandidate;
    kind: AutoReloadAlertKind;
    attempts?: number;
  }) => Promise<void>;
};

export type AutoReloadSweepResult = {
  scanned: number;
  charged: number;
  granted: number;
  failed: number;
  skipped: number;
  errors: Array<{ businessId: string; category: string; message: string }>;
};

/**
 * Remaining capacity in canonical units, or null when it cannot be read.
 *
 * Measures plan-included remaining PLUS pack remaining, not pack-only. A
 * tenant who has never bought a pack has a pack balance of zero, so a
 * pack-only threshold would charge them the instant they flip the toggle
 * while their included allowance sits untouched. This is also the number the
 * billing page already renders, so the trigger and the display cannot
 * disagree.
 */
export async function readRemainingUnits(
  candidate: AutoReloadCandidate,
  db: SupabaseClient
): Promise<number | null> {
  if (candidate.category === "voice") {
    const snap = await getVoiceBillingSnapshotForBusiness(candidate.businessId, db);
    if (!snap) return null;
    return snap.includedHeadroomSeconds + snap.bonusSecondsAvailable;
  }

  if (candidate.category === "sms") {
    const cap = effectiveSmsMonthlyCap(
      (candidate.tier ?? "starter") as PlanTier,
      candidate.enterpriseLimits,
      { phone: candidate.phone, timezone: candidate.timezone }
    );
    // An uncapped enterprise plan can never run out of plan texts, so a
    // threshold on remaining capacity can never be crossed. Skip rather than
    // charge against a number that is meaningless here.
    if (!Number.isFinite(cap)) return null;
    const [usage, bonus] = await Promise.all([
      getBillingWindowUsageTotals(candidate.businessId, db),
      getSmsBonusTextsRemaining(candidate.businessId, db)
    ]);
    // Balance in text units, the ledger the reserve RPC actually enforces,
    // so the reload threshold trips on the same number Postgres refuses at.
    return Math.max(0, cap - usage.sms_text_units) + bonus;
  }

  // Chat credit raises the spend cap and is never decremented by usage, so
  // "balance" here means headroom under the effective cap.
  const snap = await getChatSpendSnapshotForBusiness(
    candidate.businessId,
    db,
    (candidate.tier ?? null) as PlanTier | null
  );
  return Math.max(0, snap.effectiveCapMicros - snap.spendMicros);
}

async function defaultCharge(params: {
  candidate: AutoReloadCandidate;
  eventId: number;
  packId: string;
  grantUnits: number;
  amountCents: number;
  currency: string;
}): Promise<ChargeOutcome> {
  const spec = GRANT_SPEC[params.candidate.category];
  try {
    const intent = await createOffSessionPackCharge({
      customerId: params.candidate.stripeCustomerId!,
      paymentMethodId: params.candidate.stripePaymentMethodId,
      amountCents: params.amountCents,
      currency: params.currency,
      businessId: params.candidate.businessId,
      checkoutKind: spec.checkoutKind,
      unitKey: spec.unitKey,
      unitValue: params.grantUnits,
      packId: params.packId,
      eventId: params.eventId,
      receiptEmail: params.candidate.ownerEmail ?? undefined
    });
    return { ok: true, paymentIntentId: intent.id };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Grant the pack, keyed `pi_<paymentIntentId>`.
 *
 * Reuses the existing `apply_*_grant_from_checkout` RPCs, which are
 * idempotent on that text column and already accept synthetic keys (the
 * recurring add-on path uses `inv_<invoice>:<category>:<pack>`). So the
 * webhook backstop and this synchronous path can both write the same key
 * without double-granting.
 */
async function applyGrant(params: {
  db: SupabaseClient;
  candidate: AutoReloadCandidate;
  paymentIntentId: string;
  grantUnits: number;
  now: Date;
}): Promise<{ ok: boolean; sourceId: string; reason?: string }> {
  const spec = GRANT_SPEC[params.candidate.category];
  const sourceId = `pi_${params.paymentIntentId}`;
  // Same expiry rule as every other pack purchase: a pack must stay usable
  // for at least 30 days even when bought on the period's last day.
  const plus30 = new Date(params.now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const { data, error } = await params.db.rpc(spec.rpc, {
    p_business_id: params.candidate.businessId,
    p_checkout_session_id: sourceId,
    [spec.amountParam]: params.grantUnits,
    p_expires_at: plus30.toISOString()
  });
  if (error) return { ok: false, sourceId, reason: error.message };
  const payload = (data ?? {}) as { ok?: boolean; reason?: string };
  return { ok: payload.ok !== false, sourceId, reason: payload.reason };
}

/**
 * Tell the owner about the states they cannot discover on their own.
 *
 * Auto-reload runs unattended, so a rule that quietly switched itself off is
 * invisible until the tenant's texts start failing. Successes and soft
 * declines are deliberately silent: those are visible in the billing ledger
 * and do not warrant an interruption.
 */
/** Task type per alert, so the dashboard can label and link each one. */
const ALERT_TASK_TYPE: Record<AutoReloadAlertKind, string> = {
  disabled: "auto_reload_disabled",
  disabled_no_card: "auto_reload_no_card",
  paused_authentication: "auto_reload_action_required",
  monthly_limit: "auto_reload_limit_reached"
};

async function defaultNotify(params: {
  candidate: AutoReloadCandidate;
  kind: AutoReloadAlertKind;
  attempts?: number;
}): Promise<void> {
  const to = params.candidate.ownerEmail;
  if (!to) return;

  // The template has always accepted a locale; nothing was passing one, so a
  // Spanish-speaking owner got English.
  const locale = await resolveOwnerUiLocaleForEmail(to);
  const email = buildAutoReloadAlertEmail({
    kind: params.kind,
    category: params.candidate.category,
    businessName: params.candidate.businessName ?? "your account",
    recipientEmail: to,
    siteUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    attempts: params.attempts,
    locale
  });

  // Goes through the shared dispatcher rather than sending mail directly, so
  // the same alert also lands in the dashboard notification list and honours
  // the owner's channel preferences. The rich template is passed through as
  // the email override, so switching to the dispatcher costs nothing in copy.
  await dispatchUrgentNotification({
    businessId: params.candidate.businessId,
    summary: email.subject,
    kind: ALERT_TASK_TYPE[params.kind],
    emailSubject: email.subject,
    emailBody: email.text,
    // `taskType`, camelCase: that is the key `notificationLink` reads. Writing
    // the snake_case column name here looked right and silently sent every
    // one of these alerts to Activity instead of Billing.
    payload: {
      taskType: ALERT_TASK_TYPE[params.kind],
      category: params.candidate.category,
      autoReloadKind: params.kind
    },
    // Every auto-reload alert is fixed on the billing page, so the email
    // button has to go there. Without this the dispatcher renders its generic
    // "open dashboard" CTA and the tenant has to find Billing themselves.
    // Every auto-reload alert is fixed on the billing page, so all three
    // destinations have to point there: the email button, its copy-paste
    // fallback link, and the SMS link. `ctaPath` drives all of them at once.
    ctaPath: "/dashboard/billing",
    ctaLabel: email.ctaLabel
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function sweepUsagePackAutoReloads(
  deps: AutoReloadSweepDeps = {}
): Promise<AutoReloadSweepResult> {
  const result: AutoReloadSweepResult = {
    scanned: 0,
    charged: 0,
    granted: 0,
    failed: 0,
    skipped: 0,
    errors: []
  };

  // Fail closed: the switch has to be turned on deliberately, matching the
  // pack catalogs' posture.
  if (!autoReloadPlatformEnabled()) return result;

  const db = deps.client ?? (await createSupabaseServiceClient());
  const now = deps.now ?? (() => new Date());
  const charge = deps.charge ?? defaultCharge;
  const resolvePrice = deps.resolvePrice ?? resolvePackChargeAmount;
  const limit = deps.limit ?? AUTO_RELOAD_BATCH_LIMIT;
  const readCandidates =
    deps.listCandidates ??
    (deps.mode === "flagged" ? listFlaggedAutoReloadCandidates : listAutoReloadCandidates);
  const notify = deps.notify ?? defaultNotify;

  const candidates = await readCandidates(limit, db);
  result.scanned = candidates.length;

  for (const batch of chunk(candidates, AUTO_RELOAD_CHUNK_SIZE)) {
    await Promise.all(
      batch.map(async (candidate) => {
        try {
          await processCandidate({ candidate, db, now, charge, resolvePrice, notify, result });
        } catch (err) {
          // One tenant's failure must never stall the batch.
          result.errors.push({
            businessId: candidate.businessId,
            category: candidate.category,
            message: err instanceof Error ? err.message : String(err)
          });
          logger.error("auto_reload: candidate failed", {
            businessId: candidate.businessId,
            category: candidate.category,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })
    );
  }

  return result;
}

async function processCandidate(ctx: {
  candidate: AutoReloadCandidate;
  db: SupabaseClient;
  now: () => Date;
  charge: NonNullable<AutoReloadSweepDeps["charge"]>;
  resolvePrice: typeof resolvePackChargeAmount;
  notify: NonNullable<AutoReloadSweepDeps["notify"]>;
  result: AutoReloadSweepResult;
}): Promise<void> {
  const { candidate, db, now, charge, resolvePrice, notify, result } = ctx;

  if (!AUTO_RELOAD_CATEGORIES.includes(candidate.category)) {
    result.skipped += 1;
    return;
  }

  // A crashed run leaves a pending event behind. Resume THAT row rather than
  // claiming a new one: the Stripe idempotency key comes from the event id,
  // so a fresh row would mean a fresh key and Stripe would happily create a
  // second PaymentIntent for a charge that may already have succeeded.
  const resumed = await resumeStaleAutoReload(candidate.businessId, candidate.category, db);

  // A resumed attempt must replay the ORIGINAL parameters, so the pack comes
  // from the pending event rather than the rule. If the tenant switched packs
  // between the claim and the retry, using the rule's current pack would
  // charge the stored amount while granting a different size and sending
  // mismatched Stripe metadata. It would also change the request behind an
  // already-used idempotency key.
  const effectivePackId = resumed.ok ? resumed.packId : candidate.packId;
  const pack = resolveAutoReloadPack(candidate.category, effectivePackId);
  if (!pack) {
    // The pack's Stripe price env is unset, so the pack does not exist.
    if (resumed.ok) {
      await settleAutoReload(
        { eventId: resumed.eventId, status: "skipped_pack_unavailable" },
        db
      );
    }
    result.skipped += 1;
    logger.warn("auto_reload: pack unavailable", {
      businessId: candidate.businessId,
      category: candidate.category,
      packId: effectivePackId
    });
    return;
  }

  // Defensive re-check of the anti-loop invariant. The settings route rejects
  // this, but a catalog change can move a pack's size under a saved rule.
  if (candidate.thresholdUnits >= pack.grantUnits) {
    if (resumed.ok) {
      await settleAutoReload(
        {
          eventId: resumed.eventId,
          status: "failed",
          failureKind: "config",
          failureCode: "threshold_not_below_pack"
        },
        db
      );
    }
    result.skipped += 1;
    return;
  }

  let eventId: number;
  let amountCents: number;
  let currency = "usd";

  if (resumed.ok) {
    eventId = resumed.eventId;
    amountCents = resumed.amountCents;
    // Stored on the event for the same reason as the pack: Stripe rejects a
    // reused idempotency key whose parameters changed, and a non-USD pack
    // must not be retried as USD.
    currency = resumed.currency;
  } else {
    const balance = await readRemainingUnits(candidate, db);
    if (balance === null) {
      result.skipped += 1;
      return;
    }
    // Hysteresis is free: a successful reload lifts the balance above the
    // threshold, so the next tick reads above and stops. No armed flag and
    // no re-arm job needed, unlike the low-balance email alert whose payload
    // does not change the quantity being measured.
    if (!isBelowThreshold(balance, candidate.thresholdUnits)) {
      result.skipped += 1;
      return;
    }

    const price = await resolvePrice({
      stripe: getStripe(),
      priceId: pack.priceId,
      catalogPriceCents: pack.priceCents
    });
    if (!price.ok) {
      // Never charge on a pricing disagreement. Nobody sees a checkout page
      // here, so a drift would silently bill the wrong amount on a schedule.
      result.skipped += 1;
      logger.error("auto_reload: price check failed; not charging", {
        businessId: candidate.businessId,
        category: candidate.category,
        packId: pack.packId,
        reason: price.reason,
        stripeCents: "stripeCents" in price ? price.stripeCents : undefined,
        catalogCents: "catalogCents" in price ? price.catalogCents : undefined
      });
      return;
    }
    amountCents = price.amountCents;
    currency = price.currency;

    if (!candidate.stripeCustomerId) {
      result.skipped += 1;
      return;
    }

    const claim = await claimAutoReload(
      {
        businessId: candidate.businessId,
        category: candidate.category,
        packId: pack.packId,
        amountCents,
        balanceUnits: balance,
        thresholdUnits: candidate.thresholdUnits,
        platformMaxCents: autoReloadPlatformMaxMonthlyCents(),
        currency
      },
      db
    );
    if (!claim.ok) {
      // `already_claimed` is the concurrent-sweep case: another tick owns
      // this cooldown bucket, so this one charges nothing, and is not worth
      // an email. A budget ceiling IS worth one: the tenant set that number
      // and top-ups have now stopped for the month.
      if (claim.reason === "monthly_limit") {
        await notify({ candidate, kind: "monthly_limit" }).catch(() => {});
      }
      result.skipped += 1;
      return;
    }
    eventId = claim.eventId;
  }

  const outcome = await charge({
    candidate,
    eventId,
    packId: pack.packId,
    grantUnits: pack.grantUnits,
    amountCents,
    currency
  });

  if (!outcome.ok) {
    const failure = classifyChargeFailure(outcome.error);
    const settled = await settleAutoReload(
      {
        eventId,
        status: failure.kind === "requires_action" ? "requires_action" : "failed",
        failureKind: failure.kind,
        failureCode: failure.code,
        failureMessage: failure.message
      },
      db
    );
    // Auto-reload runs unattended, so a rule that just switched itself off is
    // invisible until the tenant's texts start failing. A soft decline stays
    // silent: it retries next cooldown and the ledger already shows it.
    if (settled.disabled) {
      // A missing or unusable card disables after ONE failure, so it must not
      // borrow the "declined three times in a row" copy.
      await notify({
        candidate,
        kind: failure.kind === "no_payment_method" ? "disabled_no_card" : "disabled",
        attempts: AUTO_RELOAD_MAX_CONSECUTIVE_FAILURES
      }).catch(() => {});
    } else if (failure.kind === "requires_action") {
      await notify({ candidate, kind: "paused_authentication" }).catch(() => {});
    }
    result.failed += 1;
    logger.warn("auto_reload: charge failed", {
      businessId: candidate.businessId,
      category: candidate.category,
      kind: failure.kind,
      code: failure.code
    });
    return;
  }

  result.charged += 1;

  // Grant in the same process that took the money. Charging and then
  // silently not granting is the worst outcome this feature can produce, so
  // the webhook backstop exists for the crash window rather than as the
  // primary path.
  const granted = await applyGrant({
    db,
    candidate,
    paymentIntentId: outcome.paymentIntentId,
    grantUnits: pack.grantUnits,
    now: now()
  });

  await settleAutoReload(
    {
      eventId,
      status: "succeeded",
      unitsGranted: granted.ok ? pack.grantUnits : null,
      paymentIntentId: outcome.paymentIntentId,
      grantSourceId: granted.sourceId,
      failureCode: granted.ok ? null : "grant_failed",
      failureMessage: granted.ok ? null : (granted.reason ?? null)
    },
    db
  );

  if (granted.ok) {
    result.granted += 1;
  } else {
    logger.error("auto_reload: charged but grant did not land", {
      businessId: candidate.businessId,
      category: candidate.category,
      paymentIntentId: outcome.paymentIntentId,
      reason: granted.reason
    });
  }
}
