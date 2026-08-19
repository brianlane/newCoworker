/**
 * Pure builder: repoint Amy's weekly Clever sweep alert at what the sweep
 * MEASURED, now that the engine chains capped passes until the backlog is
 * drained.
 *
 * WHAT CHANGED UNDER THE FLOW. A `forEachLink` browse step used to be one
 * capped render pass (6 items against a ~100s Cloudflare Tunnel ceiling), so
 * the flow carried arithmetic to guess the shortfall: read the backlog Clever
 * states, subtract the capacity constant, text Amy the difference. The engine
 * now reads `remaining` off each pass, defers the run, and re-enters the same
 * step until the portal's "Needs Action" list is drained (or a named terminal
 * condition stops it), then publishes measured totals as
 * `{{vars.<stepId>_updated}}` and `{{vars.<stepId>_left}}`.
 *
 * WHY THE OLD ALERT HAS TO GO. Its arithmetic was wrong in both directions on
 * the very first real run (2026-08-19): Clever stated 41 deals, the pass
 * attempted 6 and landed 2 (four cards failed), and Amy was told "about 35
 * still need you". The honest number was 39. With chaining, the same message
 * would drift the other way: the sweep covers the whole backlog and the
 * arithmetic would still page her about a remainder that no longer exists.
 * The alert must report the sweep's own totals:
 *
 *   before  backlog - 6              "35 still need you"   (assumed capacity)
 *   after   {{vars.update_each_left}} measured by the loop  (0 stays silent)
 *
 * The branch condition moves from "did the backlog fit one pass" to "did the
 * sweep leave anything", i.e. `less_than(left, 1)`: "yes" means zero left and
 * the flow stays quiet, which is the goal state, the coworker handled the
 * whole compliance ping without a human. The `sweep_remainder` subtract step
 * is REMOVED rather than repointed: nothing consumes `deals_left` once the
 * message reads the measured var.
 *
 * THE HOLE MEASURING LEFTOVERS ALONE LEAVES, and the second arm that closes
 * it. A sweep that never reaches the list reports zero cards and zero errors,
 * so leftovers are zero and a leftovers-only alert stays SILENT precisely
 * when the automation is most broken. This is not hypothetical: replaying the
 * 2026-08-19 reminder rendered "Magic link has expired" (Clever's link is
 * single-use), the loop matched no rows, and the run closed green having
 * posted nothing. Note the old arithmetic alert did NOT have this hole, since
 * backlog-minus-six always fired on a stated backlog, so shipping the
 * measured alert without this arm would have been a REGRESSION.
 *
 * So the flow also measures `less_than(updated, 1)` and alerts on its own arm,
 * placed FIRST because "we could not post anything" is the accurate sentence
 * when both arms would fire. Its condition is `notEquals "no"`, the fail-loud
 * polarity: it fires on "yes" (nothing posted) and on the not_a_number
 * sentinel a missing var produces, so a run against an engine that does not
 * publish these vars still pages the owner rather than going quiet.
 *
 * Var names come from `forEachOutcomeVars(<browse step id>)`, the same
 * function the worker writes with and the authoring validator registers, so
 * the names cannot drift from what the run actually produces.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep } from "@/lib/ai-flows/schema";
import { forEachOutcomeVars } from "../../supabase/functions/_shared/ai_flows/browse";
import {
  ALERT_ARM_ID,
  ALERT_NOTIFY_ID,
  ALERT_STEP_ID,
  BACKLOG_VAR,
  FITS_STEP_ID,
  FITS_VAR,
  REMAINDER_STEP_ID
} from "./amy-clever-weekly-update-sweep-definition";

/** Branch question, rewritten from "did it fit one pass" to the real ask. */
export const NEW_QUESTION = "Did the chained sweep leave any cards for a human?";
/** Arm label: the arm now means measured leftovers, not backlog arithmetic. */
export const NEW_LABEL = "cards the sweep could not update";

