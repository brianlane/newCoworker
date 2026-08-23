/**
 * Abandoned-signup cleanup: deleting the `businesses` rows left behind by
 * onboarding sessions that never paid.
 *
 * Signup here is deliberately "build first, pay last". `/api/business/create`
 * inserts the row BEFORE Stripe is involved, because the questionnaire needs
 * somewhere to put the intake it is already collecting (config write, website
 * ingest, AI drafts) and the Checkout session needs a `businessId` to carry so
 * the payment webhook knows what to provision. Until that webhook fires the
 * row is a saved cart: status `offline`, no box, no phone number, no auth
 * user, running nothing. It is also resumable, which is the point, the
 * questionnaire keeps the id in localStorage and `/api/business/create` is
 * idempotent, so a customer who wanders off mid-checkout can come back and
 * land on their own setup.
 *
 * Nothing ever cleans up the carts that are never claimed. The one existing
 * cascade delete (src/lib/provisioning/stale-tenant-cleanup.ts) fires on VPS
 * pool adoption, which a never-provisioned signup can never reach, so these
 * rows accumulate in the admin All Clients list as pending ghosts.
 *
 * Deleting a business is irreversible and fans out through 138 ON DELETE
 * CASCADE foreign keys, so the guards below matter more than the sweep does.
 * This fleet contains rows that LOOK dormant but must never be touched:
 *
 *   - The five internal review sandboxes (Zoom, Meta, Google, Slack, and the
 *     Cedar Street Dental demo) carry no VPS and no Stripe linkage of any
 *     kind. "Has no box" and "has no Stripe customer" are therefore NOT
 *     evidence that a row is disposable.
 *   - HQ (New Coworker itself) carries an `active` subscription whose
 *     `stripe_customer_id` and `stripe_subscription_id` are both null,
 *     because it is billed outside Stripe. A naive "no Stripe linkage after
 *     30 days" rule deletes HQ.
 *
 * What separates a genuine abandoned cart from every one of those is the
 * owner email. The Stripe-first flow stamps a self-referential sentinel,
 * `pending+<the row's own id>@onboarding.local`, and that value is one-way:
 * it is written only by the INSERT in `/api/business/create`, and
 * `updateBusinessOwnerEmailIfPending` only ever swaps it FOR a real address
 * (its update is gated on `.eq("owner_email", <sentinel>)`). Nothing writes it
 * back. So a row still carrying it has never had an owner, and no sandbox,
 * demo, or manually-created tenant can wear it by accident: they all carry
 * real addresses. Every other guard here is defence in depth behind that one.
 *
 * Everything is dependency-injected so tests run without a database;
 * production wiring lives in the cron route.
 */

