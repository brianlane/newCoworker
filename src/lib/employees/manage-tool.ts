/**
 * manage_employee core: the machinery behind "add Sandy to the team" and
 * "take Gabby off lead rotation until Monday".
 *
 * The roster (ai_flow_team_members) decides who receives leads, and until now
 * it could only be edited on /dashboard/employees. That is the wrong shape for
 * the moments it actually changes: an owner standing in a listing appointment
 * texting "Sandy starts today, 602 555 0134", or one realizing mid-call that a
 * teammate is buried and should stop receiving rotation leads. This module is
 * the one implementation behind every owner surface, sharing the same db
 * helpers the dashboard API route uses so the AI path and the page cannot
 * drift.
 *
 * Surface posture matches flag_contact_spam / set_contact_reply_mode:
 * inline-only on VERIFIED OWNER surfaces (dashboard chat at the
 * manage_settings bar, the owner-SMS operator turn) plus the MCP connector,
 * and deliberately NEVER seeded to the Rowboat texting coworker, because that
 * agent talks to customers, and a customer must not be able to talk their way
 * onto the roster that receives leads.
 *
 * Every write is reversible from the same tool and from the Employees page,
 * which is why this one is allowed to act rather than only propose. The note
 * on each result spells out what changed so the model relays it instead of
 * inventing an outcome.
 */

import {
  createTeamMember,
  listTeamMembers,
  updateTeamMember,
  type TeamMemberRow
} from "@/lib/db/employees";
import { parseScheduleText } from "@/lib/employees/schedule-text";
import { normalizeDialableNumber } from "@/lib/telnyx/format";
import { smsReachability } from "@/lib/phone/deliverability";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";
import { logger } from "@/lib/logger";

/** Postgres's wording for a unique violation, as PostgREST relays it. */
const DUPLICATE_KEY_MESSAGE = "duplicate key value violates unique constraint";

export type ManageEmployeeAction = "add" | "update" | "deactivate" | "reactivate";

export type ManageEmployeeArgs = {
  action: ManageEmployeeAction;
  /**
   * Who to change, for update/deactivate/reactivate: their roster name or
   * their phone number. Ignored by "add", which takes name + phone.
   */
  employee?: string;
  /** New name (update) or the new teammate's name (add). */
  name?: string;
  /** New number (update) or the new teammate's number (add). */
  phone?: string;
  /** "" clears the stored address. */
  email?: string;
  /** Compact working hours, e.g. "mon-fri 09:00-17:00". "" clears. */
  scheduleText?: string;
  /** Compact preferred lead hours, same format. "" clears. */
  preferredText?: string;
  /** Round-robin rotation and auto-assign. */
  leadRotation?: boolean;
  /** One lead an automation asks for them by name. */
  namedLeads?: boolean;
  /** Offers that list this person by name alongside others. */
  namedGroupOffers?: boolean;
  /** Whole-roster offers (the team-first human handoff). */
  wholeTeamOffers?: boolean;
};

export type ManageEmployeeResult =
  | {
      ok: true;
      action: ManageEmployeeAction;
      employee: {
        id: string;
        name: string;
        phoneE164: string;
        email: string | null;
        active: boolean;
        leadRotation: boolean;
        namedLeads: boolean;
        namedGroupOffers: boolean;
        wholeTeamOffers: boolean;
      };
      note: string;
    }
  | { ok: false; message: string };

export type ManageEmployeeDeps = {
  listMembers?: typeof listTeamMembers;
  createMember?: typeof createTeamMember;
  updateMember?: typeof updateTeamMember;
};

/** Roster row → the flat shape the model reads back. */
function describe(row: TeamMemberRow): Extract<ManageEmployeeResult, { ok: true }>["employee"] {
  return {
    id: row.id,
    name: row.name,
    phoneE164: row.phone_e164,
    email: row.email,
    active: row.active,
    // Pre-migration rows come back null over PostgREST; the column default is
    // true, so read anything that is not an explicit false as on.
    leadRotation: row.routing_enabled !== false,
    namedLeads: row.named_routing_enabled !== false,
    namedGroupOffers: row.named_broadcast_enabled !== false,
    wholeTeamOffers: row.team_broadcast_enabled !== false
  };
}

