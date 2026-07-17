/**
 * Resolve the owner-facing provisioning notification email.
 *
 * Mirrors the phone path in orchestrate.ts: input override first, then the
 * stored business row — but never ADMIN_EMAIL (that address is for admin
 * login / ops alerts, not customer-facing "your coworker is live" mail).
 */

/** Stripe-first onboarding rows use this sentinel until checkout finalizes. */
export function isPendingOwnerEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@onboarding.local");
}

/**
 * Returns a reachable owner email, or null when none is on file yet.
 * `inputOverride` wins over `storedOwnerEmail` (same precedence as phone).
 */
export function resolveOwnerNotifyEmail(
  inputOverride: string | null | undefined,
  storedOwnerEmail: string | null | undefined
): string | null {
  const candidate = (inputOverride ?? storedOwnerEmail)?.trim();
  if (!candidate || isPendingOwnerEmail(candidate)) return null;
  return candidate;
}
