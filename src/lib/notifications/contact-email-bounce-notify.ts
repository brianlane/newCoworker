/**
 * Tell the tenant when an email their AI coworker sent to a CONTACT bounced.
 *
 * Until 2026-09-04 a delivery failure went one place: the admin `system_logs`
 * feed, at level `error`, next to expired API keys. That is the right place
 * for a bounced OWNER alert (the owner's own channel is dying, and HQ is who
 * can call them about it). It is the wrong place for a bounced email to a
 * LEAD: the lead typed the address, the tenant is the only one who can reach
 * them another way, and HQ cannot act on it at all. The motivating case is
 * in the template module next door (KYP / Vantage Flow Media, 2026-09-03: a
 * booking confirmation to a dead work address, surfaced nowhere the tenant
 * looks, while the lead's working phone and form email sat on the contact).
 *
 * Which sends count as customer-facing is decided HERE by `email_log.source`
 * (see {@link isCustomerFacingEmailSource}), so the webhook stays a thin
 * dispatcher and the rule has one home.
 *
 * Best-effort BY CONTRACT: the receipt has already been written; nothing in
 * here may throw back into the webhook, because a non-2xx there makes Resend
 * retry and eventually disable the endpoint.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { hasRecentNotificationForContact } from "@/lib/db/notifications";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { escapeIlike, type EmailDeliveryStatus } from "@/lib/email/delivery";
import { buildContactEmailBounceAlert } from "@/lib/email/templates/contact-email-bounce-alert";
import { emailContactKey, isDialableContactKey } from "../../../supabase/functions/_shared/contact_key";
import { logger } from "@/lib/logger";

type ServiceClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** The `notifications.kind` these alerts are written under. */
const CONTACT_EMAIL_BOUNCE_KIND = "contact_email_bounce";

/**
 * At most one alert per contact per day. A flow that emails the same dead
 * address from two steps (confirmation, then reminder) is one fact for the
 * owner, not two pages; the dispatcher's own 30-minute duplicate gate is too
 * short for steps that are hours apart.
 */
const CONTACT_EMAIL_BOUNCE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * `email_log.source` values that mean "the AI coworker (or the owner, by
 * hand) wrote to a contact". A bounce on one of these is the tenant's to act
 * on and is alerted to them.
 *
 * Deliberately ABSENT:
 *   - `notification`: a platform alert TO the owner. A bounce there means the
 *     owner's channel is dying, which is HQ's problem (call them), so it stays
 *     an admin error and is never echoed back to the address that bounced.
 *   - `owner_mailbox`: mixed traffic through the owner's own Gmail/Outlook,
 *     which is also where HQ's cold-outreach pitches leave from. Those are
 *     retired automatically on bounce (src/lib/outreach/bounce.ts), and
 *     paging the owner about a pitch the system already stopped following up
 *     would be a to-do that is already done.
 *   - the inbound sources (`email_trigger`, `tenant_mailbox_inbound`), which
 *     never produce a receipt.
 */
const CUSTOMER_FACING_EMAIL_SOURCES: ReadonlySet<string> = new Set([
  "ai_flow",
  "tenant_mailbox_outbound",
  "dashboard_chat",
  "sms_assistant",
  "voice_assistant",
  "slack_assistant",
  "telegram_assistant",
  "teams_assistant",
  "google_chat_assistant",
  "email_coworker",
  "booking_reminder",
  "owner_manual"
]);

export function isCustomerFacingEmailSource(source: string | null | undefined): boolean {
  return typeof source === "string" && CUSTOMER_FACING_EMAIL_SOURCES.has(source);
}

type ContactEmailBounceInput = {
  businessId: string;
  /** The email_log row the receipt landed on. */
  emailLogId: string;
  /** The address that rejected the mail. */
  address: string;
  subject: string | null;
  status: EmailDeliveryStatus;
  errorCode: string | null;
  /** The AiFlow run that sent it, when a flow did; its context knows the lead's phone. */
  runId: string | null;
  flowId: string | null;
};

type ContactEmailBounceOutcome =
  /** At least one channel (the dashboard counts) accepted the alert. */
  | "alerted"
  /** An alert about this contact went out inside the throttle window. */
  | "alerted_earlier"
  /** The dispatcher ran and no channel accepted it. */
  | "not_delivered"
  /** Something threw; logged, never rethrown. */
  | "failed";

export type ContactEmailBounceResult = {
  outcome: ContactEmailBounceOutcome;
  /** The contact's phone when one was found, for the admin log payload. */
  contactE164: string | null;
};

type ContactEmailBounceDeps = {
  client?: ServiceClient;
  dispatch?: typeof dispatchUrgentNotification;
  hasRecent?: typeof hasRecentNotificationForContact;
};

type ContactRow = {
  customer_e164: string | null;
  display_name: string | null;
  email: string | null;
};

type FoundContact = {
  /** A dialable number for the person, from the contact row or the run. */
  phone: string | null;
  name: string | null;
  /** The contact row's email, whatever it is; compared to the address by the caller. */
  email: string | null;
};

/**
 * Phones an AiFlow run knows the lead by, in the order the engine trusts
 * them: the extracted lead phone first, then the raw trigger fields.
 */