/**
 * Find the person the owner named. Deliberately strict for a WRITE tool:
 * an exact phone, an exact full name, or a first name that belongs to exactly
 * one teammate. Anything ambiguous returns the candidate list instead of
 * guessing, because the cost of guessing here is silently redirecting
 * somebody else's leads.
 */
function resolveMember(
  members: TeamMemberRow[],
  wanted: string
): { ok: true; member: TeamMemberRow } | { ok: false; message: string } {
  const raw = wanted.trim();
  if (!raw) {
    return { ok: false, message: "missing_employee, name the teammate to change." };
  }

  const asPhone = normalizeDialableNumber(raw);
  if (asPhone.ok) {
    const byPhone = members.find((m) => m.phone_e164 === asPhone.value);
    if (byPhone) return { ok: true, member: byPhone };
    // A number that is not on the roster is not a teammate, and a phone is
    // never a name, so do not fall through to name matching with it.
    return {
      ok: false,
      message: `not_on_roster, nobody on the roster has the number ${asPhone.value}. Offer to add them.`
    };
  }

  const want = raw.toLowerCase();
  const exact = members.filter((m) => m.name.trim().toLowerCase() === want);
  if (exact.length === 1) return { ok: true, member: exact[0] };
  if (exact.length > 1) return { ok: false, message: ambiguous(raw, exact) };

  const byFirstName = members.filter(
    (m) => m.name.trim().split(/\s+/)[0]?.toLowerCase() === want
  );
  if (byFirstName.length === 1) return { ok: true, member: byFirstName[0] };
  if (byFirstName.length > 1) return { ok: false, message: ambiguous(raw, byFirstName) };

  return {
    ok: false,
    message:
      `not_on_roster, no teammate matches "${raw}". ` +
      (members.length > 0
        ? `The roster is: ${members.map((m) => m.name).join(", ")}.`
        : "The roster is empty.")
  };
}

function ambiguous(wanted: string, candidates: TeamMemberRow[]): string {
  const list = candidates.map((m) => `${m.name} (${m.phone_e164})`).join(", ");
  return `ambiguous_employee, "${wanted}" matches ${list}. Ask the owner which one, and use the phone number.`;
}

/** Availability fields present in the args, mapped to the db patch shape. */
function availabilityPatch(args: ManageEmployeeArgs): {
  routingEnabled?: boolean;
  namedRoutingEnabled?: boolean;
  namedBroadcastEnabled?: boolean;
  teamBroadcastEnabled?: boolean;
} {
  return {
    ...(args.leadRotation !== undefined ? { routingEnabled: args.leadRotation } : {}),
    ...(args.namedLeads !== undefined ? { namedRoutingEnabled: args.namedLeads } : {}),
    ...(args.namedGroupOffers !== undefined
      ? { namedBroadcastEnabled: args.namedGroupOffers }
      : {}),
    ...(args.wholeTeamOffers !== undefined ? { teamBroadcastEnabled: args.wholeTeamOffers } : {})
  };
}

/** Parse a compact schedule string, or report the parse error to the model. */
function parseWindows(
  text: string,
  label: string
): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = parseScheduleText(text);
  if (!parsed.ok) {
    return { ok: false, message: `invalid_${label}, ${parsed.error}` };
  }
  return { ok: true, value: parsed.value };
}

/** Plain-English summary of what an owner will observe after the change. */
function availabilityNote(e: Extract<ManageEmployeeResult, { ok: true }>["employee"]): string {
  if (!e.active) return "They are inactive, so they receive no leads at all until reactivated.";
  const off: string[] = [];
  if (!e.leadRotation) off.push("leads in rotation");
  if (!e.namedLeads) off.push("leads named to them");
  if (!e.namedGroupOffers) off.push("group offers that name them");
  if (!e.wholeTeamOffers) off.push("whole-team offers");
  if (off.length === 0) {
    return "They receive leads every way: rotation, leads named to them, named group offers, and whole-team offers.";
  }
  if (off.length === 4) {
    return "They receive no lead offers of any kind while all four availability switches are off.";
  }
  return `They no longer receive: ${off.join(", ")}.`;
}

