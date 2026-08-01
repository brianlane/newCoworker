/**
 * Prospecting: what the owner sees and what the owner can change.
 *
 * The read model and the three mutations behind the dashboard panel, kept here
 * rather than in the route handlers so the rules are unit-tested: which
 * settings are valid, what has to exist before the feature can be switched on,
 * and what "Send" actually does.
 *
 * The reporting vocabulary is deliberate. Drafted and sent are separate
 * numbers, drafts still waiting are reported as waiting, and the reply rate is
 * a share of what was SENT. A dashboard that says "contacted: 15" beside an
 * empty sent folder is the specific failure this vocabulary avoids.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { prospectingAllowedForBusiness } from "@/lib/plans/prospecting";
import {
  getOutreachSettings,
  listProspectOutcomes,
  listProspectsByStatus,
  upsertOutreachSettings,
  transitionProspect,
  OUTREACH_DEFAULT_DAILY_CAP,
  OUTREACH_SCAN_LIMIT,
  type OutreachMode,
  type OutreachProspectRow,
  type OutreachSettingsRow
} from "./db";
import { summarizeFunnel, type OutreachFunnel, type VerticalFunnel } from "./stats";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Drafts shown in the review queue at once. */
export const REVIEW_QUEUE_LIMIT = 25;

/** Search terms and cities a tenant may configure. Each pair is a paid query. */
export const MAX_SEARCH_TERMS = 12;
export const MAX_CITIES = 12;

/** Hard ceiling on the daily cap, mirroring the DB check constraint. */
export const MAX_DAILY_CAP = 200;

/** Weekday morning, the shape cold email lands best in. */
export const DEFAULT_WINDOW_START_HOUR = 8;
export const DEFAULT_WINDOW_END_HOUR = 11;

export type ProspectingView = {
  /** Null when the owner has never opened Prospecting: means mode 'off'. */
  settings: OutreachSettingsRow | null;
  funnel: OutreachFunnel;
  byVertical: VerticalFunnel[];
  /**
   * The outcome scan filled its bound, so the funnel counts are floors rather
   * than totals. Surfaced instead of quietly under-reporting, the same way the
   * Marketing page's lead-source summary handles its own bound.
   */
  clipped: boolean;
  /** Drafts waiting on the owner, only meaningful in manual mode. */
  queue: OutreachProspectRow[];
  /**
   * Why the feature cannot run yet, owner-readable. Empty when it can. Shown
   * whether the mode is on or off, so "why is nothing happening?" is answered
   * on the page instead of in a support conversation.
   */
  blockers: string[];
  /** False on Starter: panel shows an upgrade card; writes refuse when on. */
  tierAllowed: boolean;
};

