/**
 * Validates a caller-controlled redirect target (`?redirectTo=`) so post-auth
 * redirects can never leave the app. Returns `candidate` only when it is an
 * app-relative path; anything absolute ("https://evil.example"),
 * protocol-relative ("//evil.example"), backslash-disguised ("/\\evil.example",
 * which WHATWG URL parsing reads as protocol-relative), or unparseable falls
 * back to `fallback`.
 */
export function safeInternalPath(candidate: string | null | undefined, fallback: string): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }

  const base = "https://internal.invalid";
  try {
    if (new URL(candidate, base).origin !== base) {
      return fallback;
    }
  } catch {
    return fallback;
  }
  return candidate;
}
