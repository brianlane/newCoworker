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
 *   `gate_never_cleared` (call 3578b1a7, 2026-07-30, Amy Laidlaw). A
 *   HomeLight live transfer opened on the partner's accept menu and the
 *   referral was never accepted: the partner repeated "press one to agree"
 *   TEN times and the call ended still asking. The AI behaved perfectly, so
 *   every other rule here stayed silent, and nothing else did either. The
 *   lead ($800K, 85213) was simply lost, and it took a month and a hand
 *   audit to notice. See `isAcceptPrompt` for why the signature is the LAST
 *   caller turn rather than a repeat count.
 *
 *   `invented_amount` (call 60a64ddd, 2026-08-20, Amy Laidlaw). Calling a
 *   Clever seller lead, the AI said "the offers on your file are 375k and
 *   395k". The only offers ever sent for that lead were $320,097, $342,000
 *   and $325,000, and they arrived four minutes AFTER the call ended. At the
 *   moment it spoke, the AI held one referral text reading "Est. home value:
 *   $425,000.00" and no offers at all, so both figures were invented, and
 *   both were tens of thousands high. NO_INVENTED_CONTACT_LINE deliberately
 *   scoped itself to details "a person will ACT on, by dialling or writing to
 *   them", excluding prices as "legitimate and frequent". This call is the
 *   counter-example: a seller acts on a number like that by deciding whether
 *   to list, and unlike a wrong phone number it never fails visibly.
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

export type CallIntegrityKind =
  | "role_leak"
  | "talked_to_recording"
  | "invented_contact_number"
  | "gate_never_cleared"
  | "invented_amount";

