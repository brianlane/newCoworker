/**
 * Did the app consume this message, or did it fall on the floor?
 *
 * `/api/email/inbound` answers **200 even for unknown recipients**, on purpose:
 * the mail is already delivered at Cloudflare's edge by the time the webhook
 * runs, so a non-2xx would make the sending server retry a delivery that
 * already succeeded. That means the status code says nothing, and the response
 * BODY is the only signal that no tenant took the message.
 *
 * Envelope: `{ ok: true, data: { matched: false } }` when nothing matched.
 */
export function recipientWasUnmatched(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if ((body as { ok?: unknown }).ok !== true) return false;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (data as { matched?: unknown }).matched === false;
}
