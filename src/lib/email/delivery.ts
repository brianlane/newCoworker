/**
 * Resend delivery receipts for outbound mail.
 *
 * `sendOwnerEmail` returning an id means Resend ACCEPTED the message. It says
 * nothing about whether it arrived, which is the same gap WhatsApp had until
 * PR #1609: an accepted-then-bounced email and a delivered one were
 * indistinguishable in our own data. This module is the email half of that
 * fix, and it deliberately mirrors src/lib/messenger/db.ts so the two receipt
 * paths can be read against each other.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * The delivery states we model, out of Resend's larger event set.
 *
 * `opened` and `clicked` are deliberately absent: they are engagement, not
 * delivery, they require tracking pixels we do not set, and folding them into
 * this column would mean an unopened-but-delivered email looked worse than a
 * delivered one.
 */
export type EmailDeliveryStatus =
  | "sent"
  | "delayed"
  | "delivered"
  | "complained"
  | "bounced"
  | "failed";

/**
 * Receipts arrive out of order, so a raw last-write-wins update would report
 * a delivered message as merely sent. Rank orders the progression and the
 * writer refuses to move backwards.
 *
 * The ordering is not "how bad is it", it is "which statement about this
 * message survives when two receipts disagree":
 *
 *   sent(1)       we handed it over. The weakest claim, and the one every
 *                 other receipt should be able to replace.
 *   delayed(2)    the receiving server deferred it. Beats `sent` (it is news)
 *                 but must LOSE to `delivered`, because the common sequence
 *                 is delayed-then-delivered and a recovered email that stays
 *                 stuck on "delayed" would read as a failure it is not.
 *   delivered(3)  the receiving server accepted it.
 *   complained(4) it arrived and the recipient marked it spam. Outranks
 *                 `delivered` because it is strictly later information about
 *                 the same message, and it is a deliverability emergency.
 *   bounced(5)    it never arrived. In practice exclusive with `delivered`,
 *                 ranked above it so that no late `sent`/`delivered` receipt
 *                 can ever mask the one state this feature exists to surface.
 *   failed(6)     Resend could not send it at all. Terminal and rare; ranked
 *                 top so it is never masked either.
 */
const DELIVERY_STATUS_RANK: Record<EmailDeliveryStatus, number> = {
  sent: 1,
  delayed: 2,
  delivered: 3,
  complained: 4,
  bounced: 5,
  failed: 6
};

/** The same states as a list, for building the update's rank predicate. */
const DELIVERY_STATUS_ORDER = Object.keys(DELIVERY_STATUS_RANK) as EmailDeliveryStatus[];

/**
 * States that mean the owner did not read this email and will not, so a
 * caller can decide whether to raise it. `complained` counts: the mail
 * technically landed, but a spam complaint poisons the sending domain for
 * every other tenant, so it has to surface just as loudly as a bounce.
 */
export const EMAIL_DELIVERY_FAILURES: readonly EmailDeliveryStatus[] = [
  "bounced",
  "complained",
  "failed"
];

export function isEmailDeliveryFailure(status: EmailDeliveryStatus): boolean {
  return EMAIL_DELIVERY_FAILURES.includes(status);
}

export function emailDeliveryOutranks(
  next: EmailDeliveryStatus,
  current: EmailDeliveryStatus | null | undefined
): boolean {
  if (!current) return true;
  return DELIVERY_STATUS_RANK[next] > DELIVERY_STATUS_RANK[current];
}

/**
 * Resend event type → the status it implies, or null for an event this
 * column does not model.
 *
 * Unknown types are not errors. Resend adds event types over time, and a
 * `email.scheduled` we have never seen should be ignored rather than logged
 * as a fault (the Meta receipt path learned the same lesson with "deleted").
 */
export function resendEventToStatus(type: string): EmailDeliveryStatus | null {
  switch (type) {
    case "email.sent":
      return "sent";
    case "email.delivery_delayed":
      return "delayed";
    case "email.delivered":
      return "delivered";
    case "email.complained":
      return "complained";
    case "email.bounced":
      return "bounced";
    case "email.failed":
      return "failed";
    default:
      return null;
  }
}

export type ApplyEmailDeliveryInput = {
  /**
   * Resend's message id, matched against email_log.provider_message_id.
   * Scoped by business below, so one tenant's receipt can never rewrite
   * another's row even if a provider id somehow collided.
   */
  providerMessageId: string;
  status: EmailDeliveryStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  timestamp?: string | null;
};

