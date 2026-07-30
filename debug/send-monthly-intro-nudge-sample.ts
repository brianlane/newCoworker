/**
 * Send a sample month-to-month intro nudge (Shape B) to the ops/admin inbox
 * so an operator can visually verify the email before relying on the cron.
 *
 * Usage:
 *   tsx debug/send-monthly-intro-nudge-sample.ts [toEmail]
 *
 * Default recipient: OPS_NOTIFICATION_EMAIL, else team@newcoworker.com.
 * Sends one Standard sample and one Starter sample.
 */
import { loadEnv } from "./_shared.ts";
import { sendOwnerEmail } from "../src/lib/email/client.ts";
import { buildMonthlyIntroNudgeEmail } from "../src/lib/email/templates/monthly-intro-nudge.ts";
import { opsNotificationEmail } from "../src/lib/email/templates/ops-vps-deletion.ts";

loadEnv();

const to = (process.argv[2] ?? opsNotificationEmail()).trim();
const apiKey = process.env.RESEND_API_KEY?.trim();
const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.newcoworker.com").replace(
  /\/$/,
  ""
);

if (!apiKey) {
  console.error("RESEND_API_KEY is missing from .env");
  process.exit(1);
}

const periodEndAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

for (const tier of ["standard", "starter"] as const) {
  const email = buildMonthlyIntroNudgeEmail({
    tier,
    periodEndAt,
    recipientEmail: to,
    siteUrl,
    timeZone: "America/Phoenix",
    locale: "en"
  });
  const subject = `[SAMPLE ${tier}] ${email.subject}`;
  const id = await sendOwnerEmail(apiKey, to, subject, {
    text: email.text,
    html: email.html
  });
  console.log(`${tier}: messageId=${id ?? "(null)"} to=${to} subject=${subject}`);
}
