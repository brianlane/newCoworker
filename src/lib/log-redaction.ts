/**
 * CASA 6.5.1: production logs must not contain passwords, API keys, session
 * tokens, card numbers or CVVs.
 *
 * The logger previously spread its `context` argument straight into the JSON
 * line, so whether a secret reached the log depended entirely on every call
 * site remembering not to pass one. That is a discipline, not a control, and
 * an assessor is right not to accept it as one. This module makes it
 * structural: the logger scrubs on the way out, so a careless call site fails
 * safe.
 *
 * Matching is on the KEY, not the value. Value-shaped detection (entropy,
 * "looks like a JWT") produces both false positives on legitimate ids and
 * false negatives on short secrets, and it cannot see a secret embedded in a
 * free-text `error.message`. Key matching is predictable, which is what makes
 * it auditable. The residual gap (a secret interpolated into a message string
 * by the caller) is stated plainly in the SAQ rather than papered over.
 */

/** Replacement written in place of a redacted value. */
export const REDACTED = "[redacted]";

/**
 * Guard against pathological or cyclic structures. A log line is not worth an
 * unbounded walk, and `JSON.stringify` would throw on a cycle anyway.
 */
const MAX_DEPTH = 8;

/**
 * Single words that make a key sensitive wherever they appear as a discrete
 * word. Deliberately does NOT include bare "auth" or bare "key": `authProvider`
 * and `idempotencyKey` are useful operational context and are not secrets, and
 * redacting them would push call sites back toward logging around the scrubber.
 */
const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "cvv",
  "cvc",
  "ssn",
  "otp"
]);

/**
 * Two-word sequences that are sensitive together but harmless apart, so that
 * `apiKey` redacts while `idempotencyKey` does not.
 */
const SENSITIVE_PHRASES: readonly (readonly [string, string])[] = [
  ["api", "key"],
  ["access", "key"],
  ["secret", "key"],
  ["private", "key"],
  ["signing", "key"],
  ["card", "number"],
  ["account", "number"]
];

/**
 * Split a key into comparable words, so `accessToken`, `access_token`,
 * `ACCESS-TOKEN` and `access token` all normalize to `["access", "token"]`.
 */
export function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** True when the key names something that must never reach a log line. */
export function isSensitiveKey(key: string): boolean {
  const words = splitKeyWords(key);

  for (const word of words) {
    if (SENSITIVE_WORDS.has(word)) return true;
  }

  for (const [first, second] of SENSITIVE_PHRASES) {
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === first && words[i + 1] === second) return true;
    }
  }

  return false;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== "object") return value;

  // Cycle detection tracks the ANCESTOR CHAIN, not every object ever seen:
  // `{ a: shared, b: shared }` is a diamond, not a cycle, and marking the
  // second occurrence "[circular]" would silently drop real context. The
  // reference is removed again on the way back up.
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  const result = redactChildren(value, depth, seen);

  seen.delete(value as object);
  return result;
}

function redactChildren(value: object, depth: number, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1, seen));
  }

  // Errors serialize to `{}` through JSON.stringify, which discards the only
  // part worth having. Keep name and message. The message is free text, so a
  // secret a caller interpolated into it survives; that residual gap is stated
  // in the SAQ rather than papered over.
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, depth + 1, seen);
  }
  return out;
}

/**
 * Scrub a logger context object. Returns a new object; the caller's object is
 * never mutated, because a logger that edits its input would be a far worse
 * bug than the one it is preventing.
 */
export function redactContext(
  context: Record<string, unknown>
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value, 1, seen);
  }
  return out;
}