function runPhoneCandidates(context: unknown): string[] {
  const ctx = (context ?? {}) as {
    vars?: Record<string, unknown>;
    trigger?: Record<string, unknown>;
  };
  const raw = [
    ctx.vars?.lead_phone,
    ctx.vars?.customer_phone,
    ctx.trigger?.phone_number,
    ctx.trigger?.from
  ];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Who the bounced address belongs to, phone-first because the phone is the
 * way the owner will actually reach them.
 *
 * Three lookups, each only when the one before found nothing:
 *   1. a contact whose `email` IS the address (the ordinary case);
 *   2. an email-keyed contact (`customer_e164 = 'email:<addr>'`), which the
 *      email coworker files for correspondents with no number;
 *   3. the sending run's context, whose `lead_phone` is how the motivating
 *      case resolved: the lead's contact carried the FORM email, and the
 *      booking used a different one, so neither address lookup could match.
 *      The phone then finds the contact row (alias-aware), and stands on
 *      its own when there is none.
 */
async function findBouncedContact(
  db: ServiceClient,
  businessId: string,
  address: string,
  runId: string | null
): Promise<FoundContact | null> {
  const columns = "customer_e164, display_name, email";
  const { data: byEmail } = await db
    .from("contacts")
    .select(columns)
    .eq("business_id", businessId)
    .ilike("email", escapeIlike(address))
    .order("updated_at", { ascending: false })
    .limit(1);
  let row = ((byEmail ?? []) as ContactRow[])[0] ?? null;

  if (!row) {
    const key = emailContactKey(address);
    if (key) {
      const { data: byKey } = await db
        .from("contacts")
        .select(columns)
        .eq("business_id", businessId)
        .eq("customer_e164", key)
        .limit(1);
      row = ((byKey ?? []) as ContactRow[])[0] ?? null;
    }
  }

  if (row) {
    return {
      phone: isDialableContactKey(row.customer_e164) ? row.customer_e164 : null,
      name: row.display_name?.trim() || null,
      email: row.email?.trim() || null
    };
  }

  if (!runId) return null;
  const { data: run } = await db
    .from("ai_flow_runs")
    .select("context")
    .eq("id", runId)
    .eq("business_id", businessId)
    .maybeSingle();
  const phone = runPhoneCandidates((run as { context?: unknown } | null)?.context).find((p) =>
    isDialableContactKey(p.trim())
  );
  if (!phone) return null;
  const e164 = phone.trim();

  const { data: byPhone } = await db
    .from("contacts")
    .select(columns)
    .eq("business_id", businessId)
    .or(`customer_e164.eq.${e164},alias_e164s.cs.{${e164}}`)
    .limit(5);
  const rows = (byPhone ?? []) as ContactRow[];
  // The exact match outranks an alias hit, same rule as the booking alert.
  const match = rows.find((r) => r.customer_e164 === e164) ?? rows[0] ?? null;
  return {
    phone: e164,
    name: match?.display_name?.trim() || null,
    email: match?.email?.trim() || null
  };
}

export async function notifyContactEmailBounce(
  input: ContactEmailBounceInput,
  deps: ContactEmailBounceDeps = {}
): Promise<ContactEmailBounceResult> {
  let contactE164: string | null = null;
  try {
    const db = deps.client ?? (await createSupabaseServiceClient());
    const dispatch = deps.dispatch ?? dispatchUrgentNotification;
    const hasRecent = deps.hasRecent ?? hasRecentNotificationForContact;

    const found = await findBouncedContact(db, input.businessId, input.address, input.runId);
    contactE164 = found?.phone ?? null;

    if (contactE164) {
      // Fail toward delivering: a throttle read error must not eat the alert.
      try {
        if (
          await hasRecent(
            input.businessId,
            CONTACT_EMAIL_BOUNCE_KIND,
            contactE164,
            CONTACT_EMAIL_BOUNCE_THROTTLE_MS,
            db
          )
        ) {
          return { outcome: "alerted_earlier", contactE164 };
        }
      } catch (err) {
        logger.warn("contact-email-bounce: throttle check failed; delivering", {
          businessId: input.businessId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Only a DIFFERENT address is worth suggesting; the same one just bounced.
    const otherEmail =
      found?.email && found.email.toLowerCase() !== input.address.toLowerCase()
        ? found.email
        : null;

    const copyFor = (locale: Parameters<typeof buildContactEmailBounceAlert>[0]["locale"]) =>
      buildContactEmailBounceAlert({
        status: input.status,
        errorCode: input.errorCode,
        contactName: found?.name ?? input.address,
        address: input.address,
        emailSubject: input.subject,
        phone: contactE164,
        otherEmail,
        locale
      });
    // English for the dashboard row and the SMS: neither resolves a locale.
    const base = copyFor(undefined);

    const { results } = await dispatch({
      businessId: input.businessId,
      kind: CONTACT_EMAIL_BOUNCE_KIND,
      summary: base.summaryLine,
      smsBody: base.smsBody,
      ctaPath: base.ctaPath,
      // The email's copy comes from the template and only from the template
      // (explicit subject/body fields would outrank it in the dispatcher).
      emailTemplate: (locale) => {
        const localized = copyFor(locale);
        return {
          subject: localized.subject,
          heading: localized.heading,
          body: localized.body,
          ctaLabel: localized.ctaLabel,
          ctaPath: localized.ctaPath
        };
      },
      // Routes the page to whoever owns the contact, falling back to the
      // owner. Null when we never found a phone, which keeps it owner-addressed.
      contactE164,
      payload: {
        email_log_id: input.emailLogId,
        address: input.address,
        email_subject: input.subject,
        delivery_status: input.status,
        delivery_error_code: input.errorCode,
        run_id: input.runId,
        flow_id: input.flowId,
        other_email: otherEmail,
        // `to_e164` is what hasRecentNotificationForContact keys the throttle on.
        ...(contactE164 ? { to_e164: contactE164 } : {})
      }
    });

    const delivered = results.some((r) => r.status === "sent");
    return { outcome: delivered ? "alerted" : "not_delivered", contactE164 };
  } catch (err) {
    logger.warn("contact-email-bounce: alert failed (receipt already recorded)", {
      businessId: input.businessId,
      emailLogId: input.emailLogId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { outcome: "failed", contactE164 };
  }
}
