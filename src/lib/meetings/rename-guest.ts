/**
 * Correcting the guest's name on an imported meeting: the pure half.
 *
 * Zoom labels every line of a transcript with the account's DISPLAY name,
 * not the person's. When someone joins from a shared, stale, or legal-name
 * account, every downstream artifact inherits that wrong name: the document
 * title, the retrieval summary, the condensed minutes, the raw dialogue, and
 * the knowledge-graph person node. The owner knows who was actually on the
 * call, so the fix is a rename driven by their answer, not another guess.
 *
 * Everything here is input-only: no DB, no clock, no env, no model. Same
 * posture as `src/lib/zoom/document-title.ts` and
 * `src/lib/meetings/outcome-core.ts`.
 */
import {
  extractVttSpeakers,
  pickZoomGuestSpeaker,
  ZOOM_GUEST_TITLE_SUFFIX
} from "@/lib/zoom/document-title";
import { vttToPlainText } from "@/lib/transcripts/vtt";

/**
 * Shortest name this module will rewrite on its own.
 *
 * A two-character token ("Al", "Jo") appears inside ordinary words often
 * enough that even a word-boundary match is a coin flip, and this rewrite
 * runs over a whole transcript. The full name is still rewritten at any
 * length; this floor only governs the derived first-name pass.
 */
export const MIN_RENAMEABLE_NAME_CHARS = 3;

/** Regex-safe form of an arbitrary display name. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace one whole-word name with another, case-insensitively.
 *
 * Word-boundary anchored, so "Alexander" is rewritten inside "Alexander's"
 * (the possessive is the same person) but never inside "Alexandra" (a
 * different one). The REPLACEMENT is written verbatim rather than
 * case-matched to what it replaced: the owner picked the contact, so the
 * contact's own capitalization is the correct answer everywhere.
 */
export function replaceWholeWord(text: string, from: string, to: string): string {
  const needle = from.trim();
  if (needle === "") return text;
  return text.replace(new RegExp(`\\b${escapeRegex(needle)}\\b`, "gi"), to);
}

/**
 * Every form of the wrong name that should be rewritten, longest first.
 *
 * Zoom's display name is often the legal full name ("Alexander Delacroix")
 * while the minutes and the dialogue use the first name alone, so a rename
 * that only handled the full string would leave most of the document wrong.
 * Longest-first ordering matters: rewriting "Alexander" before "Alexander
 * Delacroix" would strand the surname.
 *
 * The derived first name is dropped when it is too short to match safely
 * (see {@link MIN_RENAMEABLE_NAME_CHARS}) or when it collides with a host
 * name, since rewriting the host's own name would corrupt the record of who
 * said what.
 */
export function guestNameVariants(wrongName: string, hostNames: string[] = []): string[] {
  const full = wrongName.trim();
  if (full === "") return [];
  const variants = [full];
  const tokens = full.split(/\s+/);
  if (tokens.length > 1) {
    const first = tokens[0] as string;
    const hosts = new Set(
      hostNames.flatMap((name) => name.trim().toLowerCase().split(/\s+/)).filter((n) => n !== "")
    );
    if (first.length >= MIN_RENAMEABLE_NAME_CHARS && !hosts.has(first.toLowerCase())) {
      variants.push(first);
    }
  }
  return variants.sort((a, b) => b.length - a.length);
}

/**
 * Rewrite every occurrence of the guest's wrong name in a block of text.
 *
 * Used on the title, the summary, and the condensed minutes (which carry the
 * raw dialogue underneath, speaker labels included, so the transcript half
 * is corrected by the same pass).
 */
export function renameGuestInText(
  text: string,
  wrongName: string,
  rightName: string,
  hostNames: string[] = []
): string {
  const replacement = rightName.trim();
  if (replacement === "") return text;
  let out = text;
  for (const variant of guestNameVariants(wrongName, hostNames)) {
    out = replaceWholeWord(out, variant, replacement);
  }
  return out;
}

/**
 * The name the import filed this meeting under, or null.
 *
 * Two sources, in the order that answers most confidently:
 *
 *   1. THE TITLE. `buildZoomGuestHeadingTitle` writes "{guest} {heading}
 *      Zoom meeting recording", so the guest is the leading token of a
 *      title carrying that suffix. This is the name the owner is actually
 *      looking at when they decide the document is wrong.
 *   2. THE SPEAKER LABELS. Whoever spoke who is not us, exactly as Zoom
 *      recorded them ("Alexander", "Alexander Delacroix"). This is the
 *      fuller string, and the one that appears throughout the dialogue.
 *
 * The title wins on the leading token but the speaker label is preferred
 * when it EXTENDS it, so "Alexander" from the title yields to "Alexander
 * Delacroix" from the transcript and the surname gets rewritten too.
 */
export function deriveWrongGuestName(input: {
  title: string;
  vtt: string;
  hostNames: string[];
}): string | null {
  const fromSpeakers = pickZoomGuestSpeaker({
    speakers: extractVttSpeakers(vttToPlainText(input.vtt)),
    hostNames: input.hostNames
  });
  const fromTitle = guestNameFromTitle(input.title);
  if (fromTitle && fromSpeakers) {
    // Same person named two ways: keep the longer, it rewrites more.
    const speakerFirst = (fromSpeakers.split(/\s+/)[0] as string).toLowerCase();
    if (speakerFirst === fromTitle.toLowerCase()) return fromSpeakers;
    return fromTitle;
  }
  return fromTitle ?? fromSpeakers;
}

