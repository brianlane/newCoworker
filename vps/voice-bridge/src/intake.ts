/**
 * Pure helpers for the HomeLight AI-takeover intake call. Kept dependency-free
 * (only ./datetime-line) so the root Vitest suite can import and test them
 * without pulling the @google/genai-coupled bridge module.
 */
import { currentDateTimeLine } from "./datetime-line.js";

export const DEFAULT_INTAKE_CAPTURE_FIELDS = ["name", "phone", "address", "timeframe", "notes"];

export type CapturedLead = Record<string, string>;

/**
 * System instruction for the HomeLight AI-takeover intake call. The live seller
 * was just connected (we pressed 1) after both Dave and Amy missed the warm
 * transfer, so the assistant's whole job is a short, warm intake: confirm who
 * they are, what they're selling, and when — then promise a fast call back.
 *
 * With `transfer` set (a place_ai_call follow-up call that may live-transfer),
 * the instruction pivots: the persona IS the call script, the goal is asking
 * whether now is a good time, and a yes leads to the `transfer_to_owner` tool
 * instead of the capture checklist (capture_lead stays available for notes).
 *
 * With `outboundCall` (WE dialed them — outbound_call / place_ai_call), the
 * framing flips from "a live lead was connected to you" to "your call was
 * just answered", and the checklist must NOT ask for a callback number — we
 * literally just called it (the first live test's exact complaint: "why do
 * you need my number if you just called it?").
 */
export function intakeSystemInstruction(
  businessName: string,
  persona: string | undefined,
  businessTimezone: string | null | undefined,
  captureFields: string[],
  hasEndCall = false,
  transfer?: { agentName?: string },
  outboundCall = false
): string {
  // Default opener: the inbound one promises a call-back (the seller phoned
  // in and expects one); on a call WE placed that promise is mixed messaging,
  // so the outbound default just states the follow-up.
  const opener =
    (persona && persona.trim()) ||
    (outboundCall || transfer
      ? `Hi, this is ${businessName}'s office, reaching out with a quick follow-up — do you have a moment?`
      : `Hi, this is ${businessName}'s office. I'd love to grab a few details so we can call you right back about selling your home.`);
  const allFields = captureFields.length > 0 ? captureFields : DEFAULT_INTAKE_CAPTURE_FIELDS;
  // On a call WE placed, "phone" must not be in the collect list either —
  // listing it would contradict the never-ask-for-their-number rule below
  // (the default field set includes it for the inbound live-transfer case).
  // A list that filters to empty (capture_fields: ["phone"]) degrades to
  // free-form notes so the collect sentence never renders an empty list.
  const outboundFields = allFields.filter((f) => f.trim().toLowerCase() !== "phone");
  const fields =
    outboundCall || transfer
      ? outboundFields.length > 0
        ? outboundFields
        : ["notes"]
      : allFields;
  // Barge-in/echo guard: Gemini Live restarts its scripted opener when the
  // callee's "Hello?" lands mid-greeting (or right after), which callers hear
  // as being greeted twice (first live test, Jul 15 2026).
  const greetOnce =
    "Say your opening line only ONCE. If they speak while you're saying it, or you were interrupted, never restart it — acknowledge what they said and continue from where the conversation actually is.";
  // On a call WE placed, the number is by definition reachable — asking for
  // it reads as a bot non-sequitur.
  const noNumberAsk =
    "You called them on their own phone just now, so NEVER ask for their phone number — only note a different number if they volunteer one.";
  const lines: string[] = [];
  if (transfer) {
    const agent = transfer.agentName?.trim() || "the team member handling this";
    lines.push(
      `You are the phone assistant for ${businessName}, making a follow-up call the office asked you to place. The person has just answered.`,
      `Open with this, warmly and naturally: "${opener}"`,
      greetOnce,
      "Keep replies concise, natural, and spoken (not bulleted). Be friendly and low-pressure — this is a real person who didn't expect a call, so let them respond before moving on.",
      noNumberAsk,
      `Your goal: after your opening and their response, explain what you're following up about (as your opening line describes) and ask whether now is a good time to talk. If they say YES, tell them "one moment while I get ${agent} on the line", then call the \`transfer_to_owner\` tool to connect them.`,
      `If it's NOT a good time, ask when would work better, note it via the \`capture_lead\` tool (fields: ${fields.join(", ")} — record whatever you learn), thank them, and wrap up politely. Never pressure them.`,
      "If they ask to stop being contacted, apologize briefly, promise to pass that on, capture it in `capture_lead` notes, and end the call.",
      "Do NOT claim to be a person if asked directly, and do not say you're an AI unless asked — keep it light and steer back to helping. Never read a tool's raw response aloud."
    );
  } else {
    lines.push(
      outboundCall
        ? `You are the phone assistant for ${businessName}, making a call the office asked you to place. The person has just answered.`
        : `You are the phone assistant for ${businessName}, taking a live seller lead that was just connected to you.`,
      `Open with this, warmly and naturally: "${opener}"`,
      greetOnce,
      outboundCall
        ? "Keep replies concise, natural, and spoken (not bulleted). Be friendly and low-pressure — this is a real person who didn't expect a call, so let them respond before moving on."
        : "Keep replies concise, natural, and spoken (not bulleted). Be friendly and efficient — this is a real seller who expected a person, so reassure them they're in the right place and someone will follow up quickly.",
      outboundCall
        ? `Collect these details naturally, one or two at a time, confirming as you go: ${fields.join(", ")}. ${noNumberAsk}`
        : `Collect these details, one or two at a time, confirming as you go: ${fields.join(", ")}. Get their best callback number, the property address, and roughly when they're looking to sell.`,
      "As soon as you have any of these details, call the `capture_lead` tool with what you have (you can call it again as you learn more). Always call it before you say goodbye.",
      "Do NOT claim to be a person if asked directly, and do not say you're an AI unless asked — keep it light and steer back to helping. Never read a tool's raw response aloud.",
      outboundCall
        ? `When you have what you need (or they're not interested), thank them for their time and wrap up politely.`
        : `When you have what you need, let them know someone from ${businessName} will call them back shortly about their home, thank them, and wrap up.`
    );
  }
  if (hasEndCall) {
    lines.push(
      transfer
        ? "After you've said your goodbye (when no transfer happened), call the `end_call` tool to hang up. Only end the call once the conversation is genuinely over, and never after a successful transfer — the human conversation continues without you."
        : "After you've captured the lead and said your goodbye, call the `end_call` tool to hang up. Only end the call once the conversation is genuinely over."
    );
  }
  lines.push(currentDateTimeLine(new Date(), businessTimezone));
  return lines.join(" ");
}

