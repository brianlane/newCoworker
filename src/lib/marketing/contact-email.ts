/**
 * The one canonical public contact address.
 *
 * Sibling of `site-url.ts`, for the same reason and under the same rule: a
 * constant that describes the deployment gets exactly one home. See the
 * README, "A constant that describes the deployment gets exactly one home".
 *
 * This string was previously copy-pasted as `process.env.CONTACT_EMAIL ??
 * "team@newcoworker.com"` into seven files: the privacy, data-deletion,
 * terms, vulnerability-disclosure, and pricing pages, the contact-form API
 * route, and `/.well-known/security.txt`, plus an eighth bare copy inside
 * the default From address in `src/lib/email/client.ts`. PR #1074 is the
 * worked example of why that hurts: security.txt shipped with the address
 * hardcoded while the disclosure policy page it links to read the env var,
 * so the two surfaces disagreed whenever `CONTACT_EMAIL` was set, and only
 * a review bot caught it.
 *
 * The hardcoded fallback had also gone stale on its own. Deployment sets
 * `CONTACT_EMAIL=contact@newcoworker.com` (and `MAILER_EMAIL` sends from the
 * same mailbox), so every one of those seven fallbacks named an address the
 * site does not actually use. The fallback now matches the deployment.
 *
 * Not to be confused with `OPS_NOTIFICATION_EMAIL`
 * (`src/lib/email/templates/ops-vps-deletion.ts`), which is the internal ops
 * inbox at `team@newcoworker.com`. Two different addresses, two homes, and
 * `tests/contact-email.test.ts` guards only this one.
 *
 * Edge functions under `supabase/functions/` read `CONTACT_EMAIL` from
 * `Deno.env` and cannot import this module; they are configured through
 * Supabase secrets and are outside the guard.
 */

/**
 * The address itself, for the rare caller that needs the literal rather than
 * the environment-aware value (the default From line in the mail client, so
 * that the sender identity never follows a reconfigured inbox onto a domain
 * Resend has not verified). Prefer `contactEmail()`.
 */
export const CONTACT_EMAIL = "contact@newcoworker.com";

/**
 * The public contact address for this deployment.
 *
 * A function, not a constant: the value is read per request so that staging
 * and preview deployments can point it elsewhere without a rebuild.
 */
export function contactEmail(): string {
  return process.env.CONTACT_EMAIL ?? CONTACT_EMAIL;
}