/**
 * The lead-offer machinery reaches teammates by SMS, and our long codes
 * deliver SMS to +1 (US/Canada) only, so a roster number outside NANP means
 * every lead offer and team alert to that person silently dies at Telnyx.
 * Saying so at save time, with the working alternative (WhatsApp), is the
 * whole point: on Jul 30 2026 KYP's owner moved his own roster number to a
 * Hong Kong +852 line, the tool confirmed "all notifications will now be
 * routed to your new number", and every team text since then went nowhere.
 */
function smsReachWarning(phoneE164: string): string {
  if (smsReachability(phoneE164) === "nanp") return "";
  return (
    ` IMPORTANT: ${phoneE164} is outside US/Canada (+1), and our texting lines cannot` +
    " deliver SMS internationally, so lead offers and team alert texts to this number" +
    " will never arrive. Recommend connecting WhatsApp (/dashboard/integrations/whatsapp)" +
    " so they have a working message channel; voice calls, email, and dashboard alerts" +
    " still work."
  );
}

/**
 * Add, edit, deactivate, or reactivate one roster member. Never throws: the
 * returned payload is a Gemini functionResponse (and an MCP tool result) and
 * must always be relayable.
 */
export async function manageEmployee(
  businessId: string,
  args: ManageEmployeeArgs,
  deps: ManageEmployeeDeps = {}
): Promise<ManageEmployeeResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const listMembers = deps.listMembers ?? listTeamMembers;
  const createMember = deps.createMember ?? createTeamMember;
  const updateMember = deps.updateMember ?? updateTeamMember;
  /* c8 ignore stop */

  let members: TeamMemberRow[];
  try {
    members = await listMembers(businessId);
  } catch (err) {
    logger.error("manage_employee: roster read failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message:
        "roster_read_failed, the roster could not be read so nothing was changed. Tell the owner honestly and suggest trying again."
    };
  }

  if (args.action === "add") return await addMember(businessId, args, members, createMember);

  const found = resolveMember(members, args.employee ?? args.name ?? args.phone ?? "");
  if (!found.ok) return found;
  const member = found.member;

  const patch: Parameters<typeof updateTeamMember>[2] = { ...availabilityPatch(args) };

  if (args.action === "deactivate") patch.active = false;
  if (args.action === "reactivate") patch.active = true;

  // Field edits apply to every non-add action, not just "update": one call
  // can reactivate someone AND fix the number they came back with.
  if (args.name !== undefined) {
    const name = args.name.trim();
    if (!name) return { ok: false, message: "invalid_name, a teammate needs a name." };
    patch.name = name.slice(0, 120);
  }
  if (args.phone !== undefined) {
    const normalized = normalizeDialableNumber(args.phone);
    if (!normalized.ok) {
      return {
        ok: false,
        message: `invalid_phone, ${normalized.reason}. Ask the owner for the exact number.`
      };
    }
    const clash = members.find((m) => m.id !== member.id && m.phone_e164 === normalized.value);
    if (clash) {
      return {
        ok: false,
        message: `phone_taken, ${normalized.value} already belongs to ${clash.name} on this roster.`
      };
    }
    patch.phoneE164 = normalized.value;
  }
  if (args.email !== undefined) {
    const email = args.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, message: `invalid_email, "${email}" is not a valid address.` };
    }
    patch.email = email ? email.slice(0, 254) : null;
  }
  if (args.scheduleText !== undefined) {
    const parsed = parseWindows(args.scheduleText, "schedule");
    if (!parsed.ok) return parsed;
    patch.weeklySchedule = parsed.value;
  }
  if (args.preferredText !== undefined) {
    const parsed = parseWindows(args.preferredText, "preferred_times");
    if (!parsed.ok) return parsed;
    patch.preferredWindows = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      message: `nothing_to_change, say what to change about ${member.name}.`
    };
  }

  let updated: TeamMemberRow | null;
  try {
    updated = await updateMember(businessId, member.id, patch);
  } catch (err) {
    logger.error("manage_employee: update failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message:
        "update_failed, the change could NOT be saved. Nothing was changed; tell the owner honestly and suggest trying again."
    };
  }
  if (!updated) {
    return {
      ok: false,
      message: `not_on_roster, ${member.name} was removed from the roster while this was running.`
    };
  }

  const employee = describe(updated);
  return {
    ok: true,
    action: args.action,
    employee,
    note:
      `Tell the owner exactly what changed for ${employee.name}. ` +
      availabilityNote(employee) +
      " Owner alerts are unaffected: keep-for-owner alerts, the nobody-claimed fallback, and claim notices still reach you." +
      smsReachWarning(employee.phoneE164)
  };
}