const INTAKE_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  phone: "Callback",
  address: "Address",
  timeframe: "Timeframe",
  notes: "Notes"
};

/** Human label for a captured field: a known label, else a Title-Cased key. */
function fieldLabel(key: string): string {
  if (INTAKE_FIELD_LABELS[key]) return INTAKE_FIELD_LABELS[key];
  return key
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the owner-facing SMS body for a completed intake call: a short header,
 * the structured captured fields, and the transcript. Truncated to `maxChars`
 * (Telnyx segments long bodies automatically).
 *
 * The only trustworthy callback is the phone the AI captured via `capture_lead`
 * (`lead.phone`). The inbound ANI on a live-transfer call is the transfer
 * partner's line (e.g. HomeLight `+14159851909`), NOT the seller — so it is
 * shown only as `transferFromE164` ("Transferred via"), never as the callback,
 * to avoid handing the owner a wrong number/identity.
 *
 * Wording is generic (no hardcoded agent names) because `voice_handoff_chains`
 * is a per-tenant table any business can configure.
 */
export function composeIntakeLeadSms(input: {
  businessName: string;
  lead: CapturedLead;
  /** The live-transfer line the call arrived on (transfer partner), not the seller. */
  transferFromE164?: string;
  transcript: string;
  maxChars: number;
}): string {
  const lines: string[] = [
    `${input.businessName}: New live-transfer lead (AI intake) — the team missed the warm handoff, so I captured this on the call.`
  ];
  // Render known fields first in a stable order, then any custom captured
  // fields (capture_lead honors the chain's ai_takeover.capture_fields, so the
  // SMS must surface whatever the AI stored — not just the standard five).
  const rendered = new Set<string>();
  for (const key of Object.keys(INTAKE_FIELD_LABELS)) {
    const v = input.lead[key];
    if (typeof v === "string" && v.trim()) {
      lines.push(`${fieldLabel(key)}: ${v.trim()}`);
      rendered.add(key);
    }
  }
  for (const [key, v] of Object.entries(input.lead)) {
    if (rendered.has(key)) continue;
    if (typeof v === "string" && v.trim()) lines.push(`${fieldLabel(key)}: ${v.trim()}`);
  }
  if (input.transferFromE164 && input.transferFromE164.trim()) {
    lines.push(`Transferred via: ${input.transferFromE164.trim()}`);
  }
  if (input.transcript.trim()) {
    lines.push("", "Transcript:", input.transcript.trim());
  }
  const text = lines.join("\n");
  return text.length > input.maxChars ? text.slice(0, input.maxChars) : text;
}
