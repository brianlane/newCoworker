/**
 * Detects the two ways a voice call goes wrong that no code check can catch,
 * because both are the model disobeying its prompt rather than the code
 * misbehaving.
 *
 * WHY THIS IS A DETECTOR AND NOT A TEST. The fix for these (PR #1377) is a
 * set of prompt rules. Unit tests can prove the rules are PRESENT in the
 * composed instruction; nothing can prove the model obeys them. A live-model
 * replay of the incident was tried and discarded: the failure lives on Gemini
 * Live's AUDIO channel, where the model streams continuous speech, and a
 * text-mode stand-in cannot reproduce it because the API enforces turn
 * boundaries structurally. That replay passed identically with and without
 * the fix, which is a green light that means nothing.
 *
 * So the guard runs on real transcripts instead. It cannot prevent a
 * recurrence; it names one within a day.
 *
 * BOTH SIGNATURES ARE FROM REAL CALLS on Amy Laidlaw's account.
 *
 *   `role_leak` (call 28f9c228, 2026-08-14). Dropped into a seller's
 *   voicemail with nobody replying, the AI spoke the caller's turns itself.
 *   Its own audio, transcribed: "...that's 975 568. Is that correct?user /
 *   Correct. I want to sell my house ASAP.Got it, ASAP. And what's the
 *   property address...". It emitted the literal role token, invented the
 *   seller's answer, then answered its own question.
 *
 *   `talked_to_recording` (call 0f12d4ef, 2026-06-27, seven weeks earlier and
 *   never noticed). The AI greeted a looping "Press one to be connected" menu
 *   three times and never pressed.
 *
 * Pure and dependency-free: the Edge sweep and `debug/audit-call-integrity.ts`
 * both import it so the two cannot drift, and it pins at 100% coverage like
 * every other `_shared` module.
 */

/** One transcript turn, narrowed to what detection needs. */
export type IntegrityTurn = { role: string | null; content: string | null };

export type CallIntegrityKind = "role_leak" | "talked_to_recording";

export type CallIntegrityFinding = {
  kind: CallIntegrityKind;
  /** Human-readable evidence, safe to put in a log line. */
  detail: string;
};

/**
 * A role label the model wrote INSIDE its own speech.
 *
 * Anchored to a word boundary plus a colon or newline, which is what keeps it
 * usable: "I'll check the user manual" and "our assistant will call you back"
 * are ordinary sentences, and a detector that cried wolf on those would be
 * muted within a week. The incident's shape was "Is that correct?user\n".
 */
