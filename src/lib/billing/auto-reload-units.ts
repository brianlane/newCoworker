/**
 * Canonical-unit conversion for auto-reload, in its own module with zero
 * imports so both the server and the billing-page client component can use
 * the SAME functions.
 *
 * They previously existed twice: once here and once inline in
 * `AutoReloadSettings.tsx`, and the copies drifted. The component's version
 * rounded, so opening the settings card and pressing Save without editing
 * anything rewrote a $2.50 chat threshold as $3.00, moving the trigger the
 * sweep actually uses away from the number the tenant had chosen.
 *
 * Canonical units are integers: seconds for voice, texts for SMS, micro-USD
 * for chat. Display units are what the tenant reads: minutes, texts, dollars.
 * `fromDisplay(toDisplay(x)) === x` must hold for every stored value, which
 * is why the display direction does not round.
 */

export type AutoReloadUnitCategory = "voice" | "sms" | "chat";

/** Canonical units to the number the tenant reads. Never rounds. */
export function toDisplayUnits(category: AutoReloadUnitCategory, units: number): number {
  if (category === "voice") return units / 60;
  if (category === "chat") return units / 1_000_000;
  return units;
}

/**
 * The tenant's number back to canonical units.
 *
 * Rounds, because this is the only direction where a fractional value is
 * possible (someone typing "2.5" dollars) and the column is an integer.
 */
export function fromDisplayUnits(category: AutoReloadUnitCategory, display: number): number {
  if (category === "voice") return Math.round(display * 60);
  if (category === "chat") return Math.round(display * 1_000_000);
  return Math.round(display);
}
