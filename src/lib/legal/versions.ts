/**
 * Single source of truth for the public legal documents' versions. The
 * effective-date string IS the version identifier: /terms and /privacy
 * render it, and terms_acceptances rows pin it at click time, so "which
 * text did this person accept" always has exactly one answer.
 *
 * Bumping a date here does two things at once: the public page shows the
 * new effective date, and the dashboard acceptance gate re-raises for
 * every signed-in user whose newest acceptance row pins an older value
 * (see src/lib/legal/acceptance.ts and TermsAcceptanceGate). That makes a
 * version bump a deliberate act with a visible consequence, which is the
 * mechanism Terms section 17 promises.
 */
export const TERMS_EFFECTIVE_DATE = "August 1, 2026";
export const PRIVACY_EFFECTIVE_DATE = "August 1, 2026";
