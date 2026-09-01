/**
 * Prospecting, bounce retirement: take a dead address off the day-5 nudge
 * queue the moment the receipt lands.
 *
 * Until 2026-08-28 a bounced pitch stayed at `sent`. The sweep's one
 * follow-up is keyed on that status, so five days later we re-mailed a
 * mailbox that had already refused us: bad for the recipient, bad for the
 * sending domain, and it burned the one follow-up the prospect will ever
 * get. A one-shot repaired the rows that had already bounced. This module
 * is the live path, so the next bounce does not wait for an operator.
 *
 * Policy is the one-shot's, not a new one: bounced/failed only (a spam
 * complaint received the mail, and whether to keep talking is an owner
 * call), `sent` -> `failed` with `sent_at` kept so the daily cap still
 * counts the send, skip a row that already replied or already got its
 * nudge. See scripts/oneshot/retire-bounced-outreach-prospects.ts.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listProspectsByEmail, listProspectsByEmailAnyTenant, transitionProspect } from "./db";
import type { EmailDeliveryStatus } from "@/lib/email/delivery";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Receipts that mean the address cannot receive mail. */
const DEAD_ADDRESS_STATUSES: ReadonlySet<EmailDeliveryStatus> = new Set([
  "bounced",
  "failed"
]);

export type OutreachBounceReceipt = {
  to: string;
  subject: string | null;
  status: EmailDeliveryStatus;
  errorCode: string | null;
  errorMessage: string | null;
  occurredAt: string | null;
  /** When known (an attributed receipt). Unattributed searches every tenant. */
  businessId?: string | null;
};

function bounceDetail(input: OutreachBounceReceipt): string {
  return `${input.status}${input.errorCode ? ` (${input.errorCode})` : ""}${
    input.errorMessage ? `: ${input.errorMessage}` : ""
  }`.slice(0, 260);
}

/**
 * A receipt naming a subject must name this pitch's. A subjectless receipt
 * still matches: Resend sometimes omits it, and the address plus send-time
 * check below is the other half of the match.
 */
function bounceSubjectMatchesPitch(
  pitchSubject: string | null,
  receiptSubject: string | null
): boolean {
  if (!receiptSubject || !pitchSubject) return true;
  return receiptSubject === pitchSubject;
}

/**
 * Retire every `sent` prospect this bounce belongs to. Returns how many
 * rows actually moved, so a retry (the webhook already recorded the bounce
 * on email_log) converges to zero.
 *
 * Never throws to the caller on a no-op: a bounce of owner-alert mail, or
 * of a prospect that already left `sent`, is the common case and must not
 * fail the delivery webhook.
 */
export async function retireProspectsOnBounce(
  input: OutreachBounceReceipt,
  client?: SupabaseClient
): Promise<number> {
  if (!DEAD_ADDRESS_STATUSES.has(input.status)) return 0;
  const to = input.to.trim();
  if (!to) return 0;

  const db = client ?? (await createSupabaseServiceClient());
  const prospects = input.businessId
    ? await listProspectsByEmail(input.businessId, to, db)
    : await listProspectsByEmailAnyTenant(to, db);

  const bounceMs = input.occurredAt ? Date.parse(input.occurredAt) : NaN;
  const detail = `pitch bounced, follow-up cancelled: ${bounceDetail(input)}`;
  let retired = 0;

  for (const prospect of prospects) {
    if (prospect.status !== "sent") continue;
    if (prospect.replied_at) continue;
    // The one follow-up already went out. Nothing left to cancel, and
    // treating this like a first-pitch bounce would erase a real send.
    if (prospect.nudged_at) continue;
    if (!bounceSubjectMatchesPitch(prospect.pitch_subject, input.subject)) continue;
    const sentMs = prospect.sent_at ? Date.parse(prospect.sent_at) : NaN;
    // An older bounce of unrelated mail to the same address must not retire
    // a later pitch that delivered fine.
    if (
      Number.isFinite(sentMs) &&
      Number.isFinite(bounceMs) &&
      bounceMs < sentMs
    ) {
      continue;
    }

    const moved = await transitionProspect(
      prospect.business_id,
      prospect.id,
      "sent",
      { status: "failed", status_detail: detail },
      db
    );
    if (moved) retired += 1;
  }
  return retired;
}