/** Step + var for "did the sweep post anything at all". */
export const POSTED_STEP_ID = "sweep_posted_check";
export const POSTED_VAR = "sweep_posted_none";
/** Arm + notify ids for the saw-nothing alert. */
export const NOTHING_ARM_ID = "posted_nothing";
export const NOTHING_NOTIFY_ID = "nothing_notify";
export const NOTHING_LABEL = "the sweep could not post anything";

/**
 * The owner alert, driven entirely by measured vars. Fires when the chained
 * sweep ended with cards still listed (per-card failures, a stuck list head,
 * the pass-cap valve, a mid-sweep permanent failure, or a lost list), so a
 * clean sweep of any backlog size stays silent.
 */
export function measuredAlertMessage(updatedVar: string, leftVar: string): string {
  return (
    `Clever asked for updates on {{vars.${BACKLOG_VAR}}} active deals this week. ` +
    `Your AI coworker posted {{vars.${updatedVar}}} updates in the portal; ` +
    `about {{vars.${leftVar}}} could not be updated automatically and still ` +
    `need you: {{vars.portal_url}}`
  );
}

/**
 * The alert for a sweep that posted NOTHING.
 *
 * A sweep that never reached the list reports zero cards and zero errors,
 * which arithmetic cannot tell apart from "the book was already clean": Amy's
 * Clever magic link is single-use, and a second visit renders "Magic link has
 * expired", a page with no rows (proved live 2026-08-19). Measuring leftovers
 * alone therefore has a hole exactly where the automation is most broken, and
 * it is a hole the OLD arithmetic alert did not have, since backlog-minus-six
 * always fired on a stated backlog. This arm closes it.
 */
export function postedNothingMessage(): string {
  return (
    `Your AI coworker could not post any Clever updates this week: it opened ` +
    `the portal and found no cards it could update, which usually means the ` +
    `login link had already been used or expired. Clever says ` +
    `{{vars.${BACKLOG_VAR}}} deals are awaiting an update, so they need you in ` +
    `the portal: {{vars.portal_url}}`
  );
}

/** Deep-clone helper so a builder never mutates the caller's live definition. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type BuildResult = {
  definition: AiFlowDefinition;
  /** Human-readable changes made; empty when the flow already says all this. */
  changes: string[];
  /** Shape problems that make the transform unsafe; abort when non-empty. */
  issues: string[];
};

/**
 * Rewrite the alert chain in place. Idempotent: running it on an
 * already-transformed definition reports no changes and no issues.
 */
