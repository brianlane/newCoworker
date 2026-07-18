/**
 * Inbound Calendly webhook verification + handling (invitee.created).
 *
 * The real-time counterpart of the polling booking-goal sweep: a signed
 * delivery on /api/webhooks/calendly fires the same appointment_booked goal
 * machinery within seconds of the booking, through the SAME firing helper
 * (fireBookingGoalsForInvitees), so both observers behave identically and
 * double-observation is a benign no-op (a jumped run has no matching goal
 * ahead anymore).
 *
 * Signature: Calendly signs `t.rawBody` with the per-subscription signing
 * key (HMAC-SHA256, hex) and sends `Calendly-Webhook-Signature:
 * t=<unix>,v1=<hex>` — the Stripe header shape. Verification is timing-safe
 * and replay-bounded by the timestamp tolerance.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveCalendarConnection } from "@/lib/voice-tools/connections";
import {
  fireBookingGoalsForInvitees,
  type BookingGoalFireDeps,
  type CalendlyBookingInvitee
} from "@/lib/ai-flows/calendly-booking-goals";
import { recordSystemLog } from "@/lib/db/system-logs";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Calendly webhook bodies are small; 64KB caps abuse. */
export const CALENDLY_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

/** Reject deliveries whose signature timestamp is older/newer than this. */
export const CALENDLY_WEBHOOK_TIMESTAMP_TOLERANCE_SEC = 300;

/** Header carrying the signature. */
export const CALENDLY_WEBHOOK_SIGNATURE_HEADER = "calendly-webhook-signature";

/**
 * Verify `Calendly-Webhook-Signature: t=...,v1=...` against the raw body.
 * False on any malformed header, stale/future timestamp, or digest
 * mismatch — never throws.
 */
export function verifyCalendlyWebhookSignature(
  rawBody: string,
  header: string | null,
  signingKey: string,
  nowMs: number
): boolean {
  if (!header) return false;
  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const t = parts.get("t") ?? "";
  const v1 = parts.get("v1") ?? "";
  if (!/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(v1)) return false;

  const ageSec = Math.abs(nowMs / 1000 - Number(t));
  if (ageSec > CALENDLY_WEBHOOK_TIMESTAMP_TOLERANCE_SEC) return false;

  const expected = createHmac("sha256", signingKey).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type CalendlyWebhookHandleResult = {
  handled: boolean;
  reason?: "ignored_event" | "not_connected" | "stale_subscription";
  goalsFired?: number;
  jumpedRuns?: number;
};

export type CalendlyWebhookHandleDeps = BookingGoalFireDeps & {
  /** Injectable connection resolver (tests). */
  resolveConnection?: typeof resolveCalendarConnection;
};

/**
 * Handle one verified webhook body. Only `invitee.created` does anything;
 * other events (or a business whose calendar no longer resolves to Calendly
 * — a stale subscription outliving a disconnect) are acknowledged and
 * ignored so Calendly does not retry them.
 *
 * `subscription` is the row whose signing key just verified this delivery.
 * A row created by a DIFFERENT connection than the business's current one
 * belongs to a possibly-switched Calendly account (the sweep replaces it on
 * its next tick — see webhook-subscriptions.ts); its deliveries are ignored
 * rather than firing goals off the previous account's bookings.
 */
export async function handleCalendlyWebhookEvent(
  db: SupabaseClient,
  businessId: string,
  body: unknown,
  subscription: { connection_key: string | null },
  deps: CalendlyWebhookHandleDeps = {}
): Promise<CalendlyWebhookHandleResult> {
  const resolveConnection = deps.resolveConnection ?? resolveCalendarConnection;
  const event = (body as { event?: unknown } | null)?.event;
  if (event !== "invitee.created") return { handled: false, reason: "ignored_event" };

  // A subscription can outlive a disconnect (e.g. the Nango link was
  // removed elsewhere): verify the business still resolves to Calendly
  // before acting on the delivery.
  const conn = await resolveConnection(businessId);
  if (!conn || conn.provider !== "calendly") {
    return { handled: false, reason: "not_connected" };
  }
  if (subscription.connection_key !== `${conn.providerConfigKey}:${conn.connectionId}`) {
    return { handled: false, reason: "stale_subscription" };
  }

  // The invitee.created payload IS the invitee resource — same fields the
  // sweep's invitees listing returns, so no API round-trip is needed.
  const invitee = ((body as { payload?: CalendlyBookingInvitee }).payload ??
    {}) as CalendlyBookingInvitee;
  const fired = await fireBookingGoalsForInvitees(db, businessId, [invitee], deps);
  if (fired.jumpedRuns > 0) {
    await recordSystemLog({
      businessId,
      source: "aiflow",
      level: "info",
      event: "ai_flow_goal_jumped_booking",
      message: `A new Calendly booking moved ${fired.jumpedRuns} flow run(s) past their remaining follow-ups`,
      payload: { source: "webhook", jumped_runs: fired.jumpedRuns }
    });
  }
  return { handled: true, ...fired };
}
