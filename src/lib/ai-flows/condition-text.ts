import type { StepCondition } from "@/lib/ai-flows/schema";

/**
 * Human reading of a step or branch condition. `blank` is its own sentence:
 * extract_text writes "" for an absent field, and showing that as
 * `contains ""` is the wrong rule.
 */
export function conditionText(when: StepCondition): string {
  if (when.blank === true) return `${when.var} is blank`;
  const operator =
    when.equals !== undefined ? "equals" : when.notEquals !== undefined ? "does not equal" : "contains";
  const value = when.equals ?? when.notEquals ?? when.contains ?? "";
  return `${when.var} ${operator} "${value}"`;
}

/** Short canvas reading of the same condition. Curly quotes match the canvas pills. */
export function canvasConditionText(when: StepCondition): string {
  if (when.blank === true) return `${when.var} is blank`;
  const op = when.equals !== undefined ? "=" : when.notEquals !== undefined ? "\u2260" : "contains";
  const value = when.equals ?? when.notEquals ?? when.contains ?? "";
  return `${when.var} ${op} \u201c${value}\u201d`;
}