const ROLE_TOKEN_LEAK = /(^|[\s.!?"'])(user|assistant|model)\s*[:\n]/i;

/** Phrases only a recording says. Matched against the CALLER side. */
const MACHINE_PHRASES = [
  "press one",
  "press 1",
  "press two",
  "press pound",
  "press star",
  "leave a message",
  "at the beep",
  "after the tone",
  "record your message",
  "re-record",
  "voicemail",
  "is not available",
  "please hold",
  "your call is important"
];

/**
 * Assistant turns before "it held a conversation with the machine".
 *
 * Three, because pressing a key and waiting is CORRECT on the HomeLight
 * accept gate: the AI is supposed to hear an announcement and press. Only a
 * sustained back-and-forth is the failure, so a greeting or two against a
 * menu is deliberately not reported.
 */
export const DEFAULT_MIN_ASSISTANT_TURNS = 3;

export function hasRoleLeak(text: string): boolean {
  return ROLE_TOKEN_LEAK.test(text);
}

export function looksMachineGenerated(text: string): boolean {
  const t = text.toLowerCase();
  return MACHINE_PHRASES.some((p) => t.includes(p));
}

function isAssistant(turn: IntegrityTurn): boolean {
  return turn.role === "assistant";
}

function textOf(turn: IntegrityTurn): string {
  return typeof turn.content === "string" ? turn.content : "";
}

/**
 * Findings for one call, newest rules first. At most one `role_leak` per
 * call: the point is to name the call, and quoting every offending turn would
 * bury the operator in one bad call's noise.
 */
export function detectCallIntegrity(
  turns: readonly IntegrityTurn[],
  opts: { minAssistantTurns?: number } = {}
): CallIntegrityFinding[] {
  const findings: CallIntegrityFinding[] = [];
  const minAssistantTurns = opts.minAssistantTurns ?? DEFAULT_MIN_ASSISTANT_TURNS;

  // Only OUR side can leak a role token. The caller side is a transcription
  // of whatever was on the line, so a menu that happens to read "user:" is
  // not the AI misbehaving.
  const leaked = turns.find((t) => isAssistant(t) && textOf(t) !== "" && hasRoleLeak(textOf(t)));
  if (leaked) {
    findings.push({
      kind: "role_leak",
      detail: textOf(leaked).replace(/\s+/g, " ").slice(0, 240)
    });
  }

  const callerTurns = turns.filter((t) => !isAssistant(t) && textOf(t) !== "");
  const assistantTurns = turns.filter((t) => isAssistant(t) && textOf(t) !== "");
  const machineTurns = callerTurns.filter((t) => looksMachineGenerated(textOf(t)));
  // EVERY caller turn has to read as a machine. One human sentence anywhere
  // means a person was reached, which is the ordinary accept path where the
  // call opens on an IVR and a seller is then connected.
  if (
    callerTurns.length > 0 &&
    machineTurns.length === callerTurns.length &&
    assistantTurns.length >= minAssistantTurns
  ) {
    findings.push({
      kind: "talked_to_recording",
      detail:
        `${assistantTurns.length} assistant turns against ${callerTurns.length} ` +
        `machine-sounding caller turns, e.g. "${textOf(machineTurns[0]!).replace(/\s+/g, " ").slice(0, 120)}"`
    });
  }

  return findings;
}

/**
 * A finding with enough call context to name it in an alert. The sweep knows
 * these columns; the pure detector does not, which is why this is a separate
 * shape rather than a field on CallIntegrityFinding.
 */
export type CallIntegrityAlertItem = CallIntegrityFinding & {
  transcriptId: string;
  business: string;
  caller: string | null;
  startedAt: string | null;
};

/** How many findings the alert body names before it starts counting. */
const ALERT_MAX_ITEMS = 10;

/** Per-finding evidence clip, so one long turn cannot dominate the post. */
const ALERT_DETAIL_CHARS = 160;

function kindPhrase(kind: CallIntegrityKind): string {
  return kind === "role_leak" ? "spoke the caller's side" : "talked to a recording";
}

/**
 * The alert body. Leads with the count because that is the part read on a
 * phone screen, then names each call with its transcript id so it can be
 * pulled up directly.
 *
 * Capped at ALERT_MAX_ITEMS with an "and N more" tail: a single bad day must
 * not post a wall of text, since an alert nobody can skim is an alert that
 * gets muted, and a muted alert is the same as none.
 *
 * Returns "" for no findings, so a caller cannot accidentally announce
 * nothing.
 */
export function formatCallIntegrityAlert(items: readonly CallIntegrityAlertItem[]): string {
  if (items.length === 0) return "";
  const noun = items.length === 1 ? "failure" : "failures";
  const head = `${items.length} call-integrity ${noun} in the last day`;
  const lines = items.slice(0, ALERT_MAX_ITEMS).map((i) => {
    const when = i.startedAt ?? "unknown time";
    const who = i.caller ?? "unknown caller";
    const detail = i.detail.slice(0, ALERT_DETAIL_CHARS);
    return `• ${i.business}: the AI ${kindPhrase(i.kind)} (${who}, ${when}, ${i.transcriptId}) ${detail}`;
  });
  const rest = items.length - Math.min(items.length, ALERT_MAX_ITEMS);
  if (rest > 0) lines.push(`• and ${rest} more`);
  return [head, ...lines].join("\n");
}

/**
 * Subject line for the alert email. Leads with the count and the word
 * "call-integrity" so it is filterable, and names the single tenant when
 * there is only one, which is the common case.
 */
export function callIntegrityAlertSubject(items: readonly CallIntegrityAlertItem[]): string {
  if (items.length === 0) return "";
  const noun = items.length === 1 ? "failure" : "failures";
  const businesses = new Set(items.map((i) => i.business));
  const who = businesses.size === 1 ? ` at ${[...businesses][0]}` : "";
  return `${items.length} call-integrity ${noun}${who}`;
}
