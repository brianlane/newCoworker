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
import {
  postalAddressRequiredForBusiness,
  postalAddressRequiredForTier,
  prospectingAllowedForTier,
  prospectingTierForBusiness
} from "@/lib/plans/prospecting";
import { utcDayStartIso } from "./compliance";
import {
  countProspectsInVertical,
  countProspectsNudgedSince,
  countProspectsSentSince,
  getOutreachSettings,
  listProspectOutcomes,
  listProspectsByStatus,
  skipProspectsInVertical,
  upsertOutreachSettings,
  transitionProspect,
  OUTREACH_DEFAULT_DAILY_CAP,
  OUTREACH_SCAN_LIMIT,
  type OutreachMode,
  type OutreachProspectRow,
  type OutreachSettingsRow
} from "./db";
import { summarizeFunnel, type OutreachFunnel, type VerticalFunnel } from "./stats";
import { listMeetingTypes } from "@/lib/booking-page/meeting-types";
import { listOutreachSendFromOptions, type SendFromOption } from "@/lib/email/mailbox-options";

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
  /**
   * False on Enterprise: the footer address is optional, so the panel drops
   * the blocker and explains the fallback instead of demanding a field.
   */
  postalAddressRequired: boolean;
  /**
   * Mailboxes cold email may leave from, "Automatic" first. Empty when the
   * tenant has connected none, which is a blocker rather than a preference.
   */
  mailboxes: SendFromOption[];
  /**
   * Meetings the CTA can link straight to. Empty when the tenant books through
   * Calendly or has no booking page, where the choice does not apply.
   */
  meetings: Array<{ id: string; name: string; durationMinutes: number; hidden: boolean }>;
  /**
   * How many more emails may go out today: the cap less what has already been
   * sent AND nudged, because a follow-up is a cold email too and both spend
   * one allowance. Computed here with the arithmetic `sendDraftsNow` uses, so
   * the number the Send all button promises is the number the server honours.
   */
  sendAllowanceLeft: number;
};

/** The two tier-derived gates the panel needs, resolved from one lookup. */
type TierGates = { tierAllowed: boolean; postalAddressRequired: boolean };

/**
 * tierAllowed is display-only (it drives the upgrade card) and every write
 * path re-checks the tier server-side, so a failed lookup degrades OPEN
 * there: a Starter briefly sees the normal panel while writes still refuse,
 * which beats flashing an upgrade card at a paying tenant over a transient
 * read blip. The address gate degrades the other way, CLOSED, because the
 * cost of being wrong is a blocker line an Enterprise tenant does not need
 * for one render, against a missing legal footer if we guess exempt.
 */
async function resolveTierGates(businessId: string, db: SupabaseClient): Promise<TierGates> {
  try {
    const tier = await prospectingTierForBusiness(businessId, db);
    return {
      tierAllowed: prospectingAllowedForTier(tier),
      postalAddressRequired: postalAddressRequiredForTier(tier)
    };
  } catch (error) {
    logger.warn("outreach: tier lookup failed; rendering the panel ungated", {
      businessId,
      error: error instanceof Error ? error.message : String(error)
    });
    return { tierAllowed: true, postalAddressRequired: true };
  }
}

/** Everything the panel renders, in one pass. */
export async function loadProspectingView(
  businessId: string,
  client?: SupabaseClient
): Promise<ProspectingView> {
  const db = client ?? (await createSupabaseServiceClient());
  const [settings, outcomes, queue, gates, mailboxes, meetingTypes, sentToday, nudgedToday] =
    await Promise.all([
    getOutreachSettings(businessId, db),
    listProspectOutcomes(businessId, db),
    listProspectsByStatus(businessId, ["drafted"], REVIEW_QUEUE_LIMIT, db),
    resolveTierGates(businessId, db),
    listOutreachSendFromOptions(businessId),
    // Only the ones a visitor could be sent to: a hidden type still books
    // through its direct link, so it is offered here even though the page's
    // own chooser leaves it off the menu.
    listMeetingTypes(businessId, db),
    countProspectsSentSince(businessId, utcDayStartIso(new Date()), db),
    countProspectsNudgedSince(businessId, utcDayStartIso(new Date()), db)
  ]);
  const { total, byVertical } = summarizeFunnel(outcomes);
  return {
    settings,
    funnel: total,
    byVertical,
    queue,
    clipped: outcomes.length >= OUTREACH_SCAN_LIMIT,
    blockers: describeBlockers(settings, {
      placesKeyConfigured: Boolean((process.env.GOOGLE_PLACES_API_KEY ?? "").trim()),
      postalAddressRequired: gates.postalAddressRequired,
      mailboxConnected: mailboxes.length > 0,
      pinnedMailboxConnected:
        !settings?.from_connection_id ||
        mailboxes.some((m) => m.id === settings.from_connection_id),
      pinnedMeetingAvailable:
        !settings?.booking_meeting_type_id ||
        meetingTypes.some((t) => t.id === settings.booking_meeting_type_id && t.enabled)
    }),
    tierAllowed: gates.tierAllowed,
    postalAddressRequired: gates.postalAddressRequired,
    mailboxes,
    meetings: meetingTypes
      .filter((t) => t.enabled)
      .map((t) => ({
        id: t.id,
        name: t.name,
        durationMinutes: t.duration_minutes,
        hidden: t.hidden
      })),
    sendAllowanceLeft: Math.max(0, (settings?.daily_cap ?? 0) - sentToday - nudgedToday)
  };
}

