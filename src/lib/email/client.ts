import { Resend } from "resend";

export async function sendOwnerEmail(
  apiKey: string,
  to: string,
  subject: string,
  text: string,
  from = process.env.MAILER_EMAIL ?? "New Coworker <contact@newcoworker.com>",
  resendCtor: typeof Resend = Resend
): Promise<string | null> {
  const resend = new resendCtor(apiKey);
  const replyTo = process.env.CONTACT_EMAIL;
  const result = await resend.emails.send({
    from,
    to,
    subject,
    text,
    ...(replyTo && { replyTo })
  });

  return result.data?.id ?? null;
}
