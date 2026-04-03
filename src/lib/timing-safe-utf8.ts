import { timingSafeEqual } from "crypto";

/**
 * Constant-time equality for two strings compared as UTF-8 bytes.
 * Uses byte length (not JavaScript string length) so `timingSafeEqual` never throws
 * when UTF-16 lengths match but UTF-8 encodings differ.
 */
export function timingSafeEqualUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