/**
 * What is missing before outreach can go out. Each one is a real precondition
 * the sweep checks, phrased as the owner action that clears it. The one
 * exception is `placesKey`: a platform-level precondition (the server's
 * Places API key), surfaced because its absence once no-oped discovery
 * silently for days, and "why is nothing happening?" belongs on the page.
 */
export function describeBlockers(
  settings: OutreachSettingsRow | null,
  env: {
    placesKeyConfigured?: boolean;
    postalAddressRequired?: boolean;
    mailboxConnected?: boolean;
    pinnedMailboxConnected?: boolean;
    pinnedMeetingAvailable?: boolean;
  } = {}
): string[] {
  if (!settings) return [];
  const blockers: string[] = [];
  // Platform blocker first: without the key, nothing the owner edits below
  // can make discovery run.
  if (env.placesKeyConfigured === false) blockers.push("placesKey");
  // No mailbox means no send path at all. It is listed here because the fix is
  // NOT a field on this page (it lives on Integrations), and an owner watching
  // drafts pile up with nothing going out has no other way to learn why.
  // Defaults to connected, so a caller that has not looked cannot invent one.
  if (env.mailboxConnected === false) blockers.push("mailbox");
  // A pinned mailbox that has since been disconnected is its own dead end, and
  // a quiet one: another mailbox is connected, so the blocker above stays
  // silent, the send path refuses to fall back to an address the owner did not
  // choose, and saving anything at all is refused until the pin is changed.
  // Named separately because the fix is different: pick another mailbox, or
  // choose Automatic. Defaults to fine, like the gate above it.
  if (env.pinnedMailboxConnected === false) blockers.push("mailboxGone");
  // Milder than the mailbox one: outreach keeps sending, the CTA just falls
  // back to the chooser page. Said anyway, because otherwise the emails quietly
  // stop offering the meeting the owner picked, and because every save is
  // refused until the pick is changed. Defaults to fine.
  if (env.pinnedMeetingAvailable === false) blockers.push("meetingGone");
  // Defaults to required, so every caller that has not resolved a tier keeps
  // the old, stricter behavior.
  if (env.postalAddressRequired !== false && !settings.postal_address?.trim()) {
    blockers.push("postalAddress");
  }
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
  /**
   * Which connected mailbox cold email leaves from. Empty means "whichever one
   * is connected", the behavior from before there was a choice.
   */
  fromConnectionId: string;
  /** Meeting the CTA links to. Empty links the page and lets them choose. */
  bookingMeetingTypeId: string;
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
 *
 * Enterprise is exempt from the typed field (postalAddressRequiredForTier).
 * The exemption is WRITTEN DOWN, in `postal_address_exempt`, rather than
 * implied by the tier: the DB check constraint reads that column, so the
 * schema still refuses a Standard tenant with an empty address, and a later
 * downgrade cannot silently re-open the gate the constraint used to hold. The
 * footer still prints the business profile address when there is one; see
 * resolveTenant in sweep.ts.
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

  // Checked before the tier lookup below, because it needs no I/O.
  if (input.mode !== "off" && !valueProp) {
    throw new ProspectingSettingsError(
      "Say what you want the email to offer before switching outreach on."
    );
  }
  const db = client ?? (await createSupabaseServiceClient());
  // TURNING OFF NEVER READS THE BUSINESS ROW. Off is exempt by definition (the
  // constraint ignores it), so the kill switch keeps working even while the
  // businesses table is unreadable.
  const postalAddressExempt =
    input.mode !== "off" && !(await postalAddressRequiredForBusiness(businessId, db));
  if (input.mode !== "off" && !postalAddress && !postalAddressExempt) {
    throw new ProspectingSettingsError(
      "A postal address is required before outreach can be switched on: every marketing email has to carry one."
    );
  }
  // TURNING OFF ALWAYS WORKS. The panel posts the whole form, so validating
  // pacing fields on the way out would let a half-typed window refuse the kill
  // switch: outreach would keep sending until the owner fixed a field they were
  // in the middle of editing. Off is the one action that must never be blocked
  // by a form error, so the pacing values are sanitized instead of rejected.
  // They are meaningless while off, and the schema still requires a legal pair.
  // Tier gating for switching ON lives in the dashboard route (and the sweep /
  // sendProspectNow path). The tier lookup above is about the postal-address
  // waiver only, and it is skipped entirely while off, so a Starter tenant can
  // always turn the feature off after a downgrade.
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

  // A pinned mailbox has to be one of this tenant's, checked here rather than
  // trusted from the form. The send path fails closed on an id it cannot
  // resolve (it will not quietly fall back to a different address), so an
  // unchecked value would be stored happily and then stop outreach dead. Only
  // verified while switching on, so the kill switch is never blocked by it.
  const fromConnectionId = input.fromConnectionId.trim();
  if (strict && fromConnectionId) {
    const options = await listOutreachSendFromOptions(businessId);
    if (!options.some((o) => o.id === fromConnectionId)) {
      throw new ProspectingSettingsError(
        "That mailbox is not connected any more. Pick another one, or choose Automatic."
      );
    }
  }

  // The chosen meeting, checked the same way and for a sharper reason: this
  // column carries a FOREIGN KEY, so an id deleted while the panel sat open
  // fails the upsert itself. Unchecked, that would break the one write this
  // function promises never to block, and turning outreach off would start
  // failing because of a meeting that no longer exists.
  //
  // Hence the split. Switching ON says so out loud, because silently swapping
  // the owner's named meeting back to "let them choose" changes what their
  // emails say without telling them. Switching OFF drops it to null instead:
  // the kill switch outranks a stale preference, and null is what the send
  // path falls back to anyway.
  let bookingMeetingTypeId: string | null = input.bookingMeetingTypeId.trim() || null;
  if (bookingMeetingTypeId) {
    const types = await listMeetingTypes(businessId, db);
    const live = types.some((t) => t.id === bookingMeetingTypeId && t.enabled);
    if (!live) {
      if (strict) {
        throw new ProspectingSettingsError(
          "That meeting is not available any more. Pick another one, or let them choose."
        );
      }
      bookingMeetingTypeId = null;
    }
  }

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
      postal_address_exempt: postalAddressExempt,
      value_prop: valueProp || null,
      sender_name: input.senderName.trim() || null,
      from_connection_id: fromConnectionId || null,
      booking_meeting_type_id: bookingMeetingTypeId
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

/** Why a prospect was retired when a whole trade was called off. */
export const VERTICAL_SKIP_DETAIL = "the owner stopped looking for this kind of business";

/**
 * The owner stopped looking for a kind of business, so the work already queued
 * for it is work nobody wants done.
 *
 * Removing a trade from the search terms only stops the NEXT discovery pass.
 * Everything that trade already produced stays in the queue: prospects waiting
 * to be drafted, and drafts waiting to be read. On a queue of a few hundred
 * that is a lot of Skip presses, and the drafts that survive them go out.
 *
 * Skipped, never deleted. The row is what keeps the domain out of future
 * discovery, so deleting it would only invite the sweep to find them again.
 * Nothing already sent is touched.
 *
 * The number returned is what was waiting the instant before the write, which
 * is what the owner should be told they just called off. The write itself
 * filters on status again, so a prospect the sweep sends in between is left
 * alone rather than marked skipped after the fact, and the count is at most one
 * or two out in that rare case.
 */
export async function skipVertical(
  businessId: string,
  vertical: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const waiting = await countProspectsInVertical(businessId, vertical, db);
  if (waiting === 0) return 0;
  await skipProspectsInVertical(businessId, vertical, VERTICAL_SKIP_DETAIL, db);
  return waiting;
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
    senderName: "",
    fromConnectionId: "",
    bookingMeetingTypeId: ""
  };
}
