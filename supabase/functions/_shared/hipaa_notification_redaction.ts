/**
 * PHI-free owner notifications for HIPAA tenants.
 *
 * An urgent alert normally carries the thing it is alerting about: the
 * summary, and since PR #1272 what the lead actually said. That is the right
 * product behavior and it is exactly wrong for a covered entity, because the
 * alert leaves our infrastructure through vendors that cannot hold PHI:
 *
 *   - Resend (owner email) publishes no BAA and its DPA never mentions HIPAA.
 *   - Meta (WhatsApp) and Slack are third-party integrations with no BAA here.
 *   - Telnyx carries SMS under the conduit exception, which is a narrow
 *     doctrine about mere transmission; deliberately putting clinical detail
 *     into the message body is not what it is for.
 *
 * So in HIPAA mode the notification becomes a doorbell rather than a letter:
 * "something needs you, open the dashboard". The owner still learns
 * immediately that there is something to act on, and the content is read back
 * over an authenticated session against our own store (central Supabase under
 * its HIPAA add-on, or the tenant's own box once residency is on).
 *
 * WHAT IS DELIBERATELY NOT REDACTED: the `notifications` history row. Its
 * `summary` and `payload` keep the real content, because that row is the
 * dashboard's copy of the alert and lives in a store the BAA covers. Redacting
 * it would blind the owner to their own data without removing a single
 * third-party disclosure. The boundary is "leaving for a vendor", not
 * "written down".
 *
 * LIVES IN _shared BECAUSE THERE ARE TWO DISPATCHERS. The Node one
 * (src/lib/notifications/dispatch.ts) and the Deno Edge mirror
 * (supabase/functions/notifications/index.ts) both build their own channel
 * bodies. A lockstep copy of a compliance rule is a leak waiting for the day
 * someone edits one file; both import this instead.
 */

/** Locales the owner-facing copy is written for. Mirrors AppLocale. */
export type PhiFreeLocale = "en" | "es";

const COPY: Record<PhiFreeLocale, { subject: string; heading: string; body: string; sms: string }> = {
  en: {
    subject: "New Coworker: something needs your attention",
    heading: "Something needs your attention",
    body: "Your AI coworker flagged something that needs you. Details are in your dashboard: this alert deliberately carries no patient information.",
    sms: "New Coworker Alert: something needs your attention. Details:"
  },
  es: {
    subject: "New Coworker: algo necesita tu atención",
    heading: "Algo necesita tu atención",
    body: "Tu AI coworker marcó algo que necesita tu atención. Los detalles están en tu panel: esta alerta no incluye información del paciente a propósito.",
    sms: "Alerta de New Coworker: algo necesita tu atención. Detalles:"
  }
};

export type PhiFreeCopy = {
  /** Outbound-only summary. The history row keeps the real one. */
  summary: string;
  emailSubject: string;
  emailHeading: string;
  emailBody: string;
  smsBody: string;
};

/**
 * The content every channel uses in place of the caller's, pointing at
 * `dashboardUrl` for the real thing.
 */
export function phiFreeNotificationCopy(
  dashboardUrl: string,
  locale: PhiFreeLocale = "en"
): PhiFreeCopy {
  const copy = COPY[locale] ?? COPY.en;
  return {
    summary: copy.heading,
    emailSubject: copy.subject,
    emailHeading: copy.heading,
    emailBody: `${copy.body}\n\nView details: ${dashboardUrl}`,
    smsBody: `${copy.sms} ${dashboardUrl}`
  };
}

/**
 * Whether this dispatch must go out content-free.
 *
 * FAILS CLOSED. `hipaaMode` is undefined when the business row could not be
 * read, and an unknown tenant is treated as a HIPAA tenant: a PHI disclosure
 * is a reportable breach with a 60-day notification duty and cannot be taken
 * back, while a generic alert still tells the owner to go look. The read
 * failure is already logged loudly by the caller, and a blip costs
 * convenience, never the alert itself.
 */
export function notificationMustBePhiFree(hipaaMode: boolean | undefined): boolean {
  return hipaaMode !== false;
}
