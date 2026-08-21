/**
 * Derive a Zoom transcript document title from what the transcript itself
 * carries, rather than from Zoom's meeting topic.
 *
 * Zoom's default topics are shared across every instant meeting, so imports
 * collided in the Documents grid: several rows all reading "New Coworker's
 * Zoom Meeting", or the bare "Zoom meeting recording (transcript)" when the
 * past-meeting metadata call failed. Neither tells the owner which call it
 * was.
 *
 * The transcript already knows two useful things: who was on the call
 * (speaker labels in the VTT) and what it was about (the first heading of the
 * generated minutes). Combined they give "Bobby Platform & Product Overview
 * Zoom meeting recording".
 *
 * Everything here is pure and input-only: no DB, no clock, no env. The
 * caller decides whether the derived title beats the provisional one.
 */

export const ZOOM_GUEST_TITLE_SUFFIX = "Zoom meeting recording";

/** Longest title we will write, matching the documents table's practical cap. */
const MAX_TITLE_LENGTH = 200;

/**
 * Zoom's own defaults, which carry no information about the call.
 *
 * Matched as whole strings (after stripping a leading "<owner>'s") so a
 * deliberate topic that merely contains the words, like "Zoom Meeting with
 * the Ashby team", is still treated as real.
 */
const GENERIC_TOPICS = new Set([
  "zoom meeting",
  "personal meeting room",
  "zoom meeting recording",
  "zoom meeting recording (transcript)",
  "my meeting"
]);

/**
 * Strip the decoration a provisional title carries back to Zoom's raw topic.
 *
 * Provisional titles come in several shapes depending on which metadata the
 * import had: "<topic> · <date> (transcript)", "<topic> (transcript)", and
 * older rows written as "<topic> - transcript" with a dash. All of it is our
 * formatting, not the host's words, so it has to come off before judging
 * whether the topic itself is generic.
 */
export function zoomTopicFromTitle(title: string): string {
  return title
    .replace(/\s*[(\[]transcript[)\]]\s*$/i, "")
    .replace(/\s*[-–—:]\s*transcript\s*$/i, "")
    .replace(/\s*·.*$/, "")
    .trim();
}

