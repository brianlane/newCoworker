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
 * What the receipt landed on, handed back so the webhook can decide WHO a
 * failure is for. `source` is the load-bearing field: a bounced owner alert
 * (`notification`) is HQ's problem, a bounced booking confirmation to a lead
 * (`tenant_mailbox_outbound`) is the tenant's, and until this was returned
 * the webhook could not tell the two apart.
 */
export type EmailDeliveryMatchedSend = {
  id: string;
  businessId: string;
  source: string | null;
  to: string | null;
  subject: string | null;
  runId: string | null;
  flowId: string | null;
};

export type ApplyEmailDeliveryResult = {
  outcome: ApplyEmailDeliveryOutcome;
  businessId: string | null;
  /** The matched row, on `applied` and `stale`; null on `not_found`. */
  send: EmailDeliveryMatchedSend | null;
};

type MatchedEmailLogRow = {
  id: string;
  business_id: string;
  delivery_status: EmailDeliveryStatus | null;
  source?: string | null;
  to_email?: string | null;
  subject?: string | null;
  run_id?: string | null;
  flow_id?: string | null;
};

const MATCH_COLUMNS = "id, business_id, delivery_status, source, to_email, subject, run_id, flow_id";

function describeSend(row: MatchedEmailLogRow): EmailDeliveryMatchedSend {
  return {
    id: row.id,
    businessId: row.business_id,
    source: row.source ?? null,
    to: row.to_email ?? null,
    subject: row.subject ?? null,
    runId: row.run_id ?? null,
    flowId: row.flow_id ?? null
  };
}

type ReceiptDetail = {
  status: EmailDeliveryStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  timestamp?: string | null;
};

/**
 * Write one receipt onto one matched row, rank-guarded. Shared by the
 * provider-id lookup and the recipient fallback so the two paths cannot
 * drift in how they enforce ordering. `label` prefixes thrown errors so a
 * failure names the lookup that found the row.
 */
async function writeDeliveryStatus(
  db: SupabaseClient,
  row: MatchedEmailLogRow,
  input: ReceiptDetail,
  label: string
): Promise<ApplyEmailDeliveryResult & { outcome: "applied" | "stale"; businessId: string }> {
  const send = describeSend(row);
  // Fast path only: skips a pointless write. It is NOT what makes the
  // ordering safe, because the row can change between this read and the
  // update below. The predicate on the update is what actually enforces it.
  if (!emailDeliveryOutranks(input.status, row.delivery_status)) {
    return { outcome: "stale", businessId: row.business_id, send };
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
  if (error) throw new Error(`${label}: ${error.message}`);
  return {
    outcome: (updated ?? []).length > 0 ? "applied" : "stale",
    businessId: row.business_id,
    send
  };
}

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
): Promise<ApplyEmailDeliveryResult> {
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
    .select(MATCH_COLUMNS)
    .eq("provider_message_id", input.providerMessageId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1);
  if (readError) throw new Error(`applyEmailDeliveryStatus: ${readError.message}`);
  const existing = (matches ?? [])[0];
  if (!existing) return { outcome: "not_found", businessId: null, send: null };
  return writeDeliveryStatus(
    db,
    existing as MatchedEmailLogRow,
    input,
    "applyEmailDeliveryStatus"
  );
}

/**
 * How far back the recipient fallback will look for the send it is a receipt
 * for. Resend retries a transiently-refused message for up to 72 hours before
 * it reports the bounce (the live case that motivated this arrived 38 hours
 * after its send), so the window has to cover that plus margin. It must NOT
 * be unbounded: recipient + subject is a heuristic key, and an old row with
 * the same pair (a re-sent pitch, a recurring report) is likelier to be a
 * different message the further back it sits.
 */
const EMAIL_RECEIPT_RECIPIENT_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/** Escape `%`, `_`, and `\` so an address is an exact ILIKE match, not a pattern. */
export function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export type ApplyEmailDeliveryByRecipientInput = {
  to: string;
  subject: string;
} & ReceiptDetail;

/**
 * Fallback attribution for receipts whose provider id matches nothing: the
 * newest recent outbound row to the same recipient with the same subject.
 *
 * Why this exists: mail can leave through Resend under an id we never see.
 * The live case is HQ's Gmail, whose default send-as identity relays through
 * smtp.resend.com, so an outreach pitch is logged with its GMAIL message id
 * while Resend delivers it under a fresh UUID. Without this, every such
 * bounce surfaces as `email_delivery_failed_unattributed` with no tenant.
 *
 * The key is heuristic, so it is deliberately conservative: exact subject,
 * case-insensitive exact recipient, outbound only, and a bounded recency
 * window. A first pitch and its follow-up nudge share a subject by design;
 * either row names the same tenant and the same conversation, and newest
 * wins, which is the row the receipt most plausibly belongs to.
 */
export async function applyEmailDeliveryStatusByRecipient(
  input: ApplyEmailDeliveryByRecipientInput,
  client?: SupabaseClient
): Promise<ApplyEmailDeliveryResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const cutoff = new Date(Date.now() - EMAIL_RECEIPT_RECIPIENT_WINDOW_MS).toISOString();
  const { data: matches, error: readError } = await db
    .from("email_log")
    .select(MATCH_COLUMNS)
    // ILIKE with a fully escaped pattern: addresses are matched
    // case-insensitively but never treated as wildcards (an `_` in a real
    // localpart must not match a different character).
    .ilike("to_email", escapeIlike(input.to))
    .eq("subject", input.subject)
    .eq("direction", "outbound")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1);
  if (readError) {
    throw new Error(`applyEmailDeliveryStatusByRecipient: ${readError.message}`);
  }
  const existing = (matches ?? [])[0];
  if (!existing) return { outcome: "not_found", businessId: null, send: null };
  return writeDeliveryStatus(
    db,
    existing as MatchedEmailLogRow,
    input,
    "applyEmailDeliveryStatusByRecipient"
  );
}
