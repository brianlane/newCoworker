/**
 * Caller booking-status fetch — the voice twin of the SMS worker's
 * "Booking status" preamble line (KYP / Tim Tsai, Jul 20 2026: the agent
 * confidently denied a Calendly reschedule it could not see).
 *
 * The Calendly transports live platform-side (tenant PATs are encrypted
 * with a key the box never holds), so the bridge asks the platform:
 * POST /api/internal/contact-booking-context with this box's own
 * per-tenant gateway bearer — the same pattern as meter-gemini-spend, and
 * the same isolation property (one box can only ask about its own tenant).
 *
 * Kept dependency-free in its own module (vault-loader/contact-context
 * convention) so repo-root tests and typecheck import it without the
 * bridge's VPS-only runtime deps. Everything fails OPEN to null: call
 * setup must never wait past the budget or degrade beyond a missing line.
 */

/** Lookup budget — small enough to never hold up Gemini Live session start. */
export const VOICE_BOOKING_CONTEXT_TIMEOUT_MS = 5_000;

export async function loadVoiceBookingLine(params: {
  appBaseUrl: string | undefined;
  gatewayToken: string | undefined;
  businessId: string;
  phone: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const base = (params.appBaseUrl ?? "").trim().replace(/\/+$/, "");
  const token = (params.gatewayToken ?? "").trim();
  if (!base || !token) return null;
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${base}/api/internal/contact-booking-context`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ businessId: params.businessId, phone: params.phone }),
      signal: AbortSignal.timeout(VOICE_BOOKING_CONTEXT_TIMEOUT_MS)
    });
    if (!res.ok) {
      console.warn("voice-bridge: booking context answered", res.status);
      return null;
    }
    const payload = (await res.json().catch(() => null)) as {
      data?: { line?: string | null };
    } | null;
    const line = payload?.data?.line;
    return typeof line === "string" && line.trim().length > 0 ? line.trim() : null;
  } catch (err) {
    console.warn(
      "voice-bridge: booking context unreachable (continuing without)",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}
