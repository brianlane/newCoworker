/**
 * Who was this meeting with?
 *
 * Everything the classifier decides is applied to a PERSON, so this answer
 * has to be right or absent. A wrong match staples a note, a stage move and
 * a set of to-dos onto a stranger's record, which is worse than doing
 * nothing at all. Four sources, strongest first, and each one either
 * produces a confident answer or hands over to the next:
 *
 *   1. THE BOOKING LEDGER. The booking that created the Zoom meeting already
 *      recorded its attendee, so a transcript carrying that meeting id
 *      resolves deterministically. No guessing, no model. This covers every
 *      meeting the platform booked, which is the case this feature is for.
 *   2. AN EMAIL IN THE TRANSCRIPT. People read addresses out loud and Zoom
 *      transcribes them. An address is an identity, so a linked contact is a
 *      confident match.
 *   3. A SPEAKER NAME. Ambiguous in a way the first two are not, so it
 *      carries an extra rule: a name resolves ONLY when exactly one contact
 *      carries it. Two Daves means nobody.
 *   4. A NAME THE HOST USED. Zoom labels every line with the ACCOUNT's
 *      display name, so a guest on a shared or stale account speaks under
 *      somebody else's name and source 3 finds nobody. Our own side still
 *      addressed them correctly on the call ("Hey, Bobby"), so host-spoken
 *      vocatives are read last, under the same unique-contact rule.
 *
 * Never throws: a lookup blip means "unattributed", and an unattributed
 * meeting still becomes a document in the library.
 */
import { findBookingByZoomMeetingId } from "@/lib/calendar-tools/booking-dedupe";
import { getCustomerMemory, findCustomerByEmail } from "@/lib/customer-memory/db";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { extractVttSpeakers, pickZoomGuestSpeaker } from "@/lib/zoom/document-title";
import { extractHostAddressedNames } from "./rename-guest";
import type { MeetingMatchSource } from "./outcome-core";
import { vttToPlainText } from "@/lib/transcripts/vtt";
import { emailContactKey } from "../../../supabase/functions/_shared/contact_key";
import { logger } from "@/lib/logger";

/**
 * How the contact was identified, carried into the logs for traceability.
 *
 * Derived from the applier's own union rather than restated, so the two can
 * never drift into disagreeing about what a match source is. `owner` is
 * excluded here on purpose: it means a person answered the question, which
 * is not something this resolver can ever conclude.
 */
export type MeetingContactMatch = Exclude<MeetingMatchSource, "owner">;

export type ResolvedMeetingContact = {
  /** `contacts.id`, the FK every write here needs. */
  contactId: string;
  /** `contacts.customer_e164`: an E.164 number OR an `email:` key. */
  contactKey: string;
  matchedOn: MeetingContactMatch;
};

export type ResolveMeetingContactInput = {
  businessId: string;
  /** Zoom's numeric meeting id, when the import knew it. */
  zoomMeetingId: string | null;
  /** The raw WebVTT, for the three fallbacks. */
  vtt: string;
  /** Names that count as "us", so a fallback never matches our own side. */
  hostNames: string[];
};

export type ResolveMeetingContactDeps = {
  findBooking?: typeof findBookingByZoomMeetingId;
  getContact?: typeof getCustomerMemory;
  findByEmail?: typeof findCustomerByEmail;
  /** Unique display-name lookup; injected in tests. */
  findByName?: (businessId: string, name: string) => Promise<string | null>;
};

/**
 * The CONTACT key behind a booking ledger's attendee key, or null.
 *
 * These are two different namespaces and conflating them silently resolves
 * nobody. `bookingAttendeeKey` writes `phone:+1...`, `email:x@y`, `name:...`
 * or `anonymous`, while `contacts.customer_e164` holds a BARE `+1...` or an
 * `email:x@y`. So the phone shape must lose its prefix and the email shape
 * must keep its own, which is exactly the sort of near-miss that looks
 * correct in a test whose fake accepts whatever it is handed.
 *
 * `name:` and `anonymous` return null: neither is an identity, and a name
 * goes through the unique-name rule like any other.
 */