/** True when Zoom's topic is a default that says nothing about the call. */
export function isGenericZoomTopic(topic: string | null | undefined): boolean {
  const trimmed = (topic ?? "").trim();
  if (trimmed === "") return true;
  // "New Coworker's Zoom Meeting" / "Brian Lane's Personal Meeting Room":
  // the possessive prefix is the account name, not a subject.
  const withoutOwner = trimmed.replace(/^.*?['’]s\s+/, "");
  return (
    GENERIC_TOPICS.has(trimmed.toLowerCase()) ||
    GENERIC_TOPICS.has(withoutOwner.toLowerCase())
  );
}

/**
 * Speaker labels from `vttToPlainText` output, in first-spoken order.
 *
 * That helper emits `Speaker: words` lines, so this reads the prefix before
 * the first colon. A length cap keeps prose containing a colon ("about our
 * pricing: it is per seat") from being read as a name.
 */
export function extractVttSpeakers(plainText: string): string[] {
  const seen = new Set<string>();
  const speakers: string[] = [];
  for (const line of plainText.split(/\r\n?|\n/)) {
    const match = line.match(/^\s*([^:]{1,60}?)\s*:\s+\S/);
    if (!match) continue;
    const name = match[1].trim();
    // A real speaker label is a short name, not a clause.
    if (name === "" || name.split(/\s+/).length > 4) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    speakers.push(name);
  }
  return speakers;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The first speaker who is not the host.
 *
 * Prefers a nickname the minutes introduce, because Zoom shows the legal
 * name on the tile while the summary reflects what people were actually
 * called: `Alexander ("Bobby")` becomes "Bobby". Otherwise the first token
 * of the display name, since "Alexander Delacroix Zoom meeting recording"
 * reads worse than "Alexander Zoom meeting recording".
 */
export function pickZoomGuestName(input: {
  speakers: string[];
  hostNames: string[];
  summary?: string | null;
}): string | null {
  const guest = pickZoomGuestSpeaker(input);
  if (!guest) return null;
  return findNickname(guest, input.summary ?? null) ?? firstNameOf(guest);
}

/**
 * The guest's speaker label as Zoom recorded it, WHOLE and untrimmed of
 * anything but whitespace: "Kingsley Moyo", not "Kingsley".
 *
 * Split out from {@link pickZoomGuestName} because the two callers want
 * opposite things from the same person. A title wants the short, friendly
 * form, so that function shortens to a first name or a nickname. An IDENTITY
 * lookup wants the full string: a contact is stored as "Kingsley Moyo", and
 * matching a first name against it either misses entirely (an anchored
 * compare) or matches too much (a prefix compare, where "Dave" also finds
 * "Dave's Plumbing"). Meeting attribution uses this one.
 */
export function pickZoomGuestSpeaker(input: {
  speakers: string[];
  hostNames: string[];
}): string | null {
  const hosts = new Set(input.hostNames.map(normalizeName).filter((n) => n !== ""));
  const guest = input.speakers.find((speaker) => !hosts.has(normalizeName(speaker)));
  return guest ? guest.trim() : null;
}

/**
 * The leading token of a display name. Callers only pass a non-empty,
 * already-trimmed name, so there is always one.
 */
function firstNameOf(name: string): string {
  return name.split(/\s+/)[0] as string;
}

/** `Alexander ("Bobby")` or `Alexander ('Bobby')` anywhere in the summary. */
function findNickname(speaker: string, summary: string | null): string | null {
  if (!summary) return null;
  const escaped = firstNameOf(speaker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `${escaped}[^("“]*[("“]+\\s*["'“]?([^"'”)]+)["'”]?\\s*\\)?`,
    "i"
  );
  const match = summary.match(pattern);
  const nickname = match?.[1]?.trim();
  if (!nickname) return null;
  // Guard against swallowing a sentence when the summary just uses brackets.
  if (nickname.split(/\s+/).length > 2) return null;
  return nickname;
}

/**
 * The first `#`/`##`/`###` heading of the minutes, which is the section the
 * model chose to open with and reads as the subject of the call.
 *
 * Stops at the `## Transcript` marker: everything below it is the raw
 * dialogue, whose headings are not a summary of anything.
 */
export function extractFirstMinutesHeading(contentMd: string): string | null {
  for (const line of contentMd.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+transcript\b/i.test(trimmed)) return null;
    const match = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (!match) continue;
    const heading = (match[2] as string).trim().replace(/\s*#+\s*$/, "");
    if (heading !== "") return heading;
  }
  return null;
}

/**
 * `{guest} {heading} Zoom meeting recording`, using whichever halves exist.
 *
 * Returns null when neither is known, which tells the caller to keep the
 * provisional Zoom-topic title rather than write a bare suffix.
 */
export function buildZoomGuestHeadingTitle(input: {
  guest: string | null;
  heading: string | null;
}): string | null {
  const guest = (input.guest ?? "").trim();
  const heading = (input.heading ?? "").trim();
  if (guest === "" && heading === "") return null;

  const lead = [guest, heading].filter((part) => part !== "").join(" ");
  const full = `${lead} ${ZOOM_GUEST_TITLE_SUFFIX}`;
  if (full.length <= MAX_TITLE_LENGTH) return full;

  // Trim the lead, not the suffix: the suffix is what makes the row
  // recognisable as a Zoom import at a glance.
  const room = MAX_TITLE_LENGTH - ZOOM_GUEST_TITLE_SUFFIX.length - 1;
  const clipped = lead.slice(0, room).replace(/\s+\S*$/, "").trim();
  return `${clipped} ${ZOOM_GUEST_TITLE_SUFFIX}`;
}
