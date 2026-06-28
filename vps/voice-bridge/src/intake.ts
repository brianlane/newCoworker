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
 */
export function intakeSystemInstruction(
  businessName: string,
  persona: string | undefined,
  businessTimezone: string | null | undefined,
  captureFields: string[]
): string {
  const opener =
    (persona && persona.trim()) ||
    `Hi, this is ${businessName}'s office. I'd love to grab a few details so we can call you right back about selling your home.`;
  const fields = captureFields.length > 0 ? captureFields : DEFAULT_INTAKE_CAPTURE_FIELDS;
  return [
    `You are the phone assistant for ${businessName}, taking a live seller lead that was just connected to you.`,
    `Open with this, warmly and naturally: "${opener}"`,
    "Keep replies concise, natural, and spoken (not bulleted). Be friendly and efficient — this is a real seller who expected a person, so reassure them they're in the right place and someone will follow up quickly.",
    `Collect these details, one or two at a time, confirming as you go: ${fields.join(", ")}. Get their best callback number, the property address, and roughly when they're looking to sell.`,
    "As soon as you have any of these details, call the `capture_lead` tool with what you have (you can call it again as you learn more). Always call it before you say goodbye.",
    "Do NOT claim to be a person if asked directly, and do not say you're an AI unless asked — keep it light and steer back to helping. Never read a tool's raw response aloud.",
    "When you have what you need, let them know Amy will call them back shortly about their home, thank them, and wrap up.",
    currentDateTimeLine(new Date(), businessTimezone)
  ].join(" ");
}

const INTAKE_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  phone: "Callback",
  address: "Address",
  timeframe: "Timeframe",
  notes: "Notes"
};

/**
 * Build the owner-facing SMS body for a completed intake call: a short header,
 * the structured captured fields, the client's number, and the transcript.
 * Truncated to `maxChars` (Telnyx segments long bodies automatically).
 */
export function composeIntakeLeadSms(input: {
  businessName: string;
  lead: CapturedLead;
  clientE164: string;
  transcript: string;
  maxChars: number;
}): string {
  const lines: string[] = [
    `${input.businessName}: HomeLight lead (AI intake) — Dave and Amy both missed the live transfer.`
  ];
  for (const [key, label] of Object.entries(INTAKE_FIELD_LABELS)) {
    const v = input.lead[key];
    if (typeof v === "string" && v.trim()) lines.push(`${label}: ${v.trim()}`);
  }
  if (!input.lead.phone && input.clientE164) lines.push(`Callback: ${input.clientE164}`);
  if (input.clientE164) lines.push(`Call from: ${input.clientE164}`);
  if (input.transcript.trim()) {
    lines.push("", "Transcript:", input.transcript.trim());
  }
  const text = lines.join("\n");
  return text.length > input.maxChars ? text.slice(0, input.maxChars) : text;
}
