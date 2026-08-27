/**
 * Detects the three ways a voice call goes wrong that no code check can
 * catch, because each is the model disobeying its prompt rather than the
 * code misbehaving.
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
 *   `invented_contact_number` (calls 68ca8cdb 2026-08-26 and 5b335fc8
 *   2026-08-27, again Amy Laidlaw). Ad-libbing a voicemail sign-off, the
 *   model told leads to "give us a call back at 480-269-7977" and
 *   480-331-9100, numbers belonging to nobody on the account. Thirteen
 *   distinct fabrications preceded these over 45 days; the prompt rule
 *   shipped against them (PR #1612, `NO_INVENTED_CONTACT_LINE`) was verified
 *   deployed and still failed on 2 of the first 8 machine calls, which is why
 *   this is now DETECTED daily rather than prompted against a fourth time.
 *   Detection needs the set of numbers the business may legitimately speak;
 *   `collectAllowedNumbers` builds it from the same sources as
 *   `debug/voicemail-number-audit.ts` (which Bugbot vetted through two rounds
 *   of false-positive holes), so the sweep and the audit cannot drift.
 *
 * Pure and dependency-free: the Edge sweep and `debug/audit-call-integrity.ts`
 * both import it so the two cannot drift, and it pins at 100% coverage like
 * every other `_shared` module.
 */

/** One transcript turn, narrowed to what detection needs. */
export type IntegrityTurn = { role: string | null; content: string | null };

export type CallIntegrityKind = "role_leak" | "talked_to_recording" | "invented_contact_number";

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

/**
 * A phone-ish value normalized to spoken 3-3-4 form ("480-269-7977"), or null
 * when it does not hold a North American number. One canonical form is what
 * lets an E.164 column, a flow script's "(480) 269-7977" and a transcribed
 * "480.269.7977" all compare equal.
 */
export function spokenNumberForm(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length !== 10) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * A phone number as it appears in assistant speech: optionally a +1/1 prefix,
 * then 3-3-4 with any mix of spaces, dots, dashes or parentheses, including
 * none. Bare digit runs ARE matched here, unlike in flow definitions below:
 * transcribed speech has no epoch timestamps to confuse them with.
 */
const SPOKEN_NUMBER_PATTERN = /\b(?:\+?1[ .\-()]*)?\(?(\d{3})\)?[ .\-]*(\d{3})[ .\-]*(\d{4})\b/g;

/** Every number spoken in a piece of text, in spoken 3-3-4 form, in order. */
export function extractSpokenNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPOKEN_NUMBER_PATTERN)) {
    out.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  return out;
}

/**
 * Raw material for the set of numbers a business may legitimately speak.
 *
 * The caller does the IO (each runtime has its own client) and hands the rows
 * over; this stays pure so the Edge sweep, `debug/voicemail-number-audit.ts`
 * and `debug/audit-call-integrity.ts` all build the SAME set. Completeness
 * matters more here than anywhere else in the file: a number missing from
 * this set is reported as INVENTED, and Bugbot found four separate holes in
 * the audit script's first drafts, every one a false positive that would have
 * called a correct call a fabrication.
 */
export type AllowedNumberSources = {
  /**
   * Rows scanned by COLUMN NAME: any phone/e164/did/number-named column is
   * collected. `businesses`, `business_telnyx_settings` and
   * `ai_flow_team_members` rows go here, so a column added later (as
   * `forward_to_e164` once was) is picked up without a code change.
   */
  phoneKeyedRows?: ReadonlyArray<Record<string, unknown> | null | undefined>;
  /** Bare values: `notification_preferences.phone_number`, `telnyx_voice_routes.to_e164`. */
  values?: ReadonlyArray<unknown>;
  /**
   * `ai_flows.definition` payloads. Numbers here are matched as E.164 or as
   * SEPARATED 3-3-4 only, deliberately NOT as bare 10-digit runs: in flow
   * JSON those are usually epoch timestamps, and matching them would quietly
   * widen the allowlist until fabrications pass.
   */
  flowDefinitions?: ReadonlyArray<unknown>;
};

const PHONE_KEYED_COLUMN = /phone|e164|did|number/i;

/** The numbers a business may legitimately speak, in spoken 3-3-4 form. */
export function collectAllowedNumbers(src: AllowedNumberSources): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const n = spokenNumberForm(v);
    if (n) out.add(n);
  };
  for (const row of src.phoneKeyedRows ?? []) {
    for (const [k, v] of Object.entries(row ?? {})) {
      if (PHONE_KEYED_COLUMN.test(k)) add(v);
    }
  }
  for (const v of src.values ?? []) add(v);
  for (const def of src.flowDefinitions ?? []) {
    const text = JSON.stringify(def ?? null);
    for (const m of text.matchAll(/\+1(\d{10})\b/g)) add(m[1]);
    for (const m of text.matchAll(/\(?(\d{3})\)?[ .\-]+(\d{3})[ .\-]+(\d{4})\b/g)) {
      add(`${m[1]}${m[2]}${m[3]}`);
    }
  }
  return out;
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
 * call, and one `invented_contact_number` per distinct number: the point is
 * to name the call, and quoting every offending turn would bury the operator
 * in one bad call's noise.
 *
 * `allowedNumbers` switches the invented-number rule on: it is the
 * business's legitimate set (see `collectAllowedNumbers`) PLUS the numbers
 * of the parties on this call, which the caller adds because reading the
 * remote party their own number back is explicitly allowed. Omitted, the
 * rule does not run at all: an allowlist a caller failed to build must
 * fail toward silence, never toward calling every spoken number invented.
 */
export function detectCallIntegrity(
  turns: readonly IntegrityTurn[],
  opts: { minAssistantTurns?: number; allowedNumbers?: ReadonlySet<string> } = {}
): CallIntegrityFinding[] {
  const findings: CallIntegrityFinding[] = [];
  const minAssistantTurns = opts.minAssistantTurns ?? DEFAULT_MIN_ASSISTANT_TURNS;

  // Only the assistant side can fabricate: the caller side is a transcription
  // of whatever was on the line, and a mailbox reading ITS number out is not
  // our AI misbehaving. One finding per distinct number, quoting its first
  // occurrence, so a script read twice does not double the alert.
  if (opts.allowedNumbers) {
    const flagged = new Set<string>();
    for (const turn of turns) {
      if (!isAssistant(turn)) continue;
      const text = textOf(turn);
      for (const n of extractSpokenNumbers(text)) {
        if (opts.allowedNumbers.has(n) || flagged.has(n)) continue;
        flagged.add(n);
        findings.push({
          kind: "invented_contact_number",
          detail:
            `spoke ${n}, which is not a number this business owns: ` +
            `"${text.replace(/\s+/g, " ").slice(0, 140)}"`
        });
      }
    }
  }

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
  if (kind === "role_leak") return "spoke the caller's side";
  if (kind === "invented_contact_number") return "gave out a number it does not own";
  return "talked to a recording";
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
