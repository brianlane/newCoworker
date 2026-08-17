/**
 * Pure copy for the "lines held for live transfers" setting, shared by the
 * settings card that edits it and unit tests. Extracted from
 * PhoneNumberCard when the control moved to Settings -> Business (the card
 * now links there instead of embedding the editor).
 */

/** The platform default when the business has no override (lockstep with TENANT_OUTBOUND_DIAL_HEADROOM_DEFAULT). */
export const DIAL_HEADROOM_DEFAULT = 3;

/** Owner-facing description of a headroom choice. */
export function describeDialHeadroom(value: number): string {
  if (value === 0) {
    return "The AI may use every line; a live transfer can find them all busy.";
  }
  const lines = value === 1 ? "1 line stays" : `${value} lines stay`;
  return `${lines} free for live transfers and ringing your team; the AI dials with the rest.`;
}