export function buildMeasuredAlert(live: AiFlowDefinition): BuildResult {
  const definition = clone(live);
  const changes: string[] = [];
  const issues: string[] = [];
  const steps = definition.steps as FlowStep[];

  const sweeps = steps.filter(
    (s) => s.type === "browse_action" && Boolean((s as { forEachLink?: string }).forEachLink)
  );
  if (sweeps.length !== 1) {
    return {
      definition,
      changes,
      issues: [`expected exactly one forEachLink browse step, found ${sweeps.length}`]
    };
  }
  const [updatedVar, leftVar] = forEachOutcomeVars(sweeps[0].id);

  // 1. The fits check now asks "did the sweep leave anything", not "would the
  //    backlog have fit one pass".
  const fits = steps.find((s) => s.id === FITS_STEP_ID);
  if (!fits || fits.type !== "math") {
    issues.push(`math step "${FITS_STEP_ID}" not found`);
  } else {
    const f = fits as unknown as { left: string; right: string; operation: string; saveAs: string };
    const wantLeft = `{{vars.${leftVar}}}`;
    if (f.left !== wantLeft || f.right !== "1") {
      changes.push(`${FITS_STEP_ID}: ${f.left} < ${f.right} -> ${wantLeft} < 1`);
      f.left = wantLeft;
      f.right = "1";
    }
    if (f.operation !== "less_than" || f.saveAs !== FITS_VAR) {
      issues.push(
        `math step "${FITS_STEP_ID}" has unexpected shape (${f.operation} -> ${f.saveAs})`
      );
    }
  }

  // 2. Nothing consumes deals_left once the message reads the measured var,
  //    so the subtract step goes away entirely.
  const remainderAt = steps.findIndex((s) => s.id === REMAINDER_STEP_ID);
  if (remainderAt >= 0) {
    steps.splice(remainderAt, 1);
    changes.push(`- math step "${REMAINDER_STEP_ID}" (nothing consumes deals_left now)`);
  }

  // 2b. "Did the sweep post anything at all?" A sweep that never reached the
  //     list looks identical to a finished one on leftovers alone, so this is
  //     measured separately and alerted on its own arm.
  const postedAt = steps.findIndex((s) => s.id === POSTED_STEP_ID);
  if (postedAt < 0) {
    const fitsAt = steps.findIndex((s) => s.id === FITS_STEP_ID);
    const insertAt = fitsAt >= 0 ? fitsAt + 1 : steps.length;
    steps.splice(insertAt, 0, {
      id: POSTED_STEP_ID,
      type: "math",
      operation: "less_than",
      left: `{{vars.${updatedVar}}}`,
      right: "1",
      saveAs: POSTED_VAR
    } as unknown as FlowStep);
    changes.push(`+ math step "${POSTED_STEP_ID}" (${updatedVar} < 1)`);
  }

  // 3. The branch keeps its ids (run history stays legible) but says what it
  //    now means, and the alert reports the measured totals.
  const alert = steps.find((s) => s.id === ALERT_STEP_ID);
  if (!alert || alert.type !== "branch") {
    issues.push(`branch step "${ALERT_STEP_ID}" not found`);
  } else {
    const branch = alert as unknown as {
      question: string;
      branches: Array<{
        id: string;
        label: string;
        condition: { var: string; equals?: string; notEquals?: string };
        steps: Array<Record<string, unknown>>;
      }>;
    };
    if (branch.question !== NEW_QUESTION) {
      branch.question = NEW_QUESTION;
      changes.push(`${ALERT_STEP_ID}: question -> "${NEW_QUESTION}"`);
    }
    // The saw-nothing arm goes FIRST: when the sweep posted nothing, that is
    // the accurate thing to say, and the leftover arm would otherwise claim a
    // count for a list we never read. `notEquals "no"` is the fail-loud
    // polarity: it fires on "yes" (nothing posted) AND on the not_a_number
    // sentinel a missing var produces, so a sweep whose vars never arrived
    // (an engine older than the one that publishes them) still pages the
    // owner instead of going quiet.
    if (!branch.branches.some((a) => a.id === NOTHING_ARM_ID)) {
      branch.branches.unshift({
        id: NOTHING_ARM_ID,
        label: NOTHING_LABEL,
        condition: { var: POSTED_VAR, notEquals: "no" },
        steps: [
          {
            id: NOTHING_NOTIFY_ID,
            type: "notify_owner",
            message: postedNothingMessage()
          }
        ]
      });
      changes.push(`+ branch arm "${NOTHING_ARM_ID}" (fires when the sweep posted nothing)`);
    }

    const arm = branch.branches.find((a) => a.id === ALERT_ARM_ID);
    if (!arm) {
      issues.push(`branch "${ALERT_STEP_ID}" has no "${ALERT_ARM_ID}" arm`);
    } else {
      if (arm.label !== NEW_LABEL) {
        arm.label = NEW_LABEL;
        changes.push(`${ALERT_STEP_ID}: arm label -> "${NEW_LABEL}"`);
      }
      if (arm.condition.var !== FITS_VAR || arm.condition.equals !== "no") {
        issues.push(
          `arm condition is {${arm.condition.var} == ${String(arm.condition.equals)}}, expected {${FITS_VAR} == no}`
        );
      }
      const notify = arm.steps.find((s) => s.id === ALERT_NOTIFY_ID);
      if (!notify || notify.type !== "notify_owner") {
        issues.push(`notify_owner step "${ALERT_NOTIFY_ID}" not found in the alert arm`);
      } else {
        const want = measuredAlertMessage(updatedVar, leftVar);
        if (notify.message !== want) {
          changes.push(`${ALERT_NOTIFY_ID}: message -> measured totals`);
          notify.message = want;
        }
      }
    }
  }

  return { definition, changes, issues };
}
