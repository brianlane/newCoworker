/**
 * Pure builders for Amy's two Clever "update the portal" flows.
 *
 * THE BUG. Clever texts Amy from ONE number, +1 314-207-7635, with TWO
 * different messages:
 *
 *   daily   "Here's a summary of the new customers you received today:
 *            - Jose Cortez ..."
 *   weekly  "We require weekly updates on all active customers ...
 *            - 29 Active Deals awaiting update"
 *
 * Two flows exist to answer them. "Clever Update Leads (Chris)" extracts the
 * named leads and updates only those cards; "Clever Update Leads" has no name
 * filter and sweeps every card needing action, which is exactly what the weekly
 * reminder asks for. But the sweep's trigger was seeded as `3142707635` where
 * the real sender is `3142077635`: a transposed digit. So the sweep has never
 * run once, and the weekly reminder falls to the (Chris) flow instead, which
 * extracts no names (the weekly text names nobody), filters the list down to
 * nothing, and reports success:
 *
 *   2026-08-12  "29 Active Deals awaiting update"
 *     [1] extract_text   lead_names=""
 *     [2] browse_action  forEach {items: 0, succeeded: 0}    run status: done
 *
 * Clever's actual compliance requirement therefore updates ZERO of 29 deals and
 * looks green. Same on 2026-08-05 with 7 deals.
 *
 * WHAT THESE BUILDERS CHANGE.
 *
 * 1. `retargetWeeklySweepTrigger` points the sweep at the real sender AND adds a
 *    `contains` needle so the two flows stop both matching. `retargetDailyTrigger`
 *    adds the complementary needle to the (Chris) flow. Without BOTH needles the
 *    fix makes things worse: the sweep would fire on the daily message too and
 *    blanket-update every active deal every day.
 *
 *    The needles are deliberately SHORT stable fragments, not whole sentences.
 *    Clever reworded its intro templates without notice in Jul 2026 and a
 *    full-brand-name match went dead for weeks (see
 *    `patch-clever-group-reply-second-intro.ts`). "summary of the new customers"
 *    and "awaiting update" are the smallest fragments that separate the two.
 *
 * 2. `addCapacityAlert` makes the sweep's own shortfall LOUD. The reminder text
 *    states the backlog ("29 Active Deals awaiting update"), so the flow can
 *    read it, compare it against what one pass can actually deliver, and text
 *    Amy the remainder. This is the real defect behind the whole phase: not that
 *    the sweep was capped, but that a capped sweep reported success.
 *
 * WHY ONE PASS CANNOT DO 29. The whole `forEachLink` loop runs inside a SINGLE
 * HTTP response, and that response crosses a Cloudflare Tunnel whose ingress
 * rules carry no `originRequest` block (`src/lib/cloudflare/tunnel.ts` writes
 * hostname and service, nothing else), so it inherits Cloudflare's default ~100s
 * 524 timeout. Measured on Amy's own completed sweeps, cost is about 5s fixed
 * plus 13s per lead:
 *
 *   items 1 -> 20.0s | 2 -> 32.0s | 3 -> 45.4s | 4 -> 59.0s | 5 -> 60.0s
 *
 * so roughly 6 leads fit and the 25-item render-side cap is a fiction: even the
 * OLD cap cannot be delivered through the tunnel. A 524 is worse than a
 * truncation, because the worker classifies a non-2xx from the edge as transient
 * and RETRIES the step, re-running "Provide Update -> We Spoke -> Submit" on
 * every card the timed-out pass already submitted.
 *
 * WHAT IS DELIBERATELY NOT CHANGED HERE.
 *
 * - The "We Spoke" status click stays. It is the only status label ever verified
 *   against the live modal, and it demonstrably submits (34 successful runs on
 *   the daily flow). Guessing a replacement would break all 29 updates at once,
 *   which is precisely how the ReferralExchange update selectors failed the
 *   first time (`debug/update-amy-aiflow-re-update-actions.ts`). Reading the
 *   modal's real option list needs a working Clever session, and Clever's
 *   password login is still failing while its magic links expire in under a day.
 *   The note text below is honest about being an automated weekly update, but
 *   the STATUS still overclaims and that is a known, recorded gap.
 * - Chaining several passes to cover the whole backlog. That depends on an
 *   unverified DOM fact: an updated card must LEAVE the "Needs Action" list, or
 *   pass 2 simply re-updates pass 1's leads. The capacity alert added here is
 *   what surfaces the number that settles it, on the next weekly run.
 *
 * Pure: no I/O. The applier reads, validates, writes and records the ledger.
 */
import type { AiFlowDefinition, FlowStep, FlowTrigger } from "@/lib/ai-flows/schema";

/** The number Clever actually texts from, for BOTH messages. */
export const CLEVER_SENDER = "3142077635";
/** The transposed number the sweep was seeded with, which never matched. */
export const CLEVER_SENDER_TYPO = "3142707635";

