/**
 * Prospecting: composing the pitch.
 *
 * Two rules shape this module.
 *
 * ONE: the email may only claim what a probe finding recorded. The opening
 * line is built FROM a finding, so it is always checkable by the person
 * reading it. A prospect with no findings is not pitched at all.
 *
 * TWO: the compliance footer is assembled in code, after any AI polish, and
 * the polish never sees it. Gemini rewrites the middle paragraphs for tone
 * only; the unsubscribe link, the postal address, and the links are
 * concatenated deterministically around whatever comes back. A model cannot
 * drop, reword, or "improve" a legal requirement it is never shown.
 *
 * The pitch is tenant-aware: what the business does and what it is asking for
 * come from the tenant's own settings and profile, so the same machinery sells
 * an AI coworker for our HQ tenant and something else entirely for the next
 * one.
 */

import { geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { NO_EM_DASH_PROMPT_LINE } from "../../../supabase/functions/_shared/sms_prompt_lines";
import type { ProbeFinding } from "./probe";

/** Model for the tone pass: cheap, and the structure is already decided. */
export const PITCH_POLISH_MODEL = "gemini-3.5-flash-lite";

/** Telemetry label for the AI-spend ledger. */
export const PITCH_POLISH_SURFACE = "outreach_pitch";

/** Ceiling on the polished body, so one odd response cannot produce an essay. */
export const PITCH_POLISH_MAX_TOKENS = 500;

export type PitchTenant = {
  name: string;
  /** One or two sentences on what the tenant does. */
  valueProp: string;
  website: string | null;
  /** Where the reader is asked to book time, when the tenant has a page. */
  bookingUrl: string | null;
  /** Who signs the mail. Falls back to the business name. */
  senderName: string | null;
  /**
   * CAN-SPAM postal address, printed verbatim in the footer. Empty only for a
   * tier the platform exempts (Enterprise) that has no address on file
   * anywhere; the footer then prints the unsubscribe line alone rather than a
   * blank line where an address should be.
   */
  postalAddress: string;
};

export type PitchProspect = {
  businessName: string;
  city: string;
  findings: ProbeFinding[];
};

export type ComposedPitch = { subject: string; body: string };

/**
 * Subject per finding code. Concrete and non-deceptive (CAN-SPAM): the subject
 * names the thing the email is actually about.
 */
const SUBJECT_BY_FINDING: Record<string, string> = {
  no_online_booking: "booking a job without the phone tag",
  no_chat_widget: "the questions your site visitors do not ask",
  no_text_option: "the customers who would rather text",
  no_tap_to_call: "one tap to call you",
  closed_weekends: "the weekend calls nobody hears",
  after_hours_gap: "the calls that come in after you close"
};

/** Opening clause per finding, phrased as the observation it came from. */
const OBSERVATION_BY_FINDING: Record<string, string> = {
  no_online_booking:
    "there is no way to book you online, so every appointment starts with a phone call or a form",
  no_chat_widget:
    "there is no chat on the site, so a visitor with a quick question has to pick up the phone",
  no_text_option: "there is no way to text you from the site",
  no_tap_to_call: "the phone number is not tappable on a phone, so it has to be copied out by hand",
  // The two hours openings are phrased WITHOUT naming a source, because the
  // evidence can come from the prospect's markup or from their Google listing
  // (see hoursFindings). "The site says you are closed at the weekend" would be
  // a claim about their site that is false whenever Google supplied the fact,
  // and a cold email that opens by getting something wrong is finished.
  closed_weekends: "you are closed at the weekend",
  after_hours_gap: "your hours end in the afternoon"
};

/**
 * What the gap costs, one sentence per finding, appended to the observation.
 *
 * The observation alone is an interesting fact about somebody's website. It is
 * the cost line that makes it worth answering: what usually happens to the
 * person on the other side of that gap, and where they go instead. Without it
 * the mail reads as a feature list bolted onto a compliment.
 *
 * Every line here describes GENERAL behaviour, never this prospect. No
 * percentages, no revenue figures, no "you are losing N calls a week". Those
 * are the sentences a cold email most wants to write and least deserves to: we
 * probed their site, we did not measure their phone. An invented number is also
 * the fastest way to be caught out by the one reader who knows the real one.
 */
const COST_BY_FINDING: Record<string, string> = {
  // "Either way" because the observation names two routes in, a call and a
  // form. A cost line that answers only the call contradicts the sentence it
  // is sitting next to.
  no_online_booking:
    "Either way the job waits on somebody getting back to them, and people who are still deciding rarely wait long.",
  no_chat_widget:
    "Plenty of people will not make a call over one question, so the question goes unasked and so does the job.",
  // Says nothing about what else is on their page: the finding establishes that
  // texting is missing, not that nothing else is there.
  no_text_option:
    "Plenty of people will not ring somewhere they have never used before, and they will not chase a business for the chance to spend money.",
  no_tap_to_call:
    "On a phone that is enough friction to lose a call that was one tap from happening.",
  closed_weekends:
    "The weekend is when a lot of people finally get round to sorting this kind of thing out, and by Monday it is usually sorted.",
  // "Waits until the morning" rather than "goes to voicemail": we read their
  // opening hours, we know nothing about what answers the phone after them.
  after_hours_gap:
    "Anything that comes in after that waits until the morning, and somebody still ringing round does not usually wait."
};

/** Findings we lead with, best first: the ones that map to lost work. */
const FINDING_PRIORITY = [
  "after_hours_gap",
  "closed_weekends",
  "no_online_booking",
  "no_text_option",
  "no_chat_widget",
  "no_tap_to_call"
];

/** The finding worth leading with, or null when nothing checkable was found. */
export function leadFinding(findings: ProbeFinding[]): ProbeFinding | null {
  for (const code of FINDING_PRIORITY) {
    const hit = findings.find((f) => f.code === code);
    if (hit) return hit;
  }
  return findings[0] ?? null;
}

/**
 * A prospect is only pitchable when we have something checkable to say and a
 * known subject line for it: an email that opens with a vague compliment is
 * spam, whatever the footer says.
 */
export function isPitchable(findings: ProbeFinding[]): boolean {
  const lead = leadFinding(findings);
  return lead !== null && lead.code in OBSERVATION_BY_FINDING;
}

function firstName(prospectName: string): string {
  return prospectName.trim() || "there";
}

/**
 * The deterministic pitch: observation, offer, ask. Short on purpose. This is
 * both the fallback when AI polish is unavailable and the input the polish
 * pass rewrites, so the facts exist before any model runs.
 */
export function composePitch(
  tenant: PitchTenant,
  prospect: PitchProspect,
  unsubscribeUrl: string
): ComposedPitch | null {
  const lead = leadFinding(prospect.findings);
  if (!lead || !(lead.code in OBSERVATION_BY_FINDING)) return null;
  const subject = `${firstName(prospect.businessName)}: ${SUBJECT_BY_FINDING[lead.code]}`;
  const paragraphs = pitchParagraphs(tenant, prospect, lead);
  return { subject, body: assembleBody(tenant, paragraphs, unsubscribeUrl) };
}

/**
 * The rewritable middle of the mail: the part a tone pass may touch. Kept
 * separate from assembly so the footer is never in a model's hands.
 */
export function pitchParagraphs(
  tenant: PitchTenant,
  prospect: PitchProspect,
  lead: ProbeFinding
): string[] {
  const observation = OBSERVATION_BY_FINDING[lead.code];
  const cost = COST_BY_FINDING[lead.code];
  const where = prospect.city.trim() ? ` in ${prospect.city.trim()}` : "";
  return [
    `Hi ${firstName(prospect.businessName)},`,
    // "Looking you up" rather than "looking at your site": the hours findings
    // can come from their Google listing instead of their markup, and an
    // opening line that misstates where we looked is a bad first sentence.
    //
    // The cost sentence rides in the SAME paragraph as the observation, so the
    // two are read as one thought: here is the gap, here is what falls through
    // it. Split across paragraphs they read as two unrelated remarks.
    `I was looking you up${where} and noticed ${observation}. ${cost}`,
    // The tenant's own words, verbatim. It answers the cost sentence above it
    // by position rather than by a lead-in we would have to write for them:
    // anything prepended here would be our sentence in their voice, and it
    // would have to make sense in front of every offer any tenant ever types.
    tenant.valueProp.trim(),
    "Worth a quick look?"
  ];
}

/**
 * The tenant's sign-off: who it is from, the business, and the website.
 *
 * Extracted so it has ONE definition. The HQ team-inbox flow signs its replies
 * too, and a second hand-written copy drifted immediately: it invented a
 * `team@newcoworker.com` line this one has never had. Anything that signs mail
 * as the tenant builds it here.
 *
 * `senderName` is `outreach_settings.sender_name`, the name the owner chose to
 * sign as. With no sender name the business name stands alone rather than
 * being printed twice.
 */
export function emailSignature(input: {
  senderName?: string | null;
  businessName: string;
  website?: string | null;
}): string {
  const sender = input.senderName?.trim() ?? "";
  const business = input.businessName.trim();
  return [sender || business, sender ? business : "", input.website?.trim() ?? ""]
    .filter(Boolean)
    .join("\n");
}

/**
 * Body assembly: paragraphs, then the sign-off, then the compliance footer.
 * Everything below the paragraphs is generated here and only here.
 */
export function assembleBody(
  tenant: PitchTenant,
  paragraphs: string[],
  unsubscribeUrl: string
): string {
  const cta = tenant.bookingUrl
    ? `You can grab a time here: ${tenant.bookingUrl}`
    : "Just reply if you want to hear more.";
  const signature = emailSignature({
    senderName: tenant.senderName,
    businessName: tenant.name,
    website: tenant.website
  });
  const footer = [
    `You can unsubscribe here and I will not email you again: ${unsubscribeUrl}`,
    tenant.postalAddress.trim()
  ]
    // An exempt tenant with no address on file gets the unsubscribe line and
    // nothing else. Filtering beats printing an empty line, which would look
    // like a template that failed to render.
    .filter(Boolean)
    .join("\n");
  return `${paragraphs.join("\n\n")}\n\n${cta}\n\n${signature}\n\n${footer}\n`;
}

/**
 * Owner-edited pitch text back into paragraphs. Blank lines separate them,
 * which is the same shape `polishParagraphs` returns, so an edited draft and a
 * machine-written one re-assemble through exactly one code path.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export type PolishDeps = {
  apiKey?: string;
  generate?: typeof geminiGenerateTextDetailed;
  meter?: typeof meterGeminiSpendForBusiness;
};

/**
 * System instruction for the tone pass. It is told what it may not do, because
 * the value of a polished cold email is entirely in it staying true: an
 * invented claim about the prospect's business is worse than a stiff sentence.
 */
export const PITCH_POLISH_INSTRUCTION = [
  "You rewrite the body of a short cold outreach email so it reads like one",
  "person writing to another, and so the reader can see what the gap you",
  "mention is costing them. Keep it under 120 words.",
  "Keep every paragraph you are given, in the order you are given them, and do",
  "not split one in two or merge two into one. The second paragraph says what",
  "was noticed about the recipient AND what usually happens because of it: those",
  "two sentences belong together and must stay in one paragraph. The paragraph",
  "after it says what the sender does about it, and the last one is the ask.",
  "Write plainly and specifically. Cut anything that reads like a brochure.",
  "Rules you must not break: keep every factual claim exactly as given, never",
  "add a claim about the recipient's business that is not already there, never",
  "invent names, numbers, percentages, statistics, prices, or results, never",
  "name a competitor, keep the greeting line first,",
  "and do not add a sign-off, a signature, a link, or a postscript.",
  "Return only the rewritten paragraphs, separated by blank lines.",
  NO_EM_DASH_PROMPT_LINE
].join(" ");

/**
 * Optional tone pass over the middle paragraphs. Any failure (no key, HTTP
 * error, empty draw, a response that looks like it ignored the rules) returns
 * the deterministic paragraphs unchanged: the pitch always ships, polished or
 * not. Spend is metered per business like every other platform Gemini call.
 */
export async function polishParagraphs(
  businessId: string,
  paragraphs: string[],
  deps: PolishDeps = {}
): Promise<string[]> {
  const apiKey = deps.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
  if (!apiKey) return paragraphs;
  const generate = deps.generate ?? geminiGenerateTextDetailed;
  const meter = deps.meter ?? meterGeminiSpendForBusiness;
  const userText = paragraphs.join("\n\n");
  try {
    const result = await generate({
      apiKey,
      model: PITCH_POLISH_MODEL,
      systemInstruction: PITCH_POLISH_INSTRUCTION,
      userText,
      temperature: 0.6,
      maxOutputTokens: PITCH_POLISH_MAX_TOKENS,
      thinkingLevel: "minimal"
    });
    await meter({
      businessId,
      model: PITCH_POLISH_MODEL,
      surface: PITCH_POLISH_SURFACE,
      usage: result.usage,
      inputChars: userText.length,
      outputChars: result.text.length
    });
    const rewritten = result.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    // A polish that came back empty, or long enough to have added material of
    // its own, is discarded rather than trusted.
    if (rewritten.length === 0 || result.text.length > userText.length * 2) {
      return paragraphs;
    }
    // Strip the em dash defensively: the prompt forbids it, the repo forbids
    // it, and a model is not a guarantee. Surrounding spaces go with it, or a
    // spaced dash leaves a double space behind.
    return rewritten.map((p) => p.replace(/\s*\u2014\s*/g, ", "));
  } catch {
    return paragraphs;
  }
}
