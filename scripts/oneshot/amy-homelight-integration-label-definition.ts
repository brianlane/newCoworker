/**
 * Pure builder: rewrite `auth.integrationLabel` on every step of a flow
 * definition, including steps nested inside branch arms.
 *
 * Kept separate from the applier so the unit suite can validate the EXACT
 * transform without live env or DB, the same split
 * `clever-spoke-check-definition.ts` uses.
 *
 * WHY THIS EXISTS. `custom_integrations.label` is the only handle a browse
 * step has on a stored credential, and the lookup
 * (`getCustomIntegrationByLabel`) is `ilike` on the trimmed label: case
 * insensitive but NOT space insensitive. On 2026-08-17 Amy's HomeLight row was
 * renamed "Home Light" -> "HomeLight" while all ten of her live HomeLight
 * browse steps still asked for the old spelling, so every one of them resolved
 * to `integration_not_found`. The render service reports that as
 * `auth_config_error`, which the worker classifies as PERMANENT, so the run
 * fails outright rather than retrying: a HomeLight referral would have died at
 * step 2 with no claim, no team routing and no lead.
 *
 * Pure: no I/O. The applier reads, validates, writes and records.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";

/** The spelling the flows asked for before 2026-08-17. */
export const OLD_LABEL = "Home Light";
/** The spelling `custom_integrations` now carries. */
export const NEW_LABEL = "HomeLight";

/**
 * Labels differing only by case or surrounding whitespace already resolve to
 * the same row, so treat them as equal and leave them alone. Only a real
 * difference (the space) is worth a write.
 */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Rewrite every `auth.integrationLabel` equal to `from` into `to`, walking
 * branch arms and `else` lists as well as the trunk. Returns the step ids that
 * changed, so the applier can print them and the ledger can record them.
 *
 * Steps are copied rather than mutated in place: the applier keeps the
 * untouched original for the ledger's `previous_definition`, which is what
 * `--revert` replays.
 */
export function relabelIntegration(
  definition: AiFlowDefinition,
  from: string,
  to: string
): string[] {
  const changed: string[] = [];

  const walk = (steps: FlowStep[]): FlowStep[] =>
    steps.map((step) => {
      let next: FlowStep = step;

      const auth = (step as { auth?: { integrationLabel?: string } }).auth;
      if (auth?.integrationLabel && sameLabel(auth.integrationLabel, from)) {
        changed.push(step.id);
        next = { ...next, auth: { ...auth, integrationLabel: to } } as FlowStep;
      }

      if (next.type === "branch") {
        next = {
          ...next,
          branches: next.branches.map((arm) => ({ ...arm, steps: walk(arm.steps) })),
          else: walk(next.else)
        };
      }
      return next;
    });

  definition.steps = walk(definition.steps);
  return changed;
}

/**
 * Every label a definition's steps reference, deduped. Used by the applier's
 * pre-flight so a run prints what it is about to touch, and by the tests to
 * assert nothing else moved.
 */
export function integrationLabelsIn(definition: AiFlowDefinition): string[] {
  const found = new Set<string>();
  const walk = (steps: FlowStep[]): void => {
    for (const step of steps) {
      const auth = (step as { auth?: { integrationLabel?: string } }).auth;
      if (auth?.integrationLabel) found.add(auth.integrationLabel);
      if (step.type === "branch") {
        for (const arm of step.branches) walk(arm.steps);
        walk(step.else);
      }
    }
  };
  walk(definition.steps);
  return [...found].sort();
}