export type CallIntegrityFinding = {
  kind: CallIntegrityKind;
  /** Human-readable evidence, safe to put in a log line. */
  detail: string;
  /**
   * `invented_contact_number` only: the offending number in spoken 3-3-4
   * form. Structured (not just embedded in `detail`) so the sweep can match
   * it against the bridge's suppressed-number record and report a firewalled
   * fabrication as BLOCKED rather than paging a human about audio the
   * spoken-number guard cut before it played.
   */
  number?: string;
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
export const MACHINE_PHRASES = [
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

/**
 * The partner's "press a key to accept this referral" announcement.
 *
 * The signature for a forfeited gate is that this prompt is the LAST thing
 * the caller side ever said: once the digit lands, the partner stops asking
 * and connects. Deliberately NOT a repeat count, which does not separate the
 * cases. Measured over every HomeLight transfer on Amy Laidlaw's account:
 * the connected calls repeated the prompt 0, 0, 1, 1, 1, 2 and 2 times, and
 * the three forfeits repeated it 3, 4 and 10 times. A threshold anywhere in
 * that overlap either misses a lost referral or fires on a won one, while
 * "was the partner still asking when the call ended" is exactly right on all
 * ten.
 *
 * Precision matters more than reach here, because a VOICEMAIL menu is also a
 * keypad menu and two of the connected calls END on one. Both of these are
 * real last-caller-turns from calls that worked, and neither may match:
 *
 *   "Replay your message. Press one. To continue recording, press two."
 *   "To review, re-record or add to your message, press one. To mark your
 *    message urgent, press two."
 *
 * So the accept verb has to follow the keypress in the SAME sentence. The
 * `[^.!?]` window is what does that: in both mailbox menus the option ends
 * at a full stop before any other word, whereas the partner's prompt reads
 * "press one to agree ... and to be connected to the client" unbroken.
 *
 * "accept" is in the verb list although HomeLight has never used it, because
 * the cost of the two errors is not symmetric: an unmatched rewording turns
 * this rule silently off and loses a referral exactly the way the incident
 * did, while an extra verb costs one line in a digest a human reads. The
 * keypress and the same-sentence window still have to hold.
 */
const ACCEPT_PROMPT =
  /press\s+(?:\d+|one|two|three|four|five|zero|pound|star)\b[^.!?]{0,90}?\b(?:agree|accept|be\s+connected|connect\s+you|connected\s+to)\b/i;

/** True when this caller turn is a partner accept prompt (see ACCEPT_PROMPT). */
export function isAcceptPrompt(text: string): boolean {
  return ACCEPT_PROMPT.test(text);
}

/**
 * The smallest amount worth reporting, in whole dollars.
 *
 * Set at the scale of the failure this rule exists for (home prices and cash
 * offers) so that ordinary priced conversation never reaches the digest: a
 * receptionist quoting an $89 tune-up or a $250 callout is legitimate and
 * frequent, which is the exact reason NO_INVENTED_CONTACT_LINE left prices
 * alone in the first place. Only the band where a wrong figure moves a
 * property decision is detected.
 */
export const MIN_REPORTABLE_AMOUNT = 10_000;

/**
 * How far a spoken amount may sit from a sourced one and still count as the
 * same figure.
 *
 * Rounding aloud is normal and correct: "about 438" for $437,900 is the same
 * fact, and reporting it would be a false positive. 2% is wide enough for
 * every rounding seen on real calls and far too narrow to absorb a
 * fabrication: the incident's 375k against the briefed $425,000 is 11.8% out.
 */
export const AMOUNT_MATCH_TOLERANCE = 0.02;

/**
 * A money amount in speech. Requires a currency marker, a magnitude suffix,
 * or comma grouping, and never matches a bare digit run: on a real-estate
 * call the bare runs are zip codes ("85205"), street numbers ("4046") and
 * years, and matching those would bury the digest instantly.
 *
 * Both lookarounds were put there by a false positive on the real corpus,
 * not by theory. The trailing `(?![\w-])` is why "9 months" is not nine
 * million: without it the greedy suffix group ate the "m" of "months" (call
 * 12f073e0, 2026-08-12). It excludes a word character and a hyphen but NOT a
 * full stop, because "...are 375k and 395k." ends the sentence that carries
 * the incident's second figure, and an earlier draft that blocked "." found
 * only the first. The leading `\b` keeps a digit run that is glued to
 * letters from reading as money.
 */
const AMOUNT_PATTERN =
  /(\$\s*)?\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([kKmM])?(?![\w-])/g;

/**
 * Every money amount in a piece of text, in whole dollars.
 *
 * Amounts below MIN_REPORTABLE_AMOUNT are dropped here rather than at the
 * comparison, so both the allowlist and the check see the same scale.
 */
export function spokenAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_PATTERN)) {
    const [, dollar, digits, suffix] = m;
    // A bare number is only money when something SAYS it is money.
    if (!dollar && !suffix && !digits.includes(",")) continue;
    const base = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = suffix ? (suffix.toLowerCase() === "m" ? 1_000_000 : 1_000) : 1;
    const value = Math.round(base * scale);
    if (value < MIN_REPORTABLE_AMOUNT) continue;
    out.push(value);
  }
  return out;
}

/** True when `value` matches something the call actually sourced. */
export function amountIsSourced(value: number, allowed: ReadonlySet<number>): boolean {
  for (const a of allowed) {
    if (Math.abs(value - a) <= a * AMOUNT_MATCH_TOLERANCE) return true;
  }
  return false;
}

/**
 * The amounts a call legitimately supplies: everything the OTHER party said
 * on it. The assistant's own turns are excluded on purpose, since a figure
 * repeated by the speaker that invented it is not a source.
 */
export function callerAmounts(turns: readonly IntegrityTurn[]): Set<number> {
  const out = new Set<number>();
  for (const turn of turns) {
    if (turn.role === "assistant") continue;
    for (const v of spokenAmounts(typeof turn.content === "string" ? turn.content : "")) {
      out.add(v);
    }
  }
  return out;
}

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
 * Assistant turns the lead never heard: muted model audio, or the
 * `[Voicemail]` badge the hangup path writes for Telnyx TTS. Counting them
 * as a conversation is how the Sep 1 2026 `talked_to_recording` email
 * became a false alarm (one heard greeting plus a muted turn plus a badge).
 */
export function isUnheardAssistantTurn(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("[Voicemail]") || t.startsWith("[Muted]");
}

function isHeardAssistant(turn: IntegrityTurn): boolean {
  if (!isAssistant(turn)) return false;
  const text = textOf(turn);
  return text !== "" && !isUnheardAssistantTurn(text);
}

