/**
 * The HQ team-inbox reply drafter: the saved Agent instructions that turn an
 * inbound sales email into the reply Brian would have written.
 *
 * Split out from its applier (the kyp-lead-flow-definition.ts pattern) so
 * tests/e2e/hq-intro-reply.e2e.test.ts can pin the EXACT production string
 * against a live model without the applier's env load and Supabase connection
 * running as an import side effect.
 *
 * The behavior this encodes came from a real thread (Aug 5 2026). James at
 * KYP Ads introduced Brian and King, and the flow's only move was to text
 * Brian about it. The reply he wrote by hand was three lines:
 *
 *   Thanks for connecting us, James!
 *
 *   King, please reach out with any questions and feel free to book a meeting
 *   with me here:
 *
 *   https://www.newcoworker.com/book/newcoworker/discovery-call
 *
 * Two people, two different sentences, and a link. That is the whole job.
 *
 * WHY THE LINK IS IN HERE rather than injected: a run_agent step gets only
 * the agent's instructions plus the rendered input. It never sees
 * bookingLinkPromptLine, which is what feeds the URL to the chat, SMS and
 * email-coworker surfaces. Carrying the link in the instructions also keeps
 * it owner-editable in the dashboard, at the cost of going stale if the
 * booking slug is ever renamed.
 */

/** business_agents.name, the upsert key for the seeding one-shot. */
export const HQ_REPLY_DRAFTER_AGENT_NAME = "Team inbox reply drafter";

/**
 * Emitted verbatim when the message carries no new ask. The flow gates its
 * send_email on this, so a thank-you or a thread correction files quietly and
 * mails nobody. A sentinel rather than an empty string because an empty
 * agent output is indistinguishable from a failed run.
 */
export const NO_REPLY_SENTINEL = "NO_REPLY";

/** The scheduling link the reply hands out, per meeting type, not the page. */
export const HQ_DISCOVERY_CALL_URL =
  "https://www.newcoworker.com/book/newcoworker/discovery-call";

/**
 * The saved instructions. Held under AGENT_INSTRUCTIONS_MAX_CHARS (8000).
 *
 * The "who is who" block is adapted from the extraction prompt's person/role
 * rules (supabase/functions/_shared/ai_flows/engine.ts). That wording exists
 * because a model answered our own agent's name for "the seller" on a real
 * intro message: the most prominent name in an introduction is usually the
 * introducer, not the person being introduced. Same trap here, opposite
 * consequence: get it backwards and the reply thanks the prospect and pitches
 * the person who did the favor.
 */
export const HQ_REPLY_DRAFTER_INSTRUCTIONS = [
  "You draft the reply Brian sends from the New Coworker team inbox. Output the email body only.",
  "",
  "SHAPE. Short plain text, three or four lines. No markdown, no bullet lists, no subject line, no signature block, no greeting line of your own beyond naming the people.",
  "",
  "WHO IS WHO. An introduction email has two people and they get different sentences. The SENDER is the person making the introduction: thank them by first name. The person being introduced is the prospect: address them by first name and speak to them directly. Decide which is which before writing. The most mentioned or most prominent name is usually the introducer, not the prospect. When someone writes in about themselves with no third party, there is only one person: thank them and answer them.",
  "",
  "WHAT TO SAY. Thank the introducer. Invite the prospect to reach out with questions. Give them this booking link on its own line, exactly as written, with nothing after it:",
  HQ_DISCOVERY_CALL_URL,
  "",
  "VOICE. Warm and brief, first person as Brian, so a meeting is booked with me. Never restate their message back to them. Never open as though this were first contact.",
  "",
  "NEVER invent a price, a date, a time, a duration, a phone number, or a commitment. Never promise a call. Do not explain what New Coworker does unless they asked.",
  "",
  `NO NEW ASK. If the message asks for nothing (a thank-you, small talk, a note that someone replied to the wrong person, an automated notice), reply with exactly ${NO_REPLY_SENTINEL} and nothing else.`,
  "",
  "EXAMPLE. Given an email where James introduces Brian and King:",
  "",
  "Thanks for connecting us, James!",
  "",
  "King, please reach out with any questions and feel free to book a meeting with me here:",
  "",
  HQ_DISCOVERY_CALL_URL
].join("\n");
