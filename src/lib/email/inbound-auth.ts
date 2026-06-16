/**
 * Shared-secret auth for the inbound-email webhook (/api/email/inbound).
 *
 * The Cloudflare Email Worker that catches tenant mail POSTs here with
 * `Authorization: Bearer <EMAIL_INBOUND_SECRET>`. Mirrors `cron-auth.ts`:
 * SHA-256 + constant-time compare so the secret can't be timing-leaked.
 *
 * A dedicated secret (not INTERNAL_CRON_SECRET) keeps the externally-reachable
 * inbound surface on its own credential, rotatable without touching cron.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function assertEmailInboundAuth(request: Request): boolean {
  const secret = (process.env.EMAIL_INBOUND_SECRET ?? "").trim();
  if (!secret) return false;

  const raw = request.headers.get("authorization");
  if (!raw) return false;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  /* v8 ignore next -- Fetch Headers normalize whitespace-only authorization values before this guard. */
  if (!token) return false;

  // Both operands are 32-byte SHA-256 digests, so timingSafeEqual's
  // equal-length precondition always holds and it can never throw here.
  const digestToken = createHash("sha256").update(token, "utf8").digest();
  const digestSecret = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(digestToken, digestSecret);
}
