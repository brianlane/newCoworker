/**
 * Pure helpers for the HomeLight AI-takeover intake call. Kept dependency-free
 * (only ./datetime-line) so the root Vitest suite can import and test them
 * without pulling the @google/genai-coupled bridge module.
 */
import { currentDateTimeLine } from "./datetime-line.js";
import {
  NO_INVENTED_CONTACT_LINE,
  ONE_VOICE_LINE,
  RECORDED_SYSTEM_LINE
} from "./call-integrity-lines.js";
import {
  customerLanguageLine,
  type VoiceCustomerLanguage
} from "./customer-language-line.js";

export const DEFAULT_INTAKE_CAPTURE_FIELDS = ["name", "phone", "address", "timeframe", "notes"];

export type CapturedLead = Record<string, string>;

/**
 * The opening line an intake session leads with: the configured persona, or
 * a mode-appropriate default. SHARED by the system instruction and the
 * bridge's coordinator greeting cue so the two can never quote different
 * openers (the cue literally reads the line aloud). The inbound default
 * promises a call-back (the seller phoned in and expects one); on a call WE
 * placed (outbound / transfer) that promise is mixed messaging, so the
 * outbound default just states the follow-up.
 */
export function intakeOpener(
  businessName: string,
  persona: string | undefined,
  mode: "inbound" | "outbound"
): string {
  const configured = persona && persona.trim();
  if (configured) return configured;
  return mode === "outbound"
    ? `Hi, this is ${businessName}'s office, reaching out with a quick follow-up, do you have a moment?`
    : `Hi, this is ${businessName}'s office. I'd love to grab a few details so we can call you right back about selling your home.`;
}

/**
 * System instruction for the HomeLight AI-takeover intake call. The live seller
 * was just connected (we pressed 1) after both Dave and Amy missed the warm
 * transfer, so the assistant's whole job is a short, warm intake: confirm who
 * they are, what they're selling, and when, then promise a fast call back.
 *
 * With `transfer` set (a place_ai_call follow-up call that may live-transfer),
 * the instruction pivots: the persona IS the call script, the goal is asking
 * whether now is a good time, and a yes leads to the `transfer_to_owner` tool
 * instead of the capture checklist (capture_lead stays available for notes).
 *
 * With `outboundCall` (WE dialed them, outbound_call / place_ai_call), the
 * framing flips from "a live lead was connected to you" to "your call was
 * just answered", and the checklist must NOT ask for a callback number, we
 * literally just called it (the first live test's exact complaint: "why do
 * you need my number if you just called it?").
 *
 * `languagePrefs` gives this persona the same bilingual handling the
 * receptionist persona has. Without it an intake call ran English-only in
 * practice, so a Spanish-speaking seller reached a takeover that answered in
 * the wrong language. The captured fields stay ENGLISH regardless, because
 * they are read by the owner, not the caller.
 */
/**
 * Recognize a bridged leg that reached a machine instead of the seller.
 *
 * Names the carrier signatures verbatim ("is not available", "please record
 * your message", "at the tone") because the generic recordings rule names
 * menus and greetings in the abstract, and on 2026-08-16 the model heard
 * "592030 is not available." mid-conversation and treated it as the seller
 * fumbling a phone number: the exact phrases are what make the recognition
 * fire before the first wrong reply, not after.
 */
export const INBOUND_VOICEMAIL_RECOGNITION_LINE =
  "THE LINE IS NOT ALWAYS A PERSON. This call is bridged onward to the seller's own phone, which can be off or unreachable. A carrier announcement (a voice saying a number \"is not available\", \"cannot be reached\", or \"has a voicemail box that is full\"), an invitation to \"please record your message\" or speak \"at the tone\", or a mailbox menu offering to replay or re-record are RECORDINGS, not the seller. The moment you hear one, stop conversing: ask it nothing, answer it nothing, and never treat a number it reads out as the seller's number.";

/**
 * The ONE message the inbound live-transfer intake may leave on a voicemail.
 *
 * Scoped to the inbound branch only: outbound calls already carry an authored
 * `voicemailTemplate` (or a deliberate hang-up policy), and a default here
 * would override that choice. The script carries no price, address, or
 * briefing detail on purpose: the recordings rule bans reading those into a
 * mailbox, and this message must stay safe on a stranger's voicemail.
 */
