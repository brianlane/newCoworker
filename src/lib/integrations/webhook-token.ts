/**
 * Shared per-tenant webhook URL token check.
 *
 * Several integrations address their inbound webhook by embedding a random
 * per-tenant token in the URL (Vagaro, Acuity). The token is compared in
 * constant time because both sides are attacker-observable strings and a
 * length-or-prefix-leaking compare is exactly the kind of thing that turns a
 * guessable-in-theory token into a guessable-in-practice one.
 *
 * Extracted from `@/lib/vagaro/webhook` (which re-exports it, so no call site
 * changed) when Acuity needed the same check: a second integration importing
 * from the first one's module would have made Vagaro a de facto shared
 * library it was never meant to be.
 */
import { timingSafeEqual } from "node:crypto";

/** Constant-time token check (both sides are attacker-observable strings). */
export function verificationTokenMatches(presented: string, stored: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