/**
 * Findings for one call, newest rules first. At most one `role_leak` per
 * call, and one `invented_contact_number` per distinct number: the point is
 * to name the call, and quoting every offending turn would bury the operator
 * in one bad call's noise.
 *
 * `allowedAmounts` switches the invented-amount rule on, and follows the same
 * fail-toward-silence contract as `allowedNumbers`: omitted, the rule does
 * not run. Callers build it with `callerAmounts`, optionally widened with
 * whatever written material the call was briefed from.
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
  opts: {
    minAssistantTurns?: number;
    allowedNumbers?: ReadonlySet<string>;
    allowedAmounts?: ReadonlySet<number>;
  } = {}
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
      if (!isHeardAssistant(turn)) continue;
      const text = textOf(turn);
      for (const n of extractSpokenNumbers(text)) {
        if (opts.allowedNumbers.has(n) || flagged.has(n)) continue;
        flagged.add(n);
        findings.push({
          kind: "invented_contact_number",
          number: n,
          detail:
            `spoke ${n}, which is not a number this business owns: ` +
            `"${clipEvidenceQuote(text, 140)}"`
        });
      }
    }
  }

  // Same shape as the invented-number rule above and the same reasons: only
  // the assistant side can fabricate, and one finding per distinct amount so
  // a figure repeated across a call does not multiply the alert.
  if (opts.allowedAmounts) {
    const flagged = new Set<number>();
    for (const turn of turns) {
      if (!isHeardAssistant(turn)) continue;
      const text = textOf(turn);
      for (const v of spokenAmounts(text)) {
        if (amountIsSourced(v, opts.allowedAmounts) || flagged.has(v)) continue;
        flagged.add(v);
        findings.push({
          kind: "invented_amount",
          detail:
            `said $${v.toLocaleString("en-US")}, which nothing on this call supplied: ` +
            `"${clipEvidenceQuote(text, 140)}"`
        });
      }
    }
  }

  // Only OUR side can leak a role token. The caller side is a transcription
  // of whatever was on the line, so a menu that happens to read "user:" is
  // not the AI misbehaving.
  const leaked = turns.find((t) => isHeardAssistant(t) && hasRoleLeak(textOf(t)));
  if (leaked) {
    findings.push({
      kind: "role_leak",
      detail: clipOnWordBoundary(textOf(leaked).replace(/\s+/g, " "), 240)
    });
  }

  const callerTurns = turns.filter((t) => !isAssistant(t) && textOf(t) !== "");
  const assistantTurns = turns.filter((t) => isHeardAssistant(t));
  // The partner was still asking us to accept when the call ended, so the
  // referral was never taken. Checked against the LAST caller turn only: see
  // ACCEPT_PROMPT for why a repeat count cannot separate a lost referral from
  // a won one.
  const lastCaller = callerTurns[callerTurns.length - 1];
  if (lastCaller && isAcceptPrompt(textOf(lastCaller))) {
    findings.push({
      kind: "gate_never_cleared",
      detail:
        "the call ended with the partner still asking us to accept: " +
        `"${clipEvidenceQuote(textOf(lastCaller), 160)}"`
    });
  }

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
        `machine-sounding caller turns, e.g. "${clipEvidenceQuote(textOf(machineTurns[0]!), 120)}"`
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

/**
 * Per-finding evidence clip. Must cover the longest detail every rule can
 * produce (role_leak's 240-char turn, plus a short prefix on other rules).
 * The Sep 1 2026 email died at 160, mid-word, inside an open quote.
 */
export const ALERT_DETAIL_CHARS = 280;

const ELLIPSIS = "...";

/**
 * Cut on a word boundary and append an ellipsis so a clip never ends
 * mid-word. Exported so the alert formatter and the per-rule quote clips
 * share one judgement.
 */
export function clipOnWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - ELLIPSIS.length);
  let cut = text.slice(0, budget);
  const sp = cut.lastIndexOf(" ");
  if (sp >= Math.floor(budget * 0.6)) cut = cut.slice(0, sp);
  return `${cut.replace(/[.,;:]+$/, "")}${ELLIPSIS}`;
}