export type ApplyEmailDeliveryOutcome = "applied" | "stale" | "not_found";

/**
 * Apply a Resend receipt to the outbound row it belongs to, keyed by the
 * provider message id the send stored.
 *
 * `not_found` is expected and benign. Resend fires receipts for every message
 * on the account, including ones written before this feature existed and ones
 * sent by callers that do not log to email_log at all, so the webhook must
 * treat a miss as routine rather than as an error.
 *
 * Deliberately NOT scoped by business_id. The provider message id is
 * globally unique within the Resend account, and the webhook has no tenant to
 * scope by: the whole point of the lookup is to discover which tenant the
 * receipt belongs to. The row it finds carries the business_id the caller
 * then reports on.
 */
export async function applyEmailDeliveryStatus(
  input: ApplyEmailDeliveryInput,
  client?: SupabaseClient
): Promise<{ outcome: ApplyEmailDeliveryOutcome; businessId: string | null }> {
  const db = client ?? (await createSupabaseServiceClient());
  // Newest match, NOT maybeSingle. provider_message_id looks unique and is
  // not: a scan of live rows on 2026-08-26 found 7 duplicated ids in a
  // 1000-row sample (Gmail-style ids recorded on more than one row by the
  // owner-mailbox paths). maybeSingle THROWS on a second row, which would
  // turn a receipt for an unrelated tenant's mail into a swallowed error and
  // lose this one silently. Newest-first is also the right tiebreak on the
  // merits: a receipt follows its own send by seconds.
  //
  // Outbound only, because a receipt is only ever about a message we sent,
  // and that alone removes the inbound/outbound pairs that make up most of
  // the observed duplication.
  const { data: matches, error: readError } = await db
    .from("email_log")
    .select("id, business_id, delivery_status")
    .eq("provider_message_id", input.providerMessageId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);
  if (readError) throw new Error(`applyEmailDeliveryStatus: ${readError.message}`);
  const existing = (matches ?? [])[0];
  if (!existing) return { outcome: "not_found", businessId: null };
  const row = existing as {
    id: string;
    business_id: string;
    delivery_status: EmailDeliveryStatus | null;
  };
  // Fast path only: skips a pointless write. It is NOT what makes the
  // ordering safe, because the row can change between this read and the
  // update below. The predicate on the update is what actually enforces it.
  if (!emailDeliveryOutranks(input.status, row.delivery_status)) {
    return { outcome: "stale", businessId: row.business_id };
  }

  // Resend fires sent/delivered within milliseconds, and separate webhook
  // POSTs run as separate concurrent invocations. Two of them reading the
  // same snapshot would both pass the check above, and last-write-wins could
  // then drop a `delivered` back to `sent`, or bury a `bounced`. Re-checking
  // the rank in the UPDATE's own WHERE clause closes that: Postgres evaluates
  // it under the row lock, so the loser of a race matches zero rows instead
  // of overwriting the winner. (Bugbot caught exactly this on the WhatsApp
  // receipt path, PR #1609.)
  const outranked = DELIVERY_STATUS_ORDER.filter(
    (candidate) => DELIVERY_STATUS_RANK[candidate] < DELIVERY_STATUS_RANK[input.status]
  );
  const rankGuard =
    outranked.length > 0
      ? `delivery_status.is.null,delivery_status.in.(${outranked.join(",")})`
      : "delivery_status.is.null";

  const failure = isEmailDeliveryFailure(input.status);
  const { data: updated, error } = await db
    .from("email_log")
    .update({
      delivery_status: input.status,
      // Only a failure carries these, and a later failure must be able to
      // replace an earlier one's reason rather than append to it.
      delivery_error_code: failure ? (input.errorCode ?? null) : null,
      delivery_error_message: failure ? (input.errorMessage ?? null) : null,
      delivery_updated_at: input.timestamp ?? new Date().toISOString()
    })
    .eq("id", row.id)
    .or(rankGuard)
    // A PostgREST update matching zero rows is NOT an error, so the returned
    // rows are the only way to tell "written" from "lost the race".
    .select("id");
  if (error) throw new Error(`applyEmailDeliveryStatus: ${error.message}`);
  return {
    outcome: (updated ?? []).length > 0 ? "applied" : "stale",
    businessId: row.business_id
  };
}
