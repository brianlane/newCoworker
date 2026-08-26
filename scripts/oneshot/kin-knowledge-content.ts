/**
 * kin-knowledge-content.ts: the REACTIVE half of KIN's booking-link routing.
 *
 * The flow (kin-lead-definition.ts) routes the first proactive text on
 * whatever the Meta lead form captured. The moment a lead REPLIES, the SMS
 * coworker takes over, which is Kingsley's stated plan: "text leads with
 * these links and follow up only if they do not reply. If they reply the ai
 * worker will nurture or assist them as needed."
 *
 * Before this, KIN's identity.md and soul.md contained NO booking links at
 * all, so a lead who answered "it's for OT" met a coworker that knew OT was
 * offered and had nothing to send. That is the dead end this closes.
 *
 * Also repairs two things the white-glove apply left in soul.md: the
 * greeting pasted verbatim from the intake with its typos ("on you healing
 * journey", "l'll" with a lowercase L), and a qualification list that names
 * disciplines without saying what to do once the lead answers.
 *
 * Pure builders; patch-kin-knowledge.ts writes them.
 */
import {
  KIN_BOOKING_SERVICES,
  KIN_COUNSELLING_AGES,
  KIN_COUPLES_BOOKING_LINK,
  KIN_GENERAL_BOOKING_LINK
} from "./kin-booking-links.ts";

/** Replace one `## Heading` section's body, leaving the rest byte-identical. */
export function replaceMarkdownSection(doc: string, heading: string, body: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return doc;

  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ") && !lines[end].startsWith("<!--")) {
    end += 1;
  }
  return [...lines.slice(0, start + 1), ...body.split("\n"), "", ...lines.slice(end)].join("\n");
}

/** The booking-link table, rendered for the coworker's business knowledge. */
export function buildKinBookingLinksSection(): string {
  const disciplines = KIN_BOOKING_SERVICES.filter(
    (s) => s.link !== KIN_GENERAL_BOOKING_LINK
  ).map((s) => `- ${s.label}: ${s.link}`);
  const ages = KIN_COUNSELLING_AGES.map((a) => `- ${a.label}: ${a.link}`);
  return [
    "Send the booking page that matches what the family needs. Paste the link on its own",
    "line, never with a period straight after it.",
    "",
    ...disciplines,
    ...ages,
    `- Couples counselling: ${KIN_COUPLES_BOOKING_LINK}`,
    `- Anything else, or not sure yet: ${KIN_GENERAL_BOOKING_LINK}`,
    "",
    "Rules that decide which one. The lead flow only recognises the plainest wording, so",
    "anything phrased differently reaches you instead. Read what the family means:",
    "- Occupational therapy, OT, sensory, motor skills, handwriting, feeding: the OT page.",
    "  An OT assessment is still OT, not a psychological assessment.",
    "- Psychological assessment, psychoed assessment, ADHD or autism testing, a school or",
    "  funding report: the psychological assessment page.",
    "- The word assessment ON ITS OWN does not tell you which. OT, speech and psychology all",
    "  run assessments, so ask what kind before sending a link.",
    "- COUNSELLING IS SPLIT BY AGE, and the pages turn away the wrong age group. Ages 3 to 12",
    "  book the child page, 13 to 17 the teen and youth page, and grown-ups the adult page.",
    "  If you do not know the age, ASK before sending a counselling link. Never guess.",
    "- Two adults wanting counselling together: the couples page.",
    "- Speech therapy or SLP: there is no online booking page for speech. Do not invent one.",
    "  Take their details, tell them the clinic will call to arrange it, and alert the team.",
    "- Nurse practitioner, behaviour consulting, or several services at once: the general page.",
    "- If they have already booked, do not resend a link. Confirm and offer to answer questions."
  ].join("\n");
}

/** identity.md with a Booking Links section added or refreshed. */
export function buildKinIdentityMd(current: string): string {
  const section = buildKinBookingLinksSection();
  if (current.includes("## Booking Links")) {
    return replaceMarkdownSection(current, "Booking Links", section);
  }
  // Insert after Offerings so the links sit beside the services they book.
  const lines = current.split("\n");
  const offerings = lines.findIndex((l) => l.trim() === "## Offerings");
  if (offerings === -1) {
    return `${current.trimEnd()}\n\n## Booking Links\n${section}\n`;
  }
  let end = offerings + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end += 1;
  return [
    ...lines.slice(0, end),
    "## Booking Links",
    ...section.split("\n"),
    "",
    ...lines.slice(end)
  ].join("\n");
}

/**
 * The corrected first-message and qualification block for soul.md.
 *
 * Kept inside the existing white-glove markers so re-running the white-glove
 * apply does not silently resurrect the typos underneath this.
 */
export function buildKinFirstMessageBlock(): string {
  return [
    "### First message & qualification",
    '- Meta lead-form leads are handled by the "Lead follow-up (white-glove build)" AiFlow,',
    "  not improvised. That flow sends the booking page for whatever discipline the lead form",
    "  named, or the general page with a question when it did not say.",
    "- For every other inbound, and for every reply to that flow, greet warmly, name the",
    "  clinic, and move toward booking the free 15 minute consult.",
    "- Ask AT MOST these questions before booking (fewer questions means fewer leads lost):",
    "  1. Is this appointment for yourself or someone else?",
    "  2. What would you like to come in for: occupational therapy, speech, counselling,",
    "     a psychological assessment, or behaviour consulting?",
    "  3. Do you prefer mornings, afternoons, or evenings?",
    "- As soon as you know the discipline, send the matching booking link from identity.md",
    "  under Booking Links. That is the whole job: the link is how they book.",
    "- If the lead asks to talk to someone, stop asking questions and hand off immediately."
  ].join("\n");
}

/** soul.md with the corrected first-message block. */
export function buildKinSoulMd(current: string): string {
  const start = current.indexOf("### First message & qualification");
  if (start === -1) return current;
  let end = current.indexOf("\n### ", start + 1);
  if (end === -1) end = current.indexOf("\n<!-- white-glove-build:end", start + 1);
  if (end === -1) return current;
  return current.slice(0, start) + buildKinFirstMessageBlock() + current.slice(end);
}