export function contactKeyFromAttendeeKey(attendeeKey: string): string | null {
  const key = attendeeKey.trim();
  if (key.startsWith("phone:")) {
    const number = key.slice("phone:".length).trim();
    return number || null;
  }
  if (key.startsWith("email:")) {
    // Re-validate rather than trusting the ledger's own normalization: this
    // is the gate that decides an address can be a contact key at all.
    return emailContactKey(key.slice("email:".length)) ?? null;
  }
  return null;
}

/** Addresses spoken or pasted into a meeting, lowercased and de-duped. */
const EMAIL_IN_TEXT_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function extractTranscriptEmails(plainText: string): string[] {
  const found = plainText.match(EMAIL_IN_TEXT_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    // Trailing sentence punctuation rides along in speech transcripts.
    const address = raw.trim().toLowerCase().replace(/[.,;:]+$/, "");
    // Reuse the contact-key validator rather than trusting the regex: it is
    // the same gate that decides whether an address can BE a contact key.
    if (!emailContactKey(address)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/**
 * The single contact carrying this display name, or null.
 *
 * Null when nobody matches AND when more than one does: a name is not an
 * identity, and picking one of two Daves would be a coin flip whose loser
 * gets a stranger's meeting notes filed on their record.
 */
export async function findContactIdByUniqueName(
  businessId: string,
  name: string
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  try {
    const db = await createSupabaseServiceClient();
    // Case-insensitive equality, via ilike with the LIKE metacharacters
    // ESCAPED. Unescaped, `_` matches any single character and `%` matches
    // anything, so a Zoom display name like "dave_smith" would also match a
    // different contact and file this meeting on them. Same escape the
    // address lookups use (emailIlikePattern, findCustomerByEmail).
    const pattern = trimmed.replace(/[%_\\]/g, (m) => `\\${m}`);
    const { data, error } = await db
      .from("contacts")
      .select("id, display_name")
      .eq("business_id", businessId)
      .ilike("display_name", pattern)
      .limit(2);
    if (error) return null;
    const rows = (data ?? []) as Array<{ id: string; display_name: string | null }>;
    if (rows.length !== 1) return null;
    // Re-verify in JS so the result can never be a wildcard false positive,
    // the same belt-and-braces findCustomerByEmail applies.
    const matched = rows[0];
    if ((matched.display_name ?? "").trim().toLowerCase() !== trimmed.toLowerCase()) {
      return null;
    }
    return matched.id;
  } catch (err) {
    logger.warn("meeting contact: name lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Load a contact row by key and shape it as a resolution, or null. */
async function resolveByKey(
  businessId: string,
  key: string,
  matchedOn: MeetingContactMatch,
  getContact: NonNullable<ResolveMeetingContactDeps["getContact"]>
): Promise<ResolvedMeetingContact | null> {
  try {
    const row = await getContact(businessId, key);
    if (!row?.id || !row.customer_e164) return null;
    return { contactId: row.id, contactKey: row.customer_e164, matchedOn };
  } catch (err) {
    logger.warn("meeting contact: key lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function resolveMeetingContact(
  input: ResolveMeetingContactInput,
  deps: ResolveMeetingContactDeps = {}
): Promise<ResolvedMeetingContact | null> {
  /* c8 ignore start -- production defaults; tests inject */
  const findBooking = deps.findBooking ?? findBookingByZoomMeetingId;
  const getContact = deps.getContact ?? getCustomerMemory;
  const findByEmail = deps.findByEmail ?? findCustomerByEmail;
  const findByName = deps.findByName ?? findContactIdByUniqueName;
  /* c8 ignore stop */
  const { businessId } = input;

  // 1. The booking ledger.
  if (input.zoomMeetingId) {
    const booking = await findBooking(businessId, input.zoomMeetingId);
    if (booking) {
      // Translated, not passed through: see contactKeyFromAttendeeKey.
      const ledgerKey = contactKeyFromAttendeeKey(booking.attendeeKey);
      if (ledgerKey) {
        const byKey = await resolveByKey(businessId, ledgerKey, "booking_ledger", getContact);
        if (byKey) return byKey;
      }
      // A booking taken by phone can still carry the address the invite went
      // to, and the contact may be keyed by that instead.
      if (booking.attendeeEmail) {
        const viaEmail = await resolveLinkedEmail(
          businessId,
          booking.attendeeEmail,
          "booking_ledger",
          getContact,
          findByEmail
        );
        if (viaEmail) return viaEmail;
      }
    }
  }

  const plain = vttToPlainText(input.vtt);

  // 2. An address spoken in the meeting.
  for (const address of extractTranscriptEmails(plain)) {
    const viaEmail = await resolveLinkedEmail(
      businessId,
      address,
      "transcript_email",
      getContact,
      findByEmail
    );
    if (viaEmail) return viaEmail;
  }

  // 3. The guest's speaker name, when exactly one contact carries it.
  //    The WHOLE label ("Kingsley Moyo"), not the title-shaped first name
  //    pickZoomGuestName returns: contacts store full names, so an anchored
  //    compare against "Kingsley" never matches one.
  const guest = pickZoomGuestSpeaker({
    speakers: extractVttSpeakers(plain),
    hostNames: input.hostNames
  });
  if (guest) {
    const contactId = await findByName(businessId, guest);
    if (contactId) {
      const key = await contactKeyForId(businessId, contactId);
      if (key) return { contactId, contactKey: key, matchedOn: "speaker_name" };
    }
  }

  // 4. A name the HOST addressed the guest by. Last, because it is a
  //    reading of speech rather than a label, but it is the source that
  //    survives a wrong Zoom display name: someone joining from an account
  //    named for somebody else is still called by their own name on the
  //    call ("Hey, Bobby"). Same unique-contact rule as the speaker label,
  //    and `extractHostAddressedNames` only reads OUR side's lines, so a
  //    guest naming a third party never lands here.
  for (const addressed of extractHostAddressedNames(input.vtt, input.hostNames)) {
    const contactId = await findByName(businessId, addressed);
    if (contactId) {
      const key = await contactKeyForId(businessId, contactId);
      if (key) return { contactId, contactKey: key, matchedOn: "addressed_name" };
    }
  }

  return null;
}

/**
 * Resolve an address two ways: as a contact KEY (an email-only contact is
 * keyed by it) and as a LINKED address on a phone-keyed profile. Both are
 * the same person; which one exists depends on how they first arrived.
 */
async function resolveLinkedEmail(
  businessId: string,
  address: string,
  matchedOn: MeetingContactMatch,
  getContact: NonNullable<ResolveMeetingContactDeps["getContact"]>,
  findByEmail: NonNullable<ResolveMeetingContactDeps["findByEmail"]>
): Promise<ResolvedMeetingContact | null> {
  const key = emailContactKey(address);
  if (key) {
    const direct = await resolveByKey(businessId, key, matchedOn, getContact);
    if (direct) return direct;
  }
  try {
    const linked = await findByEmail(businessId, address);
    if (!linked) return null;
    return await resolveByKey(businessId, linked.customerE164, matchedOn, getContact);
  } catch (err) {
    logger.warn("meeting contact: email lookup threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** The contact key behind an id, for the name path which matched on id. */
async function contactKeyForId(
  businessId: string,
  contactId: string
): Promise<string | null> {
  try {
    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("contacts")
      .select("customer_e164")
      .eq("business_id", businessId)
      .eq("id", contactId)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { customer_e164: string | null }).customer_e164 ?? null;
  } catch {
    return null;
  }
}