export function inboundVoicemailMessageLine(businessName: string, hasEndCall: boolean): string {
  const ending = hasEndCall
    ? "then call the `end_call` tool to hang up"
    : "then end the call by saying nothing more";
  return (
    "If a recording invites you to leave a message, leave EXACTLY this one message, once, and nothing else: " +
    `"Hi, this is the office of ${businessName} calling back about the home you asked about selling. We will try you again shortly. Thank you." ` +
    `Say it and stop: no questions, no details from your briefing, no second attempt, ${ending}. ` +
    "If there is no invitation to record, stay silent and end the call the same way."
  );
}

/**
 * One-sentence identification for Apple call screening on calls WE place.
 *
 * Screening answers the leg with a robotic voice asking the caller to state
 * their name and the reason for the call, transcribes the answer, and shows
 * it to the person deciding whether to pick up. One clear sentence is what
 * gets the call through; a full opener read at the robot looks like spam on
 * their screen, and conversing with it violates the recordings rule.
 */
export function iosScreeningLine(businessName: string): string {
  return (
    "If a call screening voice answers (a robotic voice asking you to state your name or the reason for your call, such as Apple call screening), say exactly ONE short sentence: " +
    `"This is ${businessName}'s office with a quick follow-up call." ` +
    "Then stay quiet until a real person speaks. When they do, greet them naturally with your opening line as if the call just began."
  );
}

/**
 * How a call WE placed reports reaching a recording.
 *
 * The generic recordings rule already says not to converse with a machine, and
 * it is not enough on its own: on 2026-08-17 the assistant delivered a full
 * listing pitch into Jennifer Kline's mailbox and then narrated a transfer it
 * never made. What was missing was somewhere to PUT the observation. The
 * `voicemail_reached` tool is that place, and calling it is what makes the run
 * resolve as no-answer instead of "spoke with them".
 *
 * Named signatures rather than the abstraction, for the same reason the
 * inbound line spells them out: recognition has to fire on the first sentence,
 * not after a pitch. "Please record your message" and "when you have finished
 * recording you may hang up" are verbatim from the two calls that went wrong.
 */
export const OUTBOUND_VOICEMAIL_TOOL_LINE =
  "IF YOU REACH A RECORDING, REPORT IT BEFORE YOU SAY ANYTHING ELSE. A recorded greeting in the person's own voice, an automated one, an invitation to \"please record your message\", \"leave a message after the tone\", \"when you have finished recording you may hang up\", or any mailbox menu offering to replay, re-record, or send your message all mean you reached a machine, not the person. The moment you notice, call the `voicemail_reached` tool and wait for its answer: never deliver your opening line, your pitch, or any question to a recording, and never narrate an action you are about to take. If it returns a `script`, read that text aloud word for word, exactly as written, then call `end_call`. If it returns no script, say nothing at all and call `end_call` immediately. The one exception: if it says a message is already being left, stay completely silent and do NOT end the call, because hanging up would cut that message off part way through.";