/** Smallest stable fragment unique to the daily "new customers" message. */
export const DAILY_NEEDLE = "summary of the new customers";
/** Smallest stable fragment unique to the weekly "active deals" reminder. */
export const WEEKLY_NEEDLE = "awaiting update";

/**
 * Leads one `forEachLink` pass can update before the ~100s Cloudflare edge
 * timeout kills the response. From Amy's own measured runs: ~5s fixed plus ~13s
 * per lead, so 6 leads is ~83s with headroom. This is also the new fleet default
 * for `AIFLOW_MAX_FOREACH_ITEMS` (`vps/aiflow-render/actions.mjs`); the two must
 * move together or the alert lies about what the sweep delivered.
 */
export const SWEEP_CAPACITY = 6;

/** Var the weekly flow reads the stated backlog into. */
export const BACKLOG_VAR = "active_deal_count";
/** Var holding "yes" when the whole backlog fits in one pass. */
export const FITS_VAR = "sweep_fits";
/** Var holding how many deals one pass leaves untouched. */
export const REMAINDER_VAR = "deals_left";

/** Step ids added by `addCapacityAlert`. Never reuse a live id. */
export const BACKLOG_STEP_ID = "backlog";
export const FITS_STEP_ID = "sweep_fits_check";
export const REMAINDER_STEP_ID = "sweep_remainder";
export const ALERT_STEP_ID = "capacity_alert";
export const ALERT_ARM_ID = "over_capacity";
export const ALERT_NOTIFY_ID = "capacity_notify";

/**
 * The note the weekly sweep types into every card. One shared string is posted
 * onto EVERY lead in the pass (a `forEachLink` loop has no per-item variable
 * bag), so the wording has to be true of all of them. The inherited
 * "call, texted, and emailed" is a per-lead claim about a specific week's
 * outreach and cannot be true of a whole book of active deals.
 */
export const WEEKLY_NOTE =
  "Weekly update posted automatically by Amy's assistant. This client is active and in ongoing follow-up by phone, text, and email.";

/** Message texted to Amy when the backlog outruns what one pass can update. */
export const CAPACITY_ALERT_MESSAGE =
  `Clever wants updates on {{vars.${BACKLOG_VAR}}} active deals this week. ` +
  `The automated sweep can cover ${SWEEP_CAPACITY} in one pass, so about ` +
  `{{vars.${REMAINDER_VAR}}} still need you in the portal: {{vars.portal_url}}`;

/** Deep-clone helper so a builder never mutates the caller's live definition. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * `FlowTrigger` is a union over channels and only some members carry
 * `conditions` (a `manual` trigger has none), so the field cannot be read off
 * the union directly. Both flows here are SMS triggers, which do carry it.
 */
type ConditionedTrigger = Extract<FlowTrigger, { conditions?: unknown }>;
type TriggerCondition = NonNullable<ConditionedTrigger["conditions"]>[number];

function conditionsOf(trigger: FlowTrigger): TriggerCondition[] {
  const held = (trigger as { conditions?: unknown }).conditions;
  return Array.isArray(held) ? (held as TriggerCondition[]) : [];
}

function hasContains(conditions: readonly TriggerCondition[], value: string): boolean {
  return conditions.some(
    (c) =>
      c.type === "contains" &&
      String((c as { value?: unknown }).value ?? "")
        .trim()
        .toLowerCase() === value.toLowerCase()
  );
}

/**
 * Point a trigger's `from_matches` at `sender` and ensure a case-insensitive
 * `contains needle`. Returns the human-readable changes made, empty when the
 * trigger already said this.
 */
function retarget(def: AiFlowDefinition, sender: string, needle: string): string[] {
  const changes: string[] = [];
  const trigger = def.trigger;
  const conditions = conditionsOf(trigger);

  for (const c of conditions) {
    if (c.type !== "from_matches") continue;
    const current = String((c as { value?: unknown }).value ?? "");
    if (current === sender) continue;
    (c as { value: string }).value = sender;
    changes.push(`from_matches ${current} -> ${sender}`);
  }

  if (!hasContains(conditions, needle)) {
    conditions.push({ type: "contains", value: needle, caseInsensitive: true } as TriggerCondition);
    changes.push(`+ contains "${needle}"`);
  }
  (trigger as { conditions?: TriggerCondition[] }).conditions = conditions;
  return changes;
}

/**
 * Weekly sweep: fire on the real sender, and only on the weekly reminder.
 */
export function retargetWeeklySweepTrigger(def: AiFlowDefinition): string[] {
  return retarget(def, CLEVER_SENDER, WEEKLY_NEEDLE);
}

/**
 * Daily (Chris) flow: same sender it already had, plus the complementary needle
 * so it stops swallowing the weekly reminder. This one matters as much as the
 * sweep's own fix: today the weekly message reaches THIS flow, which is why it
 * silently updates nothing.
 */