/**
 * The leading token of a guest-titled Zoom document, or null.
 *
 * Only titles carrying the import's own suffix are read: any other title is
 * something the owner wrote, and its first word is not a name we may act on.
 */
export function guestNameFromTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed.toLowerCase().endsWith(ZOOM_GUEST_TITLE_SUFFIX.toLowerCase())) return null;
  const lead = trimmed.slice(0, trimmed.length - ZOOM_GUEST_TITLE_SUFFIX.length).trim();
  if (lead === "") return null;
  // `lead` is trimmed and non-empty, so its first whitespace-split token is
  // always a real word.
  return lead.split(/\s+/)[0] as string;
}

/**
 * Names the HOST addressed someone by, in the order they were said.
 *
 * The narrow, high-confidence half of "who was actually on this call".
 * Zoom's speaker label can be wrong, but the host saying "Hey, Bobby" is
 * the host naming the person in front of them, and that line is in the
 * transcript verbatim. Two rules keep it honest:
 *
 *   1. ONLY host-spoken lines are read. A guest saying "Brian" names US,
 *      and a guest naming a third party names somebody who was not there.
 *   2. ONLY comma-delimited vocatives count: "Hey, Bobby.", "Bobby, can I
 *      ask you something?", "Thanks, Bobby". A bare capitalized word in the
 *      middle of a sentence is as likely to be a company, a city, or a
 *      product, and this feeds contact attribution.
 *
 * Returns candidate names only. The caller decides whether a name is an
 * identity, under the same unique-contact rule every other name-based match
 * here obeys.
 */
export function extractHostAddressedNames(vtt: string, hostNames: string[]): string[] {
  // Two different sets from the same input. A speaker LABEL is the whole
  // display name ("Brian Lane:"), while a vocative is a single first name
  // ("Thanks, Brian."), so excluding our own side needs the tokens too:
  // otherwise the host thanking a colleague by first name offers that name
  // as the guest, and a contact who shares it collects the meeting (Bugbot,
  // PR #1618). `guestNameVariants` already tokenizes for the same reason.
  const hostLabels = new Set(
    hostNames.map((name) => name.trim().toLowerCase()).filter((name) => name !== "")
  );
  const hostTokens = new Set(
    hostNames
      .flatMap((name) => name.trim().toLowerCase().split(/\s+/))
      .filter((token) => token !== "")
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of vttToPlainText(vtt).split(/\r\n?|\n/)) {
    // Same speaker-label shape `extractVttSpeakers` reads, so the two
    // helpers can never disagree about which lines are dialogue.
    const speakerSplit = line.match(/^\s*([^:]{1,60}?)\s*:\s+(\S.*)$/);
    if (!speakerSplit) continue;
    const speaker = (speakerSplit[1] as string).trim().toLowerCase();
    if (!hostLabels.has(speaker)) continue;
    for (const name of vocativeNames(speakerSplit[2] as string)) {
      const key = name.toLowerCase();
      // Never surface a name from our own side: "Thanks, Brian" is one
      // teammate to another, not the host addressing the guest.
      if (hostTokens.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/**
 * Words that open a sentence and take a comma, but are not names.
 *
 * Speech is full of these ("Hey, Bobby", "Wait, before we continue, Bobby"),
 * and the leading-vocative shape matches them exactly as well as it matches
 * a real name. Without this list the very sentence that names the guest also
 * offers "Hey" and "Wait" as candidates. They would almost always fail the
 * unique-contact lookup downstream, but "almost always" is not a rule, and a
 * contact really called "Sorry" or "Right" should not be able to collect
 * somebody else's meeting.
 */
const DISCOURSE_MARKERS = new Set([
  "actually",
  "again",
  "alright",
  "and",
  "anyway",
  "but",
  "first",
  "good",
  "great",
  "hello",
  "hey",
  "honestly",
  "instead",
  "listen",
  "look",
  "meanwhile",
  "no",
  "now",
  "okay",
  "please",
  "right",
  "sorry",
  "still",
  "sure",
  "thanks",
  "then",
  "true",
  "wait",
  "well",
  "yeah",
  "yes",
  "yep"
]);

/**
 * Capitalized names sitting in a vocative slot inside one line of speech.
 *
 * Two shapes, both requiring a comma on the side that faces the sentence:
 *   `..., Bobby.`  (trailing address: greeting, thanks, sign-off)
 *   `Bobby, can ...` (leading address, at the start of a sentence)
 */
function vocativeNames(text: string): string[] {
  const names: string[] = [];
  const trailing = /,\s+([A-Z][a-z]{2,20})(?=\s*[,.!?]|\s*$)/g;
  const leading = /(?:^|[.!?]\s+)([A-Z][a-z]{2,20}),/g;
  for (const re of [trailing, leading]) {
    let match = re.exec(text);
    while (match) {
      const candidate = match[1] as string;
      if (!DISCOURSE_MARKERS.has(candidate.toLowerCase())) names.push(candidate);
      match = re.exec(text);
    }
  }
  return names;
}
