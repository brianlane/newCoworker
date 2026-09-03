/**
 * Operator-facing copy for an email delivery failure.
 *
 * Resend's bounce body tells the operator to "remove the recipient from your
 * mailing list". That was true when a bounced outreach pitch stayed `sent`
 * and the day-5 nudge re-mailed it. The webhook now retires the prospect, so
 * quoting Resend's advice on the admin System Errors card reads as a to-do
 * that is already done. Keep the vendor text in payload.errorMessage; the
 * row message says what WE did.
 */
import type { EmailDeliveryStatus } from "@/lib/email/delivery";

export type EmailDeliveryFailedLogInput = {
  status: EmailDeliveryStatus;
  to: string | null;
  /** How many outreach_prospects rows this receipt moved off `sent`. */
  retiredCount: number;
  /** True when the receipt matched no email_log row. */
  unattributed?: boolean;
};

export function formatEmailDeliveryFailedLogMessage(
  input: EmailDeliveryFailedLogInput
): string {
  const toBit = input.to ? ` to ${input.to}` : "";
  const parts = [`Email was not delivered (${input.status})${toBit}.`];
  if (input.retiredCount > 0) {
    parts.push(
      "Outreach follow-up cancelled; this address will not be mailed again."
    );
  }
  if (input.unattributed) {
    parts.push("Matched no logged send.");
  }
  return parts.join(" ");
}
