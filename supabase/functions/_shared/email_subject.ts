/**
 * Email subject sanitizer for the notifications Edge function.
 *
 * Resend rejects any subject containing a newline with a 422
 * validation_error, and alert summaries routinely embed multiline provider
 * errors: the Aug 1 2026 KYP aiflow-failure alert carried a pretty-printed
 * Telnyx JSON body, so the SMS and dashboard channels delivered while the
 * email channel 422'd. Subjects must be one line; the email BODY keeps the
 * full summary.
 *
 * Extracted here (rather than inline in notifications/index.ts) so it sits
 * under the shared unit-test gate like aiflow_failure_alert.ts.
 */

/** Default subject cap: generous for context, far under provider limits. */
export const MAX_SUBJECT_CHARS = 180;

/**
 * Collapse a summary to a single line and cap its length, for use inside an
 * email subject. Whitespace runs (newlines included) become single spaces.
 */
export function oneLineSubject(summary: string, maxChars: number = MAX_SUBJECT_CHARS): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, maxChars);
}
