/**
 * Business profile: structured contact / address / per-day hours the owner
 * edits on the Settings page (BizBlasts-style "Business Information", adapted
 * for an AI coworker).
 *
 * Why this is load-bearing rather than cosmetic: the rendered markdown
 * (`renderBusinessProfileMd`) is persisted to `business_configs.profile_md`
 * and composed into the agent's grounding everywhere prompts are built —
 * `buildAgentInstructions` (vault sync → Rowboat SMS/chat agents), the
 * provision-time seed in `vps/scripts/deploy-client.sh`, and the
 * `business_knowledge_lookup` tool corpus (which the voice agent calls).
 * Owners previously had to hand-write hours into memory/soul markdown.
 */

import { BUSINESS_TYPE_LABELS } from "@/lib/onboarding/businessTypes";

export const BUSINESS_HOURS_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type BusinessHoursDay = (typeof BUSINESS_HOURS_DAYS)[number];

export const BUSINESS_HOURS_DAY_LABELS: Record<BusinessHoursDay, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday"
};

/**
 * One day's window. `null` = explicitly closed that day. A missing key on
 * {@link BusinessHours} = "not specified" (the owner never filled it in),
 * which renders nothing rather than claiming the business is closed.
 */
export type BusinessDayHours = { open: string; close: string } | null;

export type BusinessHours = Partial<Record<BusinessHoursDay, BusinessDayHours>>;

/** 24h "HH:MM" — the storage + API wire format for open/close times. */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHoursTime(value: string): boolean {
  return TIME_RE.test(value);
}

/**
 * Tolerant parse of the stored `businesses.business_hours` jsonb. Unknown
 * keys are dropped; malformed day entries are dropped (never thrown) so a
 * hand-edited row can't break Settings rendering or prompt composition.
 * Returns null when nothing usable remains.
 */
export function parseBusinessHours(value: unknown): BusinessHours | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: BusinessHours = {};
  let any = false;
  for (const day of BUSINESS_HOURS_DAYS) {
    if (!(day in (value as Record<string, unknown>))) continue;
    const raw = (value as Record<string, unknown>)[day];
    if (raw === null) {
      out[day] = null;
      any = true;
      continue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) continue;
    const open = (raw as Record<string, unknown>).open;
    const close = (raw as Record<string, unknown>).close;
    if (
      typeof open === "string" &&
      typeof close === "string" &&
      isValidHoursTime(open) &&
      isValidHoursTime(close)
    ) {
      out[day] = { open, close };
      any = true;
    }
  }
  return any ? out : null;
}

/** "13:30" → "1:30 PM" for prompt/UI display. */
export function formatHoursTime(time: string): string {
  const [hStr, mStr] = time.split(":");
  const h = Number(hStr);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${mStr} ${suffix}`;
}

export type BusinessProfileFacts = {
  name: string;
  /** Industry slug (businesses.business_type); labeled via BUSINESS_TYPE_LABELS. */
  businessType?: string | null;
  phone?: string | null;
  address?: string | null;
  timezone?: string | null;
  hours?: BusinessHours | null;
};

/** Industry slug → human label; unknown slugs fall back to a humanized slug. */
export function businessTypeLabel(slug: string): string {
  const known = (BUSINESS_TYPE_LABELS as Record<string, string>)[slug];
  if (known) return known;
  return slug
    .split("_")
    .filter((s) => s.length > 0)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Render the canonical `profile_md` block. Empty/blank facts are omitted;
 * when nothing at all is set, returns "" so prompt composers (which filter
 * empty sections) skip the profile entirely.
 */
export function renderBusinessProfileMd(facts: BusinessProfileFacts): string {
  const lines: string[] = [];
  const name = facts.name.trim();
  if (name) lines.push(`- Business name: ${name}`);
  const type = facts.businessType?.trim();
  if (type) lines.push(`- Industry: ${businessTypeLabel(type)}`);
  const phone = facts.phone?.trim();
  if (phone) lines.push(`- Phone: ${phone}`);
  const address = facts.address?.trim();
  if (address) lines.push(`- Address: ${address}`);
  const timezone = facts.timezone?.trim();
  if (timezone) lines.push(`- Timezone: ${timezone}`);

  const hours = facts.hours ?? null;
  const hoursLines: string[] = [];
  if (hours) {
    for (const day of BUSINESS_HOURS_DAYS) {
      const entry = hours[day];
      if (entry === undefined) continue;
      if (entry === null) {
        hoursLines.push(`- ${BUSINESS_HOURS_DAY_LABELS[day]}: Closed`);
      } else {
        hoursLines.push(
          `- ${BUSINESS_HOURS_DAY_LABELS[day]}: ${formatHoursTime(entry.open)} to ${formatHoursTime(entry.close)}`
        );
      }
    }
  }

  if (lines.length === 0 && hoursLines.length === 0) return "";

  const sections = ["## Business profile"];
  if (lines.length > 0) sections.push(lines.join("\n"));
  if (hoursLines.length > 0) sections.push("### Business hours\n" + hoursLines.join("\n"));
  return sections.join("\n\n");
}
