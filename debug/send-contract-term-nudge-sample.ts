/**
 * Send a sample pre-term contract rollover nudge (Shape B) to the ops inbox.
 *
 * Usage:
 *   tsx debug/send-contract-term-nudge-sample.ts [toEmail]
 *
 * Default recipient: OPS_NOTIFICATION_EMAIL, else team@newcoworker.com.
 * Sends Standard annual + Starter biennial samples.
 */
import { loadEnv } from "./_shared.ts";
import { sendOwnerEmail } from "../src/lib/email/client.ts";
import { buildContractTermNudgeEmail } from "../src/lib/email/templates/contract-term-nudge.ts";
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

const samples = [
  { tier: "standard" as const, billingPeriod: "annual" as const },
  { tier: "starter" as const, billingPeriod: "biennial" as const }
];

for (const sample of samples) {
  const email = buildContractTermNudgeEmail({
    ...sample,
    periodEndAt,
    recipientEmail: to,
    siteUrl,
    timeZone: "America/Phoenix",
    locale: "en"
  });
  const subject = `[SAMPLE ${sample.tier} ${sample.billingPeriod}] ${email.subject}`;
  const id = await sendOwnerEmail(apiKey, to, subject, {
    text: email.text,
    html: email.html
  });
  console.log(
    `${sample.tier}/${sample.billingPeriod}: messageId=${id ?? "(null)"} to=${to} subject=${subject}`
  );
}