export function retargetDailyTrigger(def: AiFlowDefinition): string[] {
  return retarget(def, CLEVER_SENDER, DAILY_NEEDLE);
}

/** Find a `fill_placeholder` note action inside a step's action list. */
function noteAction(step: FlowStep): { valueTemplate?: string } | null {
  const actions = (step as { actions?: Array<Record<string, unknown>> }).actions;
  if (!Array.isArray(actions)) return null;
  const found = actions.find(
    (a) => a.kind === "fill_placeholder" && String(a.target ?? "").includes("additional details")
  );
  return (found as { valueTemplate?: string } | undefined) ?? null;
}

/**
 * Replace the sweep's per-card note with wording that is true of every lead in
 * the pass. Returns the previous text, or null when it already said this.
 */
export function rewriteSweepNote(def: AiFlowDefinition, note = WEEKLY_NOTE): string | null {
  for (const step of def.steps) {
    const action = noteAction(step);
    if (!action) continue;
    const previous = String(action.valueTemplate ?? "");
    if (previous === note) return null;
    action.valueTemplate = note;
    return previous;
  }
  return null;
}

/**
 * Add the read-compare-tell chain that makes a short sweep audible.
 *
 * `backlog` reads the number Clever stated, the two `math` steps decide whether
 * it fit and by how much it did not, and the branch texts Amy only when it did
 * not. Appended AFTER the browse step so the alert reports on a pass that has
 * already run, and so a failure to read the number can never stop the sweep.
 *
 * `less_than` is arithmetic on purpose rather than a second LLM judgment: a
 * threshold gate that can contradict the number it was judged from is exactly
 * the bug `MATH_OPERATIONS` documents.
 *
 * Idempotent: returns [] when the chain is already present.
 */
export function addCapacityAlert(def: AiFlowDefinition, capacity = SWEEP_CAPACITY): string[] {
  const existing = new Set(def.steps.map((s) => s.id));
  if (existing.has(ALERT_STEP_ID)) return [];

  const added: FlowStep[] = [];

  if (!existing.has(BACKLOG_STEP_ID)) {
    added.push({
      id: BACKLOG_STEP_ID,
      type: "extract_text",
      fields: [
        {
          name: BACKLOG_VAR,
          description:
            'The number of active deals awaiting an update stated in the message, e.g. "29" from ' +
            '"29 Active Deals awaiting update". Digits only, no words. If the message states no ' +
            "number, return an empty string."
        }
      ]
    } as FlowStep);
  }

  added.push(
    {
      id: FITS_STEP_ID,
      type: "math",
      operation: "less_than",
      left: `{{vars.${BACKLOG_VAR}}}`,
      // "fits" means count <= capacity, which is count < capacity + 1.
      right: String(capacity + 1),
      saveAs: FITS_VAR
    } as FlowStep,
    {
      id: REMAINDER_STEP_ID,
      type: "math",
      operation: "subtract",
      left: `{{vars.${BACKLOG_VAR}}}`,
      right: String(capacity),
      saveAs: REMAINDER_VAR
    } as FlowStep,
    {
      id: ALERT_STEP_ID,
      type: "branch",
      question: "Did the automated sweep cover the whole backlog Clever asked for?",
      branches: [
        {
          id: ALERT_ARM_ID,
          label: "more deals than one pass can update",
          condition: { var: FITS_VAR, equals: "no" },
          steps: [
            {
              id: ALERT_NOTIFY_ID,
              type: "notify_owner",
              message: CAPACITY_ALERT_MESSAGE
            }
          ]
        }
      ],
      else: []
    } as FlowStep
  );

  // The backlog read has to precede the two math steps that consume it, and the
  // whole chain has to follow the browse step it reports on. Appending in order
  // satisfies both, since the browse step is already last.
  def.steps.push(...added);
  return added.map((s) => s.id);
}

/** Every step id in a definition's trunk, for pre-flight printing. */
export function trunkStepIds(def: AiFlowDefinition): string[] {
  return def.steps.map((s) => s.id);
}

/** Convenience for tests and the applier: the whole weekly transform. */
export function buildWeeklySweep(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  changes: string[];
} {
  const next = clone(live);
  const changes = [...retargetWeeklySweepTrigger(next)];
  const previousNote = rewriteSweepNote(next);
  if (previousNote !== null) changes.push(`note "${previousNote}" -> "${WEEKLY_NOTE}"`);
  const added = addCapacityAlert(next);
  if (added.length > 0) changes.push(`+ steps ${added.join(", ")}`);
  return { definition: next, changes };
}

/** Convenience for tests and the applier: the whole daily transform. */
export function buildDaily(live: AiFlowDefinition): {
  definition: AiFlowDefinition;
  changes: string[];
} {
  const next = clone(live);
  return { definition: next, changes: retargetDailyTrigger(next) };
}