/** Everything the panel renders, in one pass. */
export async function loadProspectingView(
  businessId: string,
  client?: SupabaseClient
): Promise<ProspectingView> {
  const db = client ?? (await createSupabaseServiceClient());
  const [settings, outcomes, queue, tierAllowed] = await Promise.all([
    getOutreachSettings(businessId, db),
    listProspectOutcomes(businessId, db),
    listProspectsByStatus(businessId, ["drafted"], REVIEW_QUEUE_LIMIT, db),
    // tierAllowed is display-only (it drives the upgrade card); every write
    // path re-checks the tier server-side. prospectingAllowedForBusiness
    // throws on lookup failure, and unhandled here that rejection 500s the
    // whole Marketing panel. Degrade OPEN instead: a Starter briefly sees
    // the normal panel while writes still refuse, which beats flashing an
    // upgrade card at a paying tenant over a transient read blip.
    prospectingAllowedForBusiness(businessId, db).catch((error) => {
      logger.warn("outreach: tier lookup failed; rendering the panel ungated", {
        businessId,
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    })
  ]);
  const { total, byVertical } = summarizeFunnel(outcomes);
  return {
    settings,
    funnel: total,
    byVertical,
    queue,
    clipped: outcomes.length >= OUTREACH_SCAN_LIMIT,
    blockers: describeBlockers(settings),
    tierAllowed
  };
}

/**
 * What is missing before outreach can go out. Each one is a real precondition
 * the sweep checks, phrased as the owner action that clears it.
 */
export function describeBlockers(settings: OutreachSettingsRow | null): string[] {
  if (!settings) return [];
  const blockers: string[] = [];
  if (!settings.postal_address?.trim()) blockers.push("postalAddress");
  if (!settings.value_prop?.trim()) blockers.push("valueProp");
  if (settings.search_terms.length === 0) blockers.push("searchTerms");
  if (settings.cities.length === 0) blockers.push("cities");
  return blockers;
}

export type ProspectingSettingsInput = {
  mode: OutreachMode;
  searchTerms: string[];
  cities: string[];
  dailyCap: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  postalAddress: string;
  valueProp: string;
  senderName: string;
};

export class ProspectingSettingsError extends Error {}

/**
 * Save the owner's settings, refusing anything the sweep could not honor.
 *
 * The postal-address rule is the important one: CAN-SPAM requires a physical
 * address in commercial email, so switching the feature on without one is
 * refused HERE with a readable message, before the database refuses it with a
 * constraint violation. Both gates exist on purpose, since the DB is what makes
 * it impossible and this is what makes it understandable.
 */
export async function saveProspectingSettings(
  businessId: string,
  input: ProspectingSettingsInput,
  client?: SupabaseClient
): Promise<OutreachSettingsRow> {
  const searchTerms = dedupeList(input.searchTerms, MAX_SEARCH_TERMS);
  const cities = dedupeList(input.cities, MAX_CITIES);
  const postalAddress = input.postalAddress.trim();
  const valueProp = input.valueProp.trim();

  if (input.mode !== "off" && !postalAddress) {
    throw new ProspectingSettingsError(
      "A postal address is required before outreach can be switched on: every marketing email has to carry one."
    );
  }
  if (input.mode !== "off" && !valueProp) {
    throw new ProspectingSettingsError(
      "Say what you want the email to offer before switching outreach on."
    );
  }
  // TURNING OFF ALWAYS WORKS. The panel posts the whole form, so validating
  // pacing fields on the way out would let a half-typed window refuse the kill
  // switch: outreach would keep sending until the owner fixed a field they were
  // in the middle of editing. Off is the one action that must never be blocked
  // by a form error, so the pacing values are sanitized instead of rejected.
  // They are meaningless while off, and the schema still requires a legal pair.
  // Tier gating for switching ON lives in the dashboard route (and the sweep /
  // sendProspectNow path), so a Starter tenant can always turn the feature off
  // after a downgrade without this function needing a businesses lookup.
  const strict = input.mode !== "off";
  if (strict && (input.dailyCap < 0 || input.dailyCap > MAX_DAILY_CAP)) {
    throw new ProspectingSettingsError(`The daily cap has to be between 0 and ${MAX_DAILY_CAP}.`);
  }
  if (strict && input.sendWindowEndHour <= input.sendWindowStartHour) {
    throw new ProspectingSettingsError("The send window has to end after it starts.");
  }
  const dailyCap = strict
    ? input.dailyCap
    : Math.min(MAX_DAILY_CAP, Math.max(0, Math.round(input.dailyCap)));
  const windowOk = input.sendWindowEndHour > input.sendWindowStartHour;
  const [startHour, endHour] =
    strict || windowOk
      ? [input.sendWindowStartHour, input.sendWindowEndHour]
      : [DEFAULT_WINDOW_START_HOUR, DEFAULT_WINDOW_END_HOUR];

  const db = client ?? (await createSupabaseServiceClient());
  return upsertOutreachSettings(
    businessId,
    {
      mode: input.mode,
      search_terms: searchTerms,
      cities,
      daily_cap: dailyCap,
      send_window_start_hour: startHour,
      send_window_end_hour: endHour,
      postal_address: postalAddress || null,
      value_prop: valueProp || null,
      sender_name: input.senderName.trim() || null
    },
    db
  );
}

/** Trim, drop blanks, de-dupe case-insensitively, and cap the length. */
function dedupeList(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * The owner read a draft and passed on it. The row stays in the ledger, which
 * is what keeps the domain out of future discovery: a skip means "not this
 * business", not "ask me again next week".
 *
 * Guarded on the draft still being a draft, and it returns whether it moved.
 * A review queue can be minutes stale: the sweep may have sent this prospect
 * while the page sat open, and an unguarded write would then mark a SENT
 * prospect skipped, quietly removing a real send from the funnel. Same claim
 * discipline as the Send button beside it.
 */
export async function skipProspect(
  businessId: string,
  prospectId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  return transitionProspect(
    businessId,
    prospectId,
    "drafted",
    { status: "skipped", status_detail: "the owner read the draft and passed" },
    db
  );
}

/** Default settings the panel shows a business that has never configured it. */
export function defaultProspectingSettings(): ProspectingSettingsInput {
  return {
    mode: "off",
    searchTerms: [],
    cities: [],
    dailyCap: OUTREACH_DEFAULT_DAILY_CAP,
    sendWindowStartHour: DEFAULT_WINDOW_START_HOUR,
    sendWindowEndHour: DEFAULT_WINDOW_END_HOUR,
    postalAddress: "",
    valueProp: "",
    senderName: ""
  };
}
