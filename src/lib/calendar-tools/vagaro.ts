/**
 * Vagaro provider cores for the calendar tools.
 *
 * Unlike Calendly, Vagaro supports REAL booking: `calendar_find_slots` runs
 * an availability search and `calendar_book_appointment` creates the
 * appointment on the merchant's book. Both need a Vagaro SERVICE to operate
 * on: the owner's configured default (`vagaro_connections.default_service_id`)
 * wins, then the model's explicit `serviceId` arg, then the merchant's
 * service whose duration is closest to the requested duration — so the tools
 * work before the owner has opened the settings card.
 *
 * All errors that mean "the stored credentials are wrong" surface as the
 * distinct detail `vagaro_auth_failed` so the model can tell the caller the
 * owner needs to reconnect; transport/API failures throw and are mapped by
 * handlers.ts to the usual calendar_lookup_failed / calendar_book_failed.
 */

import { getActiveVagaroConnection, type VagaroConnectionRow } from "@/lib/db/vagaro-connections";
import {
  createVagaroAppointment,
  listVagaroServices,
  searchVagaroAvailability,
  VagaroApiError,
  type VagaroService
} from "@/lib/vagaro/client";
import type { CalendarToolResult } from "@/lib/calendar-tools/handlers";

/** Match the other providers: offer at most 3 candidate slots. */
const MAX_SLOTS = 3;

export type VagaroFindSlotsArgs = {
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  purpose?: string;
  /** Explicit Vagaro service to search (beats duration matching). */
  serviceId?: string;
  /** Already resolved (model choice → business tz → UTC) by the caller. */
  timezone: string;
};

export type VagaroBookArgs = {
  startIso: string;
  endIso: string;
  summary: string;
  attendeeName: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  notes?: string;
  serviceId?: string;
};

type ResolvedService = { id: string; name: string | null; durationMinutes: number | null };

/**
 * Which service the tools operate on. Order: explicit arg → owner default →
 * closest-duration active service. `"no_services"` when the merchant has
 * nothing bookable.
 */
export async function resolveVagaroService(
  conn: VagaroConnectionRow,
  explicitServiceId: string | undefined,
  durationMinutes: number
): Promise<ResolvedService | "no_services"> {
  const pinnedId = explicitServiceId?.trim() || conn.default_service_id;
  if (pinnedId) {
    return { id: pinnedId, name: null, durationMinutes: null };
  }
  const services = await listVagaroServices(conn);
  if (services.length === 0) return "no_services";
  let best: VagaroService = services[0];
  for (const candidate of services.slice(1)) {
    const bestGap = Math.abs((best.durationMinutes ?? durationMinutes) - durationMinutes);
    const gap = Math.abs((candidate.durationMinutes ?? durationMinutes) - durationMinutes);
    if (gap < bestGap) best = candidate;
  }
  return { id: best.id, name: best.name, durationMinutes: best.durationMinutes };
}

/** `calendar_find_slots` core for Vagaro connections. */
export async function findVagaroSlots(
  businessId: string,
  args: VagaroFindSlotsArgs
): Promise<CalendarToolResult> {
  const conn = await getActiveVagaroConnection(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };

  try {
    const service = await resolveVagaroService(conn, args.serviceId, args.durationMinutes);
    if (service === "no_services") {
      return { ok: false, detail: "vagaro_no_services" };
    }

    // Vagaro won't offer past slots; clamp the window start to now.
    const startMs = Math.max(args.windowStart.getTime(), Date.now());
    const endMs = args.windowEnd.getTime();
    if (endMs <= startMs) {
      return { ok: false, detail: "invalid_window" };
    }

    const found = await searchVagaroAvailability(conn, {
      serviceId: service.id,
      employeeId: conn.default_employee_id,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString()
    });
    const durationMinutes = service.durationMinutes ?? args.durationMinutes;
    const slots = found.slice(0, MAX_SLOTS).map((s) => ({
      startIso: s.startIso,
      endIso:
        s.endIso ?? new Date(Date.parse(s.startIso) + durationMinutes * 60_000).toISOString()
    }));

    return {
      ok: true,
      data: {
        slots,
        timezone: args.timezone,
        purpose: args.purpose ?? null,
        durationMinutes,
        provider: "vagaro",
        serviceId: service.id,
        serviceName: service.name
      }
    };
  } catch (err) {
    if (err instanceof VagaroApiError && err.code === "auth_failed") {
      return { ok: false, detail: "vagaro_auth_failed" };
    }
    throw err;
  }
}

/**
 * `calendar_book_appointment` core for Vagaro connections — creates a real
 * appointment on the merchant's book.
 *
 * @param fallbackPhone surface-provided attendee phone (the voice bridge
 *   passes the caller's number) when the model omits one.
 */
export async function bookVagaroAppointment(
  businessId: string,
  args: VagaroBookArgs,
  fallbackPhone?: string | null
): Promise<CalendarToolResult> {
  const conn = await getActiveVagaroConnection(businessId);
  if (!conn) return { ok: false, detail: "calendar_not_connected" };

  try {
    const requestedMinutes = Math.max(
      1,
      Math.round((new Date(args.endIso).getTime() - new Date(args.startIso).getTime()) / 60_000)
    );
    const service = await resolveVagaroService(conn, args.serviceId, requestedMinutes);
    if (service === "no_services") {
      return { ok: false, detail: "vagaro_no_services" };
    }

    const notes = [args.summary, args.notes ?? ""]
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    const created = await createVagaroAppointment(conn, {
      serviceId: service.id,
      employeeId: conn.default_employee_id,
      startIso: new Date(args.startIso).toISOString(),
      endIso: new Date(args.endIso).toISOString(),
      customerName: args.attendeeName,
      customerPhone: args.attendeePhone ?? fallbackPhone ?? null,
      customerEmail: args.attendeeEmail ?? null,
      notes
    });

    return {
      ok: true,
      data: {
        eventId: created.appointmentId,
        htmlLink: null,
        provider: "vagaro",
        calendar: "vagaro",
        serviceId: service.id,
        serviceName: service.name
      }
    };
  } catch (err) {
    if (err instanceof VagaroApiError && err.code === "auth_failed") {
      return { ok: false, detail: "vagaro_auth_failed" };
    }
    throw err;
  }
}