import { deleteBusiness, listBusinesses, type BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import { deleteOnboardingDraft } from "@/lib/db/onboarding-drafts";
import { createPendingOwnerEmail } from "@/lib/onboarding/token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * How stale a never-paid signup must be before it is swept.
 *
 * Comfortably past the 72-hour onboarding-token TTL (src/lib/onboarding/token.ts),
 * so a customer whose resume link is still live is never deleted out from under
 * a follow-up. It is also past the point where a sales follow-up on an
 * abandoned checkout is realistically still in play.
 */
export const ABANDONED_SIGNUP_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Deletions per run, so a surprise never turns into a mass delete. */
export const ABANDONED_SIGNUP_MAX_DELETES_PER_RUN = 25;

/**
 * Why a row was spared. Reported for every skipped candidate: a sweep that
 * silently declines to delete looks identical to a sweep that found nothing,
 * and the difference is exactly what an operator needs to see.
 */
export type AbandonedSignupSkipReason =
  /** owner_email is a real address, so this row has an owner. Sandboxes, HQ, and every paying tenant land here. */
  | "owner_claimed"
  /** Provisioned, running, or a `wiped` lifecycle audit stamp. Only `offline` is ever a candidate. */
  | "not_offline"
  /** Operator pinned it in the admin console, which is an explicit "leave this alone". */
  | "admin_pinned"
  /** Points at a VPS, a Hostinger billing subscription, an SSH key row, or a pooled box. */
  | "vps_linked"
  /** Carries a Stripe customer or subscription id, so money has been involved. */
  | "stripe_linked"
  /** Has a subscription that is not `pending` (active, past_due, or canceled). */
  | "subscription_not_pending"
  /** A white-glove intake or offer is attached, which is human work worth keeping. */
  | "white_glove_attached"
  /** Has served a real customer (contacts, texts, calls, email, or flow runs). */
  | "customer_activity"
  /** Younger than the age threshold, the customer may still come back. */
  | "too_young";

/** The materialized facts a verdict needs. Fetched by the sweep, injected in tests. */
export type AbandonedSignupCandidate = {
  business: BusinessRow;
  /** Every subscription row for this business, in any state. */
  subscriptions: readonly Pick<
    SubscriptionRow,
    "status" | "stripe_customer_id" | "stripe_subscription_id"
  >[];
  /** An SSH key row or a pooled `vps_inventory` assignment exists for it. */
  hasVpsRecord: boolean;
  /** A `white_glove_intakes` or `white_glove_offers` row points at it. */
  hasWhiteGlove: boolean;
  /** Rows exist in a customer-facing table (contacts, SMS, voice, email, flow runs). */
  hasCustomerActivity: boolean;
};

export type AbandonedSignupVerdict =
  | { deletable: true }
  | { deletable: false; reason: AbandonedSignupSkipReason };

/**
 * Decide whether one never-paid signup may be deleted.
 *
 * Every guard must hold. They are ordered most-decisive first so the reported
 * reason is the most informative one: an owner-claimed row is reported as
 * `owner_claimed` rather than as whatever else also happens to be true of it.
 */
export function classifyAbandonedSignup(
  candidate: AbandonedSignupCandidate,
  nowMs: number
): AbandonedSignupVerdict {
  const { business, subscriptions } = candidate;

  // The load-bearing guard. See the module header: this sentinel is one-way,
  // so carrying it proves the row never had an owner.
  if (business.owner_email !== createPendingOwnerEmail(business.id)) {
    return { deletable: false, reason: "owner_claimed" };
  }

  // `offline` is the creation default. `online`/`high_load` mean a box is
  // running; `wiped` is the lifecycle engine's audit stamp for a paid account
  // that went through cancel then grace, which stale-tenant-cleanup also
  // refuses to delete for the same reason.
  if (business.status !== "offline") {
    return { deletable: false, reason: "not_offline" };
  }

  if (business.admin_pinned === true) {
    return { deletable: false, reason: "admin_pinned" };
  }

  if (
    business.hostinger_vps_id !== null ||
    business.hostinger_subscription_id != null ||
    candidate.hasVpsRecord
  ) {
    return { deletable: false, reason: "vps_linked" };
  }

  const stripeLinked = subscriptions.some(
    (s) => s.stripe_customer_id != null || s.stripe_subscription_id != null
  );
  if (stripeLinked) {
    return { deletable: false, reason: "stripe_linked" };
  }

  // A never-paid cart has at most one subscription row and it is `pending`.
  // Anything else means the billing lifecycle touched this business, so its
  // history is worth keeping even when Stripe ids are absent (HQ's shape).
  if (subscriptions.some((s) => s.status !== "pending")) {
    return { deletable: false, reason: "subscription_not_pending" };
  }

  if (candidate.hasWhiteGlove) {
    return { deletable: false, reason: "white_glove_attached" };
  }

  if (candidate.hasCustomerActivity) {
    return { deletable: false, reason: "customer_activity" };
  }

  if (nowMs - Date.parse(business.created_at) < ABANDONED_SIGNUP_MIN_AGE_MS) {
    return { deletable: false, reason: "too_young" };
  }

  return { deletable: true };
}

/**
 * Tables that prove a business actually served a customer.
 *
 * Deliberately NOT the tables a never-paid signup legitimately fills in:
 * `business_configs`, `memory_entities`/`memory_facts` (the knowledge graph
 * built from the website ingest), `analytics_daily_snapshots`,
 * `notifications`, and the chat-spend rollups all get rows during onboarding,
 * so treating them as activity would make every abandoned cart undeletable.
 * These five need a provisioned phone number or mailbox to have any rows at
 * all, so a hit here means something happened that this sweep did not expect.
 */
export const CUSTOMER_ACTIVITY_TABLES = [
  "contacts",
  "sms_outbound_log",
  "voice_call_transcripts",
  "email_log",
  "ai_flow_runs"
] as const;

/** `business_id` row count for one table, used by the guard queries. */
async function countFor(
  db: SupabaseClient,
  table: string,
  column: string,
  businessId: string
): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select(column, { count: "exact", head: true })
    .eq(column, businessId);
  if (error) {
    throw new Error(`countFor(${table}): ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Gather the facts {@link classifyAbandonedSignup} needs for one business.
 *
 * Only called for rows that already carry the pending sentinel, so this fans
 * out over a handful of abandoned carts rather than the whole fleet.
 */
export async function loadAbandonedSignupFacts(
  businessId: string,
  db: SupabaseClient
): Promise<Omit<AbandonedSignupCandidate, "business">> {
  const { data, error } = await db
    .from("subscriptions")
    .select("status,stripe_customer_id,stripe_subscription_id")
    .eq("business_id", businessId);
  if (error) {
    throw new Error(`loadAbandonedSignupFacts(subscriptions): ${error.message}`);
  }

  const sshKeys = await countFor(db, "vps_ssh_keys", "business_id", businessId);
  const pooled = await countFor(db, "vps_inventory", "assigned_business_id", businessId);
  const intakes = await countFor(db, "white_glove_intakes", "business_id", businessId);
  const offers = await countFor(db, "white_glove_offers", "business_id", businessId);

  let activity = 0;
  for (const table of CUSTOMER_ACTIVITY_TABLES) {
    activity += await countFor(db, table, "business_id", businessId);
  }

  return {
    subscriptions: (data ?? []) as AbandonedSignupCandidate["subscriptions"],
    hasVpsRecord: sshKeys + pooled > 0,
    hasWhiteGlove: intakes + offers > 0,
    hasCustomerActivity: activity > 0
  };
}

export type AbandonedSignupSweepDeps = {
  client?: SupabaseClient;
  listBusinesses?: typeof listBusinesses;
  loadFacts?: (
    businessId: string,
    db: SupabaseClient
  ) => Promise<Omit<AbandonedSignupCandidate, "business">>;
  /**
   * `onboarding_drafts` carries the customer's name, email, and phone and has
   * NO foreign key to `businesses`, so the cascade cannot reach it. Deleting
   * the business without this leaves that personal data orphaned forever.
   */
  deleteOnboardingDraft?: typeof deleteOnboardingDraft;
  deleteBusiness?: typeof deleteBusiness;
  now?: () => number;
  /** Report what WOULD be deleted and delete nothing. */
  dryRun?: boolean;
  maxDeletes?: number;
};

export type AbandonedSignupSweepResult = {
  scanned: number;
  deleted: { id: string; name: string; createdAt: string }[];
  skipped: { id: string; reason: AbandonedSignupSkipReason }[];
  /** One broken row must never stop the rest; read by withSweepRun. */
  errors: { businessId: string; message: string }[];
  /** True when the batch cap stopped the run before every candidate was handled. */
  cappedAtLimit: boolean;
  dryRun: boolean;
};

/**
 * Scan every business and delete the never-paid signups older than the age
 * threshold.
 *
 * Facts are only fetched for rows that already pass the sentinel check, so a
 * fleet of paying tenants costs one list query rather than a per-tenant fan
 * out.
 */
export async function sweepAbandonedSignups(
  deps: AbandonedSignupSweepDeps = {}
): Promise<AbandonedSignupSweepResult> {
  /* c8 ignore start -- production defaults; unit tests inject every dep */
  const db = deps.client ?? (await createSupabaseServiceClient());
  const list = deps.listBusinesses ?? listBusinesses;
  const loadFacts = deps.loadFacts ?? loadAbandonedSignupFacts;
  const dropDraft = deps.deleteOnboardingDraft ?? deleteOnboardingDraft;
  const dropBusiness = deps.deleteBusiness ?? deleteBusiness;
  /* c8 ignore stop */
  const now = deps.now ?? Date.now;
  const dryRun = deps.dryRun === true;
  const maxDeletes = deps.maxDeletes ?? ABANDONED_SIGNUP_MAX_DELETES_PER_RUN;

  const businesses = await list(db);
  const result: AbandonedSignupSweepResult = {
    scanned: businesses.length,
    deleted: [],
    skipped: [],
    errors: [],
    cappedAtLimit: false,
    dryRun
  };

  for (const business of businesses) {
    // Cheap pre-filter on the one-way sentinel, so the fact queries below only
    // ever run for rows that could plausibly be deleted.
    if (business.owner_email !== createPendingOwnerEmail(business.id)) {
      result.skipped.push({ id: business.id, reason: "owner_claimed" });
      continue;
    }

    if (result.deleted.length >= maxDeletes) {
      result.cappedAtLimit = true;
      break;
    }

    try {
      const facts = await loadFacts(business.id, db);
      const verdict = classifyAbandonedSignup({ business, ...facts }, now());

      if (!verdict.deletable) {
        result.skipped.push({ id: business.id, reason: verdict.reason });
        continue;
      }

      if (!dryRun) {
        // Draft first: it is the row the cascade cannot reach, so doing it
        // second would strand the customer's personal data if the business
        // delete threw in between.
        await dropDraft(business.id, db);
        await dropBusiness(business.id, db);
      }

      // Logged because the row is about to leave every fleet view, and
      // deliberately NOT into `system_logs`: that table cascades with the
      // business, so an audit trail written there would delete itself.
      logger.info("abandoned-signup-cleanup: deleted never-paid signup", {
        businessId: business.id,
        name: business.name,
        createdAt: business.created_at,
        dryRun
      });
      result.deleted.push({
        id: business.id,
        name: business.name,
        createdAt: business.created_at
      });
    } catch (err) {
      // One unreadable or half-deleted row must not stop the sweep.
      const message = err instanceof Error ? err.message : String(err);
      logger.error("abandoned-signup-cleanup: row failed", {
        businessId: business.id,
        message
      });
      result.errors.push({ businessId: business.id, message });
    }
  }

  return result;
}
