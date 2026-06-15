import { Resend } from "resend";

export type SendOwnerEmailOptions = {
  /**
   * URL the recipient can hit to one-click-unsubscribe. When set we attach
   * the RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers so
   * Gmail/Apple Mail render their native "Unsubscribe" UI, and append a
   * footer to the plain-text body so older clients also expose it.
   */
  unsubscribeUrl?: string | null;
  /** Custom Resend constructor (tests). */
  resendCtor?: typeof Resend;
  /** From override (defaults to MAILER_EMAIL env). */
  from?: string;
  /** Plain-text body. Required. */
  text?: string;
  /** Optional HTML body. If both are supplied, both are sent. */
  html?: string;
  /** Optional cc recipients (already normalized to valid addresses). */
  cc?: string[];
  /** Optional bcc recipients (already normalized to valid addresses). */
  bcc?: string[];
};

const DEFAULT_FROM = "New Coworker <contact@newcoworker.com>";

function resolveFrom(opts: SendOwnerEmailOptions): string {
  return opts.from ?? process.env.MAILER_EMAIL ?? DEFAULT_FROM;
}

function appendUnsubscribeFooter(text: string, url: string): string {
  return `${text}\n\n---\nDon't want these alerts? Unsubscribe with one click: ${url}`;
}

/**
 * Send an owner-facing email via Resend.
 *
 * Two call shapes are supported for backwards compatibility:
 *   sendOwnerEmail(apiKey, to, subject, "body text")
 *   sendOwnerEmail(apiKey, to, subject, "body text", from, ResendCtor)
 *
 * New code should pass an options bag instead:
 *   sendOwnerEmail(apiKey, to, subject, { text, unsubscribeUrl, html?, ... })
 *
 * The legacy positional form still works because the 4th argument is
 * pattern-matched: a string is treated as the body text, an object is
 * treated as the options bag.
 */
export async function sendOwnerEmail(
  apiKey: string,
  to: string,
  subject: string,
  textOrOptions: string | SendOwnerEmailOptions,
  legacyFrom?: string,
  legacyResendCtor: typeof Resend = Resend
): Promise<string | null> {
  const opts: SendOwnerEmailOptions =
    typeof textOrOptions === "string"
      ? {
          text: textOrOptions,
          from: legacyFrom,
          resendCtor: legacyResendCtor
        }
      : textOrOptions;

  // Fallback chain: explicit options.resendCtor → legacy positional 6th arg →
  // the real Resend class (legacyResendCtor's parameter default).
  const ctor = opts.resendCtor ?? legacyResendCtor;
  const resend = new ctor(apiKey);
  const replyTo = process.env.CONTACT_EMAIL;

  const text = opts.text ?? "";
  const finalText = opts.unsubscribeUrl
    ? appendUnsubscribeFooter(text, opts.unsubscribeUrl)
    : text;

  const headers: Record<string, string> = {};
  if (opts.unsubscribeUrl) {
    // Per RFC 8058: the `<URL>` form lets MUAs render a one-click unsubscribe
    // button. The `List-Unsubscribe-Post` header is what flips Gmail's UI from
    // "Unsubscribe" (opens the URL in a tab) to a one-click confirmation that
    // POSTs to the URL with `List-Unsubscribe=One-Click` in the body.
    headers["List-Unsubscribe"] = `<${opts.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const result = await resend.emails.send({
    from: resolveFrom(opts),
    to,
    subject,
    text: finalText,
    ...(opts.html ? { html: opts.html } : {}),
    ...(opts.cc && opts.cc.length > 0 ? { cc: opts.cc } : {}),
    ...(opts.bcc && opts.bcc.length > 0 ? { bcc: opts.bcc } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {})
  });

  return result.data?.id ?? null;
}