/** Collapse whitespace, then clip, for an evidence quote inside a finding. */
export function clipEvidenceQuote(text: string, maxChars: number): string {
  return clipOnWordBoundary(text.replace(/\s+/g, " ").trim(), maxChars);
}

/**
 * Clip a finding's detail for the alert body. If a quote is left open, close
 * it so the line cannot die at `"...or pre`.
 */
export function clipAlertDetail(detail: string, maxChars: number = ALERT_DETAIL_CHARS): string {
  const clipped = clipOnWordBoundary(detail, maxChars);
  const quotes = (clipped.match(/"/g) ?? []).length;
  return quotes % 2 === 1 ? `${clipped}"` : clipped;
}

/**
 * The predicate for one finding, reading after "the AI ...".
 *
 * Exported and shared because there are TWO places a finding gets described
 * to a human: this module's alert email, and the per-tenant `system_logs`
 * row that the fleet dashboard reads. Those were separate copies, written as
 * a chained ternary that ENDED on the recording wording, so the two kinds
 * added here were each stored and displayed as "the AI held a conversation
 * with a recording" (Bugbot, this PR). A forfeited referral shown to a client
 * as the AI chatting to a machine is worse than no alert.
 *
 * A `switch` rather than an if-chain so the compiler, not a reviewer, is what
 * catches the next kind: TypeScript proves the union exhaustive, and a sixth
 * member fails to build here instead of silently inheriting somebody else's
 * sentence.
 */
export function kindPhrase(kind: CallIntegrityKind): string {
  switch (kind) {
    case "role_leak":
      return "spoke the caller's side";
    case "invented_contact_number":
      return "gave out a number it does not own";
    case "invented_amount":
      return "quoted a figure nothing gave it";
    // The one finding that is NOT the model misbehaving: on the incident call
    // it stayed correctly silent. So the phrase names the lost referral
    // rather than an act of disobedience.
    case "gate_never_cleared":
      return "never got past the partner's accept menu, so the referral was lost";
    case "talked_to_recording":
      return "talked to a recording";
  }
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
    const detail = clipAlertDetail(i.detail, ALERT_DETAIL_CHARS);
    return `• ${i.business}: the AI ${kindPhrase(i.kind)} (${who}, ${when}, ${i.transcriptId}) ${detail}`;
  });
  const rest = items.length - Math.min(items.length, ALERT_MAX_ITEMS);
  if (rest > 0) lines.push(`• and ${rest} more`);
  return [head, ...lines].join("\n");
}

/**
 * Split one call's findings into real failures and firewall-blocked attempts.
 *
 * The voice bridge's spoken-number guard (vps/voice-bridge/src/
 * spoken-number-guard.ts) cuts a fabricated number's audio before it finishes
 * playing and records the cut on the handoff session context as
 * `suppressed_spoken_numbers`. The transcript still contains what the model
 * GENERATED, so without this split the sweep would page a human about digits
 * nobody heard, and an alert that cries wolf gets muted. A blocked finding is
 * still reported, as a `voice_call_integrity_blocked` log line, because the
 * model ATTEMPTING a fabrication is worth a daily count even when the guard
 * held.
 *
 * Only `invented_contact_number` findings can be blocked (the guard acts on
 * numbers alone), and matching is by the shared spoken 3-3-4 form so the
 * bridge's record and the detector's finding cannot disagree about format.
 * `suppressed` values are normalized defensively; anything unparsable is
 * ignored rather than trusted.
 */
export function partitionBlockedFindings(
  findings: readonly CallIntegrityFinding[],
  suppressed: unknown
): { failures: CallIntegrityFinding[]; blocked: CallIntegrityFinding[] } {
  const suppressedSet = new Set<string>();
  if (Array.isArray(suppressed)) {
    for (const v of suppressed) {
      const n = spokenNumberForm(v);
      if (n) suppressedSet.add(n);
    }
  }
  const failures: CallIntegrityFinding[] = [];
  const blocked: CallIntegrityFinding[] = [];
  for (const f of findings) {
    if (f.kind === "invented_contact_number" && f.number && suppressedSet.has(f.number)) {
      blocked.push(f);
    } else {
      failures.push(f);
    }
  }
  return { failures, blocked };
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
