/**
 * Stop a dashboard-chat reply from describing a write that this turn did
 * not make.
 *
 * A prompt line already told the model not to claim an unstaged automation
 * change. On BA Fitness (2026-09-23) it still narrated staged wording, a
 * saved knowledge section, and a test call to the owner's personal cell.
 * The check below runs on the finished text and appends a correction when
 * the tool results for the turn do not back the claim.
 */

export type ToolTurnFact = {
  name: string;
  ok: boolean;
  applied: boolean;
  staged: boolean;
};

export function toolTurnFact(name: string, result: unknown): ToolTurnFact {
  const r =
    result && typeof result === "object"
      ? (result as { ok?: unknown; applied?: unknown; staged?: unknown; confirmationToken?: unknown })
      : {};
  const ok = r.ok === true;
  const applied = r.applied === true;
  const staged =
    ok && !applied && (r.staged === true || typeof r.confirmationToken === "string");
  return { name, ok, applied, staged };
}

export type ClaimGroundingInput = {
  facts: readonly ToolTurnFact[];
  draftCount: number;
  /** Business DID. Null skips the test-number check (we do not know the right one). */
  coworkerDid: string | null;
  /** True when set_flow_enabled is declared on this turn. */
  canToggleFlows: boolean;
};

const APPLIED_CLAIM =
  /\b(?:i(?:'ve| have)|i)\s+(?:just\s+)?(?:updated|changed|edited|saved|applied|rewrote)\b[^.\n]{0,140}\b(?:automation|flow|aiflow|wording)\b/i;
const STAGED_CLAIM = /\b(?:i(?:'ve| have)|i)\s+(?:just\s+)?staged\b/i;
const KNOWLEDGE_CLAIM =
  /\b(?:saved|updated|ingested)\b[^.\n]{0,80}\b(?:memory|knowledge)\b/i;
const DRAFT_CARD_CLAIM = /open in aiflows builder/i;
const CANNOT_TOGGLE_CLAIM =
  /\b(?:cannot|can't|do not have|don't have)\b[^.\n]{0,80}\b(?:toggle|turn on|turn off|enable|disable|delete)\b[^.\n]{0,80}\b(?:automation|flow|workflow)s?\b/i;
const PHONE_IN_TEXT =
  /(?:\+?1[\s.-]*)?(?:\(\d{3}\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}/g;

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function samePhone(a: string, b: string): boolean {
  const right = digits(b);
  if (right.length < 10) return false;
  return digits(a).slice(-10) === right.slice(-10);
}

function mentionsTestCall(text: string, index: number): boolean {
  const start = Math.max(0, index - 100);
  return /\b(?:call|text|dial|ring)\b/i.test(text.slice(start, index));
}

function hasFact(
  facts: readonly ToolTurnFact[],
  name: string,
  pred: (fact: ToolTurnFact) => boolean
): boolean {
  return facts.some((fact) => fact.name === name && pred(fact));
}

/** Append honest corrections. Returns the original text when every claim is backed. */
export function groundUncommittedClaims(content: string, input: ClaimGroundingInput): string {
  const text = content.trim();
  if (!text) return content;
  const notes: string[] = [];
  const applied = hasFact(input.facts, "edit_aiflow", (fact) => fact.applied);
  const staged = hasFact(input.facts, "edit_aiflow", (fact) => fact.staged || fact.applied);
  if (APPLIED_CLAIM.test(text) && !applied) {
    notes.push(
      "Correction: this turn did not change an automation. Nothing was saved or applied."
    );
  }
  if (STAGED_CLAIM.test(text) && !staged) {
    notes.push("Correction: this turn did not stage an automation change.");
  }
  if (
    KNOWLEDGE_CLAIM.test(text) &&
    !hasFact(input.facts, "update_business_knowledge", (fact) => fact.ok)
  ) {
    notes.push(
      "Correction: this turn did not write a knowledge section. A memory save is confirmed in its own line only after it lands."
    );
  }
  if (DRAFT_CARD_CLAIM.test(text) && input.draftCount === 0) {
    notes.push("Correction: this turn did not create an AiFlows draft.");
  }
  if (
    input.canToggleFlows &&
    CANNOT_TOGGLE_CLAIM.test(text) &&
    !hasFact(input.facts, "set_flow_enabled", (fact) => fact.ok)
  ) {
    notes.push(
      "Correction: this chat can turn an automation on or off. It cannot delete one. Use /dashboard/aiflows to delete, and nothing was toggled on this turn."
    );
  }
  if (input.coworkerDid) {
    const bad: string[] = [];
    const phones = new RegExp(PHONE_IN_TEXT.source, "g");
    for (let match = phones.exec(text); match; match = phones.exec(text)) {
      const raw = match[0];
      if (!mentionsTestCall(text, match.index)) continue;
      if (samePhone(raw, input.coworkerDid)) continue;
      bad.push(raw.trim());
    }
    if (bad.length > 0) {
      notes.push(
        `Correction: to test the coworker, call ${input.coworkerDid}. Do not use ${bad[0]}.`
      );
    }
  }
  if (notes.length === 0) return content;
  return `${text}\n\n${notes.join("\n")}`;
}
