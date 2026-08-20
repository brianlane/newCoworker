/**
 * The one answer to "is the business open at this local time?".
 *
 * Two surfaces offer appointment times: the public booking page
 * (`computePublicSlots`) and the AI coworker's `calendar_find_slots`. Both
 * must agree, because a customer can reach either one and a tenant whose
 * booking page says "closed Sunday" cannot have the coworker offering Sunday
 * 3 PM. The booking page had this logic privately; the coworker had none at
 * all and would offer 2 AM. Sharing it here is what makes the agreement
 * structural instead of a coincidence that drifts.
 *
 * Kept next to the {@link BusinessHours} type rather than in either feature,
 * so neither surface depends on the other.
 */

import type { BusinessHours, BusinessHoursDay } from "@/lib/business-profile/profile";
import { parseHmToMinutes } from "../../../supabase/functions/_shared/ai_flows/engine";

/**
 * Availability when the owner never filled in business hours: weekdays 9 to 5.
 *
 * Deliberately NOT "unconstrained". An explicitly closed day (null) or a
 * missing day on a PARTIALLY specified schedule stays closed: ambiguity must
 * never offer a Sunday 3 PM the owner would then have to honor.
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: { open: "09:00", close: "17:00" },
  tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" },
  thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" }
};

/** Day window in minutes since business-local midnight, or null when closed. */
export function dayWindowMinutes(
  hours: BusinessHours,
  weekday: BusinessHoursDay
): { openMin: number; closeMin: number } | null {
  const entry = hours[weekday];
  if (entry === undefined || entry === null) return null;
  const openMin = parseHmToMinutes(entry.open);
  const closeMin = parseHmToMinutes(entry.close);
  // parseBusinessHours already validated HH:MM, but stay fail-closed on a
  // hand-edited row where close does not follow open.
  if (openMin === null || closeMin === null || closeMin <= openMin) return null;
  return { openMin, closeMin };
}
