/**
 * SLA + dedicated support (enterprise) — the concrete surface behind the
 * pricing-page bullet. Enterprise tenants hold a PERMANENT priority
 * call/video window (see hasPrioritySupportForTier) and see a dedicated
 * support card with the SLA response targets and the operator's dedicated
 * contact channels (env-configured; unset channels simply don't render).
 */

export type EnterpriseSupportContact = {
  email: string | null;
  phone: string | null;
  bookingUrl: string | null;
};

/** Env-configured dedicated contact channels; trimmed, empty → null. */
export function getEnterpriseSupportContact(): EnterpriseSupportContact {
  const clean = (v: string | undefined) => {
    const t = v?.trim() ?? "";
    return t.length > 0 ? t : null;
  };
  return {
    email: clean(process.env.ENTERPRISE_SUPPORT_EMAIL),
    phone: clean(process.env.ENTERPRISE_SUPPORT_PHONE),
    bookingUrl: clean(process.env.ENTERPRISE_SUPPORT_BOOKING_URL)
  };
}

/**
 * The SLA commitments shown on the dashboard card. Copy lives here (not in
 * the component) so ops docs, emails, and the card can never drift apart.
 */
export const ENTERPRISE_SLA_TARGETS: ReadonlyArray<{ label: string; target: string }> = [
  { label: "Critical incident response", target: "Within 1 hour, 24/7" },
  { label: "General support response", target: "Within 4 business hours" },
  { label: "Uptime monitoring", target: "24/7 automated, ops-alerted" },
  { label: "Quarterly strategy review", target: "Scheduled with your account contact" }
];
