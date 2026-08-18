/**
 * Our own record of what we have already seen on a merchant's Acuity book
 * (`acuity_appointment_state`).
 *
 * WHY THIS TABLE EXISTS: an Acuity appointment carries `dateCreated` but NO
 * last-modified timestamp, and the appointment object has no `canceled`
 * boolean at all (cancellation is signalled by which listing a row came
 * from). The AiFlow calendar poller's `event_canceled` mode gates on the
 * moment a change happened, `CalendarEventInput.updatedIso`, so on Acuity
 * there is simply nothing to gate on.
 *
 * Rather than accept degraded cancellation and reschedule triggers, we
 * synthesize that timestamp from our own observation: the first time we see
 * an appointment flip to canceled, or see its start move, THAT moment is the
 * modification time. It is a timestamp we control, so unlike a provider
 * field it is guaranteed stable and monotonic.
 *
 * The stability property is the whole point and is easy to get wrong: on
 * every later poll the SAME stored timestamp must be re-emitted, never
 * `now()`. Re-stamping would keep pushing the change forward in time, so a
 * cancellation would either refire every tick or never age out of the
 * lookback window.
 *
 * The webhook receiver writes here too, using the delivery moment, so the
 * real-time and polling paths agree and their shared `cal:` dedupe keys
 * collapse to one flow run.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Rows whose appointment started longer ago than this are swept. */
export const ACUITY_STATE_RETENTION_DAYS = 30;

export type AcuityAppointmentState = {
  business_id: string;
  appointment_id: string;
  /** The start we last observed, so a move is detectable. */
  start_at: string;
  canceled: boolean;
  /** When we FIRST saw it canceled. Never re-stamped. */
  first_seen_canceled_at: string | null;
  /** When we last saw its start change. */
  start_changed_at: string | null;
};

export type AcuityObservation = {
  appointmentId: string;
  startIso: string;
  canceled: boolean;
};

/**
 * What an observation turned out to be, and the timestamp to report as the
 * event's `updatedIso`.
 */
export type AcuityTransition = {
  appointmentId: string;
  kind: "new" | "canceled" | "moved" | "unchanged";
  /** Stable modification moment; null for a first sighting that is not a
   * cancellation (the event's own `dateCreated` covers that case). */
  updatedIso: string | null;
};

const COLUMNS =
  "business_id,appointment_id,start_at,canceled,first_seen_canceled_at,start_changed_at";

/** Existing shadow rows for the given appointment ids, keyed by id. */
export async function readAcuityAppointmentState(
  businessId: string,
  appointmentIds: string[],
  client?: SupabaseClient
): Promise<Map<string, AcuityAppointmentState>> {
  if (appointmentIds.length === 0) return new Map();
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("acuity_appointment_state")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .in("appointment_id", appointmentIds);
  if (error) throw new Error(`readAcuityAppointmentState: ${error.message}`);
  const out = new Map<string, AcuityAppointmentState>();
  for (const row of (data ?? []) as unknown as AcuityAppointmentState[]) {
    out.set(row.appointment_id, row);
  }
  return out;
}

/**
 * Diff observations against the stored shadow and persist the result.
 *
 * Returns one transition per observation, carrying the STABLE modification
 * moment: a first-seen cancellation stamps `observedIso` and reports it, and
 * every later sighting reports the stored value unchanged.
 *
 * Best-effort persistence: a write failure still returns correct transitions
 * for this tick (the shadow just re-learns them next tick), because losing a
 * flow run is worse than a duplicate one that the `cal:` dedupe keys absorb.
 */
export async function recordAcuityObservations(
  businessId: string,
  observations: AcuityObservation[],
  observedIso: string,
  client?: SupabaseClient
): Promise<AcuityTransition[]> {
  if (observations.length === 0) return [];
  const existing = await readAcuityAppointmentState(
    businessId,
    observations.map((o) => o.appointmentId),
    client
  );

  const transitions: AcuityTransition[] = [];
  const upserts: AcuityAppointmentState[] = [];

  for (const obs of observations) {
    const prior = existing.get(obs.appointmentId);
    const startMs = Date.parse(obs.startIso);

    if (!prior) {
      transitions.push({
        appointmentId: obs.appointmentId,
        kind: obs.canceled ? "canceled" : "new",
        // A first sighting that is ALREADY canceled still needs a
        // modification moment; a first sighting that is not uses the
        // appointment's own dateCreated instead.
        updatedIso: obs.canceled ? observedIso : null
      });
      upserts.push({
        business_id: businessId,
        appointment_id: obs.appointmentId,
        start_at: obs.startIso,
        canceled: obs.canceled,
        first_seen_canceled_at: obs.canceled ? observedIso : null,
        start_changed_at: null
      });
      continue;
    }

    if (obs.canceled && !prior.canceled) {
      transitions.push({
        appointmentId: obs.appointmentId,
        kind: "canceled",
        updatedIso: observedIso
      });
      upserts.push({
        ...prior,
        start_at: obs.startIso,
        canceled: true,
        first_seen_canceled_at: observedIso
      });
      continue;
    }

    if (obs.canceled) {
      // Already known canceled: re-emit the STORED moment. Re-stamping here
      // is the bug this whole module exists to avoid.
      transitions.push({
        appointmentId: obs.appointmentId,
        kind: "unchanged",
        updatedIso: prior.first_seen_canceled_at
      });
      continue;
    }

    if (Date.parse(prior.start_at) !== startMs) {
      transitions.push({
        appointmentId: obs.appointmentId,
        kind: "moved",
        updatedIso: observedIso
      });
      upserts.push({
        ...prior,
        start_at: obs.startIso,
        canceled: false,
        start_changed_at: observedIso
      });
      continue;
    }

    transitions.push({
      appointmentId: obs.appointmentId,
      kind: "unchanged",
      updatedIso: prior.start_changed_at
    });
  }

  if (upserts.length > 0) {
    try {
      const db = client ?? (await createSupabaseServiceClient());
      const { error } = await db
        .from("acuity_appointment_state")
        .upsert(upserts, { onConflict: "business_id,appointment_id" });
      if (error) throw new Error(error.message);
    } catch (err) {
      logger.warn("acuity state: persist failed", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return transitions;
}

/** Drop shadow rows for appointments well in the past. */
export async function sweepAcuityAppointmentState(
  businessId: string,
  nowMs: number,
  client?: SupabaseClient
): Promise<void> {
  const cutoff = new Date(nowMs - ACUITY_STATE_RETENTION_DAYS * 86_400_000).toISOString();
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("acuity_appointment_state")
    .delete()
    .eq("business_id", businessId)
    .lt("start_at", cutoff);
  if (error) throw new Error(`sweepAcuityAppointmentState: ${error.message}`);
}