export function intakeSystemInstruction(
  businessName: string,
  persona: string | undefined,
  businessTimezone: string | null | undefined,
  captureFields: string[],
  hasEndCall = false,
  transfer?: { agentName?: string },
  outboundCall = false,
  contextNote?: string,
  languagePrefs?: {
    established?: VoiceCustomerLanguage | null;
    defaultLang?: VoiceCustomerLanguage;
  },
  /** True when the host registered `voicemail_reached` (calls WE placed). */
  hasVoicemailTool = false
): string {
  const opener = intakeOpener(
    businessName,
    persona,
    outboundCall || transfer ? "outbound" : "inbound"
  );
  const allFields = captureFields.length > 0 ? captureFields : DEFAULT_INTAKE_CAPTURE_FIELDS;
  // On a call WE placed, "phone" must not be in the collect list either,
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
    "Say your opening line only ONCE. If they speak while you're saying it, or you were interrupted, never restart it, acknowledge what they said and continue from where the conversation actually is.";
  // On a call WE placed, the number is by definition reachable, asking for
  // it reads as a bot non-sequitur.
  const noNumberAsk =
    "You called them on their own phone just now, so NEVER ask for their phone number, only note a different number if they volunteer one.";
  const lines: string[] = [];
  if (transfer) {
    const agent = transfer.agentName?.trim() || "the team member handling this";
    lines.push(
      `You are the phone assistant for ${businessName}, making a follow-up call the office asked you to place. The person has just answered.`,
      `Open with this, warmly and naturally: "${opener}"`,
      greetOnce,
      "Keep replies concise, natural, and spoken (not bulleted). Be friendly and low-pressure, this is a real person who didn't expect a call, so let them respond before moving on.",
      noNumberAsk,
      `Your goal: after your opening and their response, explain what you're following up about (as your opening line describes) and ask whether now is a good time to talk. If they say YES, tell them "one moment while I get ${agent} on the line", then call the \`transfer_to_owner\` tool to connect them.`,
      `If it's NOT a good time, ask when would work better, note it via the \`capture_lead\` tool (fields: ${fields.join(", ")}, record whatever you learn), thank them, and wrap up politely. Never pressure them.`,
      "If they ask to stop being contacted, apologize briefly, promise to pass that on, capture it in `capture_lead` notes, and end the call.",
      "Do NOT claim to be a person if asked directly, and do not say you're an AI unless asked, keep it light and steer back to helping. Never read a tool's raw response aloud."
    );
  } else {
    lines.push(
      outboundCall
        ? `You are the phone assistant for ${businessName}, making a call the office asked you to place. The person has just answered.`
        : `You are the phone assistant for ${businessName}, taking a live seller lead that was just connected to you.`,
      `Open with this, warmly and naturally: "${opener}"`,
      greetOnce,
      outboundCall
        ? "Keep replies concise, natural, and spoken (not bulleted). Be friendly and low-pressure, this is a real person who didn't expect a call, so let them respond before moving on."
        : "Keep replies concise, natural, and spoken (not bulleted). Be friendly and efficient, this is a real seller who expected a person, so reassure them they're in the right place and someone will follow up quickly.",
      outboundCall
        ? `Collect these details naturally, one or two at a time, confirming as you go: ${fields.join(", ")}. ${noNumberAsk}`
        : `Collect these details, one or two at a time, confirming as you go: ${fields.join(", ")}. Get their best callback number, the property address, and roughly when they're looking to sell.`,
      "As soon as you have any of these details, call the `capture_lead` tool with what you have (you can call it again as you learn more). Always call it before you say goodbye.",
      "Do NOT claim to be a person if asked directly, and do not say you're an AI unless asked, keep it light and steer back to helping. Never read a tool's raw response aloud.",
      outboundCall
        ? `When you have what you need (or they're not interested), thank them for their time and wrap up politely.`
        : `When you have what you need, let them know someone from ${businessName} will call them back shortly about their home, thank them, and wrap up.`
    );
  }
  // The referral partner's details often reach us AFTER the call starts (or
  // never). If the caller expects us to already have them, own it briefly and
  // ask instead of stalling or pretending to look something up.
  if (!outboundCall && !transfer) {
    lines.push(
      "If they refer to details you were not given (their address, their price, what they submitted), apologize briefly that it has not reached your side yet, then simply ask them for it and carry on.",
      // The partner withholds the seller's number until after this call, so the
      // person on the line is often the ONLY source for it. A hang-up two
      // minutes in otherwise leaves the team with no way to reach them at all.
      "YOUR FIRST PRIORITY is their phone number. Ask for the best number to reach them within your first couple of exchanges, naturally and early (\"what's the best number for you?\"), read it back to confirm it, and record it with `capture_lead` immediately, before you work through anything else on the list. If the call ends abruptly, that number is the one thing that must not be missing.",
      "Once you have it, tell them someone from the team will be in touch shortly, and use the rest of the call to be useful: answer their questions about selling as best you can, and be honest that a person will handle the specifics you cannot.",
      // The partner bridges this call ONWARD to the client's own line after
      // the accept keypress, and that leg can reach a switched-off phone. On
      // 2026-08-16 (Thomas L.) the bridge landed in a carrier voicemail: the
      // AI heard "592030 is not available.", asked it whether it was trying
      // to give a phone number, chatted with the mailbox's time-limit menu,
      // and Thomas's voicemail recorded four minutes of one-sided intake.
      // The generic RECORDED_SYSTEM_LINE says never converse with recordings
      // but leaves "no message given" as stay-silent; this persona's calls
      // are exactly where a short scripted message beats silence, so the
      // message is given HERE, with none of the briefing's lead details in
      // it (the recording ban on details still applies).
      INBOUND_VOICEMAIL_RECOGNITION_LINE,
      inboundVoicemailMessageLine(businessName, hasEndCall)
    );
  }
  // Calls WE place can be answered by Apple's call screening (the dial runs
  // premium_ios_call_screening_detection, so the platform knows too). The
  // screening prompt transcribes what the caller says for the person deciding
  // whether to pick up, so ONE clear identification sentence is exactly what
  // gets the call through; running the whole opener at it reads as spam.
  if (outboundCall || transfer) {
    lines.push(iosScreeningLine(businessName));
  }
  // Reporting the recording is what makes the flow outcome honest, so the rule
  // only ships when the tool that carries it actually exists.
  if (hasVoicemailTool) {
    lines.push(OUTBOUND_VOICEMAIL_TOOL_LINE);
  }
  // Known details (a place_ai_call step's rendered contextTemplate): the AI
  // must never ask for something the flow already extracted, "why are you
  // asking my name if you already have it?" (live test, Jul 15 2026).
  if (contextNote && contextNote.trim()) {
    lines.push(
      `What you ALREADY KNOW about this person: ${contextNote.trim()}`,
      "This OVERRIDES any collect list above, INCLUDING the phone-number priority: NEVER ask for a detail listed there, you already have it. Use their name naturally, record known details straight into `capture_lead` without asking, and only ask about what is genuinely missing. If a known detail matters, confirm it in passing instead of asking for it fresh."
    );
  }
  if (hasEndCall) {
    lines.push(
      transfer
        ? "After you've said your goodbye (when no transfer happened), call the `end_call` tool to hang up. Only end the call once the conversation is genuinely over, and never after a successful transfer, the human conversation continues without you."
        : "After you've captured the lead and said your goodbye, call the `end_call` tool to hang up. Only end the call once the conversation is genuinely over."
    );
  }
  // Punctuation: lockstep copy of the receptionist persona's noEmDashLine
  // (system-instruction.ts), itself a copy of NO_EM_DASH_PROMPT_LINE. This
  // persona writes capture_lead values that land verbatim in the owner's SMS.
  lines.push(
    "Punctuation: never use an em dash in anything you write. Use a comma, " +
      "a period, or a colon instead."
  );
  const languageLine = customerLanguageLine({
    established: languagePrefs?.established ?? null,
    defaultLang: languagePrefs?.defaultLang ?? "en"
  });
  if (languageLine) {
    lines.push(
      languageLine,
      // The opener is owner-authored tenant content, so it is spoken as
      // written rather than machine-translated; the language rule above takes
      // over from the caller's first reply onward.
      "Speak your opening line exactly as written above even if you expect the person to prefer another language, then follow their language for the rest of the call.",
      // The captured fields and notes are read by the OWNER, not the caller,
      // so they must not arrive in the caller's language.
      "Whatever language you speak, always write the values you pass to `capture_lead` in ENGLISH: the business owner reads them in a text message. Translate what the person told you rather than passing their words through, and keep names, addresses, and phone numbers exactly as they gave them."
    );
  }
  // Every branch above gets these: this persona runs the live-transfer and
  // outbound paths, which is where the AI ran its whole intake script at a
  // voicemail system and then supplied the seller's replies itself
  // (call 28f9c228, 2026-08-14). Shared with the receptionist and staff
  // personas via call-integrity-lines.ts so the two builders cannot drift.
  lines.push(ONE_VOICE_LINE, RECORDED_SYSTEM_LINE, NO_INVENTED_CONTACT_LINE);
  lines.push(currentDateTimeLine(new Date(), businessTimezone));
  return lines.join(" ");
}

