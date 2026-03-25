import { Resend } from "resend";

export async function sendOwnerEmail(
  apiKey: string,
  to: string,
  subject: string,
  text: string,
  from = "New Coworker <alerts@newcoworker.test>",
  resendCtor: typeof Resend = Resend
): Promise<string | null> {
  const resend = new resendCtor(apiKey);
  const result = await resend.emails.send({
    from,
    to,
    subject,
    text
  });

  return result.data?.id ?? null;
}