async function addMember(
  businessId: string,
  args: ManageEmployeeArgs,
  members: TeamMemberRow[],
  createMember: typeof createTeamMember
): Promise<ManageEmployeeResult> {
  const name = (args.name ?? args.employee ?? "").trim();
  if (!name) return { ok: false, message: "missing_name, a new teammate needs a name." };
  if (!args.phone?.trim()) {
    return {
      ok: false,
      message: "missing_phone, a new teammate needs a mobile number so lead offers can reach them."
    };
  }
  const normalized = normalizeDialableNumber(args.phone);
  if (!normalized.ok) {
    return {
      ok: false,
      message: `invalid_phone, ${normalized.reason}. Ask the owner to repeat the number, digit by digit.`
    };
  }
  const existing = members.find((m) => m.phone_e164 === normalized.value);
  if (existing) {
    return {
      ok: false,
      message:
        `already_on_roster, ${normalized.value} is already ${existing.name}` +
        (existing.active ? "." : ", currently inactive. Reactivate them instead of adding a duplicate.")
    };
  }

  const email = (args.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: `invalid_email, "${email}" is not a valid address.` };
  }

  let weeklySchedule: unknown = null;
  if (args.scheduleText !== undefined) {
    const parsed = parseWindows(args.scheduleText, "schedule");
    if (!parsed.ok) return parsed;
    weeklySchedule = parsed.value;
  }
  let preferredWindows: unknown = null;
  if (args.preferredText !== undefined) {
    const parsed = parseWindows(args.preferredText, "preferred_times");
    if (!parsed.ok) return parsed;
    preferredWindows = parsed.value;
  }

  let created: TeamMemberRow;
  try {
    created = await createMember(businessId, {
      name: name.slice(0, 120),
      phoneE164: normalized.value,
      email: email ? email.slice(0, 254) : null,
      weeklySchedule,
      preferredWindows,
      ...availabilityPatch(args)
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Raced by a concurrent add (the Employees page in another tab): report
    // it as the duplicate it is rather than a mystery failure. createTeamMember
    // surfaces the PostgREST message, not the SQLSTATE, so match both.
    if (message.includes(DUPLICATE_KEY_MESSAGE) || message.includes(PG_UNIQUE_VIOLATION)) {
      return {
        ok: false,
        message: `already_on_roster, ${normalized.value} was just added by someone else.`
      };
    }
    logger.error("manage_employee: create failed", { businessId, error: message });
    return {
      ok: false,
      message:
        "add_failed, the teammate could NOT be added. Nothing was changed; tell the owner honestly and suggest trying again."
    };
  }

  const employee = describe(created);
  return {
    ok: true,
    action: "add",
    employee,
    note:
      `Tell the owner ${employee.name} is on the roster at ${employee.phoneE164}, and read the number back so a wrong digit is caught now. ` +
      availabilityNote(employee) +
      smsReachWarning(employee.phoneE164)
  };
}
