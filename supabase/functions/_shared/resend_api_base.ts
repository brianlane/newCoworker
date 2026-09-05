/**
 * Resend REST base. Overridable ONLY so the worker-integration suite can
 * point flow emails at a local fake and assert delivered bodies (the same
 * seam telnyxApiBase gives Telnyx sends); production leaves it unset and
 * always hits the real host. Runtime-agnostic (Deno on the edge, Node under
 * Vitest).
 */
export function resendApiBase(): string {
  const g = globalThis as {
    Deno?: { env: { get(name: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const raw = g.Deno ? g.Deno.env.get("RESEND_API_BASE") : g.process?.env?.RESEND_API_BASE;
  return (raw ?? "https://api.resend.com").replace(/\/+$/, "");
}