/**
 * A full SMS-width row of asterisks framing an urgent alert. Lockstep copy of
 * `STAR_ROW` in supabase/functions/_shared/star_block.ts (the bridge is its own
 * package and cannot import the Deno module); tests/star-block.test.ts pins
 * them equal.
 */
export const STAR_ROW = "****************";

/** Characters the frame adds: both rows plus their newlines. */
const STAR_FRAME_CHARS = (STAR_ROW.length + 1) * 2;

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
 * What the platform already knew about the person on this call, gathered at
 * alert time from OUTSIDE the conversation: the CRM contact row for the
 * number the flow dialed. The finished-call SMS renders these lines so the
 * owner alert carries the flow's knowledge instead of arriving blind, which
 * is what an owner actually asked for (Amy Laidlaw, 2026-08-23: "include
 * whether it's a buyer or seller and their name number and email and website
 * source of the lead and price"). Every field is optional; an absent one
 * renders nothing.
 */
export interface IntakeKnownLead {
  /** `contacts.display_name` for the dialed number. */
  name?: string;
  /** `contacts.email`. */
  email?: string;
  /** `contacts.lead_source`, the network the lead arrived from. */
  leadSource?: string;
}

/**
 * The slice of `voice_handoff_sessions.context` the finished-call alert
 * reads, pulled out of the raw row the notify path already fetches.
 *
 * `contextNote` is the flow's briefing for the call (`place_ai_call`'s
 * rendered `contextTemplate`, kept current by `voice_brief` rewrites), so it
 * holds whatever the flow knew: the lead's name, the site they inquired
 * through, buying vs selling intent, price when the flow had one. Rendering
 * it in the alert is how the flow's knowledge reaches the owner.
 *
 * `machineDetected` / `voicemailSpoken` are the top-level stamps the
 * voicemail path merges via `voice_session_context_merge` (the edge's
 * `stampMachine` mirrors both), which lets the alert say honestly that the
 * call reached a recording rather than implying a conversation happened.
 */
export interface IntakeAlertContext {
  contextNote?: string;
  machineDetected: boolean;
  voicemailSpoken: boolean;
  /**
   * Someone holds the voicemail speak claim but the delivered stamp has not
   * landed yet. At alert time this is the honest in-between: the edge/sweep
   * speak plays AFTER the stream stops (so the stamp arrives at
   * call.speak.ended, well after this alert), and the model path's
   * confirmSpoken merge is fire-and-forget (the alert read can race it).
   * Rendered as "being left" rather than the flatly wrong "no message left".
   */
  voicemailBeingLeft: boolean;
}

/** Parse `IntakeAlertContext` out of a raw `voice_handoff_sessions.context`. */
export function extractIntakeAlertContext(ctx: unknown): IntakeAlertContext {
  const c = (ctx && typeof ctx === "object" ? ctx : {}) as Record<string, unknown>;
  const ai = (c.ai_takeover && typeof c.ai_takeover === "object" ? c.ai_takeover : {}) as Record<
    string,
    unknown
  >;
  const note = typeof ai.context_note === "string" ? ai.context_note.trim() : "";
  const spoken = c.voicemail_spoken === true;
  return {
    ...(note ? { contextNote: note } : {}),
    machineDetected: c.machine_detected === true,
    voicemailSpoken: spoken,
    voicemailBeingLeft: !spoken && c.voicemail_claimed === true
  };
}

/**
 * Build the owner-facing SMS body for a completed intake call: a short header,
 * what the platform already knew about the lead, the structured captured
 * fields, the flow's briefing, and the transcript. Truncated to `maxChars`
 * (Telnyx segments long bodies automatically).
 *
 * Direction decides what the remote number MEANS, and the two cases are
 * opposites:
 *
 * - Inbound (`callDirection` omitted or "inbound"): the ANI is the transfer
 *   partner's line (e.g. HomeLight `+14159851909`), NOT the seller, so it is
 *   shown only as `transferFromE164` ("Transferred via"), never as the
 *   callback. The only trustworthy callback is the phone the AI captured via
 *   `capture_lead`.
 * - Outbound ("outbound", a call the platform placed): the number we dialed
 *   IS the lead's own number (`leadE164`), so hiding it behind "Transferred
 *   via" mislabels the one number the owner most wants. It renders on the
 *   `Lead:` line instead, and the header drops the missed-warm-handoff claim,
 *   which is simply false for a follow-up call we placed. When the model
 *   reported a recording (`voicemail`), the alert says so instead of letting
 *   an empty capture read like a conversation.
 *
 * Wording is generic (no hardcoded agent names) because `voice_handoff_chains`
 * is a per-tenant table any business can configure.
 *
 * `starFrame` (the flow's `options.starAlerts`, carried on the handoff session
 * context) wraps the finished body in a row of asterisks so the alert stands
 * out in the owner's message list. The body itself is untouched, and the
 * truncation budget shrinks by the frame so the closing row always survives.
 */
export function composeIntakeLeadSms(input: {
  businessName: string;
  lead: CapturedLead;
  /** The live-transfer line the call arrived on (transfer partner), not the seller. Inbound only. */
  transferFromE164?: string;
  transcript: string;
  maxChars: number;
  /** Frame the message in a row of asterisks (flow opted into star alerts). */
  starFrame?: boolean;
  /** Who dialed. "outbound" = the platform placed this call to the lead. Defaults to inbound. */
  callDirection?: "inbound" | "outbound";
  /** Outbound only: the number the platform dialed, which is the lead's own number. */
  leadE164?: string;
  /** CRM contact fields for the dialed number (outbound), rendered as Lead lines. */
  known?: IntakeKnownLead;
  /** The flow's briefing for this call, rendered verbatim under "Call briefing:". */
  flowContextNote?: string;
  /** The model's own machine verdict for the call, and whether a scripted message was left. */
  voicemail?: { detected: boolean; messageLeft: boolean; messageBeingLeft?: boolean };
}): string {
  const outbound = input.callDirection === "outbound";
  const lines: string[] = [
    outbound
      ? `${input.businessName}: AI follow-up call summary (AI intake).`
      : `${input.businessName}: New live-transfer lead (AI intake), the team missed the warm handoff, so I captured this on the call.`
  ];
  if (outbound && input.voicemail?.detected) {
    lines.push(
      input.voicemail.messageLeft
        ? "Outcome: reached voicemail, left the scripted message."
        : input.voicemail.messageBeingLeft === true
          ? // The platform speaks the script AFTER the media stream (and so
            // this alert) is torn down; the call page shows the final result.
            "Outcome: reached voicemail, the scripted message is being left."
          : "Outcome: reached voicemail, no message left."
    );
  }
  // What the platform already knew, before anything the conversation added.
  // Labels are distinct from the captured-field labels below on purpose, so a
  // CRM email and a spoken-on-the-call email can never collide into one line.
  const knownName = input.known?.name?.trim() ?? "";
  const leadE164 = input.leadE164?.trim() ?? "";
  if (knownName || leadE164) {
    lines.push(`Lead: ${knownName && leadE164 ? `${knownName} (${leadE164})` : knownName || leadE164}`);
  }
  const knownEmail = input.known?.email?.trim() ?? "";
  if (knownEmail) lines.push(`Lead email: ${knownEmail}`);
  const knownSource = input.known?.leadSource?.trim() ?? "";
  if (knownSource) lines.push(`Lead source: ${knownSource}`);
  // Render known fields first in a stable order, then any custom captured
  // fields (capture_lead honors the chain's ai_takeover.capture_fields, so the
  // SMS must surface whatever the AI stored, not just the standard five).
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
  // The flow's own briefing, verbatim, and OUTBOUND ONLY. On an outbound
  // `place_ai_call` the note is the flow's rendered `contextTemplate` (name,
  // source site, buy/sell intent, price when known), which is exactly the
  // knowledge the owner is missing. On an INBOUND live transfer the same
  // field holds model-only instruction text stamped from the partner alert,
  // so rendering it there would push prompt language into an owner SMS that
  // is otherwise unchanged by this feature (Bugbot, PR #1600).
  const note = outbound ? input.flowContextNote?.trim() ?? "" : "";
  if (note) lines.push(`Call briefing: ${note}`);
  if (input.transferFromE164 && input.transferFromE164.trim()) {
    lines.push(`Transferred via: ${input.transferFromE164.trim()}`);
  }
  if (input.transcript.trim()) {
    lines.push("", "Transcript:", input.transcript.trim());
  }
  const text = lines.join("\n");
  const budget = input.starFrame
    ? Math.max(0, input.maxChars - STAR_FRAME_CHARS)
    : input.maxChars;
  const body = text.length > budget ? text.slice(0, budget) : text;
  return input.starFrame ? `${STAR_ROW}\n${body.trim()}\n${STAR_ROW}` : body;
}
